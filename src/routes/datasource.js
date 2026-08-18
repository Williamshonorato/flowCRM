import { Router } from 'express'
import { Client as PgClient } from 'pg'
import mysql from 'mysql2/promise'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { importMemberRows } from '../lib/memberImport.js'

const router = Router()
router.use(requireAuth)

const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

function assertValidIdentifier(name, label) {
  if (!IDENTIFIER_RE.test(name)) throw new Error(`${label} inválido: "${name}".`)
}

// Abre uma conexão de curta duração com o banco externo do cliente.
// Suporta apenas leitura — nunca fazemos INSERT/UPDATE/DELETE no banco de terceiros.
async function withConnection(conn, fn) {
  const { dbType, host, port, database, user, password, ssl } = conn

  if (dbType === 'postgresql') {
    const client = new PgClient({
      host, port: Number(port) || 5432, database, user, password,
      ssl: ssl ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 8000,
    })
    await client.connect()
    try { return await fn({ dbType, client }) } finally { await client.end() }
  }

  if (dbType === 'mysql') {
    const connection = await mysql.createConnection({
      host, port: Number(port) || 3306, database, user, password,
      ssl: ssl ? {} : undefined,
      connectTimeout: 8000,
    })
    try { return await fn({ dbType, client: connection }) } finally { await connection.end() }
  }

  throw new Error('Tipo de banco não suportado. Use "postgresql" ou "mysql".')
}

async function listTables({ dbType, client }) {
  if (dbType === 'postgresql') {
    const r = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`)
    return r.rows.map(r => r.table_name)
  }
  const [rows] = await client.query(`SHOW TABLES`)
  return rows.map(r => Object.values(r)[0])
}

async function listColumns({ dbType, client }, table) {
  assertValidIdentifier(table, 'Tabela')
  if (dbType === 'postgresql') {
    const r = await client.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [table]
    )
    return r.rows.map(r => ({ name: r.column_name, type: r.data_type }))
  }
  const [rows] = await client.query(`SHOW COLUMNS FROM \`${table}\``)
  return rows.map(r => ({ name: r.Field, type: r.Type }))
}

async function fetchSample({ dbType, client }, table, limit = 5) {
  assertValidIdentifier(table, 'Tabela')
  if (dbType === 'postgresql') {
    const r = await client.query(`SELECT * FROM "${table}" LIMIT $1`, [limit])
    return r.rows
  }
  const [rows] = await client.query(`SELECT * FROM \`${table}\` LIMIT ?`, [limit])
  return rows
}

async function fetchAll({ dbType, client }, table, cap = 5000) {
  assertValidIdentifier(table, 'Tabela')
  if (dbType === 'postgresql') {
    const r = await client.query(`SELECT * FROM "${table}" LIMIT $1`, [cap])
    return r.rows
  }
  const [rows] = await client.query(`SELECT * FROM \`${table}\` LIMIT ?`, [cap])
  return rows
}

// POST /datasource/test — testa a conexão e já devolve a lista de tabelas
router.post('/test', async (req, res) => {
  const { dbType, host, port, database, user, password, ssl } = req.body
  if (!dbType || !host || !database || !user) {
    return res.status(400).json({ error: 'dbType, host, database e user são obrigatórios.' })
  }
  try {
    const tables = await withConnection({ dbType, host, port, database, user, password, ssl }, listTables)
    res.json({ ok: true, tables })
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message })
  }
})

// POST /datasource/columns — { ...conexão, table }
router.post('/columns', async (req, res) => {
  const { dbType, host, port, database, user, password, ssl, table } = req.body
  try {
    const columns = await withConnection({ dbType, host, port, database, user, password, ssl }, (c) => listColumns(c, table))
    const sample = await withConnection({ dbType, host, port, database, user, password, ssl }, (c) => fetchSample(c, table))
    res.json({ columns, sample })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// GET /datasource — status da conexão salva (sem a senha)
router.get('/', async (req, res) => {
  const integration = await prisma.integration.findUnique({ where: { tenantId_type: { tenantId: req.user.tenantId, type: 'external_db' } } })
  if (!integration || integration.status !== 'connected') return res.json({ connected: false })
  const { password, ...rest } = integration.config || {}
  res.json({ connected: true, ...rest })
})

// POST /datasource/save — salva a conexão testada (config fica no Integration, como as outras integrações)
router.post('/save', async (req, res) => {
  const { tenantId } = req.user
  const { dbType, host, port, database, user, password, ssl } = req.body
  if (!dbType || !host || !database || !user) {
    return res.status(400).json({ error: 'dbType, host, database e user são obrigatórios.' })
  }

  try {
    await withConnection({ dbType, host, port, database, user, password, ssl }, listTables)
  } catch (err) {
    return res.status(400).json({ error: `Não foi possível conectar: ${err.message}` })
  }

  const integration = await prisma.integration.upsert({
    where: { tenantId_type: { tenantId, type: 'external_db' } },
    create: { tenantId, type: 'external_db', status: 'connected', lastSync: new Date(), config: { dbType, host, port, database, user, password, ssl } },
    update: { status: 'connected', lastSync: new Date(), config: { dbType, host, port, database, user, password, ssl } },
  })
  const { password: _pw, ...rest } = integration.config
  res.json({ connected: true, ...rest })
})

// POST /datasource/import — { table, mapping, target: 'member' } usando a conexão já salva
router.post('/import', async (req, res) => {
  const { tenantId } = req.user
  const { table, mapping, target = 'member' } = req.body
  if (!table || !mapping) return res.status(400).json({ error: 'table e mapping são obrigatórios.' })
  if (target !== 'member') return res.status(400).json({ error: 'Por enquanto só é possível importar Inscritos do banco externo.' })

  const integration = await prisma.integration.findUnique({ where: { tenantId_type: { tenantId, type: 'external_db' } } })
  if (!integration || integration.status !== 'connected') return res.status(400).json({ error: 'Nenhum banco de dados externo conectado.' })

  try {
    const rows = await withConnection(integration.config, (c) => fetchAll(c, table))
    const result = await importMemberRows(tenantId, rows, mapping)
    await prisma.integration.update({ where: { id: integration.id }, data: { lastSync: new Date() } })
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// DELETE /datasource — desconecta e apaga as credenciais salvas
router.delete('/', async (req, res) => {
  await prisma.integration.updateMany({ where: { tenantId: req.user.tenantId, type: 'external_db' }, data: { status: 'disconnected', config: {} } })
  res.status(204).send()
})

export default router
