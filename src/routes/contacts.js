import { Router } from 'express'
import { z } from 'zod'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { dispatchWebhook } from '../lib/webhooks.js'
import { triggerFlows } from '../lib/automationEngine.js'

const router = Router()
router.use(requireAuth)

const schema = z.object({
  name:         z.string().min(1),
  email:        z.string().email().optional().or(z.literal('')),
  phone:        z.string().optional(),
  company:      z.string().optional(),
  origin:       z.string().optional(),
  temperature:  z.enum(['hot','warm','cold','new']).default('new'),
  customData:   z.record(z.any()).optional().default({}),
  notes:        z.string().optional(),
  assignedToId: z.string().nullable().optional(),
  // opcionais: se vierem, cria um negócio junto com o contato
  stageId:      z.string().optional(),
  dealValue:    z.number().min(0).optional(),
})

// GET /contacts/filters — opções e contagens reais pro painel de filtros
router.get('/filters', async (req, res) => {
  const { tenantId } = req.user

  const stages = await prisma.stage.findMany({ where: { tenantId }, orderBy: { order: 'asc' } })
  const [stageCounts, noDealCount, originsRaw, team, assigneeCounts, unassignedCount] = await Promise.all([
    Promise.all(stages.map(s => prisma.contact.count({ where: { tenantId, deals: { some: { stageId: s.id } } } }))),
    prisma.contact.count({ where: { tenantId, deals: { none: {} } } }),
    prisma.contact.groupBy({ by: ['origin'], where: { tenantId }, _count: true }),
    prisma.user.findMany({ where: { tenantId, active: true }, select: { id: true, name: true } }),
    prisma.contact.groupBy({ by: ['assignedToId'], where: { tenantId, assignedToId: { not: null } }, _count: true }),
    prisma.contact.count({ where: { tenantId, assignedToId: null } }),
  ])

  res.json({
    stages: stages.map((s, i) => ({ id: s.id, name: s.name, color: s.color, count: stageCounts[i] })),
    noDealCount,
    origins: originsRaw.map(o => ({ value: o.origin, count: o._count })),
    team: team.map(u => ({ id: u.id, name: u.name, count: assigneeCounts.find(a => a.assignedToId === u.id)?._count || 0 })),
    unassignedCount,
  })
})

// GET /contacts?search=&origin=&stageId=&assignedToId=&sort=recent|name|value&page=1&limit=20
router.get('/', async (req, res) => {
  const { tenantId } = req.user
  const { search = '', origin, temperature, stageId, assignedToId, sort = 'recent', page = '1', limit = '20' } = req.query
  const skip = (Number(page) - 1) * Number(limit)

  const AND = [{ tenantId }]
  if (search) AND.push({ OR: [
    { name: { contains: search, mode: 'insensitive' } },
    { email: { contains: search, mode: 'insensitive' } },
    { phone: { contains: search } },
  ]})
  if (origin) AND.push({ origin })
  if (temperature) AND.push({ temperature })
  if (assignedToId) AND.push({ assignedToId: assignedToId === 'unassigned' ? null : assignedToId })

  if (stageId) {
    const ids = String(stageId).split(',').filter(Boolean)
    const realIds = ids.filter(i => i !== 'none')
    const orConds = []
    if (realIds.length) orConds.push({ deals: { some: { stageId: { in: realIds } } } })
    if (ids.includes('none')) orConds.push({ deals: { none: {} } })
    if (orConds.length) AND.push({ OR: orConds })
  }

  const where = { AND }
  const dealsInclude = { deals: { select: { value: true, stage: { select: { name: true } } }, orderBy: { updatedAt: 'desc' }, take: 1 } }
  const assignedToInclude = { assignedTo: { select: { id: true, name: true } } }

  if (sort === 'value') {
    // Prisma não ordena por soma de relação diretamente — busca até 1000 e ordena em memória
    const [total, all] = await Promise.all([
      prisma.contact.count({ where }),
      prisma.contact.findMany({ where, take: 1000, include: { deals: { select: { value: true, stage: { select: { name: true } } } }, ...assignedToInclude } }),
    ])
    all.sort((a, b) => b.deals.reduce((s, d) => s + Number(d.value), 0) - a.deals.reduce((s, d) => s + Number(d.value), 0))
    const contacts = all.slice(skip, skip + Number(limit)).map(c => ({ ...c, deals: c.deals.slice(0, 1) }))
    return res.json({ total, page: Number(page), contacts })
  }

  const orderBy = sort === 'name' ? { name: 'asc' } : { createdAt: 'desc' }

  const [total, contacts] = await Promise.all([
    prisma.contact.count({ where }),
    prisma.contact.findMany({ where, orderBy, skip, take: Number(limit), include: { ...dealsInclude, ...assignedToInclude } }),
  ])

  res.json({ total, page: Number(page), contacts })
})

