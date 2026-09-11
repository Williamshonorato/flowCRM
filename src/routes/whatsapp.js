import { Router } from 'express'
import multer from 'multer'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import prisma from '../lib/prisma.js'
import { extractName, extractEmail, extractPhone } from '../lib/whatsappParser.js'
import { requireAuth } from '../middleware/auth.js'
import { triggerFlows, resolveMenuReply } from '../lib/automationEngine.js'

const router = Router()

// ── Evolution API compartilhado ──────────────────────────────────────────────
// Um único Evolution API roda na nossa infra, hospedando uma "instância" (sessão
// de WhatsApp) por empresa. O cliente nunca vê URL/API key da Evolution — só
// escaneia o QR code do próprio número dele.
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WA_UPLOAD_ROOT = path.join(__dirname, '../../public/uploads/whatsapp')

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } })

function instanceNameFor(tenantId) {
  return `t_${tenantId}`
}

function evoHeaders() {
  return { 'Content-Type': 'application/json', apikey: EVOLUTION_API_KEY }
}

// Só os dígitos de um telefone/jid ("55 (11) 9..." ou "5511...@s.whatsapp.net")
function digits(v) {
  return String(v || '').replace(/[^0-9]/g, '')
}

// É jid de grupo? (Baileys usa "<id>@g.us" pra grupo e "<numero>@s.whatsapp.net" pra pessoa)
function isGroupJid(jid) {
  return String(jid || '').endsWith('@g.us')
}

// Extensão a partir do mimetype, pra salvar a mídia com um nome plausível
const EXT_BY_MIME = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'audio/ogg': '.ogg', 'audio/oga': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/mp4': '.m4a',
  'audio/aac': '.aac', 'audio/wav': '.wav', 'audio/webm': '.webm', 'audio/x-m4a': '.m4a',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/3gpp': '.3gp', 'video/quicktime': '.mov',
  'application/pdf': '.pdf',
}
function extForMime(mime) {
  if (EXT_BY_MIME[mime]) return EXT_BY_MIME[mime]
  const sub = String(mime || '').split('/')[1]
  return sub ? '.' + sub.split(';')[0].replace(/[^a-z0-9]/gi, '') : '.bin'
}
function mediaKindForMime(mime) {
  const m = String(mime || '')
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('audio/')) return 'audio'
  if (m.startsWith('video/')) return 'video'
  return 'document'
}

// Grava um Buffer de mídia em disco (por tenant) e devolve a URL servível
async function saveMedia(tenantId, buffer, mime) {
  const dir = path.join(WA_UPLOAD_ROOT, tenantId)
  await fs.mkdir(dir, { recursive: true })
  const filename = randomUUID() + extForMime(mime)
  await fs.writeFile(path.join(dir, filename), buffer)
  return `/app/uploads/whatsapp/${tenantId}/${filename}`
}

// Config da Evolution pro tenant: instância compartilhada por padrão, ou a
// Evolution própria do cliente se ele configurou apiUrl/apiKey manualmente antes.
function evoConfigFrom(integration, tenantId) {
  const config = integration?.config || {}
  return {
    apiUrl: (config.apiUrl || EVOLUTION_API_URL || '').replace(/\/$/, ''),
    apiKey: config.apiKey || EVOLUTION_API_KEY,
    instance: config.instance || instanceNameFor(tenantId),
  }
}

// GET /whatsapp/stats — status real da integração + total de mensagens capturadas do tenant
router.get('/stats', requireAuth, async (req, res) => {
  const { tenantId } = req.user
  const [integration, messageCount] = await Promise.all([
    prisma.integration.findUnique({ where: { tenantId_type: { tenantId, type: 'whatsapp' } } }),
    prisma.message.count({ where: { OR: [{ contact: { tenantId } }, { tenantId }] } }),
  ])
  res.json({ connected: integration?.status === 'connected', messageCount })
})

