import { Router } from 'express'
import { z } from 'zod'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

const ruleSchema = z.object({
  name:            z.string().min(1),
  inactiveDays:    z.number().int().min(0).default(14),
  frequencyDays:   z.number().int().min(1).default(7),
  messageTemplate: z.string().min(1),
  active:          z.boolean().default(true),
  filters: z.object({
    temperature: z.string().nullable().optional(),
    origin:      z.string().nullable().optional(),
    stageId:     z.string().nullable().optional(),
  }).optional().default({}),
})

// ── helpers ───────────────────────────────────────────────────────────────────

function computeNextRun(frequencyDays) {
  const d = new Date()
  d.setDate(d.getDate() + frequencyDays)
  return d
}

// Encontra contatos elegíveis para uma regra
async function findEligibleContacts(tenantId, rule, limit = 50) {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - rule.inactiveDays)

  const filters = rule.filters || {}

  // Contatos que NÃO receberam esta regra no período de frequência
  const recentlySentIds = await prisma.automationDispatch.findMany({
    where: {
      tenantId,
      ruleId: rule.id,
      sentAt: { gte: new Date(Date.now() - rule.frequencyDays * 86400000) },
    },
    select: { contactId: true },
  })
  const excludeIds = recentlySentIds.map(d => d.contactId)

  const where = {
    tenantId,
    ...(filters.temperature && { temperature: filters.temperature }),
    ...(filters.origin && { origin: filters.origin }),
    ...(excludeIds.length > 0 && { id: { notIn: excludeIds } }),
    // Inativo: updatedAt < cutoff
    updatedAt: { lte: cutoff },
  }

  // Se tem filtro por estágio, filtra pelos deals nesse estágio
  if (filters.stageId) {
    const dealsInStage = await prisma.deal.findMany({
      where: { tenantId, stageId: filters.stageId },
      select: { contactId: true },
    })
    const contactsWithDeal = dealsInStage.map(d => d.contactId).filter(Boolean)
    where.id = { ...(where.id || {}), in: contactsWithDeal }
  }

  const [contacts, total] = await Promise.all([
    prisma.contact.findMany({
      where,
      take: limit,
      orderBy: { updatedAt: 'asc' }, // mais antigos primeiro
      select: {
        id: true, name: true, phone: true, email: true,
        origin: true, temperature: true, company: true,
        updatedAt: true, createdAt: true,
        deals: { take: 1, orderBy: { updatedAt: 'desc' }, select: { title: true, value: true } },
      },
    }),
    prisma.contact.count({ where }),
  ])

  return { contacts, total }
}

function interpolateMessage(template, contact, inactiveDays) {
  const days = Math.floor((Date.now() - new Date(contact.updatedAt)) / 86400000)
  return template
    .replace(/{{nome}}/g, contact.name || '')
    .replace(/{{empresa}}/g, contact.company || '')
    .replace(/{{dias_inativo}}/g, days)
    .replace(/{{ultimo_negocio}}/g, contact.deals?.[0]?.title || 'nosso serviço')
    .replace(/{{segmento}}/g, '')
}

// ── GET /campaigns — lista todas as regras + stats agregados ─────────────────

router.get('/', async (req, res) => {
  const { tenantId } = req.user

  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

  const [rules, sentThisMonth, readThisMonth, repliedThisMonth, convertedThisMonth] = await Promise.all([
    prisma.automationRule.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { dispatches: true } },
      },
    }),
    prisma.automationDispatch.count({ where: { tenantId, sentAt: { gte: monthStart } } }),
    prisma.automationDispatch.count({ where: { tenantId, readAt: { not: null }, sentAt: { gte: monthStart } } }),
    prisma.automationDispatch.count({ where: { tenantId, repliedAt: { not: null }, sentAt: { gte: monthStart } } }),
    prisma.automationDispatch.count({ where: { tenantId, convertedAt: { not: null }, sentAt: { gte: monthStart } } }),
  ])

  const stats = {
    sent:         sentThisMonth,
    readRate:     sentThisMonth > 0 ? Math.round(readThisMonth / sentThisMonth * 100) : 0,
    replyRate:    sentThisMonth > 0 ? Math.round(repliedThisMonth / sentThisMonth * 100) : 0,
    conversions:  convertedThisMonth,
    activeRules:  rules.filter(r => r.active).length,
  }

  res.json({ rules, stats })
})

