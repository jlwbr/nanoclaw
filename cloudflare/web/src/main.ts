import './style.css';

type ScheduleType = 'once' | 'interval' | 'cron';

interface SetupState {
  tenantId: string;
  displayName: string;
  email: string;
  externalRef: string;
  prompt: string;
  scheduleType: ScheduleType;
  scheduleValue: string;
  returnUrl: string;
}

const fiveMinutes = new Date(Date.now() + 5 * 60_000).toISOString();

const state: SetupState = {
  tenantId: '',
  displayName: '',
  email: '',
  externalRef: '',
  prompt:
    'You are my bot assistant. Keep responses concise and actionable. Always include next steps.',
  scheduleType: 'once',
  scheduleValue: fiveMinutes,
  returnUrl: window.location.origin,
};

function requireTenantId(): string {
  const tenantId = state.tenantId.trim();
  if (!tenantId) {
    throw new Error('Tenant ID is required.');
  }
  return tenantId;
}

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      typeof payload?.error === 'object' && payload.error !== null
        ? String((payload.error as Record<string, unknown>).message ?? 'Request failed')
        : 'Request failed';
    throw new Error(message);
  }
  return payload;
}

function setOutput(value: unknown): void {
  const output = document.getElementById('setupOutput');
  if (!output) {
    return;
  }
  output.textContent = JSON.stringify(value, null, 2);
}

function setStatus(id: string, ready: boolean): void {
  const el = document.getElementById(id);
  if (!el) {
    return;
  }
  el.className = ready ? 'badge ready' : 'badge';
  el.textContent = ready ? 'ready' : 'pending';
}

function bindInput(
  id: string,
  assign: (value: string) => void,
): void {
  const input = document.getElementById(id) as
    | HTMLInputElement
    | HTMLTextAreaElement
    | HTMLSelectElement
    | null;
  if (!input) {
    return;
  }
  input.addEventListener('input', () => {
    assign(input.value);
  });
}

async function setupTenant(): Promise<void> {
  const payload = await requestJson('/api/setup/tenant', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tenantId: requireTenantId(),
      displayName: state.displayName || undefined,
      email: state.email || undefined,
      externalRef: state.externalRef || undefined,
    }),
  });
  setStatus('tenantStatus', true);
  setOutput(payload);
}

async function createStarterTask(): Promise<void> {
  const payload = await requestJson('/api/setup/starter-task', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tenantId: requireTenantId(),
      prompt: state.prompt,
      scheduleType: state.scheduleType,
      scheduleValue: state.scheduleValue,
    }),
  });
  setStatus('taskStatus', true);
  setOutput(payload);
}

async function connectBilling(): Promise<void> {
  const payload = await requestJson('/api/setup/billing/customer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tenantId: requireTenantId(),
      email: state.email || undefined,
      externalRef: state.externalRef || undefined,
    }),
  });
  setStatus('billingStatus', true);
  setOutput(payload);
}

async function openBillingPortal(): Promise<void> {
  const tenantId = requireTenantId();
  const payload = (await requestJson(
    `/api/tenants/${encodeURIComponent(tenantId)}/billing/portal-session`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        returnUrl: state.returnUrl,
      }),
    },
  )) as Record<string, unknown>;
  const url = payload.url;
  if (typeof url === 'string' && url.length > 0) {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
  setOutput(payload);
}

async function loadSetupStatus(): Promise<void> {
  const tenantId = requireTenantId();
  const payload = (await requestJson(
    `/api/setup/status?tenantId=${encodeURIComponent(tenantId)}`,
  )) as Record<string, unknown>;
  const setup = payload.setup as Record<string, unknown> | undefined;
  const billing = payload.billing as Record<string, unknown> | undefined;
  setStatus('tenantStatus', true);
  setStatus('taskStatus', Boolean(setup?.hasStarterTask));
  setStatus(
    'billingStatus',
    typeof billing?.customer === 'object' && billing.customer !== null,
  );
  setOutput(payload);
}

async function finishSetup(): Promise<void> {
  const payload = (await requestJson('/api/setup/finish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tenantId: requireTenantId(),
    }),
  })) as Record<string, unknown>;
  const ready = payload.ready === true;
  setStatus('finishStatus', ready);
  setOutput(payload);
}