// GET /whatsapp/conversations — inbox: um item por chat (pessoa OU grupo), com a
// última mensagem e a contagem de não-lidas.
router.get('/conversations', requireAuth, async (req, res) => {
  const { tenantId } = req.user

  // ── Conversas diretas (1 contato) ──────────────────────────────────────────
  const contacts = await prisma.contact.findMany({
    where: { tenantId, messages: { some: { channel: 'whatsapp', isGroup: false } } },
    select: {
      id: true, name: true, phone: true,
      messages: { where: { channel: 'whatsapp', isGroup: false }, orderBy: { createdAt: 'desc' }, take: 1 },
    },
  })

  const directUnread = await prisma.message.groupBy({
    by: ['contactId'],
    where: { contact: { tenantId }, channel: 'whatsapp', isGroup: false, direction: 'in', readAt: null },
    _count: true,
  })
  const directUnreadMap = Object.fromEntries(directUnread.map(u => [u.contactId, u._count]))

  const direct = contacts.map(c => ({
    type: 'direct',
    contactId: c.id,
    chatJid: c.messages[0]?.chatJid || (c.phone ? `${digits(c.phone)}@s.whatsapp.net` : null),
    name: c.name,
    phone: c.phone,
    isGroup: false,
    lastMessage: c.messages[0] || null,
    unreadCount: directUnreadMap[c.id] || 0,
  }))

  // ── Conversas de grupo (chatJid @g.us, sem contato) ────────────────────────
  const groupJids = await prisma.message.groupBy({
    by: ['chatJid'],
    where: { tenantId, channel: 'whatsapp', isGroup: true },
    _max: { createdAt: true },
  })

  const groups = await Promise.all(groupJids.filter(g => g.chatJid).map(async (g) => {
    const [last, unreadCount] = await Promise.all([
      prisma.message.findFirst({ where: { tenantId, chatJid: g.chatJid }, orderBy: { createdAt: 'desc' } }),
      prisma.message.count({ where: { tenantId, chatJid: g.chatJid, direction: 'in', readAt: null } }),
    ])
    return {
      type: 'group',
      contactId: null,
      chatJid: g.chatJid,
      name: last?.chatName || 'Grupo',
      phone: null,
      isGroup: true,
      lastMessage: last,
      unreadCount,
    }
  }))

  const conversations = [...direct, ...groups]
    .sort((a, b) => new Date(b.lastMessage?.createdAt || 0) - new Date(a.lastMessage?.createdAt || 0))

  res.json(conversations)
})

// GET /whatsapp/conversations/:contactId/messages — thread de uma conversa DIRETA
router.get('/conversations/:contactId/messages', requireAuth, async (req, res) => {
  const { tenantId } = req.user
  const contact = await prisma.contact.findFirst({ where: { id: req.params.contactId, tenantId } })
  if (!contact) return res.status(404).json({ error: 'Contato não encontrado.' })

  const messages = await prisma.message.findMany({
    where: { contactId: contact.id, channel: 'whatsapp', isGroup: false },
    orderBy: { createdAt: 'asc' },
  })

  await prisma.message.updateMany({
    where: { contactId: contact.id, channel: 'whatsapp', direction: 'in', readAt: null },
    data: { readAt: new Date() },
  })

  res.json({
    type: 'direct',
    contact: { id: contact.id, name: contact.name, phone: contact.phone },
    messages,
  })
})

// GET /whatsapp/groups/:jid/messages — thread de um GRUPO (jid vem url-encoded)
router.get('/groups/:jid/messages', requireAuth, async (req, res) => {
  const { tenantId } = req.user
  const jid = decodeURIComponent(req.params.jid)
  if (!isGroupJid(jid)) return res.status(400).json({ error: 'Jid de grupo inválido.' })

  const messages = await prisma.message.findMany({
    where: { tenantId, chatJid: jid, channel: 'whatsapp' },
    orderBy: { createdAt: 'asc' },
  })
  if (!messages.length) return res.status(404).json({ error: 'Grupo não encontrado.' })

  await prisma.message.updateMany({
    where: { tenantId, chatJid: jid, direction: 'in', readAt: null },
    data: { readAt: new Date() },
  })

  // Participantes = quem já apareceu enviando mensagem no grupo
  const seen = new Map()
  for (const m of messages) {
    if (m.direction === 'in' && m.senderPhone && !seen.has(m.senderPhone)) {
      seen.set(m.senderPhone, m.senderName || m.senderPhone)
    }
  }
  const participants = [...seen].map(([phone, name]) => ({ phone, name }))
  const name = [...messages].reverse().find(m => m.chatName)?.chatName || 'Grupo'

  res.json({ type: 'group', group: { jid, name, participants }, messages })
})

