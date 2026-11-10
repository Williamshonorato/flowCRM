import { Router } from 'express'
import { z } from 'zod'
import multer from 'multer'
import { randomUUID } from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import prisma from '../lib/prisma.js'
import { patchSchema } from '../lib/patchSchema.js'
import { requireAuth } from '../middleware/auth.js'
import { startFlowRun } from '../lib/automationEngine.js'

const router = Router()
router.use(requireAuth)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOAD_ROOT = path.join(__dirname, '../../public/uploads/automation-images')
const EXT_BY_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' }
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })

// POST /automations/upload-image — usado pelo passo "mandar mensagem" quando a pessoa
// anexa uma imagem; guarda em disco (por tenant) e devolve o caminho relativo, que fica
// salvo em step.config.imagePath e é lido de volta na hora de mandar pelo WhatsApp.
router.post('/upload-image', upload.single('image'), async (req, res) => {
  const { tenantId } = req.user
  if (!req.file) return res.status(400).json({ error: 'Nenhuma imagem enviada.' })
  const ext = EXT_BY_MIME[req.file.mimetype]
  if (!ext) return res.status(400).json({ error: 'Formato de imagem não suportado (use JPG, PNG, GIF ou WEBP).' })

  const filename = randomUUID() + ext
  const tenantDir = path.join(UPLOAD_ROOT, tenantId)
  await fs.mkdir(tenantDir, { recursive: true })
  await fs.writeFile(path.join(tenantDir, filename), req.file.buffer)

  const imagePath = `automation-images/${tenantId}/${filename}`
  res.status(201).json({ imagePath, url: `/app/uploads/${imagePath}` })
})

const stepSchema = z.object({
  id:     z.string(),
  type:   z.string(),
  config: z.record(z.any()).optional().default({}),
})

const flowSchema = z.object({
  name:          z.string().min(1),
  description:   z.string().optional(),
  active:        z.boolean().default(true),
  triggerType:   z.enum(['contact_created', 'deal_created', 'deal_stage_changed', 'deal_closed', 'whatsapp_message_received', 'manual']),
  triggerConfig: z.record(z.any()).optional().default({}),
  steps:         z.array(stepSchema).default([]),
})

// GET /automations/flows
router.get('/flows', async (req, res) => {
  const { tenantId } = req.user
  const flows = await prisma.automationFlow.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { runs: true } } },
  })
  res.json(flows)
})

// GET /automations/flows/:id
router.get('/flows/:id', async (req, res) => {
  const { tenantId } = req.user
  const flow = await prisma.automationFlow.findFirst({ where: { id: req.params.id, tenantId } })
  if (!flow) return res.status(404).json({ error: 'Fluxo não encontrado.' })
  res.json(flow)
})

// POST /automations/flows
router.post('/flows', async (req, res) => {
  const { tenantId } = req.user
  const parsed = flowSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  const flow = await prisma.automationFlow.create({ data: { tenantId, ...parsed.data } })
  res.status(201).json(flow)
})

// PATCH /automations/flows/:id — substitui nome/gatilho/passos (a lista de steps inteira, o que
// permite adicionar/remover/reordenar quantos passos e opções o usuário quiser de uma vez)
router.patch('/flows/:id', async (req, res) => {
  const { tenantId } = req.user
  const existing = await prisma.automationFlow.findFirst({ where: { id: req.params.id, tenantId } })
  if (!existing) return res.status(404).json({ error: 'Fluxo não encontrado.' })

  const parsed = patchSchema(flowSchema).safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const flow = await prisma.automationFlow.update({ where: { id: req.params.id }, data: parsed.data })
  res.json(flow)
})

// DELETE /automations/flows/:id
router.delete('/flows/:id', async (req, res) => {
  const { tenantId } = req.user
  const existing = await prisma.automationFlow.findFirst({ where: { id: req.params.id, tenantId } })
  if (!existing) return res.status(404).json({ error: 'Fluxo não encontrado.' })
  await prisma.automationFlow.delete({ where: { id: req.params.id } })
  res.status(204).send()
})

// POST /automations/flows/:id/run — dispara manualmente pra um contato/negócio específico
router.post('/flows/:id/run', async (req, res) => {
  const { tenantId } = req.user
  const flow = await prisma.automationFlow.findFirst({ where: { id: req.params.id, tenantId } })
  if (!flow) return res.status(404).json({ error: 'Fluxo não encontrado.' })

  const { contactId, dealId } = req.body
  if (!contactId && !dealId) return res.status(400).json({ error: 'Informe contactId ou dealId.' })
  if (contactId) {
    const c = await prisma.contact.findFirst({ where: { id: contactId, tenantId } })
    if (!c) return res.status(404).json({ error: 'Contato não encontrado.' })
  }
  if (dealId) {
    const d = await prisma.deal.findFirst({ where: { id: dealId, tenantId } })
    if (!d) return res.status(404).json({ error: 'Negócio não encontrado.' })
  }

  const run = await startFlowRun(flow, { contactId, dealId })
  res.status(201).json(run)
})

