import { Router } from 'express'
import { z } from 'zod'
import multer from 'multer'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { kickBroadcastWorker } from '../lib/broadcastWorker.js'
import { planLimits } from '../lib/plans.js'
import { tenantPlan } from '../lib/planGuard.js'

const router = Router()
router.use(requireAuth)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const IMG_ROOT = path.join(__dirname, '../../public/uploads/broadcasts')
const EXT_BY_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } })

const digits = v => String(v || '').replace(/[^0-9]/g, '')

const audienceSchema = z.object({
  mode: z.enum(['all', 'filter', 'manual']).default('all'),
  filters: z.object({
    origin:       z.string().nullable().optional(),
    temperature:  z.string().nullable().optional(),
    assignedToId: z.string().nullable().optional(),
  }).optional().default({}),
  contactIds: z.array(z.string()).optional().default([]),
})

// Monta o `where` de contatos a partir da audiência escolhida
function audienceWhere(tenantId, { mode, filters, contactIds }) {
  const where = { tenantId, phone: { not: null } }
  if (mode === 'manual') {
    where.id = { in: contactIds.length ? contactIds : ['__none__'] }
    return where
  }
  if (mode === 'filter') {
    if (filters.origin) where.origin = filters.origin
    if (filters.temperature) where.temperature = filters.temperature
    if (filters.assignedToId) where.assignedToId = filters.assignedToId === 'unassigned' ? null : filters.assignedToId
  }
  return where
}

async function resolveRecipients(tenantId, audience) {
  const where = audienceWhere(tenantId, audience)
  const contacts = await prisma.contact.findMany({
    where,
    select: { id: true, name: true, phone: true },
    take: 5000,
  })
  // descarta quem não tem telefone utilizável e telefones repetidos
  const seen = new Set()
  const list = []
  for (const c of contacts) {
    const p = digits(c.phone)
    if (p.length < 8 || seen.has(p)) continue
    seen.add(p)
    list.push({ contactId: c.id, name: c.name, phone: p })
  }
  return list
}

// POST /broadcasts/upload-image — imagem opcional do disparo
router.post('/upload-image', upload.single('image'), async (req, res) => {
  const { tenantId } = req.user
  if (!req.file) return res.status(400).json({ error: 'Nenhuma imagem enviada.' })
  const ext = EXT_BY_MIME[req.file.mimetype]
  if (!ext) return res.status(400).json({ error: 'Use JPG, PNG, WEBP ou GIF.' })
  const dir = path.join(IMG_ROOT, tenantId)
  await fs.mkdir(dir, { recursive: true })
  const filename = randomUUID() + ext
  await fs.writeFile(path.join(dir, filename), req.file.buffer)
  res.status(201).json({ url: `/app/uploads/broadcasts/${tenantId}/${filename}` })
})

// POST /broadcasts/preview — quantos contatos e uma amostra, sem disparar
router.post('/preview', async (req, res) => {
  const { tenantId } = req.user
  const parsed = audienceSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const list = await resolveRecipients(tenantId, parsed.data)
  res.json({ count: list.length, sample: list.slice(0, 8).map(r => ({ name: r.name, phone: r.phone })) })
})

// GET /broadcasts — histórico
router.get('/', async (req, res) => {
  const { tenantId } = req.user
  const broadcasts = await prisma.broadcast.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  res.json(broadcasts)
})

// (antes de /:id, senão "quota" seria tratado como id)
// GET /broadcasts/quota — quanto do limite mensal já foi usado (limit null = sem limite)
router.get('/quota', async (req, res) => {
  res.json(await monthlyQuota(req.user.tenantId))
})

// GET /broadcasts/:id — status + resumo dos destinatários
router.get('/:id', async (req, res) => {
  const { tenantId } = req.user
  const broadcast = await prisma.broadcast.findFirst({ where: { id: req.params.id, tenantId } })
  if (!broadcast) return res.status(404).json({ error: 'Disparo não encontrado.' })

  const byStatus = await prisma.broadcastRecipient.groupBy({
    by: ['status'],
    where: { broadcastId: broadcast.id },
    _count: true,
  })
  const failures = await prisma.broadcastRecipient.findMany({
    where: { broadcastId: broadcast.id, status: 'failed' },
    select: { name: true, phone: true, error: true },
    take: 50,
  })
  res.json({ ...broadcast, byStatus: Object.fromEntries(byStatus.map(s => [s.status, s._count])), failures })
})