function bindButton(id: string, handler: () => Promise<void>): void {
  const button = document.getElementById(id) as HTMLButtonElement | null;
  if (!button) {
    return;
  }
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await handler();
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
    } finally {
      button.disabled = false;
    }
  });
}

function render(): void {
  const app = document.getElementById('app');
  if (!app) {
    throw new Error('Missing app root element');
  }

  app.innerHTML = `
    <main>
      <header>
        <h1>NanoClaw Bot Setup</h1>
        <p>Use this setup flow to provision a tenant, configure starter behavior, connect billing, and verify readiness.</p>
      </header>

      <section>
        <div class="step-title">
          <h2>1) Tenant setup</h2>
          <span id="tenantStatus" class="badge">pending</span>
        </div>
        <div class="grid">
          <div>
            <label for="tenantId">Tenant ID</label>
            <input id="tenantId" value="${state.tenantId}" placeholder="tenant_acme" />
          </div>
          <div>
            <label for="displayName">Display name</label>
            <input id="displayName" value="${state.displayName}" placeholder="Acme Inc" />
          </div>
          <div>
            <label for="email">Billing email (optional)</label>
            <input id="email" type="email" value="${state.email}" placeholder="ops@acme.com" />
          </div>
          <div>
            <label for="externalRef">External ref (optional)</label>
            <input id="externalRef" value="${state.externalRef}" placeholder="acme-prod" />
          </div>
        </div>
        <button id="setupTenantBtn" type="button">Save tenant</button>
      </section>

      <section>
        <div class="step-title">
          <h2>2) Starter bot behavior</h2>
          <span id="taskStatus" class="badge">pending</span>
        </div>
        <label for="prompt">Starter prompt</label>
        <textarea id="prompt">${state.prompt}</textarea>
        <div class="grid">
          <div>
            <label for="scheduleType">Schedule type</label>
            <select id="scheduleType">
              <option value="once" ${state.scheduleType === 'once' ? 'selected' : ''}>once</option>
              <option value="interval" ${state.scheduleType === 'interval' ? 'selected' : ''}>interval</option>
              <option value="cron" ${state.scheduleType === 'cron' ? 'selected' : ''}>cron</option>
            </select>
          </div>
          <div>
            <label for="scheduleValue">Schedule value</label>
            <input id="scheduleValue" value="${state.scheduleValue}" />
          </div>
        </div>
        <button id="starterTaskBtn" type="button">Create starter task</button>
      </section>

      <section>
        <div class="step-title">
          <h2>3) Billing connection</h2>
          <span id="billingStatus" class="badge">pending</span>
        </div>
        <div class="grid">
          <button id="connectBillingBtn" type="button">Connect Autumn customer</button>
          <button id="openPortalBtn" type="button">Open billing portal</button>
        </div>
      </section>

      <section>
        <div class="step-title">
          <h2>4) Verify and finish</h2>
          <span id="finishStatus" class="badge">pending</span>
        </div>
        <div class="grid">
          <button id="statusBtn" type="button">Load setup status</button>
          <button id="finishBtn" type="button">Finish setup</button>
        </div>
        <pre id="setupOutput" aria-label="Setup output"></pre>
      </section>
    </main>
  `;

  bindInput('tenantId', (value) => {
    state.tenantId = value;
  });
  bindInput('displayName', (value) => {
    state.displayName = value;
  });
  bindInput('email', (value) => {
    state.email = value;
  });
  bindInput('externalRef', (value) => {
    state.externalRef = value;
  });
  bindInput('prompt', (value) => {
    state.prompt = value;
  });
  bindInput('scheduleType', (value) => {
    state.scheduleType = value as ScheduleType;
  });
  bindInput('scheduleValue', (value) => {
    state.scheduleValue = value;
  });

  bindButton('setupTenantBtn', setupTenant);
  bindButton('starterTaskBtn', createStarterTask);
  bindButton('connectBillingBtn', connectBilling);
  bindButton('openPortalBtn', openBillingPortal);
  bindButton('statusBtn', loadSetupStatus);
  bindButton('finishBtn', finishSetup);
}

render();
