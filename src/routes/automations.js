import { Router } from 'express'
import { z } from 'zod'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { startFlowRun } from '../lib/automationEngine.js'

const router = Router()
router.use(requireAuth)

const stepSchema = z.object({
  id:     z.string(),
  type:   z.string(),
  config: z.record(z.any()).optional().default({}),
})

const flowSchema = z.object({
  name:          z.string().min(1),
  description:   z.string().optional(),
  active:        z.boolean().default(true),
  triggerType:   z.enum(['contact_created', 'deal_created', 'deal_stage_changed', 'deal_closed', 'manual']),
  triggerConfig: z.record(z.any()).optional().default({}),
  steps:         z.array(stepSchema).default([]),
})

// GET /automations/flows
router.get('/flows', async (req, res) => {
  const { tenantId } = req.user
  const flows = await prisma.automationFlow.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { runs: true } } },
  })
  res.json(flows)
})

// GET /automations/flows/:id
router.get('/flows/:id', async (req, res) => {
  const { tenantId } = req.user
  const flow = await prisma.automationFlow.findFirst({ where: { id: req.params.id, tenantId } })
  if (!flow) return res.status(404).json({ error: 'Fluxo não encontrado.' })
  res.json(flow)
})

// POST /automations/flows
router.post('/flows', async (req, res) => {
  const { tenantId } = req.user
  const parsed = flowSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  const flow = await prisma.automationFlow.create({ data: { tenantId, ...parsed.data } })
  res.status(201).json(flow)
})

// PATCH /automations/flows/:id — substitui nome/gatilho/passos (a lista de steps inteira, o que
// permite adicionar/remover/reordenar quantos passos e opções o usuário quiser de uma vez)
router.patch('/flows/:id', async (req, res) => {
  const { tenantId } = req.user
  const existing = await prisma.automationFlow.findFirst({ where: { id: req.params.id, tenantId } })
  if (!existing) return res.status(404).json({ error: 'Fluxo não encontrado.' })

  const parsed = flowSchema.partial().safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const flow = await prisma.automationFlow.update({ where: { id: req.params.id }, data: parsed.data })
  res.json(flow)
})

// DELETE /automations/flows/:id
router.delete('/flows/:id', async (req, res) => {
  const { tenantId } = req.user
  const existing = await prisma.automationFlow.findFirst({ where: { id: req.params.id, tenantId } })
  if (!existing) return res.status(404).json({ error: 'Fluxo não encontrado.' })
  await prisma.automationFlow.delete({ where: { id: req.params.id } })
  res.status(204).send()
})

// POST /automations/flows/:id/run — dispara manualmente pra um contato/negócio específico
router.post('/flows/:id/run', async (req, res) => {
  const { tenantId } = req.user
  const flow = await prisma.automationFlow.findFirst({ where: { id: req.params.id, tenantId } })
  if (!flow) return res.status(404).json({ error: 'Fluxo não encontrado.' })

  const { contactId, dealId } = req.body
  if (!contactId && !dealId) return res.status(400).json({ error: 'Informe contactId ou dealId.' })
  if (contactId) {
    const c = await prisma.contact.findFirst({ where: { id: contactId, tenantId } })
    if (!c) return res.status(404).json({ error: 'Contato não encontrado.' })
  }

  const run = await startFlowRun(flow, { contactId, dealId })
  res.status(201).json(run)
})

// GET /automations/flows/:id/runs — histórico de execuções (observabilidade)
router.get('/flows/:id/runs', async (req, res) => {
  const { tenantId } = req.user
  const flow = await prisma.automationFlow.findFirst({ where: { id: req.params.id, tenantId } })
  if (!flow) return res.status(404).json({ error: 'Fluxo não encontrado.' })

  const runs = await prisma.automationFlowRun.findMany({
    where: { flowId: flow.id, tenantId },
    orderBy: { startedAt: 'desc' },
    take: 30,
  })
  const contactIds = [...new Set(runs.map(r => r.contactId).filter(Boolean))]
  const contacts = contactIds.length ? await prisma.contact.findMany({ where: { id: { in: contactIds } }, select: { id: true, name: true } }) : []
  const contactMap = Object.fromEntries(contacts.map(c => [c.id, c.name]))
  const withNames = runs.map(r => ({ ...r, contactName: r.contactId ? contactMap[r.contactId] : null }))
  res.json(withNames)
})

export default router
