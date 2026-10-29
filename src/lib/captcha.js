// Google reCAPTCHA v2 ("Não sou um robô") no login e no cadastro. Só liga quando as duas
// chaves estão no .env — sem elas o login funciona como antes, sem o quadro.
const VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify'

export function captchaSiteKey() {
  return process.env.RECAPTCHA_SITE_KEY && process.env.RECAPTCHA_SECRET_KEY ? process.env.RECAPTCHA_SITE_KEY : null
}

// Confere com o Google se o token veio de um desafio resolvido de verdade (a tela sozinha
// não prova nada: um robô pode chamar a API direto). Token vale uma vez só.
export async function verifyCaptcha(token) {
  if (!captchaSiteKey()) return true
  if (!token || typeof token !== 'string') return false
  try {
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: process.env.RECAPTCHA_SECRET_KEY, response: token }),
      signal: AbortSignal.timeout(8000),
    })
    const data = await res.json()
    return data.success === true
  } catch (err) {
    // Google fora do ar/inalcançável: deixa passar em vez de trancar todo mundo do lado de
    // fora — o limite de tentativas de senha continua valendo. Resposta "success: false"
    // (desafio não resolvido) nunca cai aqui.
    console.error('recaptcha verify error', err)
    return true
  }
}
