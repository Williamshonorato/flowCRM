import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import prisma from '../lib/prisma.js'

const router = Router()

const registerSchema = z.object({
  name:         z.string().min(2),
  email:        z.string().email(),
  password:     z.string().min(6),
  businessName: z.string().min(2),
  segment:      z.string().default('other'),
  plan:         z.string().default('starter'),
})

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
})

// POST /auth/register — cria tenant + admin
router.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { name, email, password, businessName, segment, plan } = parsed.data

  const existingUser = await prisma.user.findFirst({ where: { email } })
  if (existingUser) return res.status(409).json({ error: 'E-mail já cadastrado.' })

  const slug = businessName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Date.now()
  const hash = await bcrypt.hash(password, 10)

  const DEFAULT_STAGES = [
    { name: 'Novo lead', color: '#f39c12', order: 0 },
    { name: 'Em contato', color: '#2980b9', order: 1 },
    { name: 'Proposta', color: '#8e44ad', order: 2 },
    { name: 'Negociação', color: '#16a085', order: 3 },
    { name: 'Fechado', color: '#27ae60', order: 4 },
  ]

  const tenant = await prisma.tenant.create({
    data: {
      name: businessName,
      slug,
      segment,
      plan,
      users: { create: { name, email, password: hash, role: 'admin' } },
      stages: { create: DEFAULT_STAGES },
    },
    include: { users: true },
  })

  const user = tenant.users[0]
  const token = jwt.sign(
    { userId: user.id, tenantId: tenant.id, role: user.role, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN }
  )

  res.status(201).json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role }, tenant: { id: tenant.id, name: tenant.name, plan: tenant.plan } })
})

// POST /auth/login
router.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { email, password } = parsed.data
  const user = await prisma.user.findFirst({ where: { email }, include: { tenant: true } })

  if (!user || !user.active) return res.status(401).json({ error: 'Credenciais inválidas.' })
  const valid = await bcrypt.compare(password, user.password)
  if (!valid) return res.status(401).json({ error: 'Credenciais inválidas.' })

  const token = jwt.sign(
    { userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN }
  )

  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role }, tenant: { id: user.tenant.id, name: user.tenant.name, plan: user.tenant.plan } })
})

// GET /auth/me
router.get('/me', async (req, res) => {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Não autenticado.' })
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET)
    const user = await prisma.user.findUnique({ where: { id: payload.userId }, include: { tenant: true } })
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' })
    res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role }, tenant: { id: user.tenant.id, name: user.tenant.name, plan: user.tenant.plan, segment: user.tenant.segment } })
  } catch {
    res.status(401).json({ error: 'Token inválido.' })
  }
})

export default router
