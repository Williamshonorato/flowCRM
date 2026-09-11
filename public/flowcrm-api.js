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
  // Admin da plataforma "puro" (não impersonando um cliente) não deve cair nas
  // telas normais do CRM — a área dele é o painel da plataforma. Só vê o CRM de
  // verdade quando entra num cliente ("Entrar como admin" em crm-plataforma.html),
  // que troca o token e ativa flowcrm_impersonating.
  const here = (location.pathname.split('/').pop() || '').toLowerCase();
  const isImpersonating = !!localStorage.getItem('flowcrm_impersonating');
  if (here !== 'crm-plataforma.html' && !isImpersonating && getPlatformRole()) {
    window.location.href = 'crm-plataforma.html';
    return false;
  }
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

// Só serve pra decisões rápidas e não-críticas (ex: mostrar algo antes da rede
// responder). Um token antigo pode não ter platformRole mesmo pra quem já tem o
// papel hoje — pra qualquer coisa que precise estar certa de verdade, usa /auth/me
// (é o que injectAccountUI faz), nunca confia só nisso aqui.
function getPlatformRole() {
  const token = getToken();
  if (!token) return null;
  return decodeJwtPayload(token)?.platformRole || null;
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
  // flex-wrap:wrap pra, se não couber, o botão cair pra uma segunda linha centralizada
  // em vez de estourar a tela. Sem position:fixed — ver comentário abaixo.
  banner.style.cssText = 'background:#8e44ad;color:#fff;text-align:center;padding:9px 16px;font-size:13px;font-weight:700;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px 14px;box-shadow:0 2px 8px rgba(0,0,0,.2);flex-shrink:0';
  const safeName = (data.tenantName || '').replace(/</g, '&lt;');
  // A frase inteira precisa estar num único elemento (<span>): texto solto misturado
  // com <b> direto como filhos de um flex container vira um item de flex PRA CADA
  // pedaço (o texto, o nome em negrito, o espaço em branco entre eles...) — com
  // justify-content:center isso espalhava a frase em pedaços soltos pela tela em vez
  // de ler como uma frase só.
  banner.innerHTML = `<span>🛡️ Vendo o sistema como admin de <b>${safeName}</b></span><button style="background:#fff;color:#8e44ad;border:none;padding:5px 14px;border-radius:6px;font-weight:700;font-size:12px;cursor:pointer;flex-shrink:0" onclick="stopImpersonation()">Sair da visualização</button>`;

  // Cada tela do CRM é body{display:flex} com a sidebar e o .main lado a lado.
  // Um banner position:fixed sai desse fluxo e flutua por cima de tudo — tentamos
  // "empurrar" o resto com padding-top calculado, mas a conta não fechava direito
  // (a sidebar ficava com o topo cortado). Em vez de medir e chutar padding, bota o
  // banner pra valer no fluxo normal do documento: tudo que já tava no body entra
  // num wrapper, e o banner fica como uma linha normal acima dele — o próprio
  // navegador empurra o resto pra baixo certinho, sem cálculo nenhum.
  const wrapper = document.createElement('div');
  wrapper.id = 'fcrm-app-wrapper';
  wrapper.style.cssText = 'display:flex;flex:1;min-height:0';
  while (document.body.firstChild) wrapper.appendChild(document.body.firstChild);
  document.body.appendChild(banner);
  document.body.appendChild(wrapper);
  document.body.style.display = 'flex';
  document.body.style.flexDirection = 'column';
  document.body.style.minHeight = '100vh';

  // A sidebar de cada tela usa min-height:100vh pra cobrir a tela toda sozinha; aqui
  // ela divide a altura com o banner, então troca por 0 — o align-items:stretch
  // padrão do wrapper já estica ela (e o .main) até a base de verdade.
  const sidebarEl = wrapper.querySelector('.sidebar');
  if (sidebarEl) sidebarEl.style.minHeight = '0';
}

