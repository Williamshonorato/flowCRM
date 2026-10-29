import bcrypt from 'bcryptjs'
import prisma from './prisma.js'

// Quantos dias quem se cadastra pelo site usa de graça antes de precisar pagar.
export const TRIAL_DAYS = 2

const DEFAULT_STAGES = [
  { name: 'Novo lead', color: '#f39c12', order: 0 },
  { name: 'Em contato', color: '#2980b9', order: 1 },
  { name: 'Proposta', color: '#8e44ad', order: 2 },
  { name: 'Negociação', color: '#16a085', order: 3 },
  { name: 'Fechado', color: '#27ae60', order: 4 },
]

// Teste grátis acabou e ninguém aprovou ainda: a empresa só vê a tela de pagamento.
export function trialExpired(tenant) {
  return tenant?.billingStatus === 'trial' && !!tenant.trialEndsAt && new Date(tenant.trialEndsAt) < new Date()
}

// Dados do Pix mostrados na tela de pagamento — configurados no .env do servidor.
export function paymentInfo() {
  return { pixKey: process.env.PIX_KEY || null, pixName: process.env.PIX_NAME || null }
}

// Cria empresa + primeiro admin + estágios padrão do pipeline. Usado pelo cadastro do site
// e pelo "Novo cliente" do painel da plataforma. Lança o erro P2002 do Prisma se o e-mail
// já existir (quem chama responde 409).
export async function createTenantWithAdmin({ businessName, segment, admin, ...billing }) {
  const slug = businessName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Date.now()
  const hash = await bcrypt.hash(admin.password, 10)
  return prisma.tenant.create({
    data: {
      name: businessName,
      slug,
      segment,
      ...billing,
      users: { create: { name: admin.name, email: admin.email.trim().toLowerCase(), password: hash, role: 'admin' } },
      stages: { create: DEFAULT_STAGES },
    },
    include: { users: true },
  })
}
