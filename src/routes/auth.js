import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import prisma from '../lib/prisma.js'
import { sendError } from '../lib/errorPage.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'

const router = Router()

// E-mail sem diferenciar maiúsculas: "Ana@x.com" e "ana@x.com" são a MESMA conta (antes eram
// duas contas diferentes, e quem digitava com outra caixa não conseguia entrar).
const byEmail = (email) => ({ email: { equals: String(email).trim(), mode: 'insensitive' } })

// Limite de tentativas de login por e-mail (em memória): 10 falhas em 15 min bloqueiam o
// e-mail por esse período. Sem isso dava pra tentar senhas à vontade.
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_MAX_FAILS = 10
const loginFails = new Map() // email -> { count, firstAt }
function loginBlocked(email) {
  const e = loginFails.get(email)
  if (!e) return false
  if (Date.now() - e.firstAt > LOGIN_WINDOW_MS) { loginFails.delete(email); return false }
  return e.count >= LOGIN_MAX_FAILS
}
function registerLoginFail(email) {
  const e = loginFails.get(email)
  if (!e || Date.now() - e.firstAt > LOGIN_WINDOW_MS) loginFails.set(email, { count: 1, firstAt: Date.now() })
  else e.count++
  if (loginFails.size > 5000) for (const [k, v] of loginFails) if (Date.now() - v.firstAt > LOGIN_WINDOW_MS) loginFails.delete(k)
}

const registerSchema = z.object({
  name:         z.string().min(2),
  email:        z.string().email(),
  password:     z.string().min(6),
  businessName: z.string().min(2),
  segment:      z.string().default('other'),
  // Só os planos à venda; o cliente não escolhe texto livre (antes qualquer string virava o plano).
  // Starter/Profissional seguem existindo pra contas antigas e o painel da plataforma ainda
  // consegue atribuí-los; o cadastro público só oferece estes dois.
  plan:         z.enum(['connected', 'enterprise']).default('connected'),
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

  const existingUser = await prisma.user.findFirst({ where: byEmail(email) })
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

  let tenant
  try {
    tenant = await prisma.tenant.create({
      data: {
        name: businessName,
        slug,
        segment,
        plan,
        users: { create: { name, email: email.trim().toLowerCase(), password: hash, role: 'admin' } },
        stages: { create: DEFAULT_STAGES },
      },
      include: { users: true },
    })
  } catch (err) {
    // dois cadastros simultâneos com o mesmo e-mail: o unique do banco barra o segundo
    if (err.code === 'P2002') return res.status(409).json({ error: 'E-mail já cadastrado.' })
    throw err
  }

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
  const emailKey = email.trim().toLowerCase()
  if (loginBlocked(emailKey)) return res.status(429).json({ error: 'Muitas tentativas de login. Aguarde alguns minutos e tente de novo.' })

  const user = await prisma.user.findFirst({ where: byEmail(email), include: { tenant: true } })

  if (!user || !user.active) { registerLoginFail(emailKey); return res.status(401).json({ error: 'Credenciais inválidas.' }) }
  const valid = await bcrypt.compare(password, user.password)
  if (!valid) { registerLoginFail(emailKey); return res.status(401).json({ error: 'Credenciais inválidas.' }) }
  // suspensão só é revelada a quem provou saber a senha (antes qualquer um descobria que o e-mail existia)
  if (!user.tenant.active) return res.status(403).json({ error: 'Essa empresa está com o acesso suspenso. Fale com o suporte.' })
  loginFails.delete(emailKey)

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
  if (!GOOGLE_CLIENT_ID) return sendError(req, res, 500, 'O login com Google ainda não está disponível por aqui.')

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
    const st = jwt.verify(state, process.env.JWT_SECRET)
    if (st.purpose !== 'login') throw new Error('state inválido') // só o state deste fluxo vale
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
    const user = await prisma.user.findFirst({ where: byEmail(profile.email), include: { tenant: true } })
    if (!user || !user.active) return res.redirect('/app/crm-login.html?google=no_account')
    if (!user.tenant.active) return res.redirect('/app/crm-login.html?google=suspended')

    const loginToken = jwt.sign(
      { userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email, platformRole: user.platformRole || undefined },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    )
    // token no FRAGMENTO (#), não na query: fragmento não vai pra servidor, logs nem Referer
    res.redirect(`/app/crm-google-callback.html#token=${loginToken}`)
  } catch (err) {
    console.error('google login callback error', err)
    res.redirect('/app/crm-login.html?google=error')
  }
})

// POST /auth/oauth-ticket — ticket curto pra iniciar a conexão de Gmail/Calendar/Outlook
// (vai na URL do redirect pro provedor; ver verifyConnectToken). Só admin conecta integração.
router.post('/oauth-ticket', requireAuth, requireAdmin, (req, res) => {
  const ticket = jwt.sign({ tenantId: req.user.tenantId, userId: req.user.userId, purpose: 'oauth-connect' }, process.env.JWT_SECRET, { expiresIn: '2m' })
  res.json({ ticket })
})

// GET /auth/me
router.get('/me', async (req, res) => {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Não autenticado.' })
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET)
    const user = await prisma.user.findUnique({ where: { id: payload.userId }, include: { tenant: true } })
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' })
    // mesmas regras do requireAuth: conta desativada / empresa suspensa não valem mais
    if (!user.active) return res.status(401).json({ error: 'Token inválido.' })
    if (!user.tenant.active) return res.status(403).json({ error: 'Essa empresa está com o acesso suspenso.' })
    res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role, platformRole: user.platformRole }, tenant: { id: user.tenant.id, name: user.tenant.name, plan: user.tenant.plan, segment: user.tenant.segment } })
  } catch {
    res.status(401).json({ error: 'Token inválido.' })
  }
})

export default router
