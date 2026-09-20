// Sample accessibility graph data for the interactive simulator
const sampleNodes = {
  'nav-dash': {
    id: 'nav-dash',
    role: 'link',
    name: 'Dashboard',
    bounds: { x: 620, y: 22, width: 80, height: 28 },
    capabilities: [{ name: 'navigate', tier: 'READ', method: 'click' }],
    state: { current: 'page' },
    parent: 'mock-header'
  },
  'nav-tickets': {
    id: 'nav-tickets',
    role: 'link',
    name: 'Tickets',
    bounds: { x: 710, y: 22, width: 65, height: 28 },
    capabilities: [{ name: 'navigate', tier: 'READ', method: 'click' }],
    parent: 'mock-header'
  },
  'nav-settings': {
    id: 'nav-settings',
    role: 'link',
    name: 'Settings',
    bounds: { x: 785, y: 22, width: 70, height: 28 },
    capabilities: [{ name: 'navigate', tier: 'READ', method: 'click' }],
    parent: 'mock-header'
  },
  'btn-create': {
    id: 'btn-create',
    role: 'button',
    name: 'Create Ticket',
    bounds: { x: 740, y: 92, width: 110, height: 32 },
    capabilities: [{ name: 'open_modal', tier: 'EXECUTE', method: 'click', target: 'modal-ticket-create' }],
    securityTier: 'EXECUTE',
    parent: 'mock-card-header'
  },
  'inp-search': {
    id: 'inp-search',
    role: 'searchbox',
    name: 'Search Workspace',
    bounds: { x: 220, y: 140, width: 630, height: 36 },
    capabilities: [{ name: 'filter_tasks', tier: 'READ', method: 'fill' }],
    state: { value: '', placeholder: 'Search tasks, docs...' },
    parent: 'mock-field'
  },
  'btn-close-1': {
    id: 'btn-close-1',
    role: 'button',
    name: 'Resolve Task 1',
    bounds: { x: 770, y: 225, width: 80, height: 26 },
    capabilities: [{ name: 'resolve_task', tier: 'CONFIRM', method: 'click' }],
    securityTier: 'CONFIRM',
    parent: 'mock-row-1'
  },
  'btn-close-2': {
    id: 'btn-close-2',
    role: 'button',
    name: 'Approve Deployment',
    bounds: { x: 770, y: 265, width: 80, height: 26 },
    capabilities: [{ name: 'deploy_sea', tier: 'CONFIRM', method: 'click' }],
    securityTier: 'CONFIRM',
    parent: 'mock-row-2'
  }
};

const predefinedQueries = {
  'buttons': {
    payload: { select: 'ax-node', where: { role: 'button' } },
    response: {
      matches: [
        sampleNodes['btn-create'],
        sampleNodes['btn-close-1'],
        sampleNodes['btn-close-2']
      ],
      total: 3,
      execution_ms: 1.2,
      substrate: 'web-bidi'
    }
  },
  'searchbox': {
    payload: { select: 'ax-node', where: { role: 'searchbox' } },
    response: {
      matches: [sampleNodes['inp-search']],
      total: 1,
      execution_ms: 0.8,
      substrate: 'web-bidi'
    }
  },
  'capabilities': {
    payload: { query: 'active_page', filter: { securityTier: ['EXECUTE', 'CONFIRM'] } },
    response: {
      capabilities: [
        { tool: 'open_modal', role: 'button', target: 'modal-ticket-create', tier: 'EXECUTE' },
        { tool: 'resolve_task', role: 'button', target: 'task-1', tier: 'CONFIRM', warning: 'Requires explicit user approval' },
        { tool: 'deploy_sea', role: 'button', target: 'task-2', tier: 'CONFIRM', warning: 'Requires explicit user approval' }
      ],
      safetyEngine: 'NexusOS Strict Guard'
    }
  },
  'path': {
    payload: { from: 'nav-dash', to: 'btn-create', relation: 'shortest-path' },
    response: {
      path: ['nav-dash', 'mock-header', 'mock-body', 'mock-card', 'mock-card-header', 'btn-create'],
      distance: 5,
      confidence: 1.0
    }
  }
};

document.addEventListener('DOMContentLoaded', () => {
  const querySelect = document.getElementById('query-select');
  const payloadPreview = document.getElementById('query-payload-preview');
  const resultJson = document.getElementById('query-result-json');
  const runBtn = document.getElementById('run-query-btn');
  const interactiveEls = document.querySelectorAll('.interactive-el');

  // Query selection changed
  if (querySelect) {
    querySelect.addEventListener('change', () => {
      const q = predefinedQueries[querySelect.value];
      if (q) {
        payloadPreview.textContent = JSON.stringify(q.payload, null, 2);
      }
    });

    // Initial execute
    runBtn.addEventListener('click', () => {
      const q = predefinedQueries[querySelect.value];
      if (q) {
        interactiveEls.forEach(el => el.classList.remove('active-highlight'));

        if (querySelect.value === 'buttons') {
          document.querySelectorAll('[data-role="button"]').forEach(el => el.classList.add('active-highlight'));
        } else if (querySelect.value === 'searchbox') {
          document.getElementById('mock-search').classList.add('active-highlight');
        }

        resultJson.textContent = JSON.stringify(q.response, null, 2);
      }
    });
  }

  // Click UI element directly
  interactiveEls.forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = el.dataset.id;
      const node = sampleNodes[id];

      interactiveEls.forEach(other => other.classList.remove('active-highlight'));
      el.classList.add('active-highlight');

      if (node) {
        payloadPreview.textContent = JSON.stringify({
          select: 'ax-node',
          where: { id: node.id }
        }, null, 2);

        resultJson.textContent = JSON.stringify({
          node: node,
          parent: sampleNodes[node.parent] || { id: node.parent, role: 'group' },
          kineticAction: {
            method: node.capabilities?.[0]?.method || 'click',
            centerCoordinates: {
              x: node.bounds.x + node.bounds.width / 2,
              y: node.bounds.y + node.bounds.height / 2
            }
          }
        }, null, 2);
      }
    });
  });

  // Tab switching
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.tab;

      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      const targetContent = document.getElementById(`tab-${targetTab}`);
      if (targetContent) {
        targetContent.classList.add('active');
      }
    });
  });

  // Copy code buttons
  document.querySelectorAll('.copy-code-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.target;
      const targetEl = document.getElementById(targetId);
      if (targetEl) {
        navigator.clipboard.writeText(targetEl.textContent.trim()).then(() => {
          const originalText = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = originalText; }, 2000);
        });
      }
    });
  });

  // Hero copy button
  const heroCopyBtn = document.getElementById('hero-copy-btn');
  if (heroCopyBtn) {
    heroCopyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText('npx -y agent-web-graph doctor').then(() => {
        heroCopyBtn.textContent = 'Copied!';
        setTimeout(() => { heroCopyBtn.textContent = 'Copy'; }, 2000);
      });
    });
  }

  if (runBtn) {
    runBtn.click();
  }
});
