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
    { href: 'crm-dashboard.html',      ico: '📊', label: 'Dashboard' },
    { href: 'crm-pipeline.html',       ico: '🗂️', label: 'Pipeline' },
    { href: 'crm-contatos.html',       ico: '👥', label: 'Contatos' },
    { href: 'crm-conversas.html',      ico: '💬', label: 'Conversas' },
    { href: 'crm-disparos.html',       ico: '📣', label: 'Disparos' },
    { href: 'crm-tarefas.html',        ico: '✅', label: 'Tarefas', badge: true },
    { section: 'Sistema' },
    { href: 'crm-relatorios.html',     ico: '📈', label: 'Relatórios' },
    { href: 'crm-automacoes.html',     ico: '🤖', label: 'Automações' },
    { href: 'crm-importar.html',       ico: '📥', label: 'Importar dados' },
    { href: 'crm-integracoes.html',    ico: '🔌', label: 'Integrações' },
    { href: 'crm-configuracoes.html',  ico: '⚙️', label: 'Configurações' },
  ];

  function currentPage() {
    return (location.pathname.split('/').pop() || 'crm-dashboard.html').toLowerCase();
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
      const active = it.href.toLowerCase() === here ? ' active' : '';
      const badge = it.badge ? '<span class="badge" data-fc="tasks-badge" style="display:none"></span>' : '';
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
  }

  // Atualiza o badge de tarefas ("3" vermelho no menu). Chamado pelas páginas que
  // sabem a contagem real (dashboard, tarefas). Sem contagem, fica escondido.
  window.setTasksBadge = function (count) {
    document.querySelectorAll('[data-fc="tasks-badge"]').forEach((el) => {
      if (count > 0) { el.textContent = count > 9 ? '9+' : count; el.style.display = 'flex'; }
      else { el.textContent = ''; el.style.display = 'none'; }
    });
  };

  window.hydrateSidebar = hydrate;

  // Menu montado o quanto antes (o script carrega no fim do <body>, a .sb-nav já existe).
  renderNav();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hydrate);
  else hydrate();
})();
