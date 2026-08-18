import { Router } from 'express'
import { z } from 'zod'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

const expenseSchema = z.object({
  description: z.string().min(1),
  category:    z.string().optional(),
  amount:      z.number().min(0),
  date:        z.string(),
})

// GET /treasury/summary?period=month|year|all — visão geral: contribuições x despesas
router.get('/summary', async (req, res) => {
  const { tenantId } = req.user
  const { period = 'month' } = req.query

  const now = new Date()
  // Date.UTC evita o problema de datas "dia 1" (comuns em vencimento de mensalidade) ficarem
  // de fora do período por causa do fuso horário do servidor
  const start = period === 'year' ? new Date(Date.UTC(now.getUTCFullYear(), 0, 1))
    : period === 'all' ? new Date(Date.UTC(2000, 0, 1))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

  const [contributions, expenses, memberCount, overdueCount] = await Promise.all([
    prisma.contribution.findMany({ where: { tenantId, dueDate: { gte: start } }, select: { amount: true, status: true } }),
    prisma.treasuryExpense.findMany({ where: { tenantId, date: { gte: start } }, select: { amount: true, category: true } }),
    prisma.member.count({ where: { tenantId, status: 'active' } }),
    prisma.contribution.count({ where: { tenantId, status: 'overdue' } }),
  ])

  const received = contributions.filter(c => c.status === 'paid').reduce((s, c) => s + Number(c.amount), 0)
  const pending  = contributions.filter(c => c.status !== 'paid').reduce((s, c) => s + Number(c.amount), 0)
  const totalExpenses = expenses.reduce((s, e) => s + Number(e.amount), 0)

  const byCategory = {}
  for (const e of expenses) {
    const cat = e.category || 'Outros'
    byCategory[cat] = (byCategory[cat] || 0) + Number(e.amount)
  }

  res.json({
    period,
    received,
    pending,
    totalExpenses,
    balance: received - totalExpenses,
    activeMembers: memberCount,
    overdueContributions: overdueCount,
    expensesByCategory: byCategory,
  })
})

// GET /treasury/expenses
router.get('/expenses', async (req, res) => {
  const { tenantId } = req.user
  const { page = '1', limit = '20', category } = req.query
  const skip = (Number(page) - 1) * Number(limit)

  const where = { tenantId, ...(category && { category }) }
  const [total, expenses] = await Promise.all([
    prisma.treasuryExpense.count({ where }),
    prisma.treasuryExpense.findMany({ where, skip, take: Number(limit), orderBy: { date: 'desc' } }),
  ])
  res.json({ total, page: Number(page), limit: Number(limit), expenses })
})

// POST /treasury/expenses
router.post('/expenses', async (req, res) => {
  const { tenantId } = req.user
  const parsed = expenseSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const expense = await prisma.treasuryExpense.create({
    data: { tenantId, ...parsed.data, date: new Date(parsed.data.date) },
  })
  res.status(201).json(expense)
})

// PATCH /treasury/expenses/:id
router.patch('/expenses/:id', async (req, res) => {
  const { tenantId } = req.user
  const existing = await prisma.treasuryExpense.findFirst({ where: { id: req.params.id, tenantId } })
  if (!existing) return res.status(404).json({ error: 'Despesa não encontrada.' })

  const parsed = expenseSchema.partial().safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const expense = await prisma.treasuryExpense.update({
    where: { id: req.params.id },
    data: { ...parsed.data, ...(parsed.data.date && { date: new Date(parsed.data.date) }) },
  })
  res.json(expense)
})

// DELETE /treasury/expenses/:id
router.delete('/expenses/:id', async (req, res) => {
  const { tenantId } = req.user
  const existing = await prisma.treasuryExpense.findFirst({ where: { id: req.params.id, tenantId } })
  if (!existing) return res.status(404).json({ error: 'Despesa não encontrada.' })
  await prisma.treasuryExpense.delete({ where: { id: req.params.id } })
  res.status(204).send()
})

export default router
