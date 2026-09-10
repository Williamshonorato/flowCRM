// Worker de disparo em massa. Roda em segundo plano: pega um Broadcast na fila,
// manda um lote de mensagens por vez com um intervalo aleatório entre cada uma
// (pra não tomar bloqueio do WhatsApp) e vai atualizando os contadores.
//
// Acionado tanto por um setInterval (app.js) quanto na hora que um disparo é
// criado (kickBroadcastWorker), mas nunca roda duas vezes ao mesmo tempo.

import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import prisma from './prisma.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, '../../public')

const BATCH_PER_TICK = 8          // mensagens por rodada
const MIN_DELAY_MS = 1500         // intervalo entre mensagens
const MAX_DELAY_MS = 4000

let running = false

const sleep = ms => new Promise(r => setTimeout(r, ms))
const jitter = () => MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS))
const digits = v => String(v || '').replace(/[^0-9]/g, '')

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || ''
}

function interpolate(template, recipient) {
  return String(template || '')
    .replace(/\{\{\s*nome\s*\}\}/gi, firstName(recipient.name))
    .replace(/\{\{\s*nome_completo\s*\}\}/gi, recipient.name || '')
}

async function getWhatsappConfig(tenantId) {
  const integration = await prisma.integration.findUnique({ where: { tenantId_type: { tenantId, type: 'whatsapp' } } })
  const config = integration?.config || {}
  const apiUrl = (config.apiUrl || process.env.EVOLUTION_API_URL || '').replace(/\/$/, '')
  const apiKey = config.apiKey || process.env.EVOLUTION_API_KEY
  const instance = config.instance || `t_${tenantId}`
  if (!integration || integration.status !== 'connected' || !apiUrl || !instance) return null
  return { apiUrl, apiKey, instance }
}

