import { Router } from 'express'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

// Início/fim do período escolhido + do período anterior equivalente, pra
// comparar "essa semana vs a passada", "esse mês vs o passado" etc — só a
// receita do card "Visão geral" responde ao period (o resto é sempre um
// retrato de agora, igual "sócios ativos" não muda com o filtro de período).
function periodRange(period, now, monthStart, monthEnd, lastMonthStart, lastMonthEnd) {
  if (period === 'semana') {
    const start = new Date(now); start.setDate(start.getDate() - 6); start.setHours(0, 0, 0, 0)
    const prevEnd = new Date(start.getTime() - 1)
    const prevStart = new Date(prevEnd); prevStart.setDate(prevStart.getDate() - 6); prevStart.setHours(0, 0, 0, 0)
    return { start, end: now, prevStart, prevEnd, label: 'semana anterior' }
  }
  if (period === 'ano') {
    const start = new Date(now.getFullYear(), 0, 1)
    const prevStart = new Date(now.getFullYear() - 1, 0, 1)
    const prevEnd = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59)
    return { start, end: now, prevStart, prevEnd, label: 'ano anterior' }
  }
  return { start: monthStart, end: now, prevStart: lastMonthStart, prevEnd: lastMonthEnd, label: 'mês anterior' }
}

// GET /dashboard?period=semana|mes|ano — KPIs + gráfico de receita + funil
router.get('/', async (req, res) => {
  const { tenantId } = req.user
  const period = ['semana', 'mes', 'ano'].includes(req.query.period) ? req.query.period : 'mes'
  const now = new Date()
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59)
  const today = new Date(); today.setHours(23, 59, 59)
  const RECENT_MESSAGE_DAYS = 5
  const recentSince = new Date(now.getTime() - RECENT_MESSAGE_DAYS * 24 * 60 * 60 * 1000)
  const { start: pStart, end: pEnd, prevStart: pPrevStart, prevEnd: pPrevEnd, label: pPrevLabel } =
    periodRange(period, now, startOfMonth, now, startOfLastMonth, endOfLastMonth)

  // Meses (6 últimos) pro gráfico de receita
  const months = Array.from({ length: 6 }, (_, k) => {
    const i = 5 - k
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59)
    return { d, end }
  })

  // ── Consultas independentes entre si — todas de uma vez, sem esperar uma pela outra ──
  const [
    periodDeals, prevPeriodDeals, tasks, contacts, stages,
    activeDeals, closedDeals,
    monthlyRevenueRows,
    recentDeals, upcomingTasks, overdueTasksList,
    recentInbound,
    openDealsForActions,
    pipelineValueAgg, newContactsThisMonth, temperatureRaw,
    whatsappIntegration, whatsappToday, whatsappUnreadRaw, whatsappTotal,
    teamSize,
  ] = await Promise.all([
    prisma.deal.findMany({ where: { tenantId, closedAt: { gte: pStart, lte: pEnd } }, select: { value: true } }),
    prisma.deal.findMany({ where: { tenantId, closedAt: { gte: pPrevStart, lte: pPrevEnd } }, select: { value: true } }),
    prisma.task.findMany({ where: { tenantId, doneAt: null }, select: { dueDate: true } }),
    prisma.contact.count({ where: { tenantId } }),
    prisma.stage.findMany({ where: { tenantId }, orderBy: { order: 'asc' }, include: { deals: { select: { value: true } } } }),
    prisma.deal.count({ where: { tenantId, closedAt: null } }),
    prisma.deal.count({ where: { tenantId, closedAt: { not: null } } }),
    Promise.all(months.map(({ d, end }) =>
      prisma.deal.findMany({ where: { tenantId, closedAt: { gte: d, lte: end } }, select: { value: true } })
    )),
    prisma.deal.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: { contact: { select: { name: true } }, stage: { select: { name: true, color: true } } },
    }),
    prisma.task.findMany({
      where: { tenantId, doneAt: null, dueDate: { lte: today } },
      orderBy: { dueDate: 'asc' },
      take: 5,
      include: { contact: { select: { name: true } } },
    }),
    prisma.task.findMany({
      where: { tenantId, doneAt: null, dueDate: { lt: now } },
      orderBy: { dueDate: 'asc' },
      take: 5,
      include: { contact: { select: { name: true } } },
    }),
    prisma.message.findMany({
      where: { direction: 'in', createdAt: { gte: recentSince }, contact: { tenantId } },
      orderBy: { createdAt: 'desc' },
      select: { contactId: true, createdAt: true, contact: { select: { id: true, name: true } } },
    }),
    prisma.deal.findMany({
      where: { tenantId, closedAt: null, contactId: { not: null } },
      orderBy: { value: 'desc' },
      take: 25,
      select: { id: true, title: true, value: true, updatedAt: true, contactId: true, contact: { select: { name: true } }, stage: { select: { name: true } } },
    }),
    prisma.deal.aggregate({ where: { tenantId, closedAt: null }, _sum: { value: true } }),
    prisma.contact.count({ where: { tenantId, createdAt: { gte: startOfMonth } } }),
    prisma.contact.groupBy({ by: ['temperature'], where: { tenantId }, _count: true }),
    prisma.integration.findUnique({ where: { tenantId_type: { tenantId, type: 'whatsapp' } } }),
    prisma.message.count({ where: { OR: [{ contact: { tenantId } }, { tenantId }], channel: 'whatsapp', createdAt: { gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()) } } }),
    prisma.message.groupBy({ by: ['contactId'], where: { contact: { tenantId }, channel: 'whatsapp', direction: 'in', readAt: null }, _count: true }),
    prisma.message.count({ where: { OR: [{ contact: { tenantId } }, { tenantId }], channel: 'whatsapp' } }),
    prisma.user.count({ where: { tenantId, active: true } }),
  ])

  const revenue = periodDeals.reduce((s, d) => s + Number(d.value), 0)
  const prevRevenue = prevPeriodDeals.reduce((s, d) => s + Number(d.value), 0)
  const revenueGrowth = prevRevenue > 0 ? ((revenue - prevRevenue) / prevRevenue * 100).toFixed(1) : null

  const totalDeals = activeDeals + closedDeals
  const conversion = totalDeals > 0 ? ((closedDeals / totalDeals) * 100).toFixed(1) : 0

  const overdueTasks = tasks.filter(t => t.dueDate && new Date(t.dueDate) < new Date()).length
  const todayTasks = tasks.filter(t => t.dueDate && new Date(t.dueDate) <= today).length

  // Receita dos últimos 6 meses
  const monthlyRevenue = months.map(({ d }, idx) => ({
    month: d.toLocaleString('pt-BR', { month: 'short' }),
    value: monthlyRevenueRows[idx].reduce((s, r) => s + Number(r.value), 0),
  }))

  // Funil
  const funnel = stages.map(s => ({
    name: s.name,
    color: s.color,
    count: s.deals.length,
    value: s.deals.reduce((sum, d) => sum + Number(d.value), 0),
  }))

  // Composição da base de contatos por temperatura — o equivalente ao "sócio
  // ativo / carência / inadimplente" de um sistema de associados: aqui é o
  // termômetro de quão perto do fechamento cada contato está.
  const TEMP_META = {
    new:  { label: 'Novo',  color: '#64748b' },
    hot:  { label: 'Quente', color: '#e74c3c' },
    warm: { label: 'Morno', color: '#f39c12' },
    cold: { label: 'Frio',  color: '#2980b9' },
  }
  const tempCounts = Object.fromEntries(temperatureRaw.map(t => [t.temperature, t._count]))
  const contactComposition = Object.keys(TEMP_META).map(key => ({
    key, label: TEMP_META[key].label, color: TEMP_META[key].color, count: tempCounts[key] || 0,
  }))

  const pipelineValue = Number(pipelineValueAgg._sum.value || 0)

  const whatsapp = {
    connected: whatsappIntegration?.status === 'connected',
    messagesTotal: whatsappTotal,
    messagesToday: whatsappToday,
    unreadConversations: whatsappUnreadRaw.length,
  }

  // ── Alerta: contatos que responderam recentemente e não têm follow-up agendado ──
  const lastInboundByContact = {}
  recentInbound.forEach(m => {
    if (m.contactId && !lastInboundByContact[m.contactId]) lastInboundByContact[m.contactId] = m
  })
  const messagedContactIds = Object.keys(lastInboundByContact)

  // ── Próxima ação recomendada por negócio (cruza Deal + Task + Message) ──
  const actionContactIds = [...new Set(openDealsForActions.map(d => d.contactId))]

  // ── Consultas que dependem do resultado acima, mas são independentes entre si ──
  const [openTasksForMessaged, [openTasksForActions, lastInboundForActions]] = await Promise.all([
    messagedContactIds.length
      ? prisma.task.findMany({ where: { tenantId, contactId: { in: messagedContactIds }, doneAt: null }, select: { contactId: true } })
      : Promise.resolve([]),
    actionContactIds.length
      ? Promise.all([
          prisma.task.findMany({ where: { tenantId, contactId: { in: actionContactIds }, doneAt: null }, select: { contactId: true, title: true, dueDate: true } }),
          prisma.message.findMany({ where: { direction: 'in', contactId: { in: actionContactIds } }, orderBy: { createdAt: 'desc' }, select: { contactId: true, createdAt: true } }),
        ])
      : Promise.resolve([[], []]),
  ])

  const contactsWithOpenTask = new Set(openTasksForMessaged.map(t => t.contactId))
  const followUpAlerts = messagedContactIds
    .filter(id => !contactsWithOpenTask.has(id))
    .map(id => {
      const m = lastInboundByContact[id]
      return {
        contactId: id,
        contactName: m.contact?.name || 'Contato',
        lastMessageAt: m.createdAt,
        daysSince: Math.floor((now - new Date(m.createdAt)) / 86400000),
      }
    })
    .sort((a, b) => a.daysSince - b.daysSince)
    .slice(0, 8)

  const openTasksByContact = {}
  openTasksForActions.forEach(t => { (openTasksByContact[t.contactId] = openTasksByContact[t.contactId] || []).push(t) })
  const lastInboundForAction = {}
  lastInboundForActions.forEach(m => { if (!lastInboundForAction[m.contactId]) lastInboundForAction[m.contactId] = m.createdAt })

  const nextActions = openDealsForActions.map(d => {
    const tasks = openTasksByContact[d.contactId] || []
    const overdueTask = tasks.find(t => t.dueDate && new Date(t.dueDate) < now)
    const lastInbound = lastInboundForAction[d.contactId]
    const daysSinceMsg = lastInbound ? Math.floor((now - new Date(lastInbound)) / 86400000) : null
    const daysSinceUpdate = Math.floor((now - new Date(d.updatedAt)) / 86400000)

    let action, urgency
    if (overdueTask) {
      action = `Tarefa atrasada: "${overdueTask.title}"`
      urgency = 3
    } else if (lastInbound !== undefined && tasks.length === 0) {
      action = daysSinceMsg === 0
        ? 'Responder o contato — mensagem recebida hoje, sem follow-up agendado'
        : `Responder o contato — mensagem há ${daysSinceMsg} dia${daysSinceMsg > 1 ? 's' : ''}, sem follow-up agendado`
      urgency = 2
    } else if (tasks.length === 0 && daysSinceUpdate >= 3) {
      action = `Sem contato há ${daysSinceUpdate} dias — ligar ou enviar mensagem`
      urgency = 1
    } else {
      return null
    }
    return {
      dealId: d.id, contactName: d.contact?.name || d.title, stageName: d.stage?.name,
      value: Number(d.value), action, urgency,
    }
  }).filter(Boolean).sort((a, b) => b.urgency - a.urgency || b.value - a.value).slice(0, 6)

  res.json({
    period,
    periodPrevLabel: pPrevLabel,
    kpis: {
      revenue, revenueGrowth, activeDeals, pipelineValue, conversion: Number(conversion),
      todayTasks, overdueTasks, contacts, newContactsThisMonth, teamSize,
      followUpCount: followUpAlerts.length,
    },
    monthlyRevenue,
    funnel,
    contactComposition,
    whatsapp,
    recentDeals,
    upcomingTasks,
    overdueTasksList,
    followUpAlerts,
    nextActions,
  })
})

export default router
