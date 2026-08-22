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
  if (!user.tenant.active) return res.status(403).json({ error: 'Essa empresa está com o acesso suspenso. Fale com o suporte.' })
  const valid = await bcrypt.compare(password, user.password)
  if (!valid) return res.status(401).json({ error: 'Credenciais inválidas.' })

  const token = jwt.sign(
    { userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email, platformRole: user.platformRole || undefined },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN }
  )

  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, platformRole: user.platformRole }, tenant: { id: user.tenant.id, name: user.tenant.name, plan: user.tenant.plan } })
})

// ── "Entrar com Google" — login pra quem já tem conta, não cria conta nova.  ──
// Separado do fluxo de /gmail/connect: aquele pede acesso à caixa de entrada de um
// tenant já logado; este só confirma "quem é você" pra logar, sem nenhum escopo do Gmail.
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const LOGIN_SCOPE = 'openid email profile'

function googleLoginRedirectUri(req) {
  return process.env.GOOGLE_LOGIN_REDIRECT_URI || `${req.protocol}://${req.get('host')}/auth/google/callback`
}

// GET /auth/google — inicia o login (não precisa estar autenticado, é o próprio login)
router.get('/google', (req, res) => {
  const { GOOGLE_CLIENT_ID } = process.env
  if (!GOOGLE_CLIENT_ID) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID não configurado no .env.' })

  const state = jwt.sign({ purpose: 'login' }, process.env.JWT_SECRET, { expiresIn: '10m' })

  const url = new URL(GOOGLE_AUTH_URL)
  url.searchParams.set('client_id', GOOGLE_CLIENT_ID)
  url.searchParams.set('redirect_uri', googleLoginRedirectUri(req))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', LOGIN_SCOPE)
  url.searchParams.set('state', state)
  res.redirect(url.toString())
})

// GET /auth/google/callback — o Google volta pra cá com ?code=...&state=...
router.get('/google/callback', async (req, res) => {
  const { code, state, error } = req.query
  if (error) return res.redirect('/app/crm-login.html?google=error')

  try {
    jwt.verify(state, process.env.JWT_SECRET)
  } catch {
    return res.redirect('/app/crm-login.html?google=error')
  }

  try {
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: googleLoginRedirectUri(req),
        grant_type: 'authorization_code',
      }),
    })
    const tokens = await tokenRes.json()
    if (!tokenRes.ok) {
      console.error('google login token exchange error', tokens)
      return res.redirect('/app/crm-login.html?google=error')
    }

    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    const profile = await profileRes.json()
    if (!profile.email) return res.redirect('/app/crm-login.html?google=error')

    // Só loga quem já tem conta — "Entrar com Google" não cria empresa nova
    // (isso pede nome da empresa/segmento, que o Google não manda).
    const user = await prisma.user.findFirst({ where: { email: profile.email }, include: { tenant: true } })
    if (!user || !user.active) return res.redirect('/app/crm-login.html?google=no_account')
    if (!user.tenant.active) return res.redirect('/app/crm-login.html?google=suspended')

    const loginToken = jwt.sign(
      { userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email, platformRole: user.platformRole || undefined },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    )
    res.redirect(`/app/crm-google-callback.html?token=${loginToken}`)
  } catch (err) {
    console.error('google login callback error', err)
    res.redirect('/app/crm-login.html?google=error')
  }
})

// GET /auth/me
router.get('/me', async (req, res) => {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Não autenticado.' })
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET)
    const user = await prisma.user.findUnique({ where: { id: payload.userId }, include: { tenant: true } })
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' })
    res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role, platformRole: user.platformRole }, tenant: { id: user.tenant.id, name: user.tenant.name, plan: user.tenant.plan, segment: user.tenant.segment } })
  } catch {
    res.status(401).json({ error: 'Token inválido.' })
  }
})

export default router
