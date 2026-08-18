# Testar com a Evolution API (local)

Sobe a [Evolution API](https://github.com/EvolutionAPI/evolution-api) real via Docker,
conectada por QR code a um número de WhatsApp, mandando os eventos direto pro
webhook do FlowCRM (`/whatsapp/webhook`).

## 1. Subir o serviço

```bash
cd integration/evolution
docker compose up -d
```

Isso sobe a Evolution API em `http://localhost:8080`, já configurada para
mandar todo evento de mensagem para `http://host.docker.internal:3333/whatsapp/webhook`
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
disparar um `POST /whatsapp/webhook` no FlowCRM, que cria/atualiza o contato,
salva a mensagem e — se detectar intenção de interesse — cria um negócio e uma
tarefa de follow-up automaticamente.

Para conferir sem depender de WhatsApp real, simule o payload que a Evolution
manda (formato `messages.upsert`, mensagem aninhada em `data`):

```bash
curl -s -X POST http://localhost:3333/whatsapp/webhook \
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

## Notas

- O webhook em `src/routes/whatsapp.js` reconhece o formato da Evolution
  (`data.key.remoteJid`, `data.message.conversation`/`extendedTextMessage`/etc.,
  `data.pushName`) e ignora mensagens com `fromMe: true` (ecos do que a própria
  empresa mandou).
- Se quiser exigir autenticação no webhook, defina `WHATSAPP_TOKEN` no `.env`
  do FlowCRM — o Evolution precisa então mandar esse valor no header
  `x-whatsapp-token` (configurável em `WEBHOOK_GLOBAL_HEADERS` da Evolution).
- Se a Evolution não conseguir alcançar `host.docker.internal`, troque pelo IP
  da sua máquina na rede local (ex: `http://192.168.x.x:3333/whatsapp/webhook`).
- Para produção, avalie um provedor oficial (WhatsApp Business API via Meta) —
  a Evolution/Baileys usa engenharia reversa do WhatsApp Web e não é um canal
  oficialmente suportado pela Meta.
