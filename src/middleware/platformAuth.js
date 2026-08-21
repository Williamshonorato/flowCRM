import jwt from 'jsonwebtoken'

// Autenticação separada da de tenant — usa PLATFORM_JWT_SECRET, uma chave diferente
// de JWT_SECRET, então um token de admin nunca é aceito por engano pelas rotas de
// tenant (requireAuth), e vice-versa.
export function requirePlatformAdmin(req, res, next) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não fornecido.' })
  }
  try {
    const token = header.slice(7)
    const payload = jwt.verify(token, process.env.PLATFORM_JWT_SECRET)
    if (!payload.adminId) return res.status(401).json({ error: 'Token inválido ou expirado.' })
    req.admin = payload   // { adminId, role, email }
    next()
  } catch {
    res.status(401).json({ error: 'Token inválido ou expirado.' })
  }
}

export function requireOwner(req, res, next) {
  if (req.admin?.role !== 'owner') {
    return res.status(403).json({ error: 'Acesso restrito ao owner da plataforma.' })
  }
  next()
}
