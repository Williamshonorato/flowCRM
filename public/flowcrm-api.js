// FlowCRM — API helper compartilhado
// A API e o front ficam sempre na mesma origem (Express serve os dois), então
// usar window.location.origin funciona tanto local (localhost:3333) quanto em
// produção (https://flowcrm.seculo1.com) sem precisar trocar nada manualmente.
const API_BASE = window.location.origin;

function getToken()  { return localStorage.getItem('flowcrm_token'); }
function setToken(t) { localStorage.setItem('flowcrm_token', t); }
function clearToken(){ localStorage.removeItem('flowcrm_token'); }

function authGuard() {
  if (!getToken()) { window.location.href = 'crm-login.html'; return false; }
  return true;
}

function logout() {
  clearToken();
  localStorage.removeItem('flowcrm_impersonating');
  window.location.href = 'crm-login.html';
}

// ── Painel da plataforma (superadmin/owner) ──────────────────────────────────
// Não precisa de login nem token separado: é o mesmo usuário de sempre, só que com
// platformRole no payload do JWT. Decodifica local (sem verificar assinatura — é só
// pra decidir o que MOSTRAR na tela; o servidor sempre confere de verdade em cada rota).
function decodeJwtPayload(token) {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(atob(base64).split('').map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function getPlatformRole() {
  const token = getToken();
  if (!token) return null;
  return decodeJwtPayload(token)?.platformRole || null;
}

// Injeta o link "Plataforma" no menu lateral de qualquer tela, se a conta logada
// tiver platformRole — assim não precisa editar o sidebar de cada página uma por uma.
function injectPlatformNav() {
  if (!getPlatformRole()) return;
  const nav = document.querySelector('.sb-nav');
  if (!nav || document.getElementById('navPlatformLink')) return;
  const a = document.createElement('a');
  a.id = 'navPlatformLink';
  a.className = 'nav-item';
  a.href = 'crm-plataforma.html';
  a.innerHTML = '<span class="ico">🛡️</span>Plataforma';
  nav.appendChild(a);
}

// Troca a sessão atual pela do admin de outra empresa, guardando o token de volta
// pra dar pra "sair da visualização" depois. Chamado a partir de crm-plataforma.html.
function startImpersonation(impersonateToken, tenantName) {
  localStorage.setItem('flowcrm_impersonating', JSON.stringify({ backupToken: getToken(), tenantName }));
  setToken(impersonateToken);
  window.location.href = 'crm-dashboard.html';
}

function stopImpersonation() {
  const raw = localStorage.getItem('flowcrm_impersonating');
  if (raw) {
    const data = JSON.parse(raw);
    if (data.backupToken) setToken(data.backupToken);
  }
  localStorage.removeItem('flowcrm_impersonating');
  window.location.href = 'crm-plataforma.html';
}

// Aviso fixo no topo enquanto está vendo o sistema como admin de outra empresa —
// aparece em qualquer tela automaticamente, sem precisar editar cada uma.
function injectImpersonationBanner() {
  const raw = localStorage.getItem('flowcrm_impersonating');
  if (!raw) return;
  let data;
  try { data = JSON.parse(raw) } catch { return }
  if (document.getElementById('fcrm-impersonation-banner')) return;

  const banner = document.createElement('div');
  banner.id = 'fcrm-impersonation-banner';
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#8e44ad;color:#fff;text-align:center;padding:9px 16px;font-size:13px;font-weight:700;z-index:9998;display:flex;align-items:center;justify-content:center;gap:14px;box-shadow:0 2px 8px rgba(0,0,0,.2)';
  const safeName = (data.tenantName || '').replace(/</g, '&lt;');
  banner.innerHTML = `🛡️ Vendo o sistema como admin de <b>${safeName}</b>
    <button style="background:#fff;color:#8e44ad;border:none;padding:5px 14px;border-radius:6px;font-weight:700;font-size:12px;cursor:pointer" onclick="stopImpersonation()">Sair da visualização</button>`;
  document.body.prepend(banner);
}

document.addEventListener('DOMContentLoaded', () => {
  injectPlatformNav();
  injectImpersonationBanner();
});

async function api(path, opts = {}) {
  const token = getToken();
  let res;
  try {
    res = await fetch(API_BASE + path, {
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(opts.headers || {}),
      },
      ...opts,
    });
  } catch (err) {
    apiToast('Não foi possível conectar ao servidor. Verifique sua conexão e tente novamente.');
    return null;
  }

  if (res.status === 401) { clearToken(); window.location.href = 'crm-login.html'; return null; }
  if (res.status === 204) return null;

  let body = null;
  try { body = await res.json(); } catch {}

  if (!res.ok) {
    const msg = (body && typeof body.error === 'string') ? body.error : 'Ocorreu um erro ao processar sua solicitação.';
    apiToast(msg);
    return null;
  }

  return body;
}

// Toast de erro compartilhado — usado pelo api() quando a requisição falha
// (rede fora do ar, servidor reiniciando, erro de validação, etc.) pra nunca falhar em silêncio.
function apiToast(msg) {
  let el = document.getElementById('fcrm-api-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fcrm-api-toast';
    el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);background:#991b1b;color:#fff;padding:12px 20px;border-radius:10px;font-size:13px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.25);opacity:0;pointer-events:none;transition:all .25s;z-index:9999;max-width:90vw;text-align:center';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  el.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(el._fcrmTimer);
  el._fcrmTimer = setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(-50%) translateY(20px)'; }, 4000);
}

// Formatar valores monetários
function fmtMoney(v) {
  return 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0 });
}

// Iniciais de um nome
function initials(name) {
  if (!name) return '?';
  return name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

// Paleta de cores por índice
const PALETTE = ['#27ae60','#2980b9','#8e44ad','#f39c12','#e74c3c','#16a085','#d35400'];
function palColor(i) { return PALETTE[i % PALETTE.length]; }
