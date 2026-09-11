// FlowCRM — API​‌​‌​‌‌‌​‌‌​‌​​‌​‌‌​‌‌​​​‌‌​‌‌​​​‌‌​‌​​‌​‌‌​​​​‌​‌‌​‌‌​‌​‌‌‌​​‌‌​​‌​​​​​​‌​​​‌‌​​‌‌​​‌​‌​‌‌‌​​‌​​‌‌‌​​‌​​‌‌​​‌​‌​‌‌​‌​​‌​‌‌‌​​‌​​‌‌​​​​‌​​‌​​​​​​​‌​‌‌​‌​​‌​​​​​​‌‌​​​​‌​‌‌‌​‌​‌​‌‌‌​‌​​​‌‌​‌‌‌‌​‌‌‌​​‌​​​‌​​​​​​‌‌​‌‌‌‌​‌‌‌​​‌​​‌‌​‌​​‌​‌‌​​‌‌‌​‌‌​‌​​‌​‌‌​‌‌‌​​‌‌​​​​‌​‌‌​‌‌​​​​‌​​​​​​​‌​‌‌​‌​​‌​​​​​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​​​‌​‌‌​‌​​‌‌​​​​​​‌‌‌​​​​​‌​‌‌​‌​​‌‌​​​‌​​‌‌‌​​​
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, normalize } from 'path'

import authRouter      from './routes/auth.js'
import dashboardRouter from './routes/dashboard.js'
import contactsRouter  from './routes/contacts.js'
import dealsRouter     from './routes/deals.js'
import tasksRouter     from './routes/tasks.js'
import reportsRouter   from './routes/reports.js'
import settingsRouter  from './routes/settings.js'
import importRouter    from './routes/import.js'
import campaignsRouter from './routes/campaigns.js'
import broadcastsRouter from './routes/broadcasts.js'
import whatsappRouter  from './routes/whatsapp.js'
import gmailRouter      from './routes/gmail.js'
import calendarRouter   from './routes/calendar.js'
import outlookRouter    from './routes/outlook.js'
import membersRouter    from './routes/members.js'
import treasuryRouter   from './routes/treasury.js'
import datasourceRouter from './routes/datasource.js'
import automationsRouter from './routes/automations.js'
import platformAdminRouter from './routes/platformAdmin.js'
import { resumeDueRuns } from './lib/automationEngine.js'
import { processBroadcasts } from './lib/broadcastWorker.js'
import { sendError, isBrowserNavigation, errorPageHtml } from './lib/errorPage.js'

const app = express()
const __dirname = dirname(fileURLToPath(import.meta.url))

// ── MIDDLEWARES ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET','POST','PATCH','DELETE','OPTIONS'] }))
app.use(express.json({ limit: '10mb' }))

// O frontend é HTML/JS servido direto (sem build/hash nos nomes), então cache longo
// faz o usuário ficar preso numa versão antiga depois de um deploy. Manda sempre
// revalidar — o custo é um 304 rápido quando nada mudou.
const staticOpts = {
  setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache') },
}

// O "no-cache" acima não é suficiente sozinho: o Cloudflare está configurado pra
// forçar os navegadores a guardar .js em cache por 4h (Browser Cache TTL),
// ignorando esse header — então um deploy novo não chegava em quem já tinha o
// site aberto, só depois de limpar o cache na mão. Em vez de depender de mudar
// isso no painel do Cloudflare, cada boot do servidor (= cada deploy, via
// `pm2 restart`) ganha um ID novo, e todo HTML servido troca a URL dos dois
// scripts compartilhados pra incluir esse ID — como a URL muda, o navegador
// busca de novo na hora, não importa o que tinha em cache.
const PUBLIC_DIR = join(__dirname, '../public')
const BUILD_ID = Date.now().toString(36)
function bustSharedScripts(html) {
  return html
    .replace(/(["'])flowcrm-api\.js(?:\?v=[^"'?]*)?\1/g, `$1flowcrm-api.js?v=${BUILD_ID}$1`)
    .replace(/(["'])crm-sidebar\.js(?:\?v=[^"'?]*)?\1/g, `$1crm-sidebar.js?v=${BUILD_ID}$1`)
}

// Serve todo .html do public/ (e a raiz "/", que aponta pro login) reescrevendo
// os dois <script src> compartilhados; qualquer outro caminho (imagens, o
// próprio flowcrm-api.js, uploads...) passa direto pro express.static de sempre.
function serveHtmlWithCacheBust(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next()
  const reqPath = req.path === '/' ? '/crm-login.html' : req.path
  if (!reqPath.endsWith('.html')) return next()

  const filePath = normalize(join(PUBLIC_DIR, reqPath))
  if (!filePath.startsWith(PUBLIC_DIR)) return next() // fora de public/ — deixa 404 seguir o rito normal

  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) return next() // ex: 404 — deixa o handler padrão cuidar
    res.setHeader('Content-Type', 'text/html; charset=UTF-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.send(bustSharedScripts(html))
  })
}

// Serve os arquivos HTML do frontend em desenvolvimento
app.use('/app', serveHtmlWithCacheBust)
app.use('/app', express.static(PUBLIC_DIR, staticOpts))

// Serve o mesmo frontend também na raiz do site, com a tela de login como
// página padrão — assim https://flowcrm.seculo1.com abre o login sem
// redirecionar/trocar a URL na barra de endereço.
app.use(serveHtmlWithCacheBust)
app.use(express.static(PUBLIC_DIR, { ...staticOpts, index: 'crm-login.html' }))

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.use('/auth',       authRouter)
app.use('/dashboard',  dashboardRouter)
app.use('/contacts',   contactsRouter)
app.use('/deals',      dealsRouter)
app.use('/tasks',      tasksRouter)
app.use('/reports',    reportsRouter)
app.use('/settings',   settingsRouter)
app.use('/import',     importRouter)
app.use('/campaigns',  campaignsRouter)
app.use('/broadcasts', broadcastsRouter)
app.use('/whatsapp',   whatsappRouter)
app.use('/gmail',      gmailRouter)
app.use('/calendar',   calendarRouter)
app.use('/outlook',    outlookRouter)
app.use('/members',    membersRouter)
app.use('/treasury',   treasuryRouter)
app.use('/datasource', datasourceRouter)
app.use('/automations', automationsRouter)
app.use('/platform',   platformAdminRouter)

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() }))

// 404
app.use((req, res) => sendError(req, res, 404, 'A página que você tentou acessar não existe ou foi movida.'))

// Error handler
app.use((err, req, res, next) => {
  console.error(err)
  if (isBrowserNavigation(req)) {
    return res.status(500).type('html').send(errorPageHtml('Ocorreu um erro inesperado. Já estamos cientes — tente novamente em alguns instantes.'))
  }
  res.status(500).json({ error: 'Erro interno do servidor.', detail: err.message })
})

const PORT = process.env.PORT || 3333
app.listen(PORT, () => {
  console.log(`\n⚡ FlowCRM API rodando em http://localhost:${PORT}`)
  console.log(`   Health: http://localhost:${PORT}/health`)
  console.log(`   Frontend: http://localhost:${PORT}/app/crm-login.html\n`)
})

// Retoma passos de automação em espera (ex: "wait") — checa a cada 30s
setInterval(() => { resumeDueRuns().catch(err => console.error('resumeDueRuns falhou', err)) }, 30000)

// Processa a fila de disparos em massa — checa a cada 20s
setInterval(() => { processBroadcasts().catch(err => console.error('processBroadcasts falhou', err)) }, 20000)

export default app
