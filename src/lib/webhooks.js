import prisma from './prisma.js'

// Dispara o evento pras integrações do tipo Zapier/Make que tiverem uma webhookUrl configurada.
// Fire-and-forget: nunca deixa uma falha de webhook derrubar a requisição principal.
export async function dispatchWebhook(tenantId, event, payload) {
  const integrations = await prisma.integration.findMany({
    where: { tenantId, status: 'connected', type: { in: ['zapier', 'make'] } },
  })

  for (const integration of integrations) {
    const url = integration.config?.webhookUrl
    if (!url) continue

    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, tenantId, data: payload, sentAt: new Date().toISOString() }),
    })
      .then(() => prisma.integration.update({ where: { id: integration.id }, data: { lastSync: new Date() } }))
      .catch((err) => console.error(`webhook ${integration.type} falhou:`, err.message))
  }
}
