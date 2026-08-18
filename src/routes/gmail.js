import { Router } from 'express'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send openid email'

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

function buildMimeMessage({ to, subject, htmlBody }) {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`
  const message = [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'Content-Type: text/html; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    htmlBody,
  ].join('\r\n')
  return Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// POST /gmail/send — manda e-mail de verdade pelo Gmail da empresa, com pixel de rastreio de abertura
router.post('/send', requireAuth, async (req, res) => {
  const { tenantId, userId } = req.user
  const { contactId, to, subject, body } = req.body
  if (!subject || !body) return res.status(400).json({ error: 'Assunto e corpo são obrigatórios.' })

  let contact = null
  if (contactId) {
    contact = await prisma.contact.findFirst({ where: { id: contactId, tenantId } })
    if (!contact) return res.status(404).json({ error: 'Contato não encontrado.' })
  }
  const toEmail = contact?.email || to
  if (!toEmail) return res.status(400).json({ error: 'E-mail do destinatário não informado.' })

  const integration = await prisma.integration.findUnique({ where: { tenantId_type: { tenantId, type: 'gmail' } } })
  if (!integration || integration.status !== 'connected') {
    return res.status(400).json({ error: 'Gmail não conectado. Conecte em Integrações.' })
  }

  const trackingId = crypto.randomBytes(16).toString('hex')
  const pixelUrl = `${req.protocol}://${req.get('host')}/gmail/track/${trackingId}.png`
  const htmlBody = `${body.replace(/\n/g, '<br>')}<img src="${pixelUrl}" width="1" height="1" style="display:none" alt="" />`

  let sendData
  try {
    const accessToken = await getValidAccessToken(integration)
    const raw = buildMimeMessage({ to: toEmail, subject, htmlBody })
    const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    })
    sendData = await sendRes.json()
    if (!sendRes.ok) {
      return res.status(502).json({ error: sendData?.error?.message || 'Gmail recusou o envio.', detail: sendData })
    }
  } catch (err) {
    return res.status(502).json({ error: err.message })
  }

  // Nesse ponto o e-mail JÁ foi enviado de verdade — falha ao salvar o registro não pode virar erro pro usuário
  let saved
  try {
    saved = await prisma.message.create({
      data: {
        contactId: contact?.id || null,
        from: integration.config?.email || 'me',
        to: toEmail,
        subject,
        body,
        channel: 'email',
        direction: 'out',
        trackingId,
        raw: sendData,
      },
    })
  } catch (err) {
    console.error('gmail send: falha ao salvar registro (e-mail já foi enviado)', err.message)
    saved = { contactId: contact?.id || null, to: toEmail, subject, body, channel: 'email', direction: 'out', warning: 'E-mail enviado, mas houve um erro ao salvar o registro.' }
  }

  if (contact) {
    await prisma.activity.create({ data: { tenantId, userId, contactId: contact.id, type: 'email', content: `E-mail enviado: "${subject}"` } }).catch(() => {})
  }

  res.status(201).json(saved)
})

// 1x1 GIF transparente usado como pixel de rastreio
const TRACKING_PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')

// GET /gmail/track/:trackingId.png — sem auth (o cliente de e-mail carrega isso sem token)
router.get('/track/:trackingId.png', (req, res) => {
  const { trackingId } = req.params
  prisma.message.updateMany({ where: { trackingId, openedAt: null }, data: { openedAt: new Date() } }).catch(() => {})
  res.set('Content-Type', 'image/gif')
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate')
  res.send(TRACKING_PIXEL)
})

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
