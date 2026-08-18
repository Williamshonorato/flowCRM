import XLSX from 'xlsx'

// Lê um arquivo CSV ou XLSX e retorna as linhas como objetos {coluna: valor}
export function parseRows(buffer, filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase()

  if (ext === 'csv') {
    const text = buffer.toString('utf-8')
    const lines = text.trim().split('\n')
    if (!lines.length) return []
    const sep = lines[0].includes(';') ? ';' : ','
    const headers = lines[0].split(sep).map(h => h.trim().replace(/^"|"$/g, ''))
    return lines.slice(1).map(l => {
      const vals = l.split(sep).map(v => v.trim().replace(/^"|"$/g, ''))
      const obj = {}
      headers.forEach((h, i) => { obj[h] = vals[i] || '' })
      return obj
    })
  }

  const wb = XLSX.read(buffer, { type: 'buffer' })
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' })
}