// POST /whatsapp/connect — cria (se ainda não existir) a instância dessa empresa no
// Evolution API compartilhado e devolve o QR code pra ela escanear. Pode ser chamado
// de novo a qualquer momento pra pegar um QR mais recente (o anterior expira sozinho).
router.post('/connect', requireAuth, async (req, res) => {
  const { tenantId } = req.user
  const { phone } = req.body || {}

  if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
    return res.status(500).json({ error: 'Integração de WhatsApp não configurada no servidor. Fale com o suporte.' })
  }

  const instance = instanceNameFor(tenantId)
  // NUNCA usar req.protocol/req.get('host') aqui — o Evolution API roda num container
  // Docker separado; "127.0.0.1" do ponto de vista dele não chega no nosso app (já
  // vimos esse exato bug antes com o redirect do Google OAuth). Precisa ser a URL
  // pública de verdade, que o container alcança pela internet.
  const webhookUrl = `${(process.env.APP_PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')}/whatsapp/webhook/${tenantId}`

  // Tenta criar a instância — se já existir, a Evolution retorna erro, que a gente
  // ignora de propósito: o /instance/connect logo abaixo funciona igual pra uma
  // instância nova ou já existente, então só a criação falhando não deve travar o fluxo.
  try {
    await fetch(`${EVOLUTION_API_URL}/instance/create`, {
      method: 'POST',
      headers: evoHeaders(),
      body: JSON.stringify({
        instanceName: instance,
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS',
        webhook: { url: webhookUrl, byEvents: false, base64: true, events: ['MESSAGES_UPSERT'] },
      }),
    })
  } catch (err) {
    console.error('whatsapp connect: falha ao criar instância (pode já existir)', err.message)
  }

  let qrData
  try {
    const qrRes = await fetch(`${EVOLUTION_API_URL}/instance/connect/${instance}`, { headers: evoHeaders() })
    qrData = await qrRes.json()
    if (!qrRes.ok) throw new Error(qrData?.message || 'Evolution API recusou a conexão.')
  } catch (err) {
    return res.status(502).json({ error: 'Não foi possível gerar o QR code agora. Tente de novo em alguns segundos.', detail: err.message })
  }

  await prisma.integration.upsert({
    where: { tenantId_type: { tenantId, type: 'whatsapp' } },
    create: { tenantId, type: 'whatsapp', status: 'connecting', config: { instance, phone: phone || null, provider: 'evolution' } },
    update: { status: 'connecting', config: { instance, phone: phone || null, provider: 'evolution' } },
  })

  res.json({ qrcode: qrData?.base64 || null, pairingCode: qrData?.pairingCode || null })
})

// GET /whatsapp/status — o frontend consulta em loop enquanto espera o escaneamento;
// assim que o WhatsApp conectar de verdade, marca a integração como "connected".
router.get('/status', requireAuth, async (req, res) => {
  const { tenantId } = req.user
  if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) return res.json({ status: 'unknown' })

  const instance = instanceNameFor(tenantId)
  try {
    const r = await fetch(`${EVOLUTION_API_URL}/instance/connectionState/${instance}`, { headers: evoHeaders() })
    const data = await r.json()
    const state = data?.instance?.state || 'close' // 'open' | 'connecting' | 'close'

    if (state === 'open') {
      await prisma.integration.updateMany({ where: { tenantId, type: 'whatsapp' }, data: { status: 'connected' } })
    }
    res.json({ status: state })
  } catch (err) {
    res.json({ status: 'unknown' })
  }
})