// GET /automations/flows/:id/runs — histórico de execuções (observabilidade)
router.get('/flows/:id/runs', async (req, res) => {
  const { tenantId } = req.user
  const flow = await prisma.automationFlow.findFirst({ where: { id: req.params.id, tenantId } })
  if (!flow) return res.status(404).json({ error: 'Fluxo não encontrado.' })

  const runs = await prisma.automationFlowRun.findMany({
    where: { flowId: flow.id, tenantId },
    orderBy: { startedAt: 'desc' },
    take: 30,
  })
  const contactIds = [...new Set(runs.map(r => r.contactId).filter(Boolean))]
  const contacts = contactIds.length ? await prisma.contact.findMany({ where: { id: { in: contactIds } }, select: { id: true, name: true } }) : []
  const contactMap = Object.fromEntries(contacts.map(c => [c.id, c.name]))
  const withNames = runs.map(r => ({ ...r, contactName: r.contactId ? contactMap[r.contactId] : null }))
  res.json(withNames)
})

// GET /automations/flows/:id/stats?days=30 — resultado do bot: quantos atendimentos, quantos o bot
// resolveu sozinho, quantos foram pra um humano e por qual caminho do menu cada pessoa terminou.
// Tudo sai do log de cada execução (menu_reply = opção escolhida, menu_back/menu_restart = voltou).
function indexSteps(steps, map = {}) {
  for (const s of steps || []) {
    map[s.id] = s
    if (s.type === 'menu') for (const o of s.config?.options || []) indexSteps(o.steps, map)
  }
  return map
}
const URL_RE = /https?:\/\/[^\s]+/i

router.get('/flows/:id/stats', async (req, res) => {
  const { tenantId } = req.user
  const flow = await prisma.automationFlow.findFirst({ where: { id: req.params.id, tenantId } })
  if (!flow) return res.status(404).json({ error: 'Fluxo não encontrado.' })
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365)
  const since = new Date(Date.now() - days * 86400000)

  const runs = await prisma.automationFlowRun.findMany({
    where: { flowId: flow.id, tenantId, startedAt: { gte: since }, status: { not: 'failed' } },
    orderBy: { startedAt: 'desc' },
    select: { contactId: true, status: true, log: true, startedAt: true },
  })
  const stepById = indexSteps(Array.isArray(flow.steps) ? flow.steps : [])
  const contactIds = [...new Set(runs.map(r => r.contactId).filter(Boolean))]
  const contacts = contactIds.length ? await prisma.contact.findMany({ where: { id: { in: contactIds }, tenantId }, select: { id: true, name: true, phone: true } }) : []
  const contactMap = Object.fromEntries(contacts.map(c => [c.id, c]))

  const totals = { atendimentos: runs.length, pessoas: contactIds.length, resolvidos: 0, humano: 0, semResposta: 0, emAndamento: 0 }
  const groups = new Map() // caminho+resultado -> grupo
  for (const run of runs) {
    const log = Array.isArray(run.log) ? run.log : []
    let path = []
    let human = false, link = null
    for (const e of log) {
      if (e.type === 'menu_reply' && e.result?.chosen) path.push(e.result.chosen)
      else if (e.type === 'menu_back') path.pop()
      else if (e.type === 'menu_restart') { path = []; link = null }
      else if (e.type === 'menu_escalated' || (e.type === 'create_task' && e.result?.done)) human = true
      else if (e.type === 'send_whatsapp' && e.result?.done) {
        const m = String(stepById[e.stepId]?.config?.message || '').match(URL_RE)
        if (m) link = m[0]
      }
    }
    const expired = log.some(e => e.type === 'menu_expired')
    let outcome
    if (['running', 'waiting', 'waiting_reply'].includes(run.status)) outcome = 'emAndamento'
    else if (human) outcome = 'humano'
    else if (expired || !path.length) outcome = 'semResposta'
    else outcome = 'resolvidos'
    totals[outcome]++

    const label = path.join(' › ') || '(não escolheu opção)'
    const key = outcome + '|' + label
    if (!groups.has(key)) groups.set(key, { caminho: label, resultado: outcome, link: null, total: 0, pessoas: [] })
    const g = groups.get(key)
    g.total++
    if (link && !g.link) g.link = link
    const c = run.contactId ? contactMap[run.contactId] : null
    if (g.pessoas.length < 50) g.pessoas.push({ nome: c?.name || c?.phone || 'Contato removido', telefone: c?.phone || null, em: run.startedAt })
  }
  const caminhos = [...groups.values()].sort((a, b) => b.total - a.total)
  res.json({ dias: days, totals, caminhos })
})

export default router
