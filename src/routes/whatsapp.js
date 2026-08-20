import { Router } from 'express'
import prisma from '../lib/prisma.js'
import { extractName, extractEmail, extractPhone, detectIntent } from '../lib/whatsappParser.js'
import { requireAuth } from '../middleware/auth.js'
import { triggerFlows, resolveMenuReply } from '../lib/automationEngine.js'

const router = Router()

// GET /whatsapp/stats — status real da integração + total de mensagens capturadas do tenant
router.get('/stats', requireAuth, async (req, res) => {
  const { tenantId } = req.user
  const [integration, messageCount] = await Promise.all([
    prisma.integration.findUnique({ where: { tenantId_type: { tenantId, type: 'whatsapp' } } }),
    prisma.message.count({ where: { contact: { tenantId } } }),
  ])
  res.json({ connected: integration?.status === 'connected', messageCount })
})

// GET /whatsapp/conversations — inbox: um item por contato, com a última mensagem e não-lidas
router.get('/conversations', requireAuth, async (req, res) => {
  const { tenantId } = req.user

  const contacts = await prisma.contact.findMany({
    where: { tenantId, messages: { some: { channel: 'whatsapp' } } },
    select: {
      id: true, name: true, phone: true,
      messages: { where: { channel: 'whatsapp' }, orderBy: { createdAt: 'desc' }, take: 1 },
    },
  })

  const unreadCounts = await prisma.message.groupBy({
    by: ['contactId'],
    where: { contact: { tenantId }, channel: 'whatsapp', direction: 'in', readAt: null },
    _count: true,
  })
  const unreadMap = Object.fromEntries(unreadCounts.map(u => [u.contactId, u._count]))

  const conversations = contacts
    .map(c => ({
      contactId: c.id,
      name: c.name,
      phone: c.phone,
      lastMessage: c.messages[0] || null,
      unreadCount: unreadMap[c.id] || 0,
    }))
    .sort((a, b) => new Date(b.lastMessage?.createdAt || 0) - new Date(a.lastMessage?.createdAt || 0))

  res.json(conversations)
})

// GET /whatsapp/conversations/:contactId/messages — thread completa; marca as recebidas como lidas
router.get('/conversations/:contactId/messages', requireAuth, async (req, res) => {
  const { tenantId } = req.user
  const contact = await prisma.contact.findFirst({ where: { id: req.params.contactId, tenantId } })
  if (!contact) return res.status(404).json({ error: 'Contato não encontrado.' })

  const messages = await prisma.message.findMany({
    where: { contactId: contact.id, channel: 'whatsapp' },
    orderBy: { createdAt: 'asc' },
  })

  await prisma.message.updateMany({
    where: { contactId: contact.id, channel: 'whatsapp', direction: 'in', readAt: null },
    data: { readAt: new Date() },
  })

  res.json({ contact: { id: contact.id, name: contact.name, phone: contact.phone }, messages })
})