// Lê a imagem do disparo (caminho /app/uploads/...) e devolve base64 — uma vez só por disparo
async function loadImageBase64(mediaUrl) {
  if (!mediaUrl) return null
  const rel = mediaUrl.replace(/^\/app\//, '').replace(/^\//, '')
  const abs = path.join(PUBLIC_DIR, rel)
  if (!abs.startsWith(PUBLIC_DIR + path.sep)) return null
  try {
    const buf = await fs.readFile(abs)
    const ext = path.extname(abs).toLowerCase()
    const mimetype = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg'
    return { base64: buf.toString('base64'), mimetype, fileName: path.basename(abs) }
  } catch {
    return null
  }
}

async function sendToRecipient(config, recipient, message, image) {
  const number = digits(recipient.phone)
  const headers = { 'Content-Type': 'application/json', ...(config.apiKey ? { apikey: config.apiKey } : {}) }

  if (image) {
    const r = await fetch(`${config.apiUrl}/message/sendMedia/${config.instance}`, {
      method: 'POST', headers,
      body: JSON.stringify({
        number, mediatype: 'image', mimetype: image.mimetype, media: image.base64,
        fileName: image.fileName, caption: message || undefined,
      }),
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(data?.response?.message || data?.error || 'Evolution recusou a mídia')
    return data
  }

  const r = await fetch(`${config.apiUrl}/message/sendText/${config.instance}`, {
    method: 'POST', headers,
    body: JSON.stringify({ number, text: message }),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data?.response?.message || data?.error || 'Evolution recusou o envio')
  return data
}

async function finalize(broadcastId) {
  const left = await prisma.broadcastRecipient.count({ where: { broadcastId, status: { in: ['pending', 'sending'] } } })
  if (left > 0) return
  // updateMany com filtro de status: não "ressuscita" um disparo cancelado/apagado
  await prisma.broadcast.updateMany({
    where: { id: broadcastId, status: { in: ['queued', 'sending'] } },
    data: { status: 'done', finishedAt: new Date() },
  }).catch(() => {})
}

// Máximo de destinatários processados numa única chamada — bounda quanto tempo o
// worker fica "ocupado" por vez; o resto sai nas próximas rodadas.
const MAX_PER_CALL = 400

// Reserva atomicamente os próximos N destinatários pendentes (FOR UPDATE SKIP LOCKED
// + RETURNING). Isso garante que, mesmo com o worker chamado em paralelo, cada
// destinatário é enviado uma única vez.
async function claimBatch(broadcastId, n) {
  const rows = await prisma.$queryRaw`
    UPDATE "BroadcastRecipient" SET status = 'sending'
    WHERE id IN (
      SELECT id FROM "BroadcastRecipient"
      WHERE "broadcastId" = ${broadcastId} AND status = 'pending'
      ORDER BY id
      LIMIT ${n}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, "contactId", name, phone
  `
  return rows
}

async function processBroadcast(broadcast) {
  // Destrava destinatários que ficaram presos em 'sending' (ex: o processo caiu
  // no meio de um disparo). Como só roda um worker por vez, qualquer 'sending'
  // aqui é órfão.
  await prisma.broadcastRecipient.updateMany({
    where: { broadcastId: broadcast.id, status: 'sending' },
    data: { status: 'pending' },
  })

  const config = await getWhatsappConfig(broadcast.tenantId)
  if (!config) {
    await prisma.broadcastRecipient.updateMany({
      where: { broadcastId: broadcast.id, status: 'pending' },
      data: { status: 'failed', error: 'WhatsApp desconectado' },
    })
    const failed = await prisma.broadcastRecipient.count({ where: { broadcastId: broadcast.id, status: 'failed' } })
    await prisma.broadcast.update({
      where: { id: broadcast.id },
      data: { status: 'done', finishedAt: new Date(), failedCount: failed },
    })
    return
  }

  if (broadcast.status === 'queued') {
    await prisma.broadcast.update({ where: { id: broadcast.id }, data: { status: 'sending', startedAt: new Date() } })
  }

  const image = await loadImageBase64(broadcast.mediaUrl)
  let processedInCall = 0
  let consecutiveFails = 0

  // Se o disparo sumiu ou foi cancelado, devolve/limpa o lote reservado e sai.
  async function bailIfStopped() {
    const fresh = await prisma.broadcast.findUnique({ where: { id: broadcast.id }, select: { status: true } })
    if (fresh && fresh.status !== 'canceled') return false
    await prisma.broadcastRecipient.updateMany({
      where: { broadcastId: broadcast.id, status: 'sending' },
      data: { status: fresh ? 'skipped' : 'pending' },
    }).catch(() => {})
    return true
  }

  while (processedInCall < MAX_PER_CALL) {
    const batch = await claimBatch(broadcast.id, Math.min(BATCH_PER_TICK, MAX_PER_CALL - processedInCall))
    if (!batch.length) break

    for (const recipient of batch) {
      if (await bailIfStopped()) return

      const text = interpolate(broadcast.message, recipient)
      try {
        const data = await sendToRecipient(config, recipient, text, image)
        await prisma.broadcastRecipient.update({ where: { id: recipient.id }, data: { status: 'sent', sentAt: new Date() } }).catch(() => {})
        await prisma.broadcast.update({ where: { id: broadcast.id }, data: { sentCount: { increment: 1 } } }).catch(() => {})
        await prisma.message.create({
          data: {
            contactId: recipient.contactId,
            tenantId: broadcast.tenantId,
            from: 'me',
            to: digits(recipient.phone),
            body: text || '[imagem]',
            channel: 'whatsapp',
            direction: 'out',
            chatJid: `${digits(recipient.phone)}@s.whatsapp.net`,
            isGroup: false,
            mediaType: image ? 'image' : null,
            mediaUrl: image ? broadcast.mediaUrl : null,
            whatsappMessageId: data?.key?.id || null,
            raw: data,
          },
        }).catch(() => {})
        consecutiveFails = 0
        await sleep(jitter())
      } catch (err) {
        await prisma.broadcastRecipient.update({ where: { id: recipient.id }, data: { status: 'failed', error: String(err.message || err).slice(0, 240) } }).catch(() => {})
        await prisma.broadcast.update({ where: { id: broadcast.id }, data: { failedCount: { increment: 1 } } }).catch(() => {})
        consecutiveFails += 1
        if (consecutiveFails >= 10) {
          await prisma.broadcastRecipient.updateMany({
            where: { broadcastId: broadcast.id, status: { in: ['pending', 'sending'] } },
            data: { status: 'failed', error: 'Interrompido: muitas falhas seguidas (WhatsApp/Evolution indisponível)' },
          }).catch(() => {})
          const failed = await prisma.broadcastRecipient.count({ where: { broadcastId: broadcast.id, status: 'failed' } }).catch(() => 0)
          await prisma.broadcast.update({ where: { id: broadcast.id }, data: { status: 'done', finishedAt: new Date(), failedCount: failed } }).catch(() => {})
          return
        }
      }
      processedInCall += 1
    }
  }

  await finalize(broadcast.id)
}

export async function processBroadcasts() {
  if (running) return
  running = true
  try {
    const broadcast = await prisma.broadcast.findFirst({
      where: { status: { in: ['queued', 'sending'] } },
      orderBy: { createdAt: 'asc' },
    })
    if (broadcast) await processBroadcast(broadcast)
  } catch (err) {
    console.error('broadcastWorker: erro', err)
  } finally {
    running = false
  }
}

// Chamado quando um disparo novo é criado — roda já, sem esperar o próximo tick
export function kickBroadcastWorker() {
  setImmediate(() => { processBroadcasts().catch(err => console.error('broadcastWorker kick falhou', err)) })
}
