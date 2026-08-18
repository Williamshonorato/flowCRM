import { Router } from 'express'
import jwt from 'jsonwebtoken'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

const MS_TENANT = process.env.MICROSOFT_TENANT_ID || 'common'
const MS_AUTH_URL = `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/authorize`
const MS_TOKEN_URL = `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`
const MS_SCOPE = 'openid email offline_access Mail.Read'

function redirectUri(req) {
  return process.env.MICROSOFT_REDIRECT_URI || `${req.protocol}://${req.get('host')}/outlook/callback`
}

// GET /outlook/connect?token=<jwt> — criar o app em https://entra.microsoft.com
// (App registrations → New registration → Web → redirect URI abaixo → Certificates & secrets → New client secret)
router.get('/connect', (req, res) => {
  const { MICROSOFT_CLIENT_ID } = process.env
  if (!MICROSOFT_CLIENT_ID) return res.status(500).json({ error: 'MICROSOFT_CLIENT_ID não configurado no .env.' })

  let payload
  try {
    payload = jwt.verify(req.query.token, process.env.JWT_SECRET)
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado.' })
  }

  const state = jwt.sign({ tenantId: payload.tenantId }, process.env.JWT_SECRET, { expiresIn: '10m' })

  const url = new URL(MS_AUTH_URL)
  url.searchParams.set('client_id', MICROSOFT_CLIENT_ID)
  url.searchParams.set('redirect_uri', redirectUri(req))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('response_mode', 'query')
  url.searchParams.set('scope', MS_SCOPE)
  url.searchParams.set('state', state)

  res.redirect(url.toString())
})

router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query
  if (error) return res.redirect('/app/crm-integracoes.html?outlook=error')

  let statePayload
  try {
    statePayload = jwt.verify(state, process.env.JWT_SECRET)
  } catch {
    return res.redirect('/app/crm-integracoes.html?outlook=error')
  }

  try {
    const tokenRes = await fetch(MS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.MICROSOFT_CLIENT_ID,
        client_secret: process.env.MICROSOFT_CLIENT_SECRET,
        redirect_uri: redirectUri(req),
        grant_type: 'authorization_code',
        scope: MS_SCOPE,
      }),
    })
    const tokens = await tokenRes.json()
    if (!tokenRes.ok) {
      console.error('outlook token exchange error', tokens)
      return res.redirect('/app/crm-integracoes.html?outlook=error')
    }

    let email = null
    try {
      const profileRes = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
      const profile = await profileRes.json()
      email = profile.mail || profile.userPrincipalName || null
    } catch {}

    await prisma.integration.upsert({
      where: { tenantId_type: { tenantId: statePayload.tenantId, type: 'outlook' } },
      create: {
        tenantId: statePayload.tenantId,
        type: 'outlook',
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

    res.redirect('/app/crm-integracoes.html?outlook=connected')
  } catch (err) {
    console.error('outlook callback error', err)
    res.redirect('/app/crm-integracoes.html?outlook=error')
  }
})

async function getValidAccessToken(integration) {
  const config = integration.config || {}
  if (config.access_token && config.expires_at > Date.now() + 60000) return config.access_token
  if (!config.refresh_token) throw new Error('Sem refresh_token — reconecte o Outlook.')

  const tokenRes = await fetch(MS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: config.refresh_token,
      client_id: process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      grant_type: 'refresh_token',
      scope: MS_SCOPE,
    }),
  })
  const tokens = await tokenRes.json()
  if (!tokenRes.ok) throw new Error(tokens.error_description || 'Falha ao renovar token do Outlook.')

  const newConfig = { ...config, access_token: tokens.access_token, refresh_token: tokens.refresh_token || config.refresh_token, expires_at: Date.now() + tokens.expires_in * 1000 }
  await prisma.integration.update({ where: { id: integration.id }, data: { config: newConfig, lastSync: new Date() } })
  return tokens.access_token
}

// GET /outlook/messages — e-mails recentes, prova de sincronização real
router.get('/messages', requireAuth, async (req, res) => {
  const integration = await prisma.integration.findUnique({ where: { tenantId_type: { tenantId: req.user.tenantId, type: 'outlook' } } })
  if (!integration || integration.status !== 'connected') return res.status(400).json({ error: 'Outlook não conectado.' })

  try {
    const accessToken = await getValidAccessToken(integration)
    const r = await fetch('https://graph.microsoft.com/v1.0/me/messages?$top=10&$select=subject,from,receivedDateTime,bodyPreview', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const data = await r.json()
    if (!r.ok) return res.status(502).json({ error: 'Erro ao consultar Outlook.', detail: data })

    const messages = (data.value || []).map(m => ({
      id: m.id, subject: m.subject, from: m.from?.emailAddress?.address, date: m.receivedDateTime, snippet: m.bodyPreview,
    }))
    res.json({ email: integration.config?.email, messages })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
