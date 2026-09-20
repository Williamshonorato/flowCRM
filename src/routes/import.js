import { Router } from 'express'
import multer from 'multer'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { parseRows } from '../lib/fileParser.js'

const router = Router()
router.use(requireAuth)

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

// POST /import/preview — lê o arquivo e retorna colunas + primeiras linhas (sem salvar)
router.post('/preview', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado.' })

  const rows = parseRows(req.file.buffer, req.file.originalname)

  if (!rows.length) return res.status(400).json({ error: 'Arquivo vazio.' })

  const headers = Object.keys(rows[0])
  const sample = rows.slice(0, 5)
  res.json({ headers, sample, totalRows: rows.length })
})

// POST /import/execute — importa de fato os contatos
router.post('/execute', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado.' })

  const { tenantId } = req.user
  // mapping: JSON string de { sheetColumn: crmField }
  let mapping
  try { mapping = JSON.parse(req.body.mapping || '{}') } catch { return res.status(400).json({ error: 'Mapeamento inválido.' }) }

  const rows = parseRows(req.file.buffer, req.file.originalname)

  const log = await prisma.importLog.create({
    data: { tenantId, fileName: req.file.originalname, totalRows: rows.length, status: 'processing' }
  })

  let imported = 0, duplicates = 0, errors = 0
  // e-mails comparados em minúsculas: "Ana@x.com" e "ana@x.com" são o mesmo contato
  const existingEmails = new Set(
    (await prisma.contact.findMany({ where: { tenantId, email: { not: null } }, select: { email: true } })).map(c => c.email.toLowerCase())
  )

  for (const row of rows) {
    try {
      const mapped = {}
      for (const [col, field] of Object.entries(mapping)) {
        if (field && row[col] !== undefined) mapped[field] = String(row[col]).trim()
      }

      if (!mapped.nome || !mapped.nome.trim()) { errors++; continue }

      // Verifica duplicata por e-mail
      if (mapped.email && existingEmails.has(mapped.email.toLowerCase())) { duplicates++; continue }

      const customData = {}
      for (const [k, v] of Object.entries(mapped)) {
        if (!['nome','email','telefone','empresa','origem','temperatura'].includes(k)) customData[k] = v
      }

      await prisma.contact.create({
        data: {
          tenantId,
          name:        mapped.nome || '',
          email:       mapped.email || null,
          phone:       mapped.telefone || null,
          company:     mapped.empresa || null,
          origin:      mapped.origem || null,
          temperature: 'new',
          customData,
        }
      })

      if (mapped.email) existingEmails.add(mapped.email.toLowerCase())
      imported++
    } catch { errors++ }
  }

  await prisma.importLog.update({
    where: { id: log.id },
    data: { imported, duplicates, errors, status: 'done' }
  })

  res.json({ logId: log.id, imported, duplicates, errors, total: rows.length })
})

// GET /import/logs — histórico de importações
router.get('/logs', async (req, res) => {
  const logs = await prisma.importLog.findMany({
    where: { tenantId: req.user.tenantId },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  res.json(logs)
})

export default router
