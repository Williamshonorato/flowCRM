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

  res.json({
    kpis: { revenue, revenueGrowth, activeDeals, conversion: Number(conversion), todayTasks, overdueTasks, contacts },
    monthlyRevenue,
    funnel,
    recentDeals,
    upcomingTasks,
  })
})

export default router
