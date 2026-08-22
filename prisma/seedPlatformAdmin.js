// Cria (ou atualiza) um admin da plataforma — é um User normal, só que dentro do tenant
// interno da plataforma e com platformRole setado. Loga pelo mesmo /auth/login de sempre.
// Uso: node prisma/seedPlatformAdmin.js "Nome" email@x.com "senha" owner|superadmin
import bcrypt from 'bcryptjs'
import prisma from '../src/lib/prisma.js'

const INTERNAL_TENANT_SLUG = 'flowcrm-interno'

async function main() {
  const [, , name, email, password, platformRole] = process.argv
  if (!name || !email || !password) {
    console.error('Uso: node prisma/seedPlatformAdmin.js "Nome" email@x.com "senha" owner|superadmin')
    process.exit(1)
  }

  const internalTenant = await prisma.tenant.upsert({
    where: { slug: INTERNAL_TENANT_SLUG },
    update: {},
    create: { name: 'FlowCRM (interno)', slug: INTERNAL_TENANT_SLUG, segment: 'internal', plan: 'internal' },
  })

  const hash = await bcrypt.hash(password, 10)
  const admin = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: internalTenant.id, email } },
    update: { name, password: hash, platformRole: platformRole || 'superadmin' },
    create: { tenantId: internalTenant.id, name, email, password: hash, role: 'admin', platformRole: platformRole || 'superadmin' },
  })
  console.log(`✅ ${admin.platformRole}: ${admin.name} <${admin.email}>`)
}

main().catch(err => { console.error(err); process.exit(1) }).finally(() => prisma.$disconnect())
