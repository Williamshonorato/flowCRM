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
  const res = await fetch(API_BASE + path, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(opts.headers || {}),
    },
    ...opts,
  });
  if (res.status === 401) { clearToken(); window.location.href = 'crm-login.html'; return null; }
  if (res.status === 204) return null;
  return res.json();
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
