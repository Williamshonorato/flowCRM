import { Router } from 'express'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

// GET /dashboard — KPIs + gráfico de receita + funil
router.get('/', async (req, res) => {
  const { tenantId } = req.user
  const now = new Date()
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59)

  const [deals, lastMonthDeals, tasks, contacts, stages] = await Promise.all([
    prisma.deal.findMany({ where: { tenantId, closedAt: { gte: startOfMonth } }, select: { value: true } }),
    prisma.deal.findMany({ where: { tenantId, closedAt: { gte: startOfLastMonth, lte: endOfLastMonth } }, select: { value: true } }),
    prisma.task.findMany({ where: { tenantId, doneAt: null }, select: { dueDate: true } }),
    prisma.contact.count({ where: { tenantId } }),
    prisma.stage.findMany({ where: { tenantId }, orderBy: { order: 'asc' }, include: { deals: { select: { value: true } } } }),
  ])

  const revenue = deals.reduce((s, d) => s + Number(d.value), 0)
  const lastRevenue = lastMonthDeals.reduce((s, d) => s + Number(d.value), 0)
  const revenueGrowth = lastRevenue > 0 ? ((revenue - lastRevenue) / lastRevenue * 100).toFixed(1) : null

  const activeDeals = await prisma.deal.count({ where: { tenantId, closedAt: null } })
  const closedDeals = await prisma.deal.count({ where: { tenantId, closedAt: { not: null } } })
  const totalDeals = activeDeals + closedDeals
  const conversion = totalDeals > 0 ? ((closedDeals / totalDeals) * 100).toFixed(1) : 0

  const today = new Date(); today.setHours(23, 59, 59)
  const overdueTasks = tasks.filter(t => t.dueDate && new Date(t.dueDate) < new Date()).length
  const todayTasks = tasks.filter(t => t.dueDate && new Date(t.dueDate) <= today).length

  // Receita dos últimos 6 meses
  const monthlyRevenue = []
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59)
    const rows = await prisma.deal.findMany({ where: { tenantId, closedAt: { gte: d, lte: end } }, select: { value: true } })
    monthlyRevenue.push({
      month: d.toLocaleString('pt-BR', { month: 'short' }),
      value: rows.reduce((s, r) => s + Number(r.value), 0),
    })
  }

  // Funil
  const funnel = stages.map(s => ({
    name: s.name,
    color: s.color,
    count: s.deals.length,
    value: s.deals.reduce((sum, d) => sum + Number(d.value), 0),
  }))

  // Negócios recentes
  const recentDeals = await prisma.deal.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    take: 5,
    include: { contact: { select: { name: true } }, stage: { select: { name: true, color: true } } },
  })

  // Tarefas de hoje
  const todayStart = new Date(); todayStart.setHours(0, 0, 0)
  const upcomingTasks = await prisma.task.findMany({
    where: { tenantId, doneAt: null, dueDate: { lte: today } },
    orderBy: { dueDate: 'asc' },
    take: 5,
    include: { contact: { select: { name: true } } },
  })

  // Tarefas atrasadas com detalhe (pro dropdown de notificações)
  const overdueTasksList = await prisma.task.findMany({
    where: { tenantId, doneAt: null, dueDate: { lt: now } },
    orderBy: { dueDate: 'asc' },
    take: 5,
    include: { contact: { select: { name: true } } },
  })

  // ── Alerta: contatos que responderam recentemente e não têm follow-up agendado ──
  const RECENT_MESSAGE_DAYS = 5
  const recentSince = new Date(now.getTime() - RECENT_MESSAGE_DAYS * 24 * 60 * 60 * 1000)
  const recentInbound = await prisma.message.findMany({
    where: { direction: 'in', createdAt: { gte: recentSince }, contact: { tenantId } },
    orderBy: { createdAt: 'desc' },
    select: { contactId: true, createdAt: true, contact: { select: { id: true, name: true } } },
  })
  const lastInboundByContact = {}
  recentInbound.forEach(m => {
    if (m.contactId && !lastInboundByContact[m.contactId]) lastInboundByContact[m.contactId] = m
  })
  const messagedContactIds = Object.keys(lastInboundByContact)
  const openTasksForMessaged = messagedContactIds.length
    ? await prisma.task.findMany({ where: { tenantId, contactId: { in: messagedContactIds }, doneAt: null }, select: { contactId: true } })
    : []
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

  // ── Próxima ação recomendada por negócio (cruza Deal + Task + Message) ──
  const openDealsForActions = await prisma.deal.findMany({
    where: { tenantId, closedAt: null, contactId: { not: null } },
    orderBy: { value: 'desc' },
    take: 25,
    select: { id: true, title: true, value: true, updatedAt: true, contactId: true, contact: { select: { name: true } }, stage: { select: { name: true } } },
  })
  const actionContactIds = [...new Set(openDealsForActions.map(d => d.contactId))]
  const [openTasksForActions, lastInboundForActions] = actionContactIds.length ? await Promise.all([
    prisma.task.findMany({ where: { tenantId, contactId: { in: actionContactIds }, doneAt: null }, select: { contactId: true, title: true, dueDate: true } }),
    prisma.message.findMany({ where: { direction: 'in', contactId: { in: actionContactIds } }, orderBy: { createdAt: 'desc' }, select: { contactId: true, createdAt: true } }),
  ]) : [[], []]
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
    kpis: { revenue, revenueGrowth, activeDeals, conversion: Number(conversion), todayTasks, overdueTasks, contacts },
    monthlyRevenue,
    funnel,
    recentDeals,
    upcomingTasks,
    overdueTasksList,
    followUpAlerts,
    nextActions,
  })
})

export default router
