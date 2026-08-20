import crypto from 'crypto'
import prisma from './prisma.js'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

// Garante um access_token válido, renovando com o refresh_token se estiver expirado
export async function getValidAccessToken(integration) {
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

export function buildMimeMessage({ to, subject, htmlBody }) {
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

// Envia um e-mail de verdade pelo Gmail conectado da empresa. Usado tanto pela rota
// POST /gmail/send quanto pelo motor de automação (passo send_email).
// origin: ex. "http://localhost:3333" — usado só pra montar a URL do pixel de rastreio.
export async function sendGmailMessage({ tenantId, userId, contact, to, subject, body, origin }) {
  const toEmail = contact?.email || to
  if (!toEmail) throw new Error('E-mail do destinatário não informado.')

  const integration = await prisma.integration.findUnique({ where: { tenantId_type: { tenantId, type: 'gmail' } } })
  if (!integration || integration.status !== 'connected') throw new Error('Gmail não conectado.')

  const trackingId = crypto.randomBytes(16).toString('hex')
  const pixelUrl = `${origin}/gmail/track/${trackingId}.png`
  const htmlBody = `${body.replace(/\n/g, '<br>')}<img src="${pixelUrl}" width="1" height="1" style="display:none" alt="" />`

  const accessToken = await getValidAccessToken(integration)
  const raw = buildMimeMessage({ to: toEmail, subject, htmlBody })
  const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  })
  const sendData = await sendRes.json()
  if (!sendRes.ok) throw new Error(sendData?.error?.message || 'Gmail recusou o envio.')

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
    await prisma.activity.create({ data: { tenantId, userId: userId || null, contactId: contact.id, type: 'email', content: `E-mail enviado: "${subject}"` } }).catch(() => {})
  }

  return saved
}
