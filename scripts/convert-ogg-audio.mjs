// Uma vez só: converte pra MP3 os áudios de WhatsApp já recebidos em OGG/Opus (o Safari
// antigo não toca OGG) e aponta a mensagem pro .mp3. Os .ogg originais continuam no disco.
// Uso: node scripts/convert-ogg-audio.mjs
import 'dotenv/config'
import path from 'path'
import { fileURLToPath } from 'url'
import prisma from '../src/lib/prisma.js'
import { oggToMp3 } from '../src/routes/whatsapp.js'

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public')
const msgs = await prisma.message.findMany({
  where: { mediaType: 'audio', mediaUrl: { endsWith: '.ogg' } },
  select: { id: true, mediaUrl: true },
})
let ok = 0, fail = 0
for (const m of msgs) {
  const rel = m.mediaUrl.replace(/^\/app\//, '')
  const file = path.join(PUBLIC_DIR, rel)
  if (!file.startsWith(path.join(PUBLIC_DIR, 'uploads') + path.sep)) { fail++; continue }
  const mp3 = await oggToMp3(file)
  if (!mp3) { fail++; continue }
  await prisma.message.update({ where: { id: m.id }, data: { mediaUrl: m.mediaUrl.replace(/\.ogg$/i, '.mp3') } })
  ok++
}
console.log(`áudios convertidos: ${ok}, falhas: ${fail}, total: ${msgs.length}`)
await prisma.$disconnect()
process.exit(0)
