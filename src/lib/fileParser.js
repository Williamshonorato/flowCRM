import XLSX from 'xlsx'

// Texto de um CSV a partir do buffer. Excel em português costuma salvar CSV em Windows-1252
// (Latin-1), não UTF-8 — decodificar como UTF-8 transformava "João" em "Jo�o". Se o UTF-8
// tem caractere de substituição, refaz como Latin-1. Também tira o BOM do começo, que virava
// parte do nome da primeira coluna ("﻿nome") e quebrava o mapeamento.
function decodeCsv(buffer) {
  let text = buffer.toString('utf-8')
  if (text.includes('�')) text = buffer.toString('latin1')
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
  return text
}

// Parser CSV (RFC 4180): campos entre aspas podem conter separador, quebra de linha e "" (aspa
// escapada) — o split por '\n' + ',' de antes quebrava qualquer campo assim (ex: "Silva, João").
export function parseCsvText(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || ''
  const count = (c) => firstLine.split(c).length - 1
  const sep = [';', '\t', ','].reduce((best, c) => (count(c) > count(best) ? c : best), ',')

  const rows = []
  let row = [], field = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += ch
    } else if (ch === '"' && field === '') inQuotes = true
    else if (ch === sep) { row.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      rows.push(row); row = []
    } else field += ch
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows.filter(r => r.some(c => String(c).trim() !== ''))
}

// Lê um arquivo CSV ou XLSX e retorna as linhas como objetos {coluna: valor}
export function parseRows(buffer, filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase()

  if (ext === 'csv') {
    const [headerRow, ...dataRows] = parseCsvText(decodeCsv(buffer))
    if (!headerRow) return []
    const headers = headerRow.map(h => h.trim())
    return dataRows.map(cells => {
      const obj = {}
      headers.forEach((h, i) => { if (h) obj[h] = (cells[i] ?? '').trim() })
      return obj
    })
  }

  const wb = XLSX.read(buffer, { type: 'buffer' })
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' })
}
