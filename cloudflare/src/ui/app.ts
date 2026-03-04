export function renderAppHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>NanoClaw Hosted</title>
    <style>
      :root {
        --bg: #0b1020;
        --surface: #151d35;
        --surface-alt: #1e2848;
        --text: #e6e9f6;
        --muted: #9ca7c6;
        --accent: #5ea0ff;
        --ok: #3ecf8e;
        --warn: #ffb648;
        --err: #ff6d6d;
      }
      body {
        margin: 0;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
        background: var(--bg);
        color: var(--text);
      }
      header {
        padding: 1rem;
        background: var(--surface);
        border-bottom: 1px solid #2d3963;
      }
      h1, h2 {
        margin: 0;
      }
      main {
        padding: 1rem;
        display: grid;
        gap: 1rem;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 1rem;
      }
      section {
        background: var(--surface);
        border: 1px solid #2d3963;
        border-radius: 12px;
        padding: 1rem;
      }
      label {
        display: block;
        margin-top: 0.5rem;
        margin-bottom: 0.25rem;
      }
      input, textarea, select, button {
        width: 100%;
        border-radius: 8px;
        border: 1px solid #3b4a7d;
        padding: 0.6rem 0.7rem;
        background: var(--surface-alt);
        color: var(--text);
      }
      button {
        cursor: pointer;
        background: #29427a;
      }
      button:focus,
      input:focus,
      textarea:focus,
      select:focus {
        outline: 2px solid var(--accent);
        outline-offset: 1px;
      }
      .row {
        display: flex;
        gap: 0.5rem;
      }
      .row > * {
        flex: 1;
      }
      .badge {
        display: inline-block;
        padding: 0.2rem 0.5rem;
        border-radius: 999px;
        background: #27355f;
        color: var(--muted);
        font-size: 0.8rem;
      }
      .muted {
        color: var(--muted);
      }
      pre {
        overflow: auto;
        background: #0f1730;
        padding: 0.75rem;
        border-radius: 8px;
      }
      @media (max-width: 640px) {
        .row {
          flex-direction: column;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <h1>NanoClaw Hosted</h1>
      <p class="muted">Dashboard, tasks, billing, and health</p>
    </header>
    <main>
      <section>
        <h2>Tenant Session</h2>
        <label for="tenantId">Tenant ID</label>
        <input id="tenantId" name="tenantId" placeholder="tenant_demo" />
        <button id="loadDashboardBtn" type="button">Load Dashboard</button>
      </section>

      <div class="grid">
        <section>
          <h2>Dashboard</h2>
          <p><span class="badge">Tenant Status</span> <span id="tenantStatus">-</span></p>
          <p><span class="badge">Task Counts</span> <span id="taskCount">-</span></p>
          <p><span class="badge">Recent Runs</span> <span id="runCount">-</span></p>
          <pre id="dashboardJson" aria-label="Dashboard payload"></pre>
        </section>

        <section>
          <h2>Tasks</h2>
          <label for="taskPrompt">Prompt</label>
          <textarea id="taskPrompt" rows="4" placeholder="Task prompt"></textarea>
          <div class="row">
            <div>
              <label for="scheduleType">Schedule Type</label>
              <select id="scheduleType">
                <option value="once">once</option>
                <option value="interval">interval</option>
                <option value="cron">cron</option>
              </select>
            </div>
            <div>
              <label for="scheduleValue">Schedule Value</label>
              <input id="scheduleValue" placeholder="ISO, ms, or cron" />
            </div>
          </div>
          <div class="row" style="margin-top: 0.5rem">
            <button id="createTaskBtn" type="button">Create Task</button>
            <button id="listTaskBtn" type="button">Refresh Tasks</button>
          </div>
          <pre id="tasksJson" aria-label="Task list payload"></pre>
        </section>

        <section>
          <h2>Billing</h2>
          <div class="row">
            <button id="loadBillingBtn" type="button">Load Billing</button>
            <button id="openBillingPortalBtn" type="button">Manage Billing</button>
          </div>
          <pre id="billingJson" aria-label="Billing payload"></pre>
        </section>

        <section>
          <h2>Health / Admin</h2>
          <div class="row">
            <button id="loadHealthBtn" type="button">Load Health</button>
            <button id="reconcileBtn" type="button">Reconcile Tasks</button>
          </div>
          <pre id="healthJson" aria-label="Health payload"></pre>
        </section>
      </div>
    </main>
    <script type="module" src="/app.js"></script>
  </body>
</html>`;
}

export const APP_JS = `
const state = { tenantId: '' };
const byId = (id) => document.getElementById(id);
const tenantInput = byId('tenantId');

function getTenantId() {
  const value = tenantInput.value.trim();
  if (!value) {
    throw new Error('tenantId is required');
  }
  state.tenantId = value;
  return value;
}

async function getJson(url, init) {
  const response = await fetch(url, init);
  const json = await response.json();
  if (!response.ok) {
    throw new Error(json?.error?.message || 'request failed');
  }
  return json;
}

function setPre(id, value) {
  byId(id).textContent = JSON.stringify(value, null, 2);
}

async function loadDashboard() {
  const tenantId = getTenantId();
  const data = await getJson('/api/tenants/' + encodeURIComponent(tenantId) + '/dashboard');
  byId('tenantStatus').textContent = data.tenant.status;
  byId('taskCount').textContent = String(data.taskSummary.total);
  byId('runCount').textContent = String(data.recentRuns.length);
  setPre('dashboardJson', data);
}

async function listTasks() {
  const tenantId = getTenantId();
  const data = await getJson('/api/tenants/' + encodeURIComponent(tenantId) + '/tasks');
  setPre('tasksJson', data);
}

async function createTask() {
  const tenantId = getTenantId();
  const body = {
    prompt: byId('taskPrompt').value.trim(),
    scheduleType: byId('scheduleType').value,
    scheduleValue: byId('scheduleValue').value.trim(),
  };
  const data = await getJson('/api/tenants/' + encodeURIComponent(tenantId) + '/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  setPre('tasksJson', data);
}

async function loadBilling() {
  const tenantId = getTenantId();
  const data = await getJson('/api/tenants/' + encodeURIComponent(tenantId) + '/billing/summary');
  setPre('billingJson', data);
}

async function openPortal() {
  const tenantId = getTenantId();
  const data = await getJson('/api/tenants/' + encodeURIComponent(tenantId) + '/billing/portal-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ returnUrl: window.location.href }),
  });
  setPre('billingJson', data);
  if (data.url) {
    window.open(data.url, '_blank', 'noopener,noreferrer');
  }
}

async function loadHealth() {
  const data = await getJson('/health');
  setPre('healthJson', data);
}

async function reconcile() {
  const tenantId = getTenantId();
  const data = await getJson('/api/tenants/' + encodeURIComponent(tenantId) + '/reconcile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  setPre('healthJson', data);
}

function bind(id, handler) {
  byId(id).addEventListener('click', () => {
    handler().catch((error) => {
      alert(error.message || String(error));
    });
  });
}

bind('loadDashboardBtn', loadDashboard);
bind('listTaskBtn', listTasks);
bind('createTaskBtn', createTask);
bind('loadBillingBtn', loadBilling);
bind('openBillingPortalBtn', openPortal);
bind('loadHealthBtn', loadHealth);
bind('reconcileBtn', reconcile);
`;
