// Heurísticas simples para extrair informações de mensagens WhatsApp
export function extractName(text) {
  if (!text) return null
  // exemplos: "meu nome é João", "sou João", "chamo-me Ana"
  const patterns = [/meu nome é\s+([A-ZÁÉÍÓÚÇÃÕÂÊÔ][a-záéíóúçãõâêô]+(?:\s+[A-ZÁÉÍÓÚÇÃÕÂÊÔ][a-záéíóúçãõâêô]+)?)/i, /sou\s+([A-ZÁÉÍÓÚÇÃÕÂÊÔ][a-záéíóúçãõâêô]+(?:\s+[A-ZÁÉÍÓÚÇÃÕÂÊÔ][a-záéíóúçãõâêô]+)?)/i, /chamo(?:-me| me)\s+([A-ZÁÉÍÓÚÇÃÕÂÊÔ][a-záéíóúçãõâêô]+)/i]
  for (const p of patterns) {
    const m = text.match(p)
    if (m) return m[1].trim()
  }
  return null
}

export function extractEmail(text) {
  if (!text) return null
  const m = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)
  return m ? m[0] : null
}

export function extractPhone(text) {
  if (!text) return null
  const m = text.match(/\+?\d{8,15}/)
  return m ? m[0].replace(/[^0-9]/g, '') : null
}

export function detectIntent(text) {
  if (!text) return 'unknown'
  const lc = text.toLowerCase()
  if (/orçamen|quero|precis|comprar|valor|preço/.test(lc)) return 'interest'
  if (/agendar|marcar|consulta|visita/.test(lc)) return 'schedule'
  if (/duvida|pergunta|informação|info/.test(lc)) return 'question'
  return 'unknown'
}