// ── POST /campaigns ─────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const { tenantId } = req.user
  const parsed = ruleSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const rule = await prisma.automationRule.create({
    data: {
      tenantId,
      ...parsed.data,
      nextRunAt: parsed.data.active ? computeNextRun(parsed.data.frequencyDays) : null,
    },
  })
  res.status(201).json(rule)
})

// ── GET /campaigns/:id/preview — contatos elegíveis ─────────────────────────

router.get('/:id/preview', async (req, res) => {
  const { tenantId } = req.user
  const rule = await prisma.automationRule.findFirst({ where: { id: req.params.id, tenantId } })
  if (!rule) return res.status(404).json({ error: 'Regra não encontrada.' })

  const { contacts, total } = await findEligibleContacts(tenantId, rule, 20)
  res.json({ contacts, total })
})

// ── PATCH /campaigns/:id ─────────────────────────────────────────────────────

router.patch('/:id', async (req, res) => {
  const { tenantId } = req.user
  const existing = await prisma.automationRule.findFirst({ where: { id: req.params.id, tenantId } })
  if (!existing) return res.status(404).json({ error: 'Regra não encontrada.' })

  const parsed = ruleSchema.partial().safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const data = { ...parsed.data }

  // Recalcula próximo disparo se mudar frequência ou ativar
  const newActive = data.active ?? existing.active
  const newFreq   = data.frequencyDays ?? existing.frequencyDays
  if (newActive) {
    data.nextRunAt = computeNextRun(newFreq)
  } else {
    data.nextRunAt = null
  }

  const rule = await prisma.automationRule.update({ where: { id: req.params.id }, data })
  res.json(rule)
})

// ── DELETE /campaigns/:id ────────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
  const { tenantId } = req.user
  const existing = await prisma.automationRule.findFirst({ where: { id: req.params.id, tenantId } })
  if (!existing) return res.status(404).json({ error: 'Regra não encontrada.' })
  await prisma.automationRule.delete({ where: { id: req.params.id } })
  res.status(204).send()
})

// ── POST /campaigns/:id/dispatch — disparo manual ───────────────────────────

router.post('/:id/dispatch', async (req, res) => {
  const { tenantId } = req.user
  const rule = await prisma.automationRule.findFirst({ where: { id: req.params.id, tenantId } })
  if (!rule) return res.status(404).json({ error: 'Regra não encontrada.' })

  const { contacts } = await findEligibleContacts(tenantId, rule, 500)

  let sent = 0, skipped = 0, errors = 0

  for (const contact of contacts) {
    if (!contact.phone && !contact.email) { skipped++; continue }

    const message = interpolateMessage(rule.messageTemplate, contact, rule.inactiveDays)

    try {
      await prisma.automationDispatch.create({
        data: {
          tenantId,
          ruleId:    rule.id,
          contactId: contact.id,
          message,
          status:    'sent',
          sentAt:    new Date(),
        },
      })

      // Atualiza o updatedAt do contato para não ser elegível novamente imediatamente
      await prisma.contact.update({ where: { id: contact.id }, data: { updatedAt: new Date() } })

      sent++
    } catch { errors++ }
  }

  // Atualiza lastRunAt e nextRunAt
  await prisma.automationRule.update({
    where: { id: rule.id },
    data: {
      lastRunAt: new Date(),
      nextRunAt: rule.active ? computeNextRun(rule.frequencyDays) : null,
    },
  })

  res.json({ sent, skipped, errors, total: contacts.length })
})

// ── GET /campaigns/:id/history — histórico de disparos ───────────────────────

router.get('/:id/history', async (req, res) => {
  const { tenantId } = req.user
  const dispatches = await prisma.automationDispatch.findMany({
    where: { tenantId, ruleId: req.params.id },
    orderBy: { sentAt: 'desc' },
    take: 50,
    include: { contact: { select: { id: true, name: true, phone: true } } },
  })
  res.json(dispatches)
})

export default router
