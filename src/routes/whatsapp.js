import { Router } from 'express'
import prisma from '../lib/prisma.js'
import { extractName, extractEmail, extractPhone, detectIntent } from '../lib/whatsappParser.js'
import { requireAuth } from '../middleware/auth.js'

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

// Webhook para receber mensagens do WhatsApp (ou adaptadores)
router.post('/webhook', async (req, res) => {
  const token = process.env.WHATSAPP_TOKEN
  if (token && req.headers['x-whatsapp-token'] !== token) {
    return res.status(401).json({ error: 'Token inválido.' })
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

      // Encontra ou cria contato pelo telefone
      let contact = null
      if (phone) {
        contact = await prisma.contact.findFirst({ where: { phone: phone } })
      }
      // Determina tenant padrão (cria um se necessário)
      let tenant = await prisma.tenant.findFirst()
      if (!tenant) {
        tenant = await prisma.tenant.create({
          data: {
            name: 'DEFAULT',
            slug: 'default-' + Date.now(),
            segment: 'other',
            stages: { create: [{ name: 'Novo', color: '#64748b', order: 0 }] },
          },
        })
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
