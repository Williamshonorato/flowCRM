import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import prisma from '../lib/prisma.js'
import { requirePlatformAdmin, requireOwner } from '../middleware/platformAuth.js'

const router = Router()

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
})

// POST /platform/login — login do superadmin/owner, separado do login de tenant
router.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  const { email, password } = parsed.data

  const admin = await prisma.platformAdmin.findUnique({ where: { email } })
  if (!admin) return res.status(401).json({ error: 'E-mail ou senha inválidos.' })

  const ok = await bcrypt.compare(password, admin.password)
  if (!ok) return res.status(401).json({ error: 'E-mail ou senha inválidos.' })

  const token = jwt.sign(
    { adminId: admin.id, role: admin.role, email: admin.email },
    process.env.PLATFORM_JWT_SECRET,
    { expiresIn: '7d' }
  )
  res.json({ token, admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role } })
})

router.use(requirePlatformAdmin)

// GET /platform/me
router.get('/me', (req, res) => {
  res.json(req.admin)
})

// GET /platform/tenants — lista todas as empresas cadastradas no sistema, com contagens básicas
router.get('/tenants', async (req, res) => {
  const tenants = await prisma.tenant.findMany({
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { users: true, contacts: true, deals: true } } },
  })
  res.json(tenants)
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

// PATCH /platform/tenants/:id — ativar/desativar ou mudar plano de uma empresa
const updateTenantSchema = z.object({
  active: z.boolean().optional(),
  plan:   z.string().optional(),
})
router.patch('/tenants/:id', async (req, res) => {
  const parsed = updateTenantSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  const existing = await prisma.tenant.findUnique({ where: { id: req.params.id } })
  if (!existing) return res.status(404).json({ error: 'Empresa não encontrada.' })
  const tenant = await prisma.tenant.update({ where: { id: req.params.id }, data: parsed.data })
  res.json(tenant)
})

// DELETE /platform/tenants/:id — remove a empresa e todos os dados dela (cascade). Irreversível.
router.delete('/tenants/:id', async (req, res) => {
  const existing = await prisma.tenant.findUnique({ where: { id: req.params.id } })
  if (!existing) return res.status(404).json({ error: 'Empresa não encontrada.' })
  await prisma.tenant.delete({ where: { id: req.params.id } })
  res.status(204).send()
})

// ── Gerenciar outros admins da plataforma — só o owner pode ──────────────────
router.use('/admins', requireOwner)

router.get('/admins', async (req, res) => {
  const admins = await prisma.platformAdmin.findMany({
    select: { id: true, name: true, email: true, role: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })
  res.json(admins)
})

const createAdminSchema = z.object({
  name:     z.string().min(2),
  email:    z.string().email(),
  password: z.string().min(6),
  role:     z.enum(['owner', 'superadmin']).default('superadmin'),
})
router.post('/admins', async (req, res) => {
  const parsed = createAdminSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  const { name, email, password, role } = parsed.data

  const existing = await prisma.platformAdmin.findUnique({ where: { email } })
  if (existing) return res.status(409).json({ error: 'E-mail já cadastrado.' })

  const hash = await bcrypt.hash(password, 10)
  const admin = await prisma.platformAdmin.create({ data: { name, email, password: hash, role } })
  res.status(201).json({ id: admin.id, name: admin.name, email: admin.email, role: admin.role })
})

router.delete('/admins/:id', async (req, res) => {
  if (req.params.id === req.admin.adminId) return res.status(400).json({ error: 'Você não pode remover sua própria conta.' })
  const existing = await prisma.platformAdmin.findUnique({ where: { id: req.params.id } })
  if (!existing) return res.status(404).json({ error: 'Admin não encontrado.' })
  await prisma.platformAdmin.delete({ where: { id: req.params.id } })
  res.status(204).send()
})

export default router
