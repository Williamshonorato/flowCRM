import { Router } from 'express'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import prisma from '../lib/prisma.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

// ── API KEY ───────────────────────────────────────────────────────────────────
function generateApiKey() {
  return 'fcrm_live_sk_' + crypto.randomBytes(24).toString('hex')
}

router.get('/api-key', async (req, res) => {
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
  res.json(tenant)
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
  res.json(tenant)
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

// ── EQUIPE ────────────────────────────────────────────────────────────────────
router.get('/team', async (req, res) => {
  const users = await prisma.user.findMany({ where: { tenantId: req.user.tenantId }, select: { id: true, name: true, email: true, role: true, active: true, createdAt: true } })
  res.json(users)
})

router.post('/team/invite', requireAdmin, async (req, res) => {
  const { name, email, password = 'Mudar@123', role = 'user' } = req.body
  if (!email) return res.status(400).json({ error: 'E-mail obrigatório.' })
  const existing = await prisma.user.findFirst({ where: { tenantId: req.user.tenantId, email } })
  if (existing) return res.status(409).json({ error: 'Usuário já existe.' })
  const hash = await bcrypt.hash(password, 10)
  const user = await prisma.user.create({ data: { tenantId: req.user.tenantId, name: name || email.split('@')[0], email, password: hash, role } })
  res.status(201).json({ id: user.id, name: user.name, email: user.email, role: user.role })
})

router.patch('/team/:id', requireAdmin, async (req, res) => {
  const { role, active } = req.body
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
  const { name, email, currentPassword, newPassword } = req.body
  const user = await prisma.user.findUnique({ where: { id: req.user.userId } })

  const data = {}
  if (name) data.name = name
  if (email && email !== user.email) {
    const dup = await prisma.user.findFirst({ where: { tenantId: req.user.tenantId, email } })
    if (dup) return res.status(409).json({ error: 'E-mail já em uso.' })
    data.email = email
  }
  if (newPassword) {
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
  res.json(integrations)
})

router.post('/integrations/:type', requireAdmin, async (req, res) => {
  const { config = {} } = req.body
  const integration = await prisma.integration.upsert({
    where: { tenantId_type: { tenantId: req.user.tenantId, type: req.params.type } },
    create: { tenantId: req.user.tenantId, type: req.params.type, status: 'connected', config },
    update: { status: 'connected', config, updatedAt: new Date() },
  })
  res.json(integration)
})

router.delete('/integrations/:type', requireAdmin, async (req, res) => {
  await prisma.integration.updateMany({ where: { tenantId: req.user.tenantId, type: req.params.type }, data: { status: 'disconnected', config: {} } })
  res.status(204).send()
})

export default router
