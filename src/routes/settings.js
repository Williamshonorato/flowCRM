import { Router } from 'express'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import prisma from '../lib/prisma.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

// Segredos guardados no `config` de uma integração (refresh_token do Gmail/Outlook/Calendar,
// senha do banco externo, apiKey da Evolution...) NUNCA saem pela API: só uma allowlist do
// que a interface mostra. O backend continua lendo o config completo direto do banco.
const PUBLIC_CONFIG_KEYS = ['email', 'phone', 'provider']
function publicIntegration(i) {
  const config = {}
  for (const k of PUBLIC_CONFIG_KEYS) if (i.config?.[k] !== undefined) config[k] = i.config[k]
  return { ...i, config }
}

// A API key dá acesso total à conta — só admin enxerga (ou gera) a chave.
function publicTenant(tenant, role) {
  if (role === 'admin') return tenant
  const { apiKey, ...rest } = tenant
  return rest
}

// ── API KEY ───────────────────────────────────────────────────────────────────
function generateApiKey() {
  return 'fcrm_live_sk_' + crypto.randomBytes(24).toString('hex')
}

router.get('/api-key', requireAdmin, async (req, res) => {
  let tenant = await prisma.tenant.findUnique({ where: { id: req.user.tenantId } })
  if (!tenant.apiKey) {
    tenant = await prisma.tenant.update({ where: { id: tenant.id }, data: { apiKey: generateApiKey() } })
  }
  res.json({ apiKey: tenant.apiKey })
})

router.post('/api-key/regenerate', requireAdmin, async (req, res) => {
  const tenant = await prisma.tenant.update({ where: { id: req.user.tenantId }, data: { apiKey: generateApiKey() } })
  res.json({ apiKey: tenant.apiKey })
})

// ── NEGÓCIO ──────────────────────────────────────────────────────────────────
router.get('/business', async (req, res) => {
  const tenant = await prisma.tenant.findUnique({ where: { id: req.user.tenantId } })
  res.json(publicTenant(tenant, req.user.role))
})

router.patch('/business', requireAdmin, async (req, res) => {
  const schema = z.object({
    name: z.string().optional(), segment: z.string().optional(),
    cnpj: z.string().optional(), phone: z.string().optional(),
    address: z.string().optional(), website: z.string().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  const tenant = await prisma.tenant.update({ where: { id: req.user.tenantId }, data: parsed.data })
  res.json(publicTenant(tenant, req.user.role))
})

// ── PIPELINE STAGES ───────────────────────────────────────────────────────────
router.get('/stages', async (req, res) => {
  const stages = await prisma.stage.findMany({ where: { tenantId: req.user.tenantId }, orderBy: { order: 'asc' } })
  res.json(stages)
})

router.post('/stages', requireAdmin, async (req, res) => {
  const { name, color = '#64748b' } = req.body
  if (!name) return res.status(400).json({ error: 'Nome obrigatório.' })
  const count = await prisma.stage.count({ where: { tenantId: req.user.tenantId } })
  const stage = await prisma.stage.create({ data: { tenantId: req.user.tenantId, name, color, order: count } })
  res.status(201).json(stage)
})

router.patch('/stages/:id', requireAdmin, async (req, res) => {
  const { name, color, order } = req.body
  const stage = await prisma.stage.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } })
  if (!stage) return res.status(404).json({ error: 'Estágio não encontrado.' })
  const updated = await prisma.stage.update({ where: { id: req.params.id }, data: { ...(name && { name }), ...(color && { color }), ...(order !== undefined && { order }) } })
  res.json(updated)
})

router.delete('/stages/:id', requireAdmin, async (req, res) => {
  const stage = await prisma.stage.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } })
  if (!stage) return res.status(404).json({ error: 'Estágio não encontrado.' })
  const dealsInStage = await prisma.deal.count({ where: { stageId: req.params.id } })
  if (dealsInStage > 0) return res.status(409).json({ error: `Estágio possui ${dealsInStage} negócio(s). Mova-os antes de excluir.` })
  await prisma.stage.delete({ where: { id: req.params.id } })
  res.status(204).send()
})

