# Run a WhatsApp adapter (Evolution-like) for local development

This project uses a webhook-based approach. For local development you can run a self-hosted WhatsApp Web adapter (like `wppconnect/server` or `open-wa/wa-automate`) and configure it to POST messages to your FlowCRM webhook at `/whatsapp/webhook`.

Example using `wppconnect/server` (Docker Compose):

1. Create the file `docker-compose.yml` in `integration/evolution` (example included).
2. Set `WEBHOOK_URL` to `http://host.docker.internal:3333/whatsapp/webhook` on macOS, or use your machine IP if needed.
3. Start the service:

```bash
cd integration/evolution
docker compose up -d
```

4. Open `http://localhost:3030` to scan the WhatsApp QR code.

5. Send a message to the connected number; the adapter should POST the payload to FlowCRM.

Notes
- If you run FlowCRM inside Docker, adapt `WEBHOOK_URL` to point to `http://flowcrm:3333/whatsapp/webhook` or expose ports.
- The adapter may use WebSocket/long-polling; ensure it can reach your webhook.
- If the adapter cannot reach `host.docker.internal`, use your machine IP (e.g. `http://192.168.x.x:3333/whatsapp/webhook`).
- For production, consider official providers or hosted adapters and handle compliance/scale accordingly.

If you want, I can add an example `docker-compose.yml` using `wppconnect/server` next.