// GET /contacts/:id
router.get('/:id', async (req, res) => {
  const { tenantId } = req.user
  const contact = await prisma.contact.findFirst({
    where: { id: req.params.id, tenantId },
    include: {
      deals: { include: { stage: true }, orderBy: { createdAt: 'desc' } },
      tasks: { where: { doneAt: null }, orderBy: { dueDate: 'asc' } },
      activities: { orderBy: { createdAt: 'desc' }, take: 20 },
      assignedTo: { select: { id: true, name: true } },
    },
  })
  if (!contact) return res.status(404).json({ error: 'Contato não encontrado.' })
  res.json(contact)
})

// POST /contacts — se vier stageId, cria também um negócio nesse estágio (com dealValue, se informado)
router.post('/', async (req, res) => {
  const { tenantId, userId } = req.user
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  // Detecta duplicata por e-mail
  if (parsed.data.email) {
    const dup = await prisma.contact.findFirst({ where: { tenantId, email: parsed.data.email } })
    if (dup) return res.status(409).json({ error: 'Já existe um contato com esse e-mail.', existing: dup })
  }

  const { stageId, dealValue, ...contactData } = parsed.data
  const contact = await prisma.contact.create({ data: { tenantId, ...contactData } })

  await prisma.activity.create({ data: { tenantId, userId, contactId: contact.id, type: 'contact_created', content: `Contato "${contact.name}" criado.` } })

  if (stageId) {
    const stage = await prisma.stage.findFirst({ where: { id: stageId, tenantId } })
    if (stage) {
      await prisma.deal.create({
        data: { tenantId, contactId: contact.id, stageId, title: contact.name, value: dealValue || 0 },
      })
      await prisma.activity.create({ data: { tenantId, userId, contactId: contact.id, type: 'deal_created', content: `Negócio criado em "${stage.name}".` } })
    }
  }

  dispatchWebhook(tenantId, 'contact.created', contact)
  triggerFlows(tenantId, 'contact_created', { contactId: contact.id })

  const full = await prisma.contact.findUnique({
    where: { id: contact.id },
    include: { deals: { select: { value: true, stage: { select: { name: true } } } }, assignedTo: { select: { id: true, name: true } } },
  })
  res.status(201).json(full)
})

// PATCH /contacts/:id
router.patch('/:id', async (req, res) => {
  const { tenantId, userId } = req.user
  const existing = await prisma.contact.findFirst({ where: { id: req.params.id, tenantId } })
  if (!existing) return res.status(404).json({ error: 'Contato não encontrado.' })

  const parsed = schema.partial().safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { stageId, dealValue, ...contactData } = parsed.data
  const contact = await prisma.contact.update({ where: { id: req.params.id }, data: contactData })
  await prisma.activity.create({ data: { tenantId, userId, contactId: contact.id, type: 'note', content: 'Dados do contato atualizados.' } })

  res.json(contact)
})

// DELETE /contacts/:id
router.delete('/:id', async (req, res) => {
  const { tenantId } = req.user
  const existing = await prisma.contact.findFirst({ where: { id: req.params.id, tenantId } })
  if (!existing) return res.status(404).json({ error: 'Contato não encontrado.' })

  await prisma.contact.delete({ where: { id: req.params.id } })
  res.status(204).send()
})

// POST /contacts/:id/activities — adiciona nota/interação manual
router.post('/:id/activities', async (req, res) => {
  const { tenantId, userId } = req.user
  const { type = 'note', content } = req.body
  if (!content) return res.status(400).json({ error: 'Conteúdo obrigatório.' })

  const contact = await prisma.contact.findFirst({ where: { id: req.params.id, tenantId } })
  if (!contact) return res.status(404).json({ error: 'Contato não encontrado.' })

  const activity = await prisma.activity.create({ data: { tenantId, userId, contactId: req.params.id, type, content } })
  res.status(201).json(activity)
})

export default router
