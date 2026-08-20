import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import prisma from './prisma.js'
import { sendGmailMessage } from './gmailSender.js'

const APP_ORIGIN = `http://localhost:${process.env.PORT || 3333}`
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOADS_DIR = path.join(__dirname, '../../public/uploads')
const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' }

// Executa um passo do fluxo. Cada tipo sabe seu próprio formato de "config" —
// isso é o que permite passos e opções ilimitados sem mexer no schema.
async function executeStep(step, ctx) {
  const { tenantId, userId, contact, deal } = ctx

  switch (step.type) {
    case 'wait': {
      const amount = Number(step.config?.amount) || 1
      const unit = step.config?.unit || 'days'
      const ms = { minutes: 60000, hours: 3600000, days: 86400000 }[unit] || 86400000
      return { wait: amount * ms }
    }

    case 'create_task': {
      if (!contact) return { skipped: 'sem contato' }
      const dueDays = Number(step.config?.dueInDays) || 0
      await prisma.task.create({
        data: {
          tenantId, userId: null, contactId: contact.id,
          title: step.config?.title || 'Tarefa da automação',
          type: step.config?.taskType || 'follow',
          priority: step.config?.priority || 'mid',
          dueDate: new Date(Date.now() + dueDays * 86400000),
        },
      })
      return { done: true }
    }

    case 'change_stage': {
      if (!deal || !step.config?.stageId) return { skipped: 'sem negócio ou estágio' }
      await prisma.deal.update({ where: { id: deal.id }, data: { stageId: step.config.stageId } })
      return { done: true }
    }

    case 'set_temperature': {
      if (!contact || !step.config?.temperature) return { skipped: 'sem contato' }
      await prisma.contact.update({ where: { id: contact.id }, data: { temperature: step.config.temperature } })
      return { done: true }
    }

    case 'notify_team': {
      if (!contact) return { skipped: 'sem contato' }
      await prisma.activity.create({
        data: { tenantId, userId: null, contactId: contact.id, type: 'note', content: step.config?.message || 'Automação: verificar contato' },
      })
      return { done: true }
    }

    case 'send_email': {
      if (!contact?.email) return { skipped: 'contato sem e-mail' }
      try {
        await sendGmailMessage({ tenantId, userId, contact, subject: step.config?.subject || '', body: step.config?.body || '', origin: APP_ORIGIN })
        return { done: true }
      } catch (err) {
        return { skipped: err.message }
      }
    }

    case 'send_whatsapp': {
      if (!contact?.phone) return { skipped: 'contato sem telefone' }
      const sent = step.config?.imagePath
        ? await sendWhatsappMedia(tenantId, contact, step.config.imagePath, step.config?.message || '')
        : await sendWhatsappText(tenantId, contact, step.config?.message || '')
      return sent.ok ? { done: true } : { skipped: sent.error }
    }

    // Manda a pergunta com as opções numeradas e pausa a execução esperando a resposta —
    // é o que dá "memória de conversa" ao bot (a próxima mensagem da pessoa não vira um
    // gatilho novo, vira resposta desse menu).
    case 'menu': {
      if (!contact?.phone) return { skipped: 'contato sem telefone' }
      const options = Array.isArray(step.config?.options) ? step.config.options : []
      if (!options.length) return { skipped: 'menu sem opções configuradas' }
      const text = formatMenuMessage(step.config?.message || '', options)
      const sent = await sendWhatsappText(tenantId, contact, text)
      if (!sent.ok) return { skipped: sent.error }
      return { menu: true }
    }

    case 'webhook': {
      if (!step.config?.url) return { skipped: 'sem URL' }
      try {
        await fetch(step.config.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'automation.step', contact, deal }),
        })
        return { done: true }
      } catch (err) {
        return { skipped: err.message }
      }
    }

    case 'condition': {
      const value = resolveField(step.config?.field, ctx)
      const target = step.config?.value
      const pass = compare(value, step.config?.operator, target)
      if (!pass && step.config?.onFalse === 'stop') return { stop: true }
      return { done: true, conditionPassed: pass }
    }

    default:
      return { skipped: `tipo de passo desconhecido: ${step.type}` }
  }
}

