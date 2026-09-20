import prisma from './prisma.js'

// Aplica o mapeamento {coluna: campo} sobre as linhas e cria os Inscritos.
// Usado tanto pela importação de planilha quanto pela de banco de dados externo.
export async function importMemberRows(tenantId, rows, mapping) {
  let imported = 0, duplicates = 0, errors = 0
  // Documento comparado só pelos dígitos: "123.456.789-00" e "12345678900" são o mesmo CPF
  // (a comparação exata deixava importar o mesmo inscrito de novo com outra formatação).
  const digits = (v) => String(v || '').replace(/\D/g, '')
  const existingDocs = new Set(
    (await prisma.member.findMany({ where: { tenantId, document: { not: null } }, select: { document: true } })).map(m => digits(m.document)).filter(Boolean)
  )

  for (const row of rows) {
    try {
      const mapped = {}
      for (const [col, field] of Object.entries(mapping)) {
        if (field && row[col] !== undefined && row[col] !== null) mapped[field] = String(row[col]).trim()
      }
      if (!mapped.name) { errors++; continue }
      if (mapped.document && digits(mapped.document) && existingDocs.has(digits(mapped.document))) { duplicates++; continue }

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
      if (mapped.document && digits(mapped.document)) existingDocs.add(digits(mapped.document))
      imported++
    } catch {
      errors++
    }
  }

  return { imported, duplicates, errors, total: rows.length }
}
