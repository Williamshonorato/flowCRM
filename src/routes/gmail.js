import { Router } from 'express'
import jwt from 'jsonwebtoken'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly openid email'

function redirectUri(req) {
  return process.env.GOOGLE_REDIRECT_URI || `${req.protocol}://${req.get('host')}/gmail/callback`
}

// GET /gmail/connect?token=<jwt> — inicia o fluxo OAuth. Recebe o token via query
// porque o navegador vai ser redirecionado pro Google (não dá pra mandar header Authorization num redirect).
router.get('/connect', (req, res) => {
  const { GOOGLE_CLIENT_ID } = process.env
  if (!GOOGLE_CLIENT_ID) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID não configurado no .env.' })

  let payload
  try {
    payload = jwt.verify(req.query.token, process.env.JWT_SECRET)
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado.' })
  }

  // state carrega o tenantId assinado, pra sabermos de quem é a conexão quando o Google chamar o callback
  const state = jwt.sign({ tenantId: payload.tenantId }, process.env.JWT_SECRET, { expiresIn: '10m' })

  const url = new URL(GOOGLE_AUTH_URL)
  url.searchParams.set('client_id', GOOGLE_CLIENT_ID)
  url.searchParams.set('redirect_uri', redirectUri(req))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', GMAIL_SCOPE)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('state', state)

  res.redirect(url.toString())
})

// GET /gmail/callback — o Google volta pra cá com ?code=...&state=...
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query
  if (error) return res.redirect('/app/crm-integracoes.html?gmail=error')

  let statePayload
  try {
    statePayload = jwt.verify(state, process.env.JWT_SECRET)
  } catch {
    return res.redirect('/app/crm-integracoes.html?gmail=error')
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
      console.error('gmail token exchange error', tokens)
      return res.redirect('/app/crm-integracoes.html?gmail=error')
    }

    // busca o e-mail conectado, só pra exibir na tela quem está sincronizado
    let email = null
    try {
      const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
      const profile = await profileRes.json()
      email = profile.email || null
    } catch {}

    await prisma.integration.upsert({
      where: { tenantId_type: { tenantId: statePayload.tenantId, type: 'gmail' } },
      create: {
        tenantId: statePayload.tenantId,
        type: 'gmail',
        status: 'connected',
        lastSync: new Date(),
        config: {
          email,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: Date.now() + tokens.expires_in * 1000,
        },
      },
      update: {
        status: 'connected',
        lastSync: new Date(),
        config: {
          email,
          access_token: tokens.access_token,
          // o Google só manda refresh_token na primeira autorização (prompt=consent garante isso,
          // mas se por algum motivo não vier, mantém o que já tínhamos salvo)
          refresh_token: tokens.refresh_token || undefined,
          expires_at: Date.now() + tokens.expires_in * 1000,
        },
      },
    })

    res.redirect('/app/crm-integracoes.html?gmail=connected')
  } catch (err) {
    console.error('gmail callback error', err)
    res.redirect('/app/crm-integracoes.html?gmail=error')
  }
})

// Garante um access_token válido, renovando com o refresh_token se estiver expirado
async function getValidAccessToken(integration) {
  const config = integration.config || {}
  if (config.access_token && config.expires_at > Date.now() + 60000) {
    return config.access_token
  }
  if (!config.refresh_token) throw new Error('Sem refresh_token — reconecte o Gmail.')

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
  if (!tokenRes.ok) throw new Error(tokens.error_description || 'Falha ao renovar token do Gmail.')

  const newConfig = { ...config, access_token: tokens.access_token, expires_at: Date.now() + tokens.expires_in * 1000 }
  await prisma.integration.update({ where: { id: integration.id }, data: { config: newConfig, lastSync: new Date() } })
  return tokens.access_token
}

// GET /gmail/messages — lista os e-mails recentes, prova de que a sincronização funciona de verdade
router.get('/messages', requireAuth, async (req, res) => {
  const integration = await prisma.integration.findUnique({
    where: { tenantId_type: { tenantId: req.user.tenantId, type: 'gmail' } },
  })
  if (!integration || integration.status !== 'connected') {
    return res.status(400).json({ error: 'Gmail não conectado.' })
  }

  try {
    const accessToken = await getValidAccessToken(integration)
    const listRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const list = await listRes.json()
    if (!listRes.ok) return res.status(502).json({ error: 'Erro ao consultar Gmail.', detail: list })

    const messages = await Promise.all(
      (list.messages || []).map(async (m) => {
        const r = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        )
        const msg = await r.json()
        const headers = Object.fromEntries((msg.payload?.headers || []).map(h => [h.name, h.value]))
        return { id: msg.id, snippet: msg.snippet, from: headers.From, subject: headers.Subject, date: headers.Date }
      })
    )

    res.json({ email: integration.config?.email, messages })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
