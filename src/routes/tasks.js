import { Router } from 'express'
import { z } from 'zod'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

const schema = z.object({
  title:     z.string().min(1),
  type:      z.enum(['call','follow','meet','email','note']).default('follow'),
  priority:  z.enum(['high','mid','low']).default('mid'),
  dueDate:   z.string().optional(),
  contactId: z.string().optional(),
  notes:     z.string().optional(),
})

// GET /tasks?view=hoje|atrasadas|semana|todas|concluidas&type=
router.get('/', async (req, res) => {
  const { tenantId, userId } = req.user
  const { view = 'hoje', type } = req.query

  const now = new Date()
  const todayEnd = new Date(now); todayEnd.setHours(23, 59, 59)
  const weekEnd  = new Date(now.getTime() + 7 * 86400000)

  const dueDateFilter = {
    hoje:      { dueDate: { lte: todayEnd }, doneAt: null },
    atrasadas: { dueDate: { lt: now }, doneAt: null },
    semana:    { dueDate: { gte: now, lte: weekEnd }, doneAt: null },
    todas:     { doneAt: null },
    concluidas:{ doneAt: { not: null } },
  }[view] ?? {}

  const tasks = await prisma.task.findMany({
    where: {
      tenantId,
      ...dueDateFilter,
      ...(type && type !== 'all' && { type }),
    },
    orderBy: { dueDate: 'asc' },
    include: { contact: { select: { id: true, name: true } } },
  })

  const counts = await prisma.task.groupBy({
    by: ['type'],
    where: { tenantId },
    _count: true,
  })

  res.json({ tasks, counts })
})

// POST /tasks
router.post('/', async (req, res) => {
  const { tenantId, userId } = req.user
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const task = await prisma.task.create({
    data: {
      tenantId,
      userId,
      ...parsed.data,
      dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
    },
    include: { contact: { select: { id: true, name: true } } },
  })
  res.status(201).json(task)
})

// PATCH /tasks/:id
router.patch('/:id', async (req, res) => {
  const { tenantId } = req.user
  const existing = await prisma.task.findFirst({ where: { id: req.params.id, tenantId } })
  if (!existing) return res.status(404).json({ error: 'Tarefa não encontrada.' })

  const { done, ...rest } = req.body
  const parsed = schema.partial().safeParse(rest)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const task = await prisma.task.update({
    where: { id: req.params.id },
    data: {
      ...parsed.data,
      ...(parsed.data.dueDate && { dueDate: new Date(parsed.data.dueDate) }),
      ...(done === true  && { doneAt: new Date() }),
      ...(done === false && { doneAt: null }),
    },
    include: { contact: { select: { id: true, name: true } } },
  })
  res.json(task)
})

// DELETE /tasks/:id
router.delete('/:id', async (req, res) => {
  const { tenantId } = req.user
  const existing = await prisma.task.findFirst({ where: { id: req.params.id, tenantId } })
  if (!existing) return res.status(404).json({ error: 'Tarefa não encontrada.' })
  await prisma.task.delete({ where: { id: req.params.id } })
  res.status(204).send()
})

export default router
