// Sidebar compartilhada — mantém o rodapé (usuário/plano/empresa), o item de menu ativo
// e o badge de tarefas consistentes em TODAS as telas.
//
// Antes, cada página tinha sua própria cópia da sidebar. A maioria deixava
// "Williams / Plano Profissional" chumbado no HTML, então ao usar a conta de um cliente
// a barra continuava mostrando a conta errada (ou piscava a conta errada por um segundo
// antes de corrigir). Agora todas usam os mesmos atributos data-fc e este script único.
//
// Carregar SEMPRE depois de flowcrm-api.js (precisa de api() e initials()).

(function () {
  const PLAN_LABELS = {
    starter: 'Plano Starter',
    professional: 'Plano Profissional',
    connected: 'Plano Connected',
    enterprise: 'Plano Enterprise',
  };

  function setText(selector, value) {
    document.querySelectorAll(selector).forEach((el) => { el.textContent = value; });
  }

  // Fonte única do menu — antes cada página tinha sua própria lista chumbada no HTML,
  // então "Importar dados" (e a ordem de "Sistema") variava de tela pra tela.
  const NAV = [
    { section: 'Principal' },
    { href: 'crm-dashboard',      ico: '📊', label: 'Dashboard' },
    { href: 'crm-pipeline',       ico: '🗂️', label: 'Pipeline', module: 'pipeline' },
    { href: 'crm-contatos',       ico: '👥', label: 'Contatos' },
    { href: 'crm-conversas',      ico: '💬', label: 'Conversas', unread: true },
    { href: 'crm-disparos',       ico: '📣', label: 'Disparos', module: 'broadcasts' },
    { href: 'crm-tarefas',        ico: '✅', label: 'Tarefas', badge: true },
    { section: 'Sistema' },
    { href: 'crm-relatorios',     ico: '📈', label: 'Relatórios' },
    { href: 'crm-automacoes',     ico: '🤖', label: 'Automações' },
    { href: 'crm-importar',       ico: '📥', label: 'Importar dados' },
    { href: 'crm-integracoes',    ico: '🔌', label: 'Integrações' },
    { href: 'crm-configuracoes',  ico: '⚙️', label: 'Configurações' },
  ];

  // Módulos fora do plano (ex: Starter não tem Pipeline nem Disparos). Fica guardado no navegador
  // pra montar o menu já certo no carregamento, sem o item aparecer e sumir; /auth/me confirma depois.
  const BLOCKED_KEY = 'flowcrm_blocked_modules';
  function cachedBlocked() {
    try { return JSON.parse(localStorage.getItem(BLOCKED_KEY) || '[]'); } catch (_) { return []; }
  }
  let blockedModules = cachedBlocked();

  // Esconde o menu e qualquer atalho marcado com data-module (ex: "+ Novo negócio" no Dashboard),
  // e tira a pessoa da tela se ela abriu o endereço de um módulo que o plano não tem.
  function applyBlockedModules() {
    const page = NAV.find((it) => it.href === currentPage());
    if (page && page.module && blockedModules.includes(page.module)) { location.replace('crm-dashboard'); return; }
    document.querySelectorAll('[data-module]').forEach((el) => {
      el.style.display = blockedModules.includes(el.getAttribute('data-module')) ? 'none' : '';
    });
  }

  function currentPage() {
    return (location.pathname.split('/').pop() || 'crm-dashboard').toLowerCase().replace(/\.html$/, '');
  }

  // Reconstrói o <nav class="sb-nav"> a partir do NAV acima, pra que TODAS as telas
  // tenham exatamente os mesmos itens, na mesma ordem. O link "Plataforma" continua
  // sendo adicionado depois, só pra quem é admin da plataforma (flowcrm-api.js).
  function renderNav() {
    const nav = document.querySelector('.sb-nav');
    if (!nav) return;
    const here = currentPage();
    nav.innerHTML = NAV.map((it) => {
      if (it.section) return `<div class="sb-section">${it.section}</div>`;
      if (it.module && blockedModules.includes(it.module)) return '';
      const active = it.href.toLowerCase() === here ? ' active' : '';
      // O menu inteiro é reconstruído aqui, então o badge de não lidas (#sbUnread, preenchido pela
      // tela de Conversas) precisa nascer junto — senão ele sumia e a tela dava erro de JS.
      const badge = it.badge ? '<span class="badge" data-fc="tasks-badge" style="display:none"></span>'
        : it.unread ? '<span class="badge" id="sbUnread" style="display:none">0</span>' : '';
      return `<a class="nav-item${active}" href="${it.href}"><span class="ico">${it.ico}</span>${it.label}${badge}</a>`;
    }).join('');
  }

  // Marca como ativo o item de menu cuja href aponta pra página atual.
  function highlightActive() {
    const here = currentPage();
    document.querySelectorAll('.sidebar .nav-item, .sb-nav .nav-item').forEach((a) => {
      const href = (a.getAttribute('href') || '').split('/').pop().toLowerCase();
      if (href) a.classList.toggle('active', href === here);
    });
  }

  function localInitials(name) {
    if (typeof initials === 'function') return initials(name);
    return (name || '').trim().split(/\s+/).map((p) => p[0] || '').slice(0, 2).join('').toUpperCase() || '·';
  }

  async function hydrate() {
    highlightActive();

    if (typeof api !== 'function') return;
    const me = await api('/auth/me');
    if (!me || !me.user) return;

    const fresh = (me.tenant && me.tenant.limits && me.tenant.limits.blockedModules) || [];
    if (fresh.join() !== blockedModules.join()) {
      blockedModules = fresh;
      try { localStorage.setItem(BLOCKED_KEY, JSON.stringify(fresh)); } catch (_) { /* sem storage: só não fica em cache */ }
      renderNav();
    }
    applyBlockedModules();

    const name = me.user.name || '';
    const plan = PLAN_LABELS[me.tenant && me.tenant.plan] || (me.tenant && me.tenant.plan) || '';

    setText('[data-fc="user-name"]', name);
    setText('[data-fc="user-plan"]', plan);
    setText('[data-fc="user-avatar"]', localInitials(name));
    setText('[data-fc="tenant-name"]', (me.tenant && me.tenant.name) || '');

    // Badge de tarefas pendentes — em TODAS as telas, sem esperar abrir "Tarefas".
    try {
      const c = await api('/tasks/count');
      if (c && typeof c.pending === 'number') window.setTasksBadge(c.pending);
    } catch (_) { /* silencioso */ }

    checkWhatsappAlert();
  }

  // Aviso vermelho em TODAS as telas quando o WhatsApp cai de verdade (o servidor consulta o
  // estado real e já tenta reconectar sozinho; se chegou aqui, precisa de alguém escanear o QR).
  async function checkWhatsappAlert() {
    if (typeof api !== 'function' || /crm-integracoes/.test(location.pathname)) return;
    let s = null;
    try { s = await api('/whatsapp/stats'); } catch (_) { return; }
    let el = document.getElementById('fc-wpp-alert');
    if (s && s.configured && !s.connected) {
      if (el) return;
      el = document.createElement('div');
      el.id = 'fc-wpp-alert';
      el.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:400;background:#dc2626;color:#fff;padding:10px 12px 10px 16px;border-radius:12px;box-shadow:0 10px 30px rgba(220,38,38,.35);font-size:13.5px;font-weight:700;display:flex;align-items:center;gap:12px;max-width:calc(100vw - 32px);flex-wrap:wrap';
      el.innerHTML = '<span>⚠️ WhatsApp desconectado — o bot e as mensagens estão parados.</span><a href="crm-integracoes" style="background:#fff;color:#dc2626;padding:6px 12px;border-radius:8px;text-decoration:none;font-weight:800">Reconectar agora</a>';
      document.body.appendChild(el);
    } else if (el) {
      el.remove();
    }
  }
  setInterval(function () { if (!document.hidden) checkWhatsappAlert(); }, 120000);

  // Atualiza o badge de tarefas ("3" vermelho no menu). Chamado pelas páginas que
  // sabem a contagem real (dashboard, tarefas). Sem contagem, fica escondido.
  window.setTasksBadge = function (count) {
    document.querySelectorAll('[data-fc="tasks-badge"]').forEach((el) => {
      if (count > 0) { el.textContent = count > 9 ? '9+' : count; el.style.display = 'flex'; }
      else { el.textContent = ''; el.style.display = 'none'; }
    });
  };

  window.hydrateSidebar = hydrate;
  // Pra telas que desenham botões depois de carregar (ex: lista de Contatos) saberem o que esconder.
  window.fcModuleBlocked = (module) => blockedModules.includes(module);

  // Menu montado o quanto antes (o script carrega no fim do <body>, a .sb-nav já existe).
  renderNav();
  applyBlockedModules();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hydrate);
  else hydrate();
})();