// ── CUSTOM FIELDS ─────────────────────────────────────────────────────────────
router.get('/fields', async (req, res) => {
  const fields = await prisma.customField.findMany({ where: { tenantId: req.user.tenantId }, orderBy: { order: 'asc' } })
  res.json(fields)
})

router.post('/fields', requireAdmin, async (req, res) => {
  const { name, type = 'text', required = false } = req.body
  if (!name) return res.status(400).json({ error: 'Nome obrigatório.' })
  const count = await prisma.customField.count({ where: { tenantId: req.user.tenantId } })
  const field = await prisma.customField.create({ data: { tenantId: req.user.tenantId, name, type, required, order: count } })
  res.status(201).json(field)
})

router.delete('/fields/:id', requireAdmin, async (req, res) => {
  const field = await prisma.customField.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } })
  if (!field) return res.status(404).json({ error: 'Campo não encontrado.' })
  await prisma.customField.delete({ where: { id: req.params.id } })
  res.status(204).send()
})

// ── PALAVRAS-CHAVE DE NEGÓCIO ─────────────────────────────────────────────────
// Controla quando uma mensagem de WhatsApp vira negócio automático no pipeline
// (ver POST /whatsapp/webhook/:tenantId). Sem nenhuma cadastrada, nada é criado
// sozinho — é opt-in de propósito.
router.get('/deal-keywords', async (req, res) => {
  const keywords = await prisma.dealKeyword.findMany({ where: { tenantId: req.user.tenantId }, orderBy: { createdAt: 'asc' } })
  res.json(keywords)
})

router.post('/deal-keywords', requireAdmin, async (req, res) => {
  const keyword = String(req.body?.keyword || '').trim().toLowerCase()
  if (!keyword) return res.status(400).json({ error: 'Informe uma palavra-chave.' })
  if (keyword.length > 60) return res.status(400).json({ error: 'Palavra-chave muito longa.' })
  try {
    const created = await prisma.dealKeyword.create({ data: { tenantId: req.user.tenantId, keyword } })
    res.status(201).json(created)
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Essa palavra-chave já está cadastrada.' })
    throw err
  }
})

router.delete('/deal-keywords/:id', requireAdmin, async (req, res) => {
  const existing = await prisma.dealKeyword.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } })
  if (!existing) return res.status(404).json({ error: 'Palavra-chave não encontrada.' })
  await prisma.dealKeyword.delete({ where: { id: existing.id } })
  res.status(204).send()
})

// ── EQUIPE ────────────────────────────────────────────────────────────────────
router.get('/team', async (req, res) => {
  const users = await prisma.user.findMany({ where: { tenantId: req.user.tenantId }, select: { id: true, name: true, email: true, role: true, active: true, createdAt: true } })
  res.json(users)
})

const ROLES = ['admin', 'user', 'viewer']
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)

router.post('/team/invite', requireAdmin, async (req, res) => {
  const { name, role = 'user' } = req.body
  const email = String(req.body.email || '').trim().toLowerCase()
  if (!email || !emailOk(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' })
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Papel inválido.' })
  // E-mail é único no sistema inteiro (o login não sabe de qual empresa a pessoa é)
  const existing = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } })
  if (existing) return res.status(409).json({ error: 'Esse e-mail já está cadastrado.' })
  // Senha temporária ALEATÓRIA (antes era "Mudar@123" pra todo mundo). Vai na resposta uma
  // única vez, pra o admin repassar; a pessoa deve trocar em Configurações → Minha conta.
  const password = req.body.password && String(req.body.password).length >= 6 ? String(req.body.password) : crypto.randomBytes(9).toString('base64url')
  const hash = await bcrypt.hash(password, 10)
  try {
    const user = await prisma.user.create({ data: { tenantId: req.user.tenantId, name: name || email.split('@')[0], email, password: hash, role } })
    res.status(201).json({ id: user.id, name: user.name, email: user.email, role: user.role, temporaryPassword: password })
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Esse e-mail já está cadastrado.' })
    throw err
  }
})