// Envia texto puro pelo WhatsApp da empresa — usado pelo passo send_whatsapp e pelo menu.
async function getWhatsappConfig(tenantId) {
  const integration = await prisma.integration.findUnique({ where: { tenantId_type: { tenantId, type: 'whatsapp' } } })
  const config = integration?.config || {}
  if (!integration || integration.status !== 'connected' || !config.apiUrl || !config.instance) return null
  return config
}

async function sendWhatsappText(tenantId, contact, message) {
  const config = await getWhatsappConfig(tenantId)
  if (!config) return { ok: false, error: 'WhatsApp não conectado' }
  const toPhone = contact.phone.replace(/[^0-9]/g, '')
  try {
    const evoRes = await fetch(`${config.apiUrl.replace(/\/$/, '')}/message/sendText/${config.instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { apikey: config.apiKey } : {}) },
      body: JSON.stringify({ number: toPhone, text: message }),
    })
    const data = await evoRes.json().catch(() => ({}))
    if (!evoRes.ok) return { ok: false, error: 'Evolution recusou o envio' }
    await prisma.message.create({
      data: { contactId: contact.id, from: 'me', to: toPhone, body: message, channel: 'whatsapp', direction: 'out', whatsappMessageId: data?.key?.id || null, raw: data },
    }).catch(() => {})
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

// Manda uma imagem enviada pela pessoa no assistente/editor — a imagem fica salva em disco
// (public/uploads/automation-images) e é lida e mandada em base64 pra Evolution API, então
// não depende da Evolution (que roda em outro container) conseguir alcançar nosso localhost.
async function sendWhatsappMedia(tenantId, contact, imagePath, caption) {
  const config = await getWhatsappConfig(tenantId)
  if (!config) return { ok: false, error: 'WhatsApp não conectado' }
  const toPhone = contact.phone.replace(/[^0-9]/g, '')

  let base64, mimetype
  try {
    const absPath = path.join(UPLOADS_DIR, imagePath)
    if (!absPath.startsWith(UPLOADS_DIR + path.sep)) return { ok: false, error: 'Caminho de imagem inválido' }
    const buf = await fs.readFile(absPath)
    base64 = buf.toString('base64')
    mimetype = MIME_BY_EXT[path.extname(imagePath).toLowerCase()] || 'image/jpeg'
  } catch {
    return { ok: false, error: 'Imagem não encontrada' }
  }

  try {
    const evoRes = await fetch(`${config.apiUrl.replace(/\/$/, '')}/message/sendMedia/${config.instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { apikey: config.apiKey } : {}) },
      body: JSON.stringify({ number: toPhone, mediatype: 'image', mimetype, media: base64, caption, fileName: path.basename(imagePath) }),
    })
    const data = await evoRes.json().catch(() => ({}))
    if (!evoRes.ok) return { ok: false, error: 'Evolution recusou o envio' }
    await prisma.message.create({
      data: { contactId: contact.id, from: 'me', to: toPhone, body: caption || '[imagem]', channel: 'whatsapp', direction: 'out', whatsappMessageId: data?.key?.id || null, raw: data },
    }).catch(() => {})
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

function formatMenuMessage(message, options) {
  const list = options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')
  return `${message}\n\n${list}`
}

// Casa a resposta da pessoa com uma das opções do menu: por palavra-chave configurada,
// ou pela posição numérica ("2" bate com a segunda opção), sempre sem diferenciar maiúsculas.
function matchMenuOption(options, reply) {
  const normalized = String(reply || '').trim().toLowerCase()
  const byKeyword = options.find(o => (o.keywords || []).some(k => normalized === String(k).toLowerCase() || normalized.includes(String(k).toLowerCase())))
  if (byKeyword) return byKeyword
  const asNumber = parseInt(normalized, 10)
  if (!isNaN(asNumber) && options[asNumber - 1]) return options[asNumber - 1]
  return null
}

