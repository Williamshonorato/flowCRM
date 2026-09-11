import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import prisma from '../lib/prisma.js'
import { requireAuth, requirePlatformRole, requirePlatformOwner } from '../middleware/auth.js'

const router = Router()

// Tenant "de casa" que hospeda as contas de quem administra a plataforma — não é uma
// empresa cliente de verdade, só o jeito de reaproveitar o mesmo login/User de sempre
// sem inventar um sistema de conta separado.
const INTERNAL_TENANT_SLUG = 'flowcrm-interno'
async function getInternalTenant() {
  return prisma.tenant.upsert({
    where: { slug: INTERNAL_TENANT_SLUG },
    update: {},
    create: { name: 'FlowCRM (interno)', slug: INTERNAL_TENANT_SLUG, segment: 'internal', plan: 'internal' },
  })
}

router.use(requireAuth, requirePlatformRole)

// GET /platform/tenants — lista todas as empresas cadastradas, com contagens básicas
router.get('/tenants', async (req, res) => {
  const tenants = await prisma.tenant.findMany({
    where: { slug: { not: INTERNAL_TENANT_SLUG } },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { users: true, contacts: true, deals: true } } },
  })
  const now = new Date()
  // "Inadimplente" é sempre derivado da data — nunca marcado à mão — pra nunca
  // ficar desatualizado por alguém esquecer de trocar o status.
  res.json(tenants.map(t => ({
    ...t,
    overdue: t.billingStatus === 'active' && !!t.nextDueDate && new Date(t.nextDueDate) < now,
  })))
})

// GET /platform/stats — visão agregada de negócio: crescimento, planos, cobrança
// e o que os clientes estão fazendo dentro do CRM deles (contatos, negócios,
// pipeline, WhatsApp conectado). Tudo cruzando TODOS os tenants, exceto o interno.
router.get('/stats', async (req, res) => {
  const now = new Date()
  const tenants = await prisma.tenant.findMany({ where: { slug: { not: INTERNAL_TENANT_SLUG } } })
  const tenantIds = tenants.map(t => t.id)

  // Novas empresas por mês (últimos 6 meses)
  const months = Array.from({ length: 6 }, (_, k) => {
    const i = 5 - k
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59)
    return { d, end }
  })
  const signupsByMonth = months.map(({ d, end }) => ({
    month: d.toLocaleString('pt-BR', { month: 'short' }),
    count: tenants.filter(t => t.createdAt >= d && t.createdAt <= end).length,
  }))

  // Empresas por plano
  const PLAN_COLOR = { starter: '#64748b', professional: '#2980b9', connected: '#8e44ad', enterprise: '#f39c12' }
  const planCounts = {}
  tenants.forEach(t => { planCounts[t.plan] = (planCounts[t.plan] || 0) + 1 })
  const planDistribution = Object.entries(planCounts).map(([plan, count]) => ({ plan, count, color: PLAN_COLOR[plan] || '#94a3b8' }))

  // Status de cobrança (mesma regra de "atrasado" do GET /tenants: sempre pela data)
  const billing = { trial: 0, ok: 0, late: 0, canceled: 0 }
  tenants.forEach(t => {
    if (t.billingStatus === 'trial') billing.trial++
    else if (t.billingStatus === 'canceled') billing.canceled++
    else billing[t.nextDueDate && new Date(t.nextDueDate) < now ? 'late' : 'ok']++
  })

  const [contactsTotal, dealsTotal, pipelineAgg, closedAgg, whatsappConnected] = tenantIds.length ? await Promise.all([
    prisma.contact.count({ where: { tenantId: { in: tenantIds } } }),
    prisma.deal.count({ where: { tenantId: { in: tenantIds } } }),
    prisma.deal.aggregate({ where: { tenantId: { in: tenantIds }, closedAt: null }, _sum: { value: true } }),
    prisma.deal.aggregate({ where: { tenantId: { in: tenantIds }, closedAt: { not: null } }, _sum: { value: true } }),
    prisma.integration.count({ where: { tenantId: { in: tenantIds }, type: 'whatsapp', status: 'connected' } }),
  ]) : [0, 0, { _sum: { value: 0 } }, { _sum: { value: 0 } }, 0]

  res.json({
    signupsByMonth,
    planDistribution,
    billing,
    business: {
      totalTenants: tenants.length,
      contactsTotal,
      dealsTotal,
      pipelineValue: Number(pipelineAgg._sum.value || 0),
      closedValue: Number(closedAgg._sum.value || 0),
      whatsappConnected,
    },
  })
})

// GET /platform/tenants/:id — detalhe de uma empresa
router.get('/tenants/:id', async (req, res) => {
  const tenant = await prisma.tenant.findUnique({
    where: { id: req.params.id },
    include: {
      users: { select: { id: true, name: true, email: true, role: true, active: true, createdAt: true } },
      _count: { select: { contacts: true, deals: true, tasks: true } },
    },
  })
  if (!tenant) return res.status(404).json({ error: 'Empresa não encontrada.' })
  res.json(tenant)
})

