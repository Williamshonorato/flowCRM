import bcrypt from 'bcryptjs'
import prisma from '../src/lib/prisma.js'

async function main() {
  console.log('🌱 Semeando banco de dados...')

  const hash = await bcrypt.hash('senha123', 10)

  const tenant = await prisma.tenant.upsert({
    where: { slug: 'clinica-vida-plena' },
    update: {},
    create: {
      name: 'Clínica Vida Plena',
      slug: 'clinica-vida-plena',
      segment: 'health',
      plan: 'professional',
      phone: '(11) 3000-0000',
      website: 'https://vidaplena.com.br',
    },
  })

  const admin = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: 'admin@flowcrm.dev' } },
    update: {},
    create: { tenantId: tenant.id, name: 'Admin', email: 'admin@flowcrm.dev', password: hash, role: 'admin' },
  })

  // Stages
  const stagesData = [
    { name: 'Novo lead', color: '#f39c12', order: 0 },
    { name: 'Em contato', color: '#2980b9', order: 1 },
    { name: 'Proposta', color: '#8e44ad', order: 2 },
    { name: 'Negociação', color: '#16a085', order: 3 },
    { name: 'Fechado', color: '#27ae60', order: 4 },
  ]

  const stages = []
  for (const s of stagesData) {
    const stage = await prisma.stage.upsert({
      where: { tenantId_name: { tenantId: tenant.id, name: s.name } },
      update: {},
      create: { tenantId: tenant.id, ...s },
    })
    stages.push(stage)
  }

  // Custom fields
  await prisma.customField.createMany({
    skipDuplicates: true,
    data: [
      { tenantId: tenant.id, name: 'Convênio', type: 'text', order: 0 },
      { tenantId: tenant.id, name: 'Data de nascimento', type: 'date', order: 1 },
      { tenantId: tenant.id, name: 'Especialidade', type: 'select', order: 2 },
    ],
  })

  // Contacts
  const contactsData = [
    { name: 'Maria Clara Souza', email: 'maria.clara@email.com', phone: '(11) 98765-4321', origin: 'whatsapp', temperature: 'hot', customData: { convenio: 'Unimed' } },
    { name: 'João Pedro Alves', email: 'joao@email.com', phone: '(11) 91234-5678', origin: 'indicacao', temperature: 'warm', customData: { convenio: 'Bradesco' } },
    { name: 'Ana Beatriz Lima', email: 'ana.b@email.com', phone: '(21) 99876-5432', origin: 'instagram', temperature: 'new', customData: { convenio: 'Particular' } },
    { name: 'Roberto Mendes', email: 'roberto@email.com', phone: '(11) 97654-3210', origin: 'whatsapp', temperature: 'cold', customData: { convenio: 'Amil' } },
    { name: 'Carla Fernanda', email: 'carla@email.com', phone: '(31) 98888-7777', origin: 'indicacao', temperature: 'warm', customData: {} },
    { name: 'Paulo Sérgio Costa', email: 'paulo@email.com', phone: '(11) 93333-2222', origin: 'whatsapp', temperature: 'hot', customData: {} },
    { name: 'Fernanda Costa', email: 'fernanda@email.com', phone: '(41) 96543-2109', origin: 'instagram', temperature: 'new', customData: {} },
    { name: 'Lucas Almeida', email: 'lucas@email.com', phone: '(11) 95555-4444', origin: 'indicacao', temperature: 'warm', customData: {} },
  ]

  const contacts = []
  for (const c of contactsData) {
    const contact = await prisma.contact.upsert({
      where: { tenantId_email: { tenantId: tenant.id, email: c.email } },
      update: {},
      create: { tenantId: tenant.id, ...c },
    })
    contacts.push(contact)
  }

  // Deals
  const dealsData = [
    { title: 'Maria Clara Souza', contactIdx: 0, stageIdx: 2, value: 3200 },
    { title: 'João Pedro Alves', contactIdx: 1, stageIdx: 3, value: 1800 },
    { title: 'Ana Beatriz Lima', contactIdx: 2, stageIdx: 4, value: 5600, closedAt: new Date() },
    { title: 'Roberto Mendes', contactIdx: 3, stageIdx: 0, value: 920 },
    { title: 'Carla Fernanda', contactIdx: 4, stageIdx: 1, value: 2400 },
    { title: 'Paulo Sérgio Costa', contactIdx: 5, stageIdx: 2, value: 4100 },
    { title: 'Fernanda Costa', contactIdx: 6, stageIdx: 0, value: 1200 },
    { title: 'Lucas Almeida', contactIdx: 7, stageIdx: 1, value: 3800 },
  ]

  for (const d of dealsData) {
    await prisma.deal.create({
      data: {
        tenantId: tenant.id,
        title: d.title,
        contactId: contacts[d.contactIdx].id,
        stageId: stages[d.stageIdx].id,
        value: d.value,
        closedAt: d.closedAt || null,
      }
    })
  }

  // Tasks
  const now = new Date()
  const yesterday = new Date(now.getTime() - 86400000)
  const tomorrow  = new Date(now.getTime() + 86400000)

  await prisma.task.createMany({
    data: [
      { tenantId: tenant.id, userId: admin.id, contactId: contacts[0].id, title: 'Ligar para Maria Clara', type: 'call', priority: 'high', dueDate: yesterday },
      { tenantId: tenant.id, userId: admin.id, contactId: contacts[1].id, title: 'Enviar proposta revisada', type: 'follow', priority: 'high', dueDate: yesterday },
      { tenantId: tenant.id, userId: admin.id, contactId: contacts[3].id, title: 'Follow-up WhatsApp', type: 'follow', priority: 'mid', dueDate: now },
      { tenantId: tenant.id, userId: admin.id, contactId: contacts[4].id, title: 'Confirmar consulta', type: 'call', priority: 'mid', dueDate: now },
      { tenantId: tenant.id, userId: admin.id, contactId: contacts[5].id, title: 'Agendar retorno', type: 'email', priority: 'low', dueDate: tomorrow },
    ],
  })

  console.log(`✅ Seed concluído!`)
  console.log(`   Tenant: ${tenant.name} (${tenant.slug})`)
  console.log(`   Admin:  ${admin.email} / senha123`)
  console.log(`   ${contacts.length} contatos, ${dealsData.length} negócios, 5 tarefas criados.`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