router.patch('/team/:id', requireAdmin, async (req, res) => {
  const { role, active } = req.body
  if (role !== undefined && !ROLES.includes(role)) return res.status(400).json({ error: 'Papel inválido.' })
  if (req.params.id === req.user.userId) return res.status(400).json({ error: 'Você não pode alterar seu próprio papel.' })
  const user = await prisma.user.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } })
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' })
  const updated = await prisma.user.update({ where: { id: req.params.id }, data: { ...(role && { role }), ...(active !== undefined && { active }) }, select: { id: true, name: true, email: true, role: true, active: true } })
  res.json(updated)
})

router.delete('/team/:id', requireAdmin, async (req, res) => {
  if (req.params.id === req.user.userId) return res.status(400).json({ error: 'Você não pode remover a si mesmo.' })
  const user = await prisma.user.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } })
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' })
  await prisma.user.delete({ where: { id: req.params.id } })
  res.status(204).send()
})

// ── MINHA CONTA ───────────────────────────────────────────────────────────────
router.get('/account', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.userId }, select: { id: true, name: true, email: true, role: true } })
  res.json(user)
})

router.patch('/account', async (req, res) => {
  const { name, currentPassword, newPassword } = req.body
  const email = req.body.email ? String(req.body.email).trim().toLowerCase() : undefined
  if (!req.user.userId) return res.status(403).json({ error: 'Essa ação exige um usuário logado (não vale com API key).' })
  const user = await prisma.user.findUnique({ where: { id: req.user.userId } })

  const data = {}
  if (name) data.name = name
  if (email && email !== user.email.toLowerCase()) {
    if (!emailOk(email)) return res.status(400).json({ error: 'E-mail inválido.' })
    // único no sistema todo (não só na empresa) — senão o unique do banco estourava com 500
    const dup = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' }, NOT: { id: user.id } } })
    if (dup) return res.status(409).json({ error: 'E-mail já em uso.' })
    data.email = email
  }
  if (newPassword) {
    if (String(newPassword).length < 6) return res.status(400).json({ error: 'A nova senha precisa ter pelo menos 6 caracteres.' })
    if (!currentPassword) return res.status(400).json({ error: 'Senha atual obrigatória.' })
    const valid = await bcrypt.compare(currentPassword, user.password)
    if (!valid) return res.status(401).json({ error: 'Senha atual incorreta.' })
    data.password = await bcrypt.hash(newPassword, 10)
  }

  const updated = await prisma.user.update({ where: { id: req.user.userId }, data, select: { id: true, name: true, email: true, role: true } })
  res.json(updated)
})

// ── INTEGRAÇÕES ───────────────────────────────────────────────────────────────
router.get('/integrations', async (req, res) => {
  const integrations = await prisma.integration.findMany({ where: { tenantId: req.user.tenantId } })
  res.json(integrations.map(publicIntegration))
})

router.post('/integrations/:type', requireAdmin, async (req, res) => {
  const { config = {} } = req.body
  const integration = await prisma.integration.upsert({
    where: { tenantId_type: { tenantId: req.user.tenantId, type: req.params.type } },
    create: { tenantId: req.user.tenantId, type: req.params.type, status: 'connected', config },
    update: { status: 'connected', config, updatedAt: new Date() },
  })
  res.json(publicIntegration(integration))
})

router.delete('/integrations/:type', requireAdmin, async (req, res) => {
  await prisma.integration.updateMany({ where: { tenantId: req.user.tenantId, type: req.params.type }, data: { status: 'disconnected', config: {} } })
  res.status(204).send()
})

export default router