// POST /whatsapp/disconnect — encerra a sessão do WhatsApp DE VERDADE (desvincula o
// celular em "Aparelhos conectados") e marca a integração como desconectada. Sem isso,
// "Desconectar" só mudava o status no nosso banco e o celular seguia linkado à Evolution.
router.post('/disconnect', requireAuth, async (req, res) => {
  const { tenantId } = req.user
  const instance = instanceNameFor(tenantId)

  if (EVOLUTION_API_URL && EVOLUTION_API_KEY) {
    try {
      await fetch(`${EVOLUTION_API_URL}/instance/logout/${instance}`, { method: 'DELETE', headers: evoHeaders() })
    } catch (err) {
      console.error('whatsapp disconnect: falha no logout da Evolution', err.message)
    }
  }

  await prisma.integration.updateMany({
    where: { tenantId, type: 'whatsapp' },
    data: { status: 'disconnected', config: {} },
  })

  res.json({ ok: true })
})

// Resolve o alvo do envio a partir de { contactId } ou { chatJid }.
// Devolve { number, contact, isGroup, chatJid } — `number` é o que vai no campo
// "number" da Evolution (aceita tanto telefone quanto jid completo).
async function resolveSendTarget({ tenantId, contactId, chatJid, phone }) {
  if (chatJid && isGroupJid(chatJid)) {
    return { number: chatJid, contact: null, isGroup: true, chatJid }
  }
  let contact = null
  if (contactId) {
    contact = await prisma.contact.findFirst({ where: { id: contactId, tenantId } })
    if (!contact) return { error: 'Contato não encontrado.' }
  }
  const toPhone = digits(contact?.phone || phone || (chatJid ? chatJid.split('@')[0] : ''))
  if (!toPhone) return { error: 'Telefone do destinatário não informado.' }
  return { number: toPhone, contact, isGroup: false, chatJid: chatJid || `${toPhone}@s.whatsapp.net` }
}