// POST /whatsapp/send — manda mensagem de saída pela Evolution API da empresa
router.post('/send', requireAuth, async (req, res) => {
  const { tenantId, userId } = req.user
  const { contactId, phone, message } = req.body
  if (!message || !message.trim()) return res.status(400).json({ error: 'Mensagem obrigatória.' })

  let contact = null
  if (contactId) {
    contact = await prisma.contact.findFirst({ where: { id: contactId, tenantId } })
    if (!contact) return res.status(404).json({ error: 'Contato não encontrado.' })
  }

  const toPhone = ((contact?.phone || phone || '')).replace(/[^0-9]/g, '')
  if (!toPhone) return res.status(400).json({ error: 'Telefone do destinatário não informado.' })

  const integration = await prisma.integration.findUnique({ where: { tenantId_type: { tenantId, type: 'whatsapp' } } })
  const config = integration?.config || {}
  if (!integration || integration.status !== 'connected' || !config.apiUrl || !config.instance) {
    return res.status(400).json({ error: 'WhatsApp não conectado. Configure a Evolution API em Integrações.' })
  }

  let evoData
  try {
    const evoRes = await fetch(`${config.apiUrl.replace(/\/$/, '')}/message/sendText/${config.instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { apikey: config.apiKey } : {}) },
      body: JSON.stringify({ number: toPhone, text: message }),
    })
    evoData = await evoRes.json().catch(() => ({}))
    if (!evoRes.ok) {
      return res.status(502).json({ error: evoData?.response?.message || evoData?.error || 'A Evolution API recusou o envio.', detail: evoData })
    }
  } catch (err) {
    return res.status(502).json({ error: 'Não foi possível conectar na Evolution API. Confira a URL configurada.', detail: err.message })
  }

  // Nesse ponto a mensagem JÁ foi enviada de verdade pelo WhatsApp — se salvar o registro
  // falhar por qualquer motivo (ex: whatsappMessageId duplicado), não podemos reportar erro
  // pro usuário, senão ele reenvia a mesma mensagem achando que falhou.
  let saved
  try {
    saved = await prisma.message.create({
      data: {
        contactId: contact?.id || null,
        from: 'me',
        to: toPhone,
        body: message,
        direction: 'out',
        whatsappMessageId: evoData?.key?.id || null,
        raw: evoData,
      },
    })
  } catch (err) {
    console.error('whatsapp send: falha ao salvar registro (mensagem já foi enviada)', err.message)
    saved = { contactId: contact?.id || null, to: toPhone, body: message, direction: 'out', warning: 'Mensagem enviada, mas houve um erro ao salvar o registro no histórico.' }
  }

  if (contact) {
    await prisma.activity.create({ data: { tenantId, userId, contactId: contact.id, type: 'whatsapp', content: `WhatsApp enviado: "${message.slice(0, 80)}"` } }).catch(() => {})
  }

  res.status(201).json(saved)
})

// Webhook para receber mensagens do WhatsApp (ou adaptadores) — uma URL por empresa,
// já que cada uma conecta seu próprio número/instância da Evolution API.
router.post('/webhook/:tenantId', async (req, res) => {
  const token = process.env.WHATSAPP_TOKEN
  if (token && req.headers['x-whatsapp-token'] !== token) {
    return res.status(401).json({ error: 'Token inválido.' })
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: req.params.tenantId } })
  if (!tenant) return res.status(404).json({ error: 'Empresa não encontrada.' })

  // A Evolution manda webhook pra vários tipos de evento, não só mensagem
  // (qrcode.updated, connection.update, etc). Ignora tudo que não for mensagem de chat.
  const eventType = req.body?.event
  if (eventType && eventType !== 'messages.upsert') {
    return res.json({ ok: true, ignored: eventType })
  }

  try {
    const payload = req.body || {}
    // Evolution API (Baileys) manda um evento por webhook, com a mensagem aninhada em `data`
    const messages = Array.isArray(payload.messages)
      ? payload.messages
      : payload.data && (payload.data.key || payload.data.message)
      ? [payload.data]
      : payload.message
      ? [payload.message]
      : [payload]

    let processed = 0

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
        if (msg.buttonsResponseMessage?.selectedDisplayText) return msg.buttonsResponseMessage.selectedDisplayText
        if (msg.listResponseMessage?.title) return msg.listResponseMessage.title
      }
      if (message.content?.text) return message.content.text
      if (message.text?.body) return message.text.body
      if (message?.text?.caption) return message.text.caption
      return ''
    }

    for (const m of messages) {
      // Ignora mensagens enviadas pela própria instância (eco do que a empresa mandou)
      if (m.key?.fromMe) continue

      const from = m.from || m.sender || m.author || m.chatId || m.key?.remoteJid || ''
      const to = m.to || m.recipient || ''
      const body = getMessageText(m)
      const whatsappId = m.id || m.messageId || m.key?.id || null
      const pushName = m.pushName || null

      const phone = (from || '').replace(/[^0-9]/g, '')

      // Sem telefone não dá pra saber quem mandou — ignora em vez de criar contato em branco
      if (!phone) continue

      // Encontra ou cria contato pelo telefone, sempre dentro desta empresa
      let contact = null
      if (phone) {
        contact = await prisma.contact.findFirst({ where: { phone, tenantId: tenant.id } })
      }

      if (!contact) {
        // prioriza o nome de exibição do WhatsApp (Evolution manda em pushName); cai pro texto se não vier
        const name = pushName || extractName(body) || ''
        const email = extractEmail(body)
        const phoneExtracted = extractPhone(body) || phone
        contact = await prisma.contact.create({ data: { tenantId: tenant.id, name, phone: phoneExtracted, email: email || null } })
      } else {
        // atualiza contato se encontrarmos mais dados
        const name = pushName || extractName(body)
        const email = extractEmail(body)
        const updates = {}
        if (name && !contact.name) updates.name = name
        if (email && !contact.email) updates.email = email
        if (Object.keys(updates).length) {
          contact = await prisma.contact.update({ where: { id: contact.id }, data: updates })
        }
      }

      // idempotência: ignora mensagens já processadas
      if (whatsappId) {
        const existing = await prisma.message.findUnique({ where: { whatsappMessageId: whatsappId } }).catch(()=>null)
        if (existing) {
          processed += 1
          continue
        }
      }

      await prisma.message.create({
        data: {
          contactId: contact.id,
          from,
          to,
          body,
          direction: 'in',
          whatsappMessageId: whatsappId,
          raw: m,
        },
      })

      // Dispara os fluxos de automação com gatilho "mensagem recebida no WhatsApp"
      // (ex: responder automaticamente com uma sequência de mensagens configurada)
      // Se a pessoa está no meio de um menu, a mensagem é resposta dele, não um gatilho novo
      const consumedByMenu = await resolveMenuReply(tenant.id, contact.id, body)
      if (!consumedByMenu) {
        triggerFlows(tenant.id, 'whatsapp_message_received', { contactId: contact.id, messageBody: body })
      }

      // Detecção simples de gatilhos para criar deal/task
      const intent = detectIntent(body)
      if (intent === 'interest') {
        // garante que exista um stage para o tenant
        let stage = await prisma.stage.findFirst({ where: { tenantId: tenant.id } })
        if (!stage) {
          stage = await prisma.stage.create({ data: { tenantId: tenant.id, name: 'Novo', color: '#64748b', order: 0 } })
        }

        await prisma.deal.create({
          data: {
            tenantId: contact.tenantId || tenant.id,
            contactId: contact.id,
            stageId: stage.id,
            title: `Oportunidade - ${body.slice(0, 60)}`,
            value: 0,
          },
        })

        await prisma.task.create({
          data: {
            tenantId: contact.tenantId || tenant.id,
            userId: null,
            contactId: contact.id,
            title: `Seguir com ${contact.name || phone}`,
          },
        })
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
