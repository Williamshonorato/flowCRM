// Planos à venda no cadastro público — fonte ÚNICA de preço. O valor gravado na empresa
// (monthlyValue) sempre sai daqui, nunca do que o navegador manda, e a tela de cadastro
// lê os mesmos números por GET /auth/plans.
export const PLANS = {
  connected:  { name: 'Conectado',   monthly: 500 },
  enterprise: { name: 'Empresarial', monthly: 1200 },
}
export const ANNUAL_DISCOUNT = 0.10 // desconto pra quem paga o ano inteiro

const cents = (n) => Math.round(n * 100) / 100

// monthly: paga mês a mês. annual: paga 12 meses de uma vez com desconto.
// monthlyValue é sempre o valor MENSAL equivalente (é o que o painel da plataforma soma como MRR).
export function priceFor(plan, cycle) {
  const monthly = PLANS[plan].monthly
  if (cycle === 'annual') {
    const total = cents(monthly * 12 * (1 - ANNUAL_DISCOUNT))
    return { cycle, monthlyValue: cents(total / 12), total }
  }
  return { cycle: 'monthly', monthlyValue: monthly, total: monthly }
}

// O que cada plano pode usar. null = sem limite. Planos fora da lista (connected,
// enterprise, professional, internal) não têm restrição.
export const PLAN_LIMITS = {
  starter: {
    integrations: ['whatsapp'],        // só WhatsApp; Gmail, Outlook, Agenda, Zapier, Make, banco próprio e API ficam de fora
    broadcastRecipientsPerMonth: 100,  // pessoas que podem receber Disparos (envio em massa) por mês
  },
}
const NO_LIMITS = { integrations: null, broadcastRecipientsPerMonth: null }

export function planLimits(plan) {
  return PLAN_LIMITS[plan] || NO_LIMITS
}

export function integrationAllowed(plan, type) {
  const allowed = planLimits(plan).integrations
  return !allowed || allowed.includes(type)
}
