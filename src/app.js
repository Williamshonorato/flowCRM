import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

import authRouter      from './routes/auth.js'
import dashboardRouter from './routes/dashboard.js'
import contactsRouter  from './routes/contacts.js'
import dealsRouter     from './routes/deals.js'
import tasksRouter     from './routes/tasks.js'
import reportsRouter   from './routes/reports.js'
import settingsRouter  from './routes/settings.js'
import importRouter    from './routes/import.js'
import campaignsRouter from './routes/campaigns.js'
import whatsappRouter  from './routes/whatsapp.js'
import gmailRouter      from './routes/gmail.js'

const app = express()
const __dirname = dirname(fileURLToPath(import.meta.url))

// ── MIDDLEWARES ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET','POST','PATCH','DELETE','OPTIONS'] }))
app.use(express.json({ limit: '10mb' }))

// Serve os arquivos HTML do frontend em desenvolvimento
app.use('/app', express.static(join(__dirname, '../public')))

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
app.use('/whatsapp',   whatsappRouter)
app.use('/gmail',      gmailRouter)

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() }))

// 404
app.use((_, res) => res.status(404).json({ error: 'Rota não encontrada.' }))

// Error handler
app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ error: 'Erro interno do servidor.', detail: err.message })
})

const PORT = process.env.PORT || 3333
app.listen(PORT, () => {
  console.log(`\n⚡ FlowCRM API rodando em http://localhost:${PORT}`)
  console.log(`   Health: http://localhost:${PORT}/health`)
  console.log(`   Frontend: http://localhost:${PORT}/app/crm-login.html\n`)
})

export default app
