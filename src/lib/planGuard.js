import prisma from './prisma.js'
import { integrationAllowed, moduleAllowed } from './plans.js'

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

// Middleware pra um módulo inteiro do CRM (Pipeline, Disparos) que pode ficar de fora do plano.
export function requireModule(module) {
  return async (req, res, next) => {
    if (moduleAllowed(await tenantPlan(req.user.tenantId), module)) return next()
    res.status(403).json({ error: 'Esse recurso não está disponível no seu plano. Fale com a gente pra fazer upgrade.', code: 'PLAN_LIMIT' })
  }
}
