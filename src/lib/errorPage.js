// Tela de erro amigável — usada no lugar do JSON cru quando quem bateu na rota foi
// o navegador navegando direto (ex: um redirect de OAuth), não uma chamada fetch/AJAX
// do próprio frontend. Chamadas de API continuam recebendo JSON normalmente.

export function errorPageHtml(message) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ops — FlowCRM</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #0f172a;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    padding: 24px;
  }
  .card {
    max-width: 440px;
    width: 100%;
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 20px;
    padding: 40px 36px;
    text-align: center;
  }
  .icon {
    width: 64px;
    height: 64px;
    margin: 0 auto 20px;
    border-radius: 50%;
    background: linear-gradient(135deg, #27ae60, #1abc9c);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 28px;
  }
  .brand {
    font-size: 13px;
    font-weight: 700;
    letter-spacing: .04em;
    color: #64748b;
    margin-bottom: 18px;
    text-transform: uppercase;
  }
  .brand span { color: #27ae60; }
  h1 {
    color: #f1f5f9;
    font-size: 20px;
    margin-bottom: 10px;
  }
  p {
    color: #94a3b8;
    font-size: 14.5px;
    line-height: 1.55;
    margin-bottom: 28px;
  }
  button {
    appearance: none;
    border: none;
    cursor: pointer;
    background: linear-gradient(90deg, #27ae60, #1abc9c);
    color: #fff;
    font-size: 14.5px;
    font-weight: 700;
    padding: 13px 28px;
    border-radius: 10px;
    transition: opacity .15s;
  }
  button:hover { opacity: .9; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">⚠️</div>
    <div class="brand">Flow<span>CRM</span></div>
    <h1>Algo não saiu como esperado</h1>
    <p>${message}</p>
    <button onclick="history.length > 1 ? history.back() : (location.href = '/')">← Voltar</button>
  </div>
</body>
</html>`
}

// Diferencia navegação de página inteira (usuário digitou/clicou/foi redirecionado
// pro link) de uma chamada fetch/XHR feita pelo próprio frontend. O header Accept
// sozinho não dá pra confiar: fetch() manda "Accept: */*" por padrão, que empataria
// com "html" numa negociação simples e quebraria o JSON que o app.js espera receber.
// Sec-Fetch-Dest é enviado automaticamente pelo navegador (não dá pra forjar do JS) e
// diz exatamente o tipo de requisição: "document" = navegação de página inteira.
export function isBrowserNavigation(req) {
  const dest = req.get('sec-fetch-dest')
  if (dest) return dest === 'document'
  // Fallback pra clientes sem Fetch Metadata (Safari antigo, curl, bots, etc.)
  const accept = req.get('accept') || ''
  return accept.includes('text/html') && !accept.includes('application/json')
}

// Responde com a tela bonita se quem pediu foi o navegador navegando pra página,
// senão mantém o JSON de sempre pra não quebrar chamadas de API/fetch do frontend.
export function sendError(req, res, status, message) {
  if (isBrowserNavigation(req)) {
    return res.status(status).type('html').send(errorPageHtml(message))
  }
  return res.status(status).json({ error: message })
}
