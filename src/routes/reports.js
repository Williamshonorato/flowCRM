import { Router } from 'express'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

// GET /reports?period=month|quarter|year
router.get('/', async (req, res) => {
  const { tenantId } = req.user
  const { period = 'month' } = req.query
  const now = new Date()

  const periodStart = {
    month:   new Date(now.getFullYear(), now.getMonth(), 1),
    quarter: new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1),
    year:    new Date(now.getFullYear(), 0, 1),
  }[period] ?? new Date(now.getFullYear(), now.getMonth(), 1)

  const [allDeals, closedDeals, contacts, tasks] = await Promise.all([
    prisma.deal.findMany({ where: { tenantId, createdAt: { gte: periodStart } }, select: { value: true, closedAt: true, stageId: true } }),
    prisma.deal.findMany({ where: { tenantId, closedAt: { gte: periodStart } }, select: { value: true } }),
    prisma.contact.findMany({ where: { tenantId, createdAt: { gte: periodStart } }, select: { origin: true } }),
    prisma.task.findMany({ where: { tenantId, doneAt: { gte: periodStart } }, select: { type: true } }),
  ])

  const revenue = closedDeals.reduce((s, d) => s + Number(d.value), 0)
  const totalCreated = allDeals.length
  const totalClosed  = allDeals.filter(d => d.closedAt).length
  const conversion   = totalCreated > 0 ? ((totalClosed / totalCreated) * 100).toFixed(1) : 0

  // Receita dos últimos 6 meses
  const monthlyRevenue = []
  for (let i = 5; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const end   = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59)
    const rows = await prisma.deal.findMany({ where: { tenantId, closedAt: { gte: start, lte: end } }, select: { value: true } })
    monthlyRevenue.push({ month: start.toLocaleString('pt-BR', { month: 'short' }), value: rows.reduce((s, r) => s + Number(r.value), 0) })
  }

  // Funil por estágio
  const stages = await prisma.stage.findMany({
    where: { tenantId }, orderBy: { order: 'asc' },
    include: { deals: { select: { value: true } } },
  })
  const maxCount = Math.max(...stages.map(s => s.deals.length), 1)
  const funnel = stages.map(s => ({
    name: s.name, color: s.color,
    count: s.deals.length,
    pct: Math.round((s.deals.length / maxCount) * 100),
    value: s.deals.reduce((sum, d) => sum + Number(d.value), 0),
  }))

  // Origem dos leads
  const originMap = {}
  contacts.forEach(c => { originMap[c.origin || 'outro'] = (originMap[c.origin || 'outro'] || 0) + 1 })
  const total = contacts.length || 1
  const origins = Object.entries(originMap).map(([name, count]) => ({ name, count, pct: Math.round(count / total * 100) })).sort((a, b) => b.count - a.count)

  // Top negócios
  const topDeals = await prisma.deal.findMany({
    where: { tenantId },
    orderBy: { value: 'desc' },
    take: 5,
    include: { contact: { select: { name: true } }, stage: { select: { name: true } } },
  })

  // Churn (% clientes que não tiveram atividade no período)
  const activeContactIds = await prisma.activity.findMany({ where: { tenantId, createdAt: { gte: periodStart } }, select: { contactId: true }, distinct: ['contactId'] })
  const totalContacts = await prisma.contact.count({ where: { tenantId } })
  const churn = totalContacts > 0 ? (((totalContacts - activeContactIds.length) / totalContacts) * 100).toFixed(1) : 0

  res.json({ revenue, conversion: Number(conversion), churn: Number(churn), totalDeals: totalCreated, monthlyRevenue, funnel, origins, topDeals })
})

export default router