// Tira o contato do fluxo automático e passa pra um humano — usado quando a pessoa erra
// o menu demais vezes seguidas, pra nunca deixar a pessoa presa num loop de "não entendi".
async function handoffToHuman(tenantId, contact, runId, log, logType, logResult) {
  log.push({ stepId: null, type: logType, at: new Date().toISOString(), result: logResult })
  if (contact) {
    await sendWhatsappText(tenantId, contact, 'Entendido! Um atendente da nossa equipe vai continuar por aqui. 🙋')
    await prisma.task.create({
      data: {
        tenantId, userId: null, contactId: contact.id,
        title: `Atendimento humano solicitado — ${contact.name || contact.phone}`,
        type: 'follow', priority: 'high', dueDate: new Date(),
      },
    }).catch(() => {})
  }
  await prisma.automationFlowRun.update({ where: { id: runId }, data: { status: 'completed', log, finishedAt: new Date() } })
}

function resolveField(field, ctx) {
  const { contact, deal } = ctx
  switch (field) {
    case 'temperature': return contact?.temperature
    case 'origin': return contact?.origin
    case 'dealValue': return deal ? Number(deal.value) : null
    case 'daysSinceCreated': return contact ? Math.floor((Date.now() - new Date(contact.createdAt)) / 86400000) : null
    default: return null
  }
}

function compare(value, operator, target) {
  switch (operator) {
    case 'equals': return String(value) === String(target)
    case 'not_equals': return String(value) !== String(target)
    case 'greater_than': return Number(value) > Number(target)
    case 'less_than': return Number(value) < Number(target)
    case 'contains': return String(value || '').toLowerCase().includes(String(target || '').toLowerCase())
    default: return true
  }
}

// Avança uma execução a partir do stepIndex atual até encontrar um wait, um menu, terminar ou falhar.
// currentSteps é a lista "ativa" no momento — no começo é flow.steps; ao escolher uma opção de
// menu, currentSteps vira a lista de passos daquela opção (permite submenus sem limite de nível).
export async function advanceRun(runId) {
  const run = await prisma.automationFlowRun.findUnique({ where: { id: runId }, include: { flow: true } })
  if (!run || run.status === 'completed' || run.status === 'failed') return

  const steps = Array.isArray(run.currentSteps) ? run.currentSteps : (Array.isArray(run.flow.steps) ? run.flow.steps : [])
  const contact = run.contactId ? await prisma.contact.findUnique({ where: { id: run.contactId } }) : null
  const deal = run.dealId ? await prisma.deal.findUnique({ where: { id: run.dealId } }) : null
  const ctx = { tenantId: run.tenantId, userId: null, contact, deal }

  let i = run.stepIndex
  const log = Array.isArray(run.log) ? [...run.log] : []

  while (i < steps.length) {
    const step = steps[i]
    let result
    try {
      result = await executeStep(step, ctx)
    } catch (err) {
      result = { skipped: err.message }
    }
    log.push({ stepId: step.id, type: step.type, at: new Date().toISOString(), result })

    if (result?.stop) {
      await prisma.automationFlowRun.update({ where: { id: runId }, data: { status: 'completed', stepIndex: i + 1, currentSteps: steps, log, finishedAt: new Date() } })
      return
    }
    if (result?.wait) {
      await prisma.automationFlowRun.update({
        where: { id: runId },
        data: { status: 'waiting', stepIndex: i + 1, currentSteps: steps, resumeAt: new Date(Date.now() + result.wait), log },
      })
      return
    }
    if (result?.menu) {
      await prisma.automationFlowRun.update({
        where: { id: runId },
        data: { status: 'waiting_reply', stepIndex: i, currentSteps: steps, log },
      })
      return
    }
    i++
  }

  await prisma.automationFlowRun.update({ where: { id: runId }, data: { status: 'completed', stepIndex: i, currentSteps: steps, log, finishedAt: new Date() } })
}

