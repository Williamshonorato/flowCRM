import jwt from 'jsonwebtoken'
import prisma from '../lib/prisma.js'

export async function requireAuth(req, res, next) {
  // Ferramentas externas (Zapier, Make, scripts) autenticam com a API key do tenant
  const apiKey = req.headers['x-api-key']
  if (apiKey) {
    const tenant = await prisma.tenant.findUnique({ where: { apiKey } })
    if (!tenant) return res.status(401).json({ error: 'API key inválida.' })
    if (!tenant.active) return res.status(403).json({ error: 'Essa empresa está com o acesso suspenso.' })
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
    // Sem tenantId o Prisma trata o filtro como "ausente" em vez de barrar a query —
    // isso vazaria dados de todos os tenants se um token de outro tipo chegasse aqui.
    if (!payload.tenantId || !payload.userId) return res.status(401).json({ error: 'Token inválido ou expirado.' })
    // Confere no banco a cada request (não só no login), senão o JWT de até 7 dias
    // sobrevive a tudo: usuário desativado/removido, empresa suspensa, papel rebaixado e
    // platformRole revogado continuariam valendo até o token expirar sozinho.
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { active: true, role: true, email: true, platformRole: true, tenantId: true, tenant: { select: { active: true } } },
    })
    if (!user || !user.active || user.tenantId !== payload.tenantId) return res.status(401).json({ error: 'Token inválido ou expirado.' })
    if (!user.tenant?.active) return res.status(403).json({ error: 'Essa empresa está com o acesso suspenso.' })
    // "Visualizador" é somente leitura: antes o papel existia na tela de equipe mas nenhuma rota
    // o respeitava (um viewer apagava contatos e disparava mensagens em massa). A única
    // escrita liberada é a da própria conta (nome/senha).
    if (user.role === 'viewer' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.originalUrl.startsWith('/settings/account')) {
      return res.status(403).json({ error: 'Seu perfil é somente leitura (visualizador).' })
    }
    // role/platformRole vêm do BANCO (o que está no token pode estar desatualizado)
    req.user = { ...payload, role: user.role, email: user.email, platformRole: user.platformRole || undefined }   // { userId, tenantId, role, email, platformRole }
    next()
  } catch {
    res.status(401).json({ error: 'Token inválido ou expirado.' })
  }
}

// Token aceito em /gmail|/calendar|/outlook/connect?token=... — o navegador é redirecionado
// pro provedor OAuth, então não dá pra mandar header Authorization e o token vai na URL
// (histórico, logs de proxy, Referer). Por isso o frontend usa um TICKET curto (2 min) e de
// finalidade única (POST /auth/oauth-ticket) em vez do JWT da sessão. Sessão antiga
// ainda é aceita (só de admin) pra não quebrar quem está com a tela aberta durante o deploy.
export function verifyConnectToken(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET)
  if (!payload.tenantId) throw new Error('token sem empresa')
  if (payload.purpose === 'oauth-connect') return payload
  if (payload.purpose) throw new Error('token de outra finalidade')   // ex.: state do login com Google
  if (payload.role !== 'admin') throw new Error('só admin conecta integrações')
  return payload
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso restrito a administradores.' })
  }
  next()
}

// Acesso ao painel da plataforma (ver/gerenciar todas as empresas) — mesmo login e
// mesmo token de sempre, só que com platformRole setado no usuário.
export function requirePlatformRole(req, res, next) {
  if (!['owner', 'superadmin'].includes(req.user?.platformRole)) {
    return res.status(403).json({ error: 'Acesso restrito ao painel da plataforma.' })
  }
  next()
}

export function requirePlatformOwner(req, res, next) {
  if (req.user?.platformRole !== 'owner') {
    return res.status(403).json({ error: 'Acesso restrito ao owner da plataforma.' })
  }
  next()
}
