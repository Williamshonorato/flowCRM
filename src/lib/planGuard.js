import prisma from './prisma.js'
import { integrationAllowed } from './plans.js'

export const PLAN_BLOCKED_ERROR = 'Essa integração não está disponível no seu plano. Fale com a gente pra fazer upgrade.'

export async function tenantPlan(tenantId) {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } })
  return t?.plan
}

// Middleware pras rotas autenticadas de uma integração (Gmail, Agenda, Outlook, banco próprio...).
export function requireIntegration(type) {
  return async (req, res, next) => {
    if (integrationAllowed(await tenantPlan(req.user.tenantId), type)) return next()
    res.status(403).json({ error: PLAN_BLOCKED_ERROR, code: 'PLAN_LIMIT' })
  }
}