// POST /whatsapp/send — mensagem de TEXTO de saída (pessoa ou grupo)
router.post('/send', requireAuth, async (req, res) => {
  const { tenantId, userId } = req.user
  const { contactId, phone, chatJid, message } = req.body
  if (!message || !message.trim()) return res.status(400).json({ error: 'Mensagem obrigatória.' })

  const target = await resolveSendTarget({ tenantId, contactId, chatJid, phone })
  if (target.error) return res.status(target.error === 'Contato não encontrado.' ? 404 : 400).json({ error: target.error })

  const integration = await prisma.integration.findUnique({ where: { tenantId_type: { tenantId, type: 'whatsapp' } } })
  const { apiUrl, apiKey, instance } = evoConfigFrom(integration, tenantId)
  if (!integration || integration.status !== 'connected' || !apiUrl || !instance) {
    return res.status(400).json({ error: 'WhatsApp não conectado. Conecte o número em Integrações.' })
  }

  let evoData
  try {
    const evoRes = await fetch(`${apiUrl}/message/sendText/${instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { apikey: apiKey } : {}) },
      body: JSON.stringify({ number: target.number, text: message }),
    })
    evoData = await evoRes.json().catch(() => ({}))
    if (!evoRes.ok) {
      return res.status(502).json({ error: evoData?.response?.message || evoData?.error || 'A Evolution API recusou o envio.', detail: evoData })
    }
  } catch (err) {
    return res.status(502).json({ error: 'Não foi possível conectar na Evolution API. Confira a URL configurada.', detail: err.message })
  }

  // Nesse ponto a mensagem JÁ foi enviada — se salvar o registro falhar, não podemos
  // reportar erro pro usuário, senão ele reenvia achando que falhou.
  let saved
  try {
    saved = await prisma.message.create({
      data: {
        contactId: target.contact?.id || null,
        tenantId,
        from: 'me',
        to: target.number,
        body: message,
        direction: 'out',
        chatJid: target.chatJid,
        isGroup: target.isGroup,
        whatsappMessageId: evoData?.key?.id || null,
        raw: evoData,
      },
    })
  } catch (err) {
    console.error('whatsapp send: falha ao salvar registro (mensagem já foi enviada)', err.message)
    saved = { contactId: target.contact?.id || null, to: target.number, body: message, direction: 'out', warning: 'Mensagem enviada, mas houve um erro ao salvar o registro no histórico.' }
  }

  if (target.contact) {
    await prisma.activity.create({ data: { tenantId, userId, contactId: target.contact.id, type: 'whatsapp', content: `WhatsApp enviado: "${message.slice(0, 80)}"` } }).catch(() => {})
  }

  res.status(201).json(saved)
})

// POST /whatsapp/send-media — envia imagem / áudio / vídeo / documento (multipart, campo "file").
// Body: contactId OU chatJid, opcional caption. Áudio vira nota de voz (PTT).
router.post('/send-media', requireAuth, upload.single('file'), async (req, res) => {
  const { tenantId, userId } = req.user
  const { contactId, phone, chatJid, caption } = req.body
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' })

  const target = await resolveSendTarget({ tenantId, contactId, chatJid, phone })
  if (target.error) return res.status(target.error === 'Contato não encontrado.' ? 404 : 400).json({ error: target.error })

  const integration = await prisma.integration.findUnique({ where: { tenantId_type: { tenantId, type: 'whatsapp' } } })
  const { apiUrl, apiKey, instance } = evoConfigFrom(integration, tenantId)
  if (!integration || integration.status !== 'connected' || !apiUrl || !instance) {
    return res.status(400).json({ error: 'WhatsApp não conectado. Conecte o número em Integrações.' })
  }

  const mime = req.file.mimetype || 'application/octet-stream'
  const kind = mediaKindForMime(mime)
  const base64 = req.file.buffer.toString('base64')
  const evoAuth = { 'Content-Type': 'application/json', ...(apiKey ? { apikey: apiKey } : {}) }

  let evoData
  try {
    let evoRes
    if (kind === 'audio') {
      evoRes = await fetch(`${apiUrl}/message/sendWhatsAppAudio/${instance}`, {
        method: 'POST', headers: evoAuth,
        body: JSON.stringify({ number: target.number, audio: base64 }),
      })
    } else {
      evoRes = await fetch(`${apiUrl}/message/sendMedia/${instance}`, {
        method: 'POST', headers: evoAuth,
        body: JSON.stringify({
          number: target.number,
          mediatype: kind, // image | video | document
          mimetype: mime,
          media: base64,
          fileName: req.file.originalname || `arquivo${extForMime(mime)}`,
          caption: caption || undefined,
        }),
      })
    }
    evoData = await evoRes.json().catch(() => ({}))
    if (!evoRes.ok) {
      return res.status(502).json({ error: evoData?.response?.message || evoData?.error || 'A Evolution API recusou o envio da mídia.', detail: evoData })
    }
  } catch (err) {
    return res.status(502).json({ error: 'Não foi possível enviar a mídia pela Evolution API.', detail: err.message })
  }

  let mediaUrl = null
  try { mediaUrl = await saveMedia(tenantId, req.file.buffer, mime) } catch (err) {
    console.error('whatsapp send-media: falha ao salvar cópia local (já foi enviado)', err.message)
  }

  const labels = { image: '[imagem]', audio: '[áudio]', video: '[vídeo]', document: '[documento]' }
  let saved
  try {
    saved = await prisma.message.create({
      data: {
        contactId: target.contact?.id || null,
        tenantId,
        from: 'me',
        to: target.number,
        body: caption || labels[kind] || '[mídia]',
        direction: 'out',
        chatJid: target.chatJid,
        isGroup: target.isGroup,
        mediaType: kind,
        mediaUrl,
        whatsappMessageId: evoData?.key?.id || null,
        raw: evoData,
      },
    })
  } catch (err) {
    console.error('whatsapp send-media: falha ao salvar registro (mídia já foi enviada)', err.message)
    saved = { contactId: target.contact?.id || null, to: target.number, body: labels[kind], direction: 'out', mediaType: kind, mediaUrl, warning: 'Mídia enviada, mas houve um erro ao salvar o registro.' }
  }

  if (target.contact) {
    await prisma.activity.create({ data: { tenantId, userId, contactId: target.contact.id, type: 'whatsapp', content: `WhatsApp enviado: ${labels[kind] || '[mídia]'}` } }).catch(() => {})
  }

  res.status(201).json(saved)
})

// ── Webhook (Evolution → nós) ────────────────────────────────────────────────

// Puxa o texto de uma mensagem, seja qual for o formato que a Evolution mandar
function getMessageText(message) {
  if (!message) return ''
  if (typeof message === 'string') return message
  if (message.body) return message.body
  if (message.text) return typeof message.text === 'string' ? message.text : message.text?.body || ''
  if (message.message) {
    const msg = message.message
    if (typeof msg === 'string') return msg
    if (msg.conversation) return msg.conversation
    if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text
    if (msg.imageMessage?.caption) return msg.imageMessage.caption
    if (msg.videoMessage?.caption) return msg.videoMessage.caption
    if (msg.documentMessage?.caption) return msg.documentMessage.caption
    if (msg.buttonsResponseMessage?.selectedDisplayText) return msg.buttonsResponseMessage.selectedDisplayText
    if (msg.listResponseMessage?.title) return msg.listResponseMessage.title
  }
  if (message.content?.text) return message.content.text
  if (message.text?.body) return message.text.body
  if (message?.text?.caption) return message.text.caption
  return ''
}

// Detecta mídia na mensagem recebida e devolve { kind, mimetype, node } ou null
function detectIncomingMedia(m) {
  const msg = m?.message || {}
  const map = [
    ['imageMessage', 'image'],
    ['audioMessage', 'audio'],
    ['videoMessage', 'video'],
    ['documentMessage', 'document'],
    ['documentWithCaptionMessage', 'document'],
    ['stickerMessage', 'sticker'],
  ]
  for (const [key, kind] of map) {
    const node = key === 'documentWithCaptionMessage' ? msg[key]?.message?.documentMessage : msg[key]
    if (node) return { kind, mimetype: node.mimetype || '', node }
  }
  return null
}

// Baixa a mídia recebida: usa o base64 que a Evolution já manda (webhook base64:true)
// e, se não vier, pede pra Evolution converter com getBase64FromMediaMessage.
async function fetchIncomingMediaBuffer(m, evo) {
  const inline = m?.message?.base64 || m?.base64 || m?.mediaBase64
  if (inline) { try { return Buffer.from(inline, 'base64') } catch {} }
  if (!evo?.apiUrl) return null
  try {
    const r = await fetch(`${evo.apiUrl}/chat/getBase64FromMediaMessage/${evo.instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(evo.apiKey ? { apikey: evo.apiKey } : {}) },
      body: JSON.stringify({ message: { key: m.key }, convertToMp4: false }),
    })
    const data = await r.json().catch(() => ({}))
    if (data?.base64) return Buffer.from(data.base64, 'base64')
  } catch (err) {
    console.error('whatsapp webhook: falha ao baixar mídia', err.message)
  }
  return null
}

