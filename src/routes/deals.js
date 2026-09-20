import { Router } from 'express'
import { z } from 'zod'
import prisma from '../lib/prisma.js'
import { patchSchema } from '../lib/patchSchema.js'
import { requireAuth } from '../middleware/auth.js'
import { dispatchWebhook } from '../lib/webhooks.js'
import { triggerFlows } from '../lib/automationEngine.js'

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
        include: { contact: { select: { id: true, name: true, phone: true, origin: true, temperature: true } } },
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
  if (parsed.data.contactId && !(await prisma.contact.findFirst({ where: { id: parsed.data.contactId, tenantId }, select: { id: true } }))) {
    return res.status(400).json({ error: 'Contato inválido.' })
  }

  // Criado direto no estágio "Fechado" já nasce fechado (senão fica "em aberto" nos relatórios)
  const deal = await prisma.deal.create({ data: { tenantId, ...parsed.data, closedAt: stage.name === 'Fechado' ? new Date() : null } })
  await prisma.activity.create({ data: { tenantId, userId, dealId: deal.id, contactId: deal.contactId, type: 'deal_created', content: `Negócio "${deal.title}" criado em "${stage.name}".` } })
  triggerFlows(tenantId, 'deal_created', { contactId: deal.contactId, dealId: deal.id })

  res.status(201).json(deal)
})

// PATCH /deals/:id — atualiza campos ou muda de estágio
router.patch('/:id', async (req, res) => {
  const { tenantId, userId } = req.user
  const existing = await prisma.deal.findFirst({ where: { id: req.params.id, tenantId }, include: { stage: true } })
  if (!existing) return res.status(404).json({ error: 'Negócio não encontrado.' })

  const parsed = patchSchema(schema).safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  // Tudo que o PATCH referencia (estágio, contato) precisa ser DESTA empresa — antes o
  // estágio era buscado só pelo id (dava pra mover o negócio pro estágio de outra empresa)
  // e um id inexistente estourava 500 depois de já ter gravado atividade e disparado fluxos.
  let newStage = null
  const stageChanged = !!parsed.data.stageId && parsed.data.stageId !== existing.stageId
  if (stageChanged) {
    newStage = await prisma.stage.findFirst({ where: { id: parsed.data.stageId, tenantId } })
    if (!newStage) return res.status(400).json({ error: 'Estágio inválido.' })
  }
  if (parsed.data.contactId && !(await prisma.contact.findFirst({ where: { id: parsed.data.contactId, tenantId }, select: { id: true } }))) {
    return res.status(400).json({ error: 'Contato inválido.' })
  }

  // Se está fechando o negócio (stage com nome "Fechado")
  let closedAt = existing.closedAt
  if (stageChanged) {
    if (newStage.name === 'Fechado' && !closedAt) closedAt = new Date()
    if (newStage.name !== 'Fechado') closedAt = null
  }

  const deal = await prisma.deal.update({ where: { id: req.params.id }, data: { ...parsed.data, closedAt } })

  // Efeitos colaterais só DEPOIS de a mudança ter sido gravada com sucesso
  if (stageChanged) {
    await prisma.activity.create({ data: { tenantId, userId, dealId: existing.id, contactId: existing.contactId, type: 'stage_change', content: `Negócio movido de "${existing.stage.name}" para "${newStage.name}".` } })
    dispatchWebhook(tenantId, 'deal.stage_changed', { dealId: existing.id, title: existing.title, from: existing.stage.name, to: newStage.name })
    triggerFlows(tenantId, 'deal_stage_changed', { contactId: existing.contactId, dealId: existing.id, stageId: parsed.data.stageId })
    if (newStage.name === 'Fechado' && !existing.closedAt) {
      triggerFlows(tenantId, 'deal_closed', { contactId: existing.contactId, dealId: existing.id })
    }
  }

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
