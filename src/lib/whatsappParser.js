// Heurísticas simples para extrair informações de mensagens WhatsApp
export function extractName(text) {
  if (!text) return null
  // exemplos: "meu nome é João", "sou João", "chamo-me Ana"
  // Sem a flag /i de propósito: com ela [A-Z] casava qualquer letra e "estou pensando em comprar"
  // virava nome "pensando". O nome tem que começar com maiúscula, e "sou" como palavra inteira.
  const patterns = [/\b[Mm]eu nome é\s+([A-ZÁÉÍÓÚÇÃÕÂÊÔ][a-záéíóúçãõâêô]+(?:\s+[A-ZÁÉÍÓÚÇÃÕÂÊÔ][a-záéíóúçãõâêô]+)?)/, /\b[Ss]ou\s+([A-ZÁÉÍÓÚÇÃÕÂÊÔ][a-záéíóúçãõâêô]+(?:\s+[A-ZÁÉÍÓÚÇÃÕÂÊÔ][a-záéíóúçãõâêô]+)?)/, /\b[Cc]hamo(?:-me| me)\s+([A-ZÁÉÍÓÚÇÃÕÂÊÔ][a-záéíóúçãõâêô]+)/]
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
