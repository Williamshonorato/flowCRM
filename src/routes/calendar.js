import { Router } from 'express'
import jwt from 'jsonwebtoken'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { sendError } from '../lib/errorPage.js'

const router = Router()

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events openid email'

function redirectUri(req) {
  return process.env.GOOGLE_CALENDAR_REDIRECT_URI || `${req.protocol}://${req.get('host')}/calendar/callback`
}

// Usa as mesmas credenciais OAuth do Gmail (mesmo projeto no Google Cloud) — só o escopo muda.
// Requer a Calendar API habilitada no mesmo projeto além da Gmail API.
router.get('/connect', (req, res) => {
  const { GOOGLE_CLIENT_ID } = process.env
  if (!GOOGLE_CLIENT_ID) return sendError(req, res, 500, 'A integração com Google Calendar ainda não está disponível por aqui.')

  let payload
  try {
    payload = jwt.verify(req.query.token, process.env.JWT_SECRET)
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado.' })
  }

  const state = jwt.sign({ tenantId: payload.tenantId }, process.env.JWT_SECRET, { expiresIn: '10m' })

  const url = new URL(GOOGLE_AUTH_URL)
  url.searchParams.set('client_id', GOOGLE_CLIENT_ID)
  url.searchParams.set('redirect_uri', redirectUri(req))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', CALENDAR_SCOPE)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('state', state)

  res.redirect(url.toString())
})

router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query
  if (error) return res.redirect('/app/crm-integracoes.html?calendar=error')

  let statePayload
  try {
    statePayload = jwt.verify(state, process.env.JWT_SECRET)
  } catch {
    return res.redirect('/app/crm-integracoes.html?calendar=error')
  }

  try {
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri(req),
        grant_type: 'authorization_code',
      }),
    })
    const tokens = await tokenRes.json()
    if (!tokenRes.ok) {
      console.error('calendar token exchange error', tokens)
      return res.redirect('/app/crm-integracoes.html?calendar=error')
    }

    let email = null
    try {
      const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
      email = (await profileRes.json()).email || null
    } catch {}

    await prisma.integration.upsert({
      where: { tenantId_type: { tenantId: statePayload.tenantId, type: 'google_calendar' } },
      create: {
        tenantId: statePayload.tenantId,
        type: 'google_calendar',
        status: 'connected',
        lastSync: new Date(),
        config: { email, access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: Date.now() + tokens.expires_in * 1000 },
      },
      update: {
        status: 'connected',
        lastSync: new Date(),
        config: { email, access_token: tokens.access_token, refresh_token: tokens.refresh_token || undefined, expires_at: Date.now() + tokens.expires_in * 1000 },
      },
    })

    res.redirect('/app/crm-integracoes.html?calendar=connected')
  } catch (err) {
    console.error('calendar callback error', err)
    res.redirect('/app/crm-integracoes.html?calendar=error')
  }
})

async function getValidAccessToken(integration) {
  const config = integration.config || {}
  if (config.access_token && config.expires_at > Date.now() + 60000) return config.access_token
  if (!config.refresh_token) throw new Error('Sem refresh_token — reconecte o Google Calendar.')

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: config.refresh_token,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  })
  const tokens = await tokenRes.json()
  if (!tokenRes.ok) throw new Error(tokens.error_description || 'Falha ao renovar token do Google Calendar.')

  const newConfig = { ...config, access_token: tokens.access_token, expires_at: Date.now() + tokens.expires_in * 1000 }
  await prisma.integration.update({ where: { id: integration.id }, data: { config: newConfig, lastSync: new Date() } })
  return tokens.access_token
}

// GET /calendar/events — próximos eventos, prova de sincronização real
router.get('/events', requireAuth, async (req, res) => {
  const integration = await prisma.integration.findUnique({ where: { tenantId_type: { tenantId: req.user.tenantId, type: 'google_calendar' } } })
  if (!integration || integration.status !== 'connected') return res.status(400).json({ error: 'Google Calendar não conectado.' })

  try {
    const accessToken = await getValidAccessToken(integration)
    const r = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=10&orderBy=startTime&singleEvents=true&timeMin=${new Date().toISOString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    )
    const data = await r.json()
    if (!r.ok) return res.status(502).json({ error: 'Erro ao consultar Google Calendar.', detail: data })
    res.json({ email: integration.config?.email, events: (data.items || []).map(e => ({ id: e.id, summary: e.summary, start: e.start, end: e.end })) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /calendar/events — cria um evento (usado quando um negócio agenda reunião no CRM)
router.post('/events', requireAuth, async (req, res) => {
  const { summary, description, startDateTime, endDateTime } = req.body
  if (!summary || !startDateTime || !endDateTime) return res.status(400).json({ error: 'summary, startDateTime e endDateTime são obrigatórios.' })

  const integration = await prisma.integration.findUnique({ where: { tenantId_type: { tenantId: req.user.tenantId, type: 'google_calendar' } } })
  if (!integration || integration.status !== 'connected') return res.status(400).json({ error: 'Google Calendar não conectado.' })

  try {
    const accessToken = await getValidAccessToken(integration)
    const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary,
        description,
        start: { dateTime: startDateTime },
        end: { dateTime: endDateTime },
      }),
    })
    const event = await r.json()
    if (!r.ok) return res.status(502).json({ error: 'Erro ao criar evento.', detail: event })
    res.status(201).json(event)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