// Assunto do grupo — cacheado em memória pra não bater na Evolution a cada mensagem
// Acha o contato comparando só os dígitos do telefone. Contato importado de
// planilha ou cadastrado manualmente pode ter o telefone formatado
// ("(41) 96543-2109"), enquanto o WhatsApp manda só dígitos ("41965432109") —
// comparar string exata perdia esses contatos e criava um duplicado a cada
// mensagem nova de alguém que já existia no CRM.
async function findContactByPhone(tenantId, phoneDigits) {
  if (!phoneDigits) return null
  const rows = await prisma.$queryRaw`
    SELECT id FROM "Contact"
    WHERE "tenantId" = ${tenantId} AND regexp_replace(phone, '[^0-9]', '', 'g') = ${phoneDigits}
    LIMIT 1
  `
  if (!rows.length) return null
  return prisma.contact.findUnique({ where: { id: rows[0].id } })
}

// Palavra-chave (cadastrada em Pipeline → 🔑 Palavras-chave / Configurações) que
// bate com a mensagem, se houver. Sem nenhuma cadastrada devolve null — não cria
// negócio sozinho até a empresa configurar pelo menos uma.
async function matchDealKeyword(tenantId, body) {
  if (!body) return null
  const keywords = await prisma.dealKeyword.findMany({ where: { tenantId }, select: { keyword: true } })
  if (!keywords.length) return null
  const lc = body.toLowerCase()
  const hit = keywords.find(k => lc.includes(k.keyword))
  return hit ? hit.keyword : null
}

