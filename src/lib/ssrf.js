import dns from 'dns/promises'
import net from 'net'

// Proteção contra SSRF: várias funcionalidades fazem o SERVIDOR abrir conexão pra um destino
// que o usuário digitou (banco de dados externo, passo "webhook" das automações, URLs do
// Zapier/Make). Sem isso, qualquer usuário conseguiria usar o servidor pra varrer/atacar a
// rede interna (localhost, o Postgres do próprio CRM, metadados de nuvem, Evolution API...).
// Destinos privados só passam com ALLOW_PRIVATE_NETWORK_TARGETS=1 (ambiente de dev).

function isPrivateV4(ip) {
  const [a, b] = ip.split('.').map(Number)
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||   // CGNAT
    (a === 169 && b === 254) ||             // link-local / metadados de nuvem
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224                                // multicast/reservado
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip)
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase()
    if (v === '::1' || v === '::') return true
    if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateV4(mapped[1])
    return false
  }
  return true // não é IP válido — trata como bloqueado
}

export async function assertPublicHost(host) {
  if (process.env.ALLOW_PRIVATE_NETWORK_TARGETS === '1') return
  const h = String(host || '').trim().replace(/^\[|\]$/g, '')
  if (!h) throw new Error('Host não informado.')
  const addrs = net.isIP(h) ? [{ address: h }] : await dns.lookup(h, { all: true }).catch(() => { throw new Error(`Não foi possível resolver o endereço "${h}".`) })
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) {
    throw new Error('Esse endereço aponta pra uma rede interna e não é permitido. Use o endereço público do servidor.')
  }
}

// Só http(s) e só destinos públicos
export async function assertPublicUrl(rawUrl) {
  let url
  try { url = new URL(rawUrl) } catch { throw new Error('URL inválida.') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Só URLs http/https são permitidas.')
  await assertPublicHost(url.hostname)
  return url
}
