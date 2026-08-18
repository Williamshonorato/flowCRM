import { Router } from 'express'
import { z } from 'zod'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { dispatchWebhook } from '../lib/webhooks.js'

const router = Router()
router.use(requireAuth)

const schema = z.object({
  name:        z.string().min(1),
  email:       z.string().email().optional().or(z.literal('')),
  phone:       z.string().optional(),
  company:     z.string().optional(),
  origin:      z.string().optional(),
  temperature: z.enum(['hot','warm','cold','new']).default('new'),
  customData:  z.record(z.any()).optional().default({}),
  notes:       z.string().optional(),
})

// GET /contacts?search=&origin=&stage=&page=1&limit=20
router.get('/', async (req, res) => {
  const { tenantId } = req.user
  const { search = '', origin, temperature, page = '1', limit = '20' } = req.query
  const skip = (Number(page) - 1) * Number(limit)

  const where = {
    tenantId,
    ...(search && { OR: [
      { name: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
      { phone: { contains: search } },
    ]}),
    ...(origin && { origin }),
    ...(temperature && { temperature }),
  }

  const [total, contacts] = await Promise.all([
    prisma.contact.count({ where }),
    prisma.contact.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: Number(limit),
      include: { deals: { select: { value: true, stage: { select: { name: true } } }, orderBy: { updatedAt: 'desc' }, take: 1 } },
    }),
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
    },
  })
  if (!contact) return res.status(404).json({ error: 'Contato não encontrado.' })
  res.json(contact)
})

// POST /contacts
router.post('/', async (req, res) => {
  const { tenantId, userId } = req.user
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  // Detecta duplicata por e-mail
  if (parsed.data.email) {
    const dup = await prisma.contact.findFirst({ where: { tenantId, email: parsed.data.email } })
    if (dup) return res.status(409).json({ error: 'Já existe um contato com esse e-mail.', existing: dup })
  }

  const contact = await prisma.contact.create({ data: { tenantId, ...parsed.data } })

  await prisma.activity.create({ data: { tenantId, userId, contactId: contact.id, type: 'contact_created', content: `Contato "${contact.name}" criado.` } })
  dispatchWebhook(tenantId, 'contact.created', contact)

  res.status(201).json(contact)
})

// PATCH /contacts/:id
router.patch('/:id', async (req, res) => {
  const { tenantId, userId } = req.user
  const existing = await prisma.contact.findFirst({ where: { id: req.params.id, tenantId } })
  if (!existing) return res.status(404).json({ error: 'Contato não encontrado.' })

  const parsed = schema.partial().safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const contact = await prisma.contact.update({ where: { id: req.params.id }, data: parsed.data })
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
