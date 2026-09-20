import prisma from './prisma.js'
import { assertPublicUrl } from './ssrf.js'

// Dispara o evento pras integrações do tipo Zapier/Make que tiverem uma webhookUrl configurada.
// Fire-and-forget: nunca deixa uma falha de webhook derrubar a requisição principal.
export async function dispatchWebhook(tenantId, event, payload) {
  // Chamado sem await pelas rotas: qualquer erro aqui viraria unhandledRejection (que derruba
  // o processo no Node), então a falha da própria consulta é logada e engolida.
  let integrations
  try {
    integrations = await prisma.integration.findMany({
      where: { tenantId, status: 'connected', type: { in: ['zapier', 'make'] } },
    })
  } catch (err) {
    console.error('dispatchWebhook: falha ao buscar integrações', err.message)
    return
  }

  for (const integration of integrations) {
    const url = integration.config?.webhookUrl
    if (!url) continue

    assertPublicUrl(url)
      .then(() => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, tenantId, data: payload, sentAt: new Date().toISOString() }),
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      }))
      .then(() => prisma.integration.update({ where: { id: integration.id }, data: { lastSync: new Date() } }))
      .catch((err) => console.error(`webhook ${integration.type} falhou:`, err.message))
  }
}