const createSchema = audienceSchema.extend({
  message: z.string().max(4096).optional().default(''),
  imageUrl: z.string().optional().nullable(),
})

// Cota mensal de Disparos do plano (ex.: Starter = 100 pessoas/mês). Conta quem já recebeu
// ou ainda vai receber neste mês; falhas de envio e o que foi cancelado antes de sair
// (status failed/skipped) não gastam cota.
async function monthlyQuota(tenantId) {
  const limit = planLimits(await tenantPlan(tenantId)).broadcastRecipientsPerMonth
  if (limit == null) return { limit: null, used: null, remaining: null }
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const used = await prisma.broadcastRecipient.count({
    where: { broadcast: { tenantId, createdAt: { gte: monthStart } }, status: { notIn: ['failed', 'skipped'] } },
  })
  return { limit, used, remaining: Math.max(0, limit - used) }
}

// POST /broadcasts — cria o disparo e enfileira; o worker manda em segundo plano
router.post('/', async (req, res) => {
  const { tenantId, userId } = req.user
  const parsed = createSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { message, imageUrl, ...audience } = parsed.data
  if (!message.trim() && !imageUrl) {
    return res.status(400).json({ error: 'Escreva uma mensagem ou anexe uma imagem.' })
  }

  const integration = await prisma.integration.findUnique({ where: { tenantId_type: { tenantId, type: 'whatsapp' } } })
  if (!integration || integration.status !== 'connected') {
    return res.status(400).json({ error: 'WhatsApp não conectado. Conecte o número em Integrações antes de disparar.' })
  }

  const recipients = await resolveRecipients(tenantId, audience)
  if (!recipients.length) return res.status(400).json({ error: 'Nenhum contato com telefone válido nessa seleção.' })

  const quota = await monthlyQuota(tenantId)
  if (quota.limit != null && recipients.length > quota.remaining) {
    return res.status(400).json({
      error: quota.remaining
        ? `Seu plano permite disparar pra ${quota.limit} pessoas por mês e restam ${quota.remaining}. Diminua a seleção pra ${quota.remaining} contato(s) ou fale com a gente pra fazer upgrade.`
        : `Você já usou os ${quota.limit} disparos do seu plano este mês. A cota renova no dia 1º — ou fale com a gente pra fazer upgrade.`,
      code: 'PLAN_LIMIT',
    })
  }

  const broadcast = await prisma.broadcast.create({
    data: {
      tenantId,
      message: message.trim(),
      mediaUrl: imageUrl || null,
      mediaType: imageUrl ? 'image' : null,
      status: 'queued',
      total: recipients.length,
      createdById: userId || null,
      recipients: {
        create: recipients.map(r => ({ contactId: r.contactId, name: r.name, phone: r.phone })),
      },
    },
  })

  kickBroadcastWorker()
  res.status(201).json(broadcast)
})

// POST /broadcasts/:id/cancel — para o que ainda não foi enviado
router.post('/:id/cancel', async (req, res) => {
  const { tenantId } = req.user
  const broadcast = await prisma.broadcast.findFirst({ where: { id: req.params.id, tenantId } })
  if (!broadcast) return res.status(404).json({ error: 'Disparo não encontrado.' })
  if (broadcast.status === 'done') return res.status(400).json({ error: 'Esse disparo já terminou.' })

  await prisma.broadcast.update({ where: { id: broadcast.id }, data: { status: 'canceled', finishedAt: new Date() } })
  await prisma.broadcastRecipient.updateMany({
    where: { broadcastId: broadcast.id, status: { in: ['pending', 'sending'] } },
    data: { status: 'skipped' },
  })
  res.json({ ok: true })
})

export default router