// O bloco "Williams · Plano Profissional" no rodapé do menu lateral existe em toda
// tela mas nunca teve nenhuma ação ligada a ele — não tinha nenhum jeito de sair da
// conta em lugar nenhum do sistema. Liga um menuzinho (Configurações / Sair) no clique.
function injectUserMenu() {
  const row = document.querySelector('.user-row');
  if (!row || row.dataset.fcrmBound) return;
  row.dataset.fcrmBound = '1';
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    const existing = document.getElementById('fcrm-user-menu');
    if (existing) { existing.remove(); return; }

    const rect = row.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.id = 'fcrm-user-menu';
    menu.style.cssText = `position:fixed;left:${rect.left}px;bottom:${window.innerHeight - rect.top + 8}px;background:#1e293b;border:1px solid #334155;border-radius:10px;padding:6px;min-width:180px;box-shadow:0 8px 24px rgba(0,0,0,.35);z-index:9999;font-family:inherit`;
    menu.innerHTML = `
      <a href="crm-configuracoes.html" style="display:block;padding:8px 12px;color:#cbd5e1;text-decoration:none;font-size:13px;border-radius:7px">⚙️ Configurações</a>
      <div style="height:1px;background:#334155;margin:4px 0"></div>
      <a href="#" onclick="logout();return false;" style="display:block;padding:8px 12px;color:#f87171;text-decoration:none;font-size:13px;border-radius:7px">🚪 Sair</a>
    `;
    document.body.appendChild(menu);
    document.addEventListener('click', function closeMenu() {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    }, { once: true });
  });
}

// Uma chamada só de /auth/me pra tudo que depende de saber quem está logado de
// verdade: o link "Plataforma" no menu (nunca confia no token pra isso — um token
// emitido antes dessa função existir não teria platformRole nele) e o nome/plano
// reais no rodapé (que antes era texto fixo de exemplo, igual em toda tela).
const PLAN_LABELS = { starter: 'Plano Starter', professional: 'Plano Profissional', connected: 'Plano Connected', enterprise: 'Plano Enterprise', internal: 'Plataforma' };
let _fcrmMeCache = null;
async function getMe(force) {
  if (_fcrmMeCache && !force) return _fcrmMeCache;
  if (!getToken()) return null;
  _fcrmMeCache = await api('/auth/me');
  return _fcrmMeCache;
}

async function injectAccountUI() {
  const me = await getMe();
  if (!me) return;

  const nav = document.querySelector('.sb-nav');
  if (me.user.platformRole && nav && !document.getElementById('navPlatformLink')) {
    const a = document.createElement('a');
    a.id = 'navPlatformLink';
    a.className = 'nav-item';
    a.href = 'crm-plataforma.html';
    a.innerHTML = '<span class="ico">🛡️</span>Plataforma';
    nav.appendChild(a);
  }

  const row = document.querySelector('.user-row');
  if (row) {
    const nameEl = row.querySelector('.name');
    const planEl = row.querySelector('.plan');
    const avatarEl = row.querySelector('.user-avatar');
    if (nameEl) nameEl.textContent = me.user.name;
    const platformLabels = { owner: 'Owner da plataforma', superadmin: 'Superadmin da plataforma' };
    if (planEl) planEl.textContent = platformLabels[me.user.platformRole] || PLAN_LABELS[me.tenant.plan] || me.tenant.plan;
    if (avatarEl) avatarEl.textContent = initials(me.user.name);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  injectUserMenu();
  injectImpersonationBanner();
  injectAccountUI();
});

async function api(path, opts = {}) {
  const token = getToken();
  let res;
  // Timeout de 25s — sem isso, uma requisição pendurada (rede ruim, CDN, proxy) deixava
  // a tela presa em "Carregando..." pra sempre, sem nunca cair no tratamento de erro.
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 25000);
  try {
    res = await fetch(API_BASE + path, {
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(opts.headers || {}),
      },
      ...opts,
    });
  } catch (err) {
    apiToast(err?.name === 'AbortError'
      ? 'O servidor demorou demais pra responder. Tente recarregar a página.'
      : 'Não foi possível conectar ao servidor. Verifique sua conexão e tente novamente.');
    return null;
  } finally {
    clearTimeout(timeoutId);
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
