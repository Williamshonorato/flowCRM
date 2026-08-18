import prisma from './prisma.js'

// Aplica o mapeamento {coluna: campo} sobre as linhas e cria os Inscritos.
// Usado tanto pela importação de planilha quanto pela de banco de dados externo.
export async function importMemberRows(tenantId, rows, mapping) {
  let imported = 0, duplicates = 0, errors = 0
  const existingDocs = new Set(
    (await prisma.member.findMany({ where: { tenantId, document: { not: null } }, select: { document: true } })).map(m => m.document)
  )

  for (const row of rows) {
    try {
      const mapped = {}
      for (const [col, field] of Object.entries(mapping)) {
        if (field && row[col] !== undefined && row[col] !== null) mapped[field] = String(row[col]).trim()
      }
      if (!mapped.name) { errors++; continue }
      if (mapped.document && existingDocs.has(mapped.document)) { duplicates++; continue }

      await prisma.member.create({
        data: {
          tenantId,
          name: mapped.name,
          document: mapped.document || null,
          registration: mapped.registration || null,
          rank: mapped.rank || null,
          email: mapped.email || null,
          phone: mapped.phone || null,
        },
      })
      if (mapped.document) existingDocs.add(mapped.document)
      imported++
    } catch {
      errors++
    }
  }

  return { imported, duplicates, errors, total: rows.length }
}
