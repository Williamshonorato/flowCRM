// FlowCRM — API helper compartilhado
const API_BASE = 'http://localhost:3333';

function getToken()  { return localStorage.getItem('flowcrm_token'); }
function setToken(t) { localStorage.setItem('flowcrm_token', t); }
function clearToken(){ localStorage.removeItem('flowcrm_token'); }

function authGuard() {
  if (!getToken()) { window.location.href = 'crm-login.html'; return false; }
  return true;
}

function logout() {
  clearToken();
  window.location.href = 'crm-login.html';
}

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
