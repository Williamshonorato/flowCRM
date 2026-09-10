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

  // Marca como ativo o item de menu cuja href aponta pra página atual.
  function highlightActive() {
    const here = (location.pathname.split('/').pop() || 'crm-dashboard.html').toLowerCase();
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

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hydrate);
  else hydrate();
})();
