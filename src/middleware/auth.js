import jwt from 'jsonwebtoken'
import prisma from '../lib/prisma.js'

export async function requireAuth(req, res, next) {
  // Ferramentas externas (Zapier, Make, scripts) autenticam com a API key do tenant
  const apiKey = req.headers['x-api-key']
  if (apiKey) {
    const tenant = await prisma.tenant.findUnique({ where: { apiKey } })
    if (!tenant) return res.status(401).json({ error: 'API key inválida.' })
    req.user = { tenantId: tenant.id, userId: null, role: 'api', email: null }
    return next()
  }

  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não fornecido.' })
  }
  try {
    const token = header.slice(7)
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    req.user = payload   // { userId, tenantId, role, email }
    next()
  } catch {
    res.status(401).json({ error: 'Token inválido ou expirado.' })
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso restrito a administradores.' })
  }
  next()
}
