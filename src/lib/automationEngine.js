import prisma from './prisma.js'
import { sendGmailMessage } from './gmailSender.js'

const APP_ORIGIN = `http://localhost:${process.env.PORT || 3333}`

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
      const integration = await prisma.integration.findUnique({ where: { tenantId_type: { tenantId, type: 'whatsapp' } } })
      const config = integration?.config || {}
      if (!integration || integration.status !== 'connected' || !config.apiUrl || !config.instance) return { skipped: 'WhatsApp não conectado' }
      const toPhone = contact.phone.replace(/[^0-9]/g, '')
      try {
        const evoRes = await fetch(`${config.apiUrl.replace(/\/$/, '')}/message/sendText/${config.instance}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { apikey: config.apiKey } : {}) },
          body: JSON.stringify({ number: toPhone, text: step.config?.message || '' }),
        })
        const data = await evoRes.json().catch(() => ({}))
        if (!evoRes.ok) return { skipped: 'Evolution recusou o envio' }
        await prisma.message.create({
          data: { contactId: contact.id, from: 'me', to: toPhone, body: step.config?.message || '', channel: 'whatsapp', direction: 'out', whatsappMessageId: data?.key?.id || null, raw: data },
        }).catch(() => {})
        return { done: true }
      } catch (err) {
        return { skipped: err.message }
      }
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

// Avança uma execução a partir do stepIndex atual até encontrar um wait, terminar ou falhar.
export async function advanceRun(runId) {
  const run = await prisma.automationFlowRun.findUnique({ where: { id: runId }, include: { flow: true } })
  if (!run || run.status === 'completed' || run.status === 'failed') return

  const steps = Array.isArray(run.flow.steps) ? run.flow.steps : []
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
      await prisma.automationFlowRun.update({ where: { id: runId }, data: { status: 'completed', stepIndex: i + 1, log, finishedAt: new Date() } })
      return
    }
    if (result?.wait) {
      await prisma.automationFlowRun.update({
        where: { id: runId },
        data: { status: 'waiting', stepIndex: i + 1, resumeAt: new Date(Date.now() + result.wait), log },
      })
      return
    }
    i++
  }

  await prisma.automationFlowRun.update({ where: { id: runId }, data: { status: 'completed', stepIndex: i, log, finishedAt: new Date() } })
}

export async function startFlowRun(flow, { contactId, dealId }) {
  const run = await prisma.automationFlowRun.create({
    data: { tenantId: flow.tenantId, flowId: flow.id, contactId: contactId || null, dealId: dealId || null, status: 'running', stepIndex: 0, log: [] },
  })
  advanceRun(run.id).catch(err => console.error('automation run failed', err))
  return run
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