// PATCH /platform/tenants/:id — editar empresa: ativar/desativar, plano, cobrança
const updateTenantSchema = z.object({
  name:          z.string().min(1).optional(),
  active:        z.boolean().optional(),
  plan:          z.string().optional(),
  billingStatus: z.enum(['trial', 'active', 'canceled']).optional(),
  monthlyValue:  z.number().min(0).optional(),
  nextDueDate:   z.string().nullable().optional(), // ISO date, ou null pra limpar
})
router.patch('/tenants/:id', async (req, res) => {
  const parsed = updateTenantSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  const existing = await prisma.tenant.findUnique({ where: { id: req.params.id } })
  if (!existing) return res.status(404).json({ error: 'Empresa não encontrada.' })

  const { nextDueDate, ...rest } = parsed.data
  const tenant = await prisma.tenant.update({
    where: { id: req.params.id },
    data: { ...rest, ...(nextDueDate !== undefined && { nextDueDate: nextDueDate ? new Date(nextDueDate) : null }) },
  })
  res.json(tenant)
})

// DELETE /platform/tenants/:id — remove a empresa e todos os dados dela (cascade). Irreversível.
router.delete('/tenants/:id', async (req, res) => {
  const existing = await prisma.tenant.findUnique({ where: { id: req.params.id } })
  if (!existing) return res.status(404).json({ error: 'Empresa não encontrada.' })
  if (existing.slug === INTERNAL_TENANT_SLUG) return res.status(400).json({ error: 'Essa é a empresa interna da plataforma, não pode ser excluída.' })
  await prisma.tenant.delete({ where: { id: req.params.id } })
  res.status(204).send()
})

// POST /platform/tenants/:id/impersonate — entra na empresa vendo exatamente como o
// admin dela vê. Pega a identidade real do admin mais antigo da empresa (não inventa
// um usuário novo), então tudo que o sistema já faz com userId continua funcionando
// igual. Pra voltar, o front guarda o token original e troca de volta — não tem nada
// de especial no token de impersonação em si, ele é um login de tenant normal.
router.post('/tenants/:id/impersonate', async (req, res) => {
  const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } })
  if (!tenant) return res.status(404).json({ error: 'Empresa não encontrada.' })

  const admin = await prisma.user.findFirst({
    where: { tenantId: tenant.id, role: 'admin', active: true },
    orderBy: { createdAt: 'asc' },
  })
  if (!admin) return res.status(404).json({ error: 'Essa empresa não tem nenhum admin ativo pra representar.' })

  console.log(`[platform] ${req.user.email} entrou como admin de "${tenant.name}" (${admin.email})`)

  const token = jwt.sign(
    { userId: admin.id, tenantId: tenant.id, role: admin.role, email: admin.email },
    process.env.JWT_SECRET,
    { expiresIn: '2h' } // sessão de impersonação é curta de propósito
  )
  res.json({ token, tenant: { id: tenant.id, name: tenant.name } })
})

// ── Gerenciar quem mais tem acesso ao painel da plataforma — só o owner ──────
router.get('/admins', requirePlatformOwner, async (req, res) => {
  const admins = await prisma.user.findMany({
    where: { platformRole: { not: null } },
    select: { id: true, name: true, email: true, platformRole: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })
  res.json(admins)
})

const createAdminSchema = z.object({
  name:     z.string().min(2),
  email:    z.string().email(),
  password: z.string().min(6),
  platformRole: z.enum(['owner', 'superadmin']).default('superadmin'),
})
router.post('/admins', requirePlatformOwner, async (req, res) => {
  const parsed = createAdminSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  const { name, email, password, platformRole } = parsed.data

  const existing = await prisma.user.findFirst({ where: { email } })
  if (existing) return res.status(409).json({ error: 'E-mail já cadastrado.' })

  const internalTenant = await getInternalTenant()
  const hash = await bcrypt.hash(password, 10)
  const admin = await prisma.user.create({
    data: { tenantId: internalTenant.id, name, email, password: hash, role: 'admin', platformRole },
  })
  res.status(201).json({ id: admin.id, name: admin.name, email: admin.email, platformRole: admin.platformRole })
})

router.delete('/admins/:id', requirePlatformOwner, async (req, res) => {
  if (req.params.id === req.user.userId) return res.status(400).json({ error: 'Você não pode remover seu próprio acesso.' })
  const existing = await prisma.user.findUnique({ where: { id: req.params.id } })
  if (!existing || !existing.platformRole) return res.status(404).json({ error: 'Admin não encontrado.' })
  await prisma.user.update({ where: { id: req.params.id }, data: { platformRole: null } })
  res.status(204).send()
})

export default router
