import { Router } from 'express'
import { z } from 'zod'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

const schema = z.object({
  title:     z.string().min(1),
  contactId: z.string().optional(),
  stageId:   z.string(),
  value:     z.number().min(0).default(0),
  notes:     z.string().optional(),
})

// GET /deals — agrupado por stage (kanban)
router.get('/', async (req, res) => {
  const { tenantId } = req.user
  const { search = '', stageId } = req.query

  const stages = await prisma.stage.findMany({
    where: { tenantId },
    orderBy: { order: 'asc' },
    include: {
      deals: {
        where: {
          tenantId,
          ...(stageId && { stageId }),
          ...(search && { title: { contains: search, mode: 'insensitive' } }),
        },
        include: { contact: { select: { id: true, name: true, phone: true } } },
        orderBy: { updatedAt: 'desc' },
      },
    },
  })

  const kanban = stages.map(s => ({
    id: s.id,
    name: s.name,
    color: s.color,
    order: s.order,
    totalValue: s.deals.reduce((sum, d) => sum + Number(d.value), 0),
    deals: s.deals,
  }))

  res.json(kanban)
})

// GET /deals/:id
router.get('/:id', async (req, res) => {
  const { tenantId } = req.user
  const deal = await prisma.deal.findFirst({
    where: { id: req.params.id, tenantId },
    include: {
      contact: true,
      stage: true,
      activities: { orderBy: { createdAt: 'desc' }, take: 20 },
    },
  })
  if (!deal) return res.status(404).json({ error: 'Negócio não encontrado.' })
  res.json(deal)
})

// POST /deals
router.post('/', async (req, res) => {
  const { tenantId, userId } = req.user
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const stage = await prisma.stage.findFirst({ where: { id: parsed.data.stageId, tenantId } })
  if (!stage) return res.status(400).json({ error: 'Estágio inválido.' })

  const deal = await prisma.deal.create({ data: { tenantId, ...parsed.data } })
  await prisma.activity.create({ data: { tenantId, userId, dealId: deal.id, contactId: deal.contactId, type: 'deal_created', content: `Negócio "${deal.title}" criado em "${stage.name}".` } })

  res.status(201).json(deal)
})

// PATCH /deals/:id — atualiza campos ou muda de estágio
router.patch('/:id', async (req, res) => {
  const { tenantId, userId } = req.user
  const existing = await prisma.deal.findFirst({ where: { id: req.params.id, tenantId }, include: { stage: true } })
  if (!existing) return res.status(404).json({ error: 'Negócio não encontrado.' })

  const parsed = schema.partial().safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  // Se está fechando o negócio (stage com nome "Fechado")
  let closedAt = existing.closedAt
  if (parsed.data.stageId && parsed.data.stageId !== existing.stageId) {
    const newStage = await prisma.stage.findUnique({ where: { id: parsed.data.stageId } })
    if (newStage?.name === 'Fechado' && !closedAt) closedAt = new Date()
    if (newStage && newStage.name !== 'Fechado') closedAt = null

    await prisma.activity.create({ data: { tenantId, userId, dealId: existing.id, contactId: existing.contactId, type: 'stage_change', content: `Negócio movido de "${existing.stage.name}" para "${newStage?.name}".` } })
  }

  const deal = await prisma.deal.update({ where: { id: req.params.id }, data: { ...parsed.data, closedAt } })
  res.json(deal)
})

// DELETE /deals/:id
router.delete('/:id', async (req, res) => {
  const { tenantId } = req.user
  const existing = await prisma.deal.findFirst({ where: { id: req.params.id, tenantId } })
  if (!existing) return res.status(404).json({ error: 'Negócio não encontrado.' })

  await prisma.deal.delete({ where: { id: req.params.id } })
  res.status(204).send()
})

export default router