export async function startFlowRun(flow, { contactId, dealId }) {
  const run = await prisma.automationFlowRun.create({
    data: { tenantId: flow.tenantId, flowId: flow.id, contactId: contactId || null, dealId: dealId || null, status: 'running', stepIndex: 0, currentSteps: flow.steps, log: [] },
  })
  advanceRun(run.id).catch(err => console.error('automation run failed', err))
  return run
}

// Se a pessoa está no meio de um menu, trata a mensagem como resposta em vez de gatilho novo.
// Retorna true se consumiu a mensagem (o chamador não deve avaliar outros gatilhos nesse caso).
export async function resolveMenuReply(tenantId, contactId, messageBody) {
  const run = await prisma.automationFlowRun.findFirst({
    where: { tenantId, contactId, status: 'waiting_reply' },
    orderBy: { startedAt: 'desc' },
    include: { flow: true },
  })
  if (!run) return false

  const steps = Array.isArray(run.currentSteps) ? run.currentSteps : []
  const menuStep = steps[run.stepIndex]
  if (!menuStep || menuStep.type !== 'menu') return false

  const options = Array.isArray(menuStep.config?.options) ? menuStep.config.options : []
  const match = matchMenuOption(options, messageBody)
  const contact = await prisma.contact.findUnique({ where: { id: contactId } })
  const log = Array.isArray(run.log) ? [...run.log] : []

  if (!match) {
    // depois de errar 2x seguidas o mesmo menu, passa pra um atendente em vez de repetir
    // "não entendi" pra sempre — evita a pessoa ficar presa num loop do bot.
    let missStreak = 0
    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i].stepId === menuStep.id && log[i].type === 'menu_invalid_reply') missStreak++
      else break
    }
    if (missStreak >= 1) {
      await handoffToHuman(tenantId, contact, run.id, log, 'menu_escalated', { reply: messageBody, reason: 'duas respostas seguidas não reconhecidas' })
      return true
    }

    log.push({ stepId: menuStep.id, type: 'menu_invalid_reply', at: new Date().toISOString(), result: { reply: messageBody } })
    const retryText = `Não entendi. ${formatMenuMessage(menuStep.config?.message || '', options)}`
    if (contact) await sendWhatsappText(tenantId, contact, retryText)
    await prisma.automationFlowRun.update({ where: { id: run.id }, data: { log } })
    return true
  }

  log.push({ stepId: menuStep.id, type: 'menu_reply', at: new Date().toISOString(), result: { reply: messageBody, chosen: match.label } })
  const nextSteps = Array.isArray(match.steps) ? match.steps : []
  await prisma.automationFlowRun.update({
    where: { id: run.id },
    data: { status: 'running', currentSteps: nextSteps, stepIndex: 0, log },
  })
  await advanceRun(run.id)
  return true
}

// Dispara todos os fluxos ativos de um tenant que casam com o gatilho informado.
export async function triggerFlows(tenantId, triggerType, { contactId, dealId, stageId, messageBody } = {}) {
  const flows = await prisma.automationFlow.findMany({ where: { tenantId, active: true, triggerType } })
  for (const flow of flows) {
    if (triggerType === 'deal_stage_changed' && flow.triggerConfig?.stageId && flow.triggerConfig.stageId !== stageId) continue
    if (triggerType === 'whatsapp_message_received' && flow.triggerConfig?.keyword) {
      const keyword = String(flow.triggerConfig.keyword).toLowerCase()
      if (!String(messageBody || '').toLowerCase().includes(keyword)) continue
    }
    startFlowRun(flow, { contactId, dealId })
  }
}

// Retoma execuções em espera cujo horário já chegou — chamado periodicamente.
export async function resumeDueRuns() {
  const due = await prisma.automationFlowRun.findMany({ where: { status: 'waiting', resumeAt: { lte: new Date() } }, select: { id: true } })
  for (const run of due) {
    await prisma.automationFlowRun.update({ where: { id: run.id }, data: { status: 'running' } })
    advanceRun(run.id).catch(err => console.error('automation resume failed', err))
  }
}