const groupNameCache = new Map() // jid -> { name, at }
async function resolveGroupName(jid, evo) {
  const hit = groupNameCache.get(jid)
  if (hit && Date.now() - hit.at < 3600_000) return hit.name
  let name = null
  if (evo?.apiUrl) {
    try {
      const r = await fetch(`${evo.apiUrl}/group/findGroupInfos/${evo.instance}?groupJid=${encodeURIComponent(jid)}`, {
        headers: { ...(evo.apiKey ? { apikey: evo.apiKey } : {}) },
      })
      const data = await r.json().catch(() => ({}))
      name = data?.subject || data?.groupMetadata?.subject || null
    } catch { /* silencioso */ }
  }
  groupNameCache.set(jid, { name, at: Date.now() })
  return name
}

// Webhook para receber mensagens do WhatsApp — uma URL por empresa.
router.post('/webhook/:tenantId', async (req, res) => {
  const token = process.env.WHATSAPP_TOKEN
  if (token && req.headers['x-whatsapp-token'] !== token) {
    return res.status(401).json({ error: 'Token inválido.' })
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: req.params.tenantId } })
  if (!tenant) return res.status(404).json({ error: 'Empresa não encontrada.' })

  const eventType = req.body?.event
  if (eventType && eventType !== 'messages.upsert') {
    return res.json({ ok: true, ignored: eventType })
  }

  const integration = await prisma.integration.findUnique({ where: { tenantId_type: { tenantId: tenant.id, type: 'whatsapp' } } }).catch(() => null)
  const evo = evoConfigFrom(integration, tenant.id)

  try {
    const payload = req.body || {}
    const messages = Array.isArray(payload.messages)
      ? payload.messages
      : payload.data && (payload.data.key || payload.data.message)
      ? [payload.data]
      : payload.message
      ? [payload.message]
      : [payload]

    let processed = 0

    for (const m of messages) {
      // Ignora o eco das mensagens enviadas pela própria empresa
      if (m.key?.fromMe) continue

      const remoteJid = m.from || m.key?.remoteJid || m.chatId || ''
      const group = isGroupJid(remoteJid)
      // Em grupo, quem enviou é `participant`; em conversa direta é o próprio remoteJid
      const senderJid = group ? (m.key?.participant || m.participant || '') : remoteJid
      const senderPhone = digits(senderJid)
      const pushName = m.pushName || null
      const body = getMessageText(m)
      const whatsappId = m.id || m.messageId || m.key?.id || null
      const to = m.to || m.recipient || ''

      if (!senderPhone) continue // sem remetente identificável, ignora

      // idempotência: não processa a mesma mensagem duas vezes
      if (whatsappId) {
        const existing = await prisma.message.findUnique({ where: { whatsappMessageId: whatsappId } }).catch(() => null)
        if (existing) { processed += 1; continue }
      }

      // Mídia (se houver)
      let mediaType = null, mediaUrl = null
      const media = detectIncomingMedia(m)
      if (media) {
        mediaType = media.kind
        const buf = await fetchIncomingMediaBuffer(m, evo)
        if (buf) { try { mediaUrl = await saveMedia(tenant.id, buf, media.mimetype || 'application/octet-stream') } catch {} }
      }

      // ── GRUPO: não cria contato, guarda a conversa por chatJid ───────────────
      if (group) {
        const chatName = await resolveGroupName(remoteJid, evo)
        await prisma.message.create({
          data: {
            contactId: null,
            tenantId: tenant.id,
            from: senderJid,
            to,
            body: body || (mediaType ? `[${mediaType}]` : ''),
            direction: 'in',
            chatJid: remoteJid,
            isGroup: true,
            chatName,
            senderPhone,
            senderName: pushName,
            mediaType,
            mediaUrl,
            whatsappMessageId: whatsappId,
            raw: m,
          },
        })
        processed += 1
        continue
      }

      // ── DIRETO: acha ou cria contato pelo telefone, dentro da empresa ────────
      let contact = await findContactByPhone(tenant.id, senderPhone)
      if (!contact) {
        const name = pushName || extractName(body) || ''
        const email = extractEmail(body)
        const phoneExtracted = extractPhone(body) || senderPhone
        contact = await prisma.contact.create({ data: { tenantId: tenant.id, name, phone: phoneExtracted, email: email || null } })
      } else {
        const name = pushName || extractName(body)
        const email = extractEmail(body)
        const updates = {}
        if (name && !contact.name) updates.name = name
        if (email && !contact.email) updates.email = email
        if (Object.keys(updates).length) {
          contact = await prisma.contact.update({ where: { id: contact.id }, data: updates })
        }
      }

      await prisma.message.create({
        data: {
          contactId: contact.id,
          tenantId: tenant.id,
          from: remoteJid,
          to,
          body: body || (mediaType ? `[${mediaType}]` : ''),
          direction: 'in',
          chatJid: remoteJid,
          isGroup: false,
          mediaType,
          mediaUrl,
          whatsappMessageId: whatsappId,
          raw: m,
        },
      })

      // Automações com gatilho "mensagem recebida no WhatsApp"
      const consumedByMenu = await resolveMenuReply(tenant.id, contact.id, body)
      if (!consumedByMenu) {
        triggerFlows(tenant.id, 'whatsapp_message_received', { contactId: contact.id, messageBody: body })
      }

      // Cria negócio automático SÓ quando a mensagem bate com uma palavra-chave
      // cadastrada pela empresa (Pipeline → 🔑 Palavras-chave). Sem nenhuma
      // cadastrada, não cria nada sozinho — antes era um regex fixo ("quero",
      // "preço"...) que confundia mensagem de grupo/propaganda com interesse de
      // verdade e enchia o "Novo" de negócio-lixo.
      const matchedKeyword = await matchDealKeyword(tenant.id, body)
      if (matchedKeyword) {
        // Não cria de novo se esse contato já tem um negócio em aberto — sem isso,
        // cada mensagem nova da mesma pessoa virava um negócio a mais.
        const hasOpenDeal = await prisma.deal.findFirst({ where: { tenantId: tenant.id, contactId: contact.id, closedAt: null } })
        if (!hasOpenDeal) {
          let stage = await prisma.stage.findFirst({ where: { tenantId: tenant.id }, orderBy: { order: 'asc' } })
          if (!stage) {
            stage = await prisma.stage.create({ data: { tenantId: tenant.id, name: 'Novo', color: '#64748b', order: 0 } })
          }
          await prisma.deal.create({
            data: { tenantId: tenant.id, contactId: contact.id, stageId: stage.id, title: `Oportunidade - ${body.slice(0, 60)}`, value: 0 },
          })
          await prisma.task.create({
            data: { tenantId: tenant.id, userId: null, contactId: contact.id, title: `Seguir com ${contact.name || senderPhone} — mencionou "${matchedKeyword}"` },
          })
        }
      }

      processed += 1
    }

    res.json({ ok: true, processed })
  } catch (err) {
    console.error('whatsapp webhook error', err)
    res.status(500).json({ error: 'Erro interno', detail: err.message })
  }
})

export default router
