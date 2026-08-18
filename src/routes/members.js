import { Router } from 'express'
import { z } from 'zod'
import multer from 'multer'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { parseRows } from '../lib/fileParser.js'
import { importMemberRows } from '../lib/memberImport.js'

const router = Router()
router.use(requireAuth)

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

const memberSchema = z.object({
  name:         z.string().min(1),
  document:     z.string().optional(),
  registration: z.string().optional(),
  rank:         z.string().optional(),
  email:        z.string().email().optional().or(z.literal('')),
  phone:        z.string().optional(),
  status:       z.enum(['active', 'inactive']).default('active'),
  joinedAt:     z.string().optional(),
  notes:        z.string().optional(),
  customData:   z.record(z.any()).optional().default({}),
})

const contributionSchema = z.object({
  amount:    z.number().min(0),
  dueDate:   z.string(),
  paidAt:    z.string().optional(),
  status:    z.enum(['pending', 'paid', 'overdue']).default('pending'),
  reference: z.string().optional(),
})

// GET /members?search=&status=&page=1&limit=20
router.get('/', async (req, res) => {
  const { tenantId } = req.user
  const { search = '', status, page = '1', limit = '20' } = req.query
  const skip = (Number(page) - 1) * Number(limit)

  const where = {
    tenantId,
    ...(search && { OR: [
      { name: { contains: search, mode: 'insensitive' } },
      { document: { contains: search } },
      { registration: { contains: search } },
    ]}),
    ...(status && { status }),
  }

  const [total, members] = await Promise.all([
    prisma.member.count({ where }),
    prisma.member.findMany({
      where,
      skip, take: Number(limit),
      orderBy: { name: 'asc' },
      include: { _count: { select: { contributions: true } } },
    }),
  ])

  res.json({ total, page: Number(page), limit: Number(limit), members })
})

// GET /members/:id — detalhe + contribuições
router.get('/:id', async (req, res) => {
  const { tenantId } = req.user
  const member = await prisma.member.findFirst({
    where: { id: req.params.id, tenantId },
    include: { contributions: { orderBy: { dueDate: 'desc' } } },
  })
  if (!member) return res.status(404).json({ error: 'Inscrito não encontrado.' })

  const totals = member.contributions.reduce((acc, c) => {
    if (c.status === 'paid') acc.paid += Number(c.amount)
    else acc.pending += Number(c.amount)
    return acc
  }, { paid: 0, pending: 0 })

  res.json({ ...member, totals })
})

// POST /members
router.post('/', async (req, res) => {
  const { tenantId } = req.user
  const parsed = memberSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  if (parsed.data.document) {
    const dup = await prisma.member.findFirst({ where: { tenantId, document: parsed.data.document } })
    if (dup) return res.status(409).json({ error: 'Já existe um inscrito com esse CPF/documento.', existing: dup })
  }

  const member = await prisma.member.create({
    data: { tenantId, ...parsed.data, joinedAt: parsed.data.joinedAt ? new Date(parsed.data.joinedAt) : undefined },
  })
  res.status(201).json(member)
})

// PATCH /members/:id
router.patch('/:id', async (req, res) => {
  const { tenantId } = req.user
  const existing = await prisma.member.findFirst({ where: { id: req.params.id, tenantId } })
  if (!existing) return res.status(404).json({ error: 'Inscrito não encontrado.' })

  const parsed = memberSchema.partial().safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const member = await prisma.member.update({
    where: { id: req.params.id },
    data: { ...parsed.data, ...(parsed.data.joinedAt && { joinedAt: new Date(parsed.data.joinedAt) }) },
  })
  res.json(member)
})

// DELETE /members/:id
router.delete('/:id', async (req, res) => {
  const { tenantId } = req.user
  const existing = await prisma.member.findFirst({ where: { id: req.params.id, tenantId } })
  if (!existing) return res.status(404).json({ error: 'Inscrito não encontrado.' })
  await prisma.member.delete({ where: { id: req.params.id } })
  res.status(204).send()
})

// ── CONTRIBUIÇÕES ──────────────────────────────────────────────────────────────

// POST /members/:id/contributions
router.post('/:id/contributions', async (req, res) => {
  const { tenantId } = req.user
  const member = await prisma.member.findFirst({ where: { id: req.params.id, tenantId } })
  if (!member) return res.status(404).json({ error: 'Inscrito não encontrado.' })

  const parsed = contributionSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const contribution = await prisma.contribution.create({
    data: {
      tenantId, memberId: member.id, ...parsed.data,
      dueDate: new Date(parsed.data.dueDate),
      paidAt: parsed.data.paidAt ? new Date(parsed.data.paidAt) : (parsed.data.status === 'paid' ? new Date() : null),
    },
  })
  res.status(201).json(contribution)
})

// PATCH /members/:memberId/contributions/:id
router.patch('/:memberId/contributions/:id', async (req, res) => {
  const { tenantId } = req.user
  const existing = await prisma.contribution.findFirst({ where: { id: req.params.id, memberId: req.params.memberId, tenantId } })
  if (!existing) return res.status(404).json({ error: 'Contribuição não encontrada.' })

  const parsed = contributionSchema.partial().safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const data = { ...parsed.data }
  if (data.dueDate) data.dueDate = new Date(data.dueDate)
  if (data.paidAt) data.paidAt = new Date(data.paidAt)
  if (data.status === 'paid' && !existing.paidAt && !data.paidAt) data.paidAt = new Date()
  if (data.status && data.status !== 'paid') data.paidAt = null

  const contribution = await prisma.contribution.update({ where: { id: req.params.id }, data })
  res.json(contribution)
})

// DELETE /members/:memberId/contributions/:id
router.delete('/:memberId/contributions/:id', async (req, res) => {
  const { tenantId } = req.user
  const existing = await prisma.contribution.findFirst({ where: { id: req.params.id, memberId: req.params.memberId, tenantId } })
  if (!existing) return res.status(404).json({ error: 'Contribuição não encontrada.' })
  await prisma.contribution.delete({ where: { id: req.params.id } })
  res.status(204).send()
})

// ── IMPORTAÇÃO POR PLANILHA ────────────────────────────────────────────────────

// POST /members/import/preview
router.post('/import/preview', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado.' })
  const rows = parseRows(req.file.buffer, req.file.originalname)
  if (!rows.length) return res.status(400).json({ error: 'Arquivo vazio.' })
  res.json({ headers: Object.keys(rows[0]), sample: rows.slice(0, 5), totalRows: rows.length })
})

// POST /members/import/execute — mapping: JSON { coluna: 'name'|'document'|'registration'|'rank'|'email'|'phone' }
router.post('/import/execute', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado.' })
  const { tenantId } = req.user
  const mapping = JSON.parse(req.body.mapping || '{}')
  const rows = parseRows(req.file.buffer, req.file.originalname)

  const result = await importMemberRows(tenantId, rows, mapping)
  res.json(result)
})

export default router
