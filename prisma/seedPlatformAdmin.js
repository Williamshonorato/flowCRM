// Cria (ou atualiza a senha de) um admin da plataforma. Uso:
//   node prisma/seedPlatformAdmin.js "Nome" email@x.com "senha" owner|superadmin
import bcrypt from 'bcryptjs'
import prisma from '../src/lib/prisma.js'

async function main() {
  const [, , name, email, password, role] = process.argv
  if (!name || !email || !password) {
    console.error('Uso: node prisma/seedPlatformAdmin.js "Nome" email@x.com "senha" owner|superadmin')
    process.exit(1)
  }
  const hash = await bcrypt.hash(password, 10)
  const admin = await prisma.platformAdmin.upsert({
    where: { email },
    update: { name, password: hash, role: role || 'superadmin' },
    create: { name, email, password: hash, role: role || 'superadmin' },
  })
  console.log(`✅ ${admin.role}: ${admin.name} <${admin.email}>`)
}

main().catch(err => { console.error(err); process.exit(1) }).finally(() => prisma.$disconnect())
