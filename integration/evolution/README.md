# Testar com a Evolution API (local)

Sobe a [Evolution API](https://github.com/EvolutionAPI/evolution-api) real via Docker,
conectada por QR code a um número de WhatsApp, mandando os eventos direto pro
webhook do FlowCRM.

**Importante:** o webhook é por empresa — `/whatsapp/webhook/:tenantId`. Cada empresa
que usa o FlowCRM tem sua própria URL (visível na tela de Integrações, já logado como
aquela empresa) e deve conectar seu próprio número/instância da Evolution API a ela.
Isso é o que garante que as mensagens de uma empresa nunca se misturem com as de outra.

## 1. Subir o serviço

```bash
cd integration/evolution
docker compose up -d
```

Isso sobe a Evolution API em `http://localhost:8080`. O `WEBHOOK_GLOBAL_URL` no
`docker-compose.yml` está com um placeholder — troque `SEU_TENANT_ID` pelo ID real
da empresa (pegue na tela de Integrações → seção "Chave de API" → "Webhook URL",
já logado com o usuário daquela empresa) antes de subir:

```yaml
- WEBHOOK_GLOBAL_URL=http://host.docker.internal:3333/whatsapp/webhook/SEU_TENANT_ID
```

(o FlowCRM precisa estar rodando em `localhost:3333` — `npm run dev`).

A API key usada nos exemplos abaixo é `flowcrm-dev-key` (definida no `docker-compose.yml`).
Troque antes de expor isso fora da sua máquina.

## 2. Criar uma instância

```bash
curl -s -X POST http://localhost:8080/instance/create \
  -H "Content-Type: application/json" \
  -H "apikey: flowcrm-dev-key" \
  -d '{
    "instanceName": "flowcrm",
    "qrcode": true,
    "integration": "WHATSAPP-BAILEYS"
  }'
```

## 3. Escanear o QR code

```bash
curl -s http://localhost:8080/instance/connect/flowcrm \
  -H "apikey: flowcrm-dev-key"
```

A resposta traz o QR code em base64. Abra num navegador (ou decodifique pra imagem)
e escaneie com o WhatsApp do celular (Aparelhos conectados → Conectar um aparelho).

## 4. Testar

Mande uma mensagem de WhatsApp para o número conectado. A Evolution deve
disparar um `POST /whatsapp/webhook/:tenantId` no FlowCRM, que cria/atualiza o
contato, salva a mensagem e — se detectar intenção de interesse — cria um negócio
e uma tarefa de follow-up automaticamente, tudo dentro da empresa dona daquele
tenantId.

Para conferir sem depender de WhatsApp real, simule o payload que a Evolution
manda (formato `messages.upsert`, mensagem aninhada em `data`) — troque
`SEU_TENANT_ID` pelo ID real:

```bash
curl -s -X POST http://localhost:3333/whatsapp/webhook/SEU_TENANT_ID \
  -H "Content-Type: application/json" \
  -d '{
    "event": "messages.upsert",
    "instance": "flowcrm",
    "data": {
      "key": { "remoteJid": "5511987654321@s.whatsapp.net", "fromMe": false, "id": "TESTE001" },
      "pushName": "Cliente Teste",
      "message": { "conversation": "Oi, quero um orçamento" }
    },
    "sender": "5511999999999@s.whatsapp.net"
  }'
```

## Múltiplas empresas (ex: várias associadas de um sindicato)

Cada empresa precisa da sua própria instância da Evolution (ou de qualquer outro
serviço equivalente) conectada à sua própria URL de webhook. Não dá pra reusar a
mesma instância/número da Evolution pra duas empresas — cada uma é um `docker
compose up` (ou instância dentro de uma Evolution compartilhada) separado, com
`WEBHOOK_GLOBAL_URL` apontando pro `tenantId` daquela empresa específica.

## Notas

- O webhook em `src/routes/whatsapp.js` reconhece o formato da Evolution
  (`data.key.remoteJid`, `data.message.conversation`/`extendedTextMessage`/etc.,
  `data.pushName`) e ignora mensagens com `fromMe: true` (ecos do que a própria
  empresa mandou).
- Se o `tenantId` na URL não existir, o FlowCRM responde 404 — a Evolution não
  consegue mandar mensagem pra uma empresa que não existe.
- Se quiser exigir autenticação extra no webhook, defina `WHATSAPP_TOKEN` no
  `.env` do FlowCRM — a Evolution precisa então mandar esse valor no header
  `x-whatsapp-token` (configurável em `WEBHOOK_GLOBAL_HEADERS` da Evolution).
  Isso é além do isolamento por `tenantId`, não em vez dele.
- Se a Evolution não conseguir alcançar `host.docker.internal`, troque pelo IP
  da sua máquina na rede local.
- Para produção, avalie um provedor oficial (WhatsApp Business API via Meta) —
  a Evolution/Baileys usa engenharia reversa do WhatsApp Web e não é um canal
  oficialmente suportado pela Meta.
