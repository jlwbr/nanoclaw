export type AgentPlanId = 'starter' | 'growth' | 'scale';

export interface AgentPlan {
  id: AgentPlanId;
  name: string;
  priceUsdMonthly: number;
  description: string;
  features: string[];
  limits: {
    requestsPerMinute: number;
    tokenBudgetDaily: number;
    maxConcurrentRuns: number;
  };
}

const CHANNEL_OPTIONS = [
  'whatsapp',
  'telegram',
  'slack',
  'discord',
  'gmail',
] as const;

type AgentChannel = (typeof CHANNEL_OPTIONS)[number];

export interface PurchasePayload {
  fullName: string;
  email: string;
  company: string;
  planId: AgentPlanId;
  assistantName: string;
  channels: AgentChannel[];
  timezone: string;
  useCase: string;
}

export interface SetupGuide {
  steps: string[];
  quickstartCommand: string;
  sampleWebhookCommand: string;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const AGENT_PLANS: AgentPlan[] = [
  {
    id: 'starter',
    name: 'Starter',
    priceUsdMonthly: 29,
    description: 'Great for solo operators automating daily tasks.',
    features: [
      '1 tenant workspace',
      'Task scheduler and webhook ingress',
      'Usage dashboard and billing export',
    ],
    limits: {
      requestsPerMinute: 120,
      tokenBudgetDaily: 1_000_000,
      maxConcurrentRuns: 2,
    },
  },
  {
    id: 'growth',
    name: 'Growth',
    priceUsdMonthly: 89,
    description: 'For teams running multiple channels and workflows.',
    features: [
      '3 tenant workspaces',
      'Higher throughput for inbound traffic',
      'Priority queue retries',
    ],
    limits: {
      requestsPerMinute: 360,
      tokenBudgetDaily: 3_500_000,
      maxConcurrentRuns: 6,
    },
  },
  {
    id: 'scale',
    name: 'Scale',
    priceUsdMonthly: 249,
    description: 'Enterprise-grade plan for always-on agent operations.',
    features: [
      'Unlimited tenant expansion',
      'Aggressive rate + concurrency envelopes',
      'Priority support handoff metadata',
    ],
    limits: {
      requestsPerMinute: 1_200,
      tokenBudgetDaily: 12_000_000,
      maxConcurrentRuns: 16,
    },
  },
];

function normalizeText(raw: unknown, maxLength: number): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function parseChannels(raw: unknown): AgentChannel[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set<AgentChannel>(CHANNEL_OPTIONS);
  const seen = new Set<AgentChannel>();
  for (const value of raw) {
    const normalized = normalizeText(value, 24).toLowerCase() as AgentChannel;
    if (allowed.has(normalized)) seen.add(normalized);
  }
  return Array.from(seen);
}

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function getPlanById(planId: string): AgentPlan | undefined {
  return AGENT_PLANS.find((plan) => plan.id === planId);
}

export function parsePurchasePayload(
  body: unknown,
): { ok: true; value: PurchasePayload } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Payload must be a JSON object' };
  }
  const raw = body as Record<string, unknown>;
  const fullName = normalizeText(raw.fullName, 120);
  const email = normalizeText(raw.email, 180).toLowerCase();
  const company = normalizeText(raw.company, 120);
  const planId = normalizeText(raw.planId, 32) as AgentPlanId;
  const assistantName = normalizeText(raw.assistantName, 64);
  const timezone = normalizeText(raw.timezone, 64) || 'UTC';
  const useCase = normalizeText(raw.useCase, 1_000);
  const channels = parseChannels(raw.channels);

  if (
    !fullName ||
    !email ||
    !company ||
    !planId ||
    !assistantName ||
    !useCase
  ) {
    return { ok: false, error: 'Missing required purchase fields' };
  }
  if (!EMAIL_REGEX.test(email)) {
    return { ok: false, error: 'Email address is invalid' };
  }
  if (!getPlanById(planId)) {
    return { ok: false, error: 'Selected plan is invalid' };
  }
  if (channels.length === 0) {
    return { ok: false, error: 'Select at least one channel for your agent' };
  }

  return {
    ok: true,
    value: {
      fullName,
      email,
      company,
      planId,
      assistantName,
      channels,
      timezone,
      useCase,
    },
  };
}

export function createTenantId(args: { company: string; email: string }): string {
  const companySlug = slugify(args.company);
  const fallbackSlug = slugify(args.email.split('@')[0] ?? 'tenant');
  const prefix = companySlug || fallbackSlug || 'tenant';
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export function createOrderId(): string {
  return `ord_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

export function buildSetupGuide(args: {
  origin: string;
  tenantId: string;
  assistantName: string;
  channels: AgentChannel[];
  timezone: string;
  plan: AgentPlan;
}): SetupGuide {
  const origin = args.origin.replace(/\/+$/, '');
  const primaryChannel = args.channels[0] ?? 'telegram';
  const scheduleJson = JSON.stringify({
    chatJid: 'main-chat',
    groupFolder: 'main',
    prompt: `Send a welcome update from ${args.assistantName}`,
    scheduleType: 'once',
    scheduleValue: 'in 5 minutes',
    contextMode: 'isolated',
  });

  return {
    steps: [
      `Payment confirmed for the ${args.plan.name} plan.`,
      `Tenant ${args.tenantId} was created with production-safe defaults.`,
      `Use ${args.timezone} as your scheduling timezone.`,
      `Connect your ${args.channels.join(', ')} channels and send your first webhook event.`,
    ],
    quickstartCommand: [
      `export NANOCLAW_TENANT_ID="${args.tenantId}"`,
      `curl -X POST "${origin}/tenants/${args.tenantId}/tasks" \\`,
      '  -H "content-type: application/json" \\',
      `  -d '${scheduleJson}'`,
    ].join('\n'),
    sampleWebhookCommand: [
      `curl -X POST "${origin}/webhooks/${primaryChannel}" \\`,
      `  -H "x-tenant-id: ${args.tenantId}" \\`,
      '  -H "content-type: application/json" \\',
      `  -d '{"chat_jid":"chat-1","sender":"owner","content":"@${args.assistantName} hello"}'`,
    ].join('\n'),
  };
}

function renderPlanCards(): string {
  return AGENT_PLANS.map((plan) => {
    const features = plan.features
      .map((feature) => `<li>${escapeHtml(feature)}</li>`)
      .join('');
    return `<button type="button" class="plan-card" data-plan="${plan.id}">
      <p class="plan-tag">${escapeHtml(plan.name)}</p>
      <h3>$${plan.priceUsdMonthly}<span>/month</span></h3>
      <p class="plan-description">${escapeHtml(plan.description)}</p>
      <ul>${features}</ul>
    </button>`;
  }).join('');
}

export function renderPurchasePage(): string {
  const planSummary = AGENT_PLANS.map((plan) => ({
    id: plan.id,
    name: plan.name,
    priceUsdMonthly: plan.priceUsdMonthly,
  }));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>NanoClaw Agent Purchase + Setup</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #09090b;
      --panel: #18181b;
      --muted: #a1a1aa;
      --line: #27272a;
      --text: #f4f4f5;
      --brand: #6366f1;
      --brand-strong: #818cf8;
      --ok: #22c55e;
      --danger: #f87171;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background: radial-gradient(1200px 800px at 20% -5%, #1d2444 0%, var(--bg) 60%);
      color: var(--text);
    }
    .shell {
      max-width: 1100px;
      margin: 0 auto;
      padding: 2rem 1rem 3rem;
    }
    .hero {
      margin-bottom: 2rem;
    }
    .hero h1 {
      margin: 0 0 0.5rem;
      font-size: clamp(1.6rem, 2.4vw, 2.4rem);
    }
    .hero p {
      margin: 0;
      color: var(--muted);
      max-width: 760px;
    }
    .grid {
      display: grid;
      grid-template-columns: 1.1fr 1fr;
      gap: 1rem;
    }
    .panel {
      border: 1px solid var(--line);
      border-radius: 1rem;
      background: color-mix(in oklab, var(--panel) 94%, black 6%);
      padding: 1rem;
    }
    .panel h2 {
      margin: 0 0 0.9rem;
      font-size: 1.1rem;
    }
    .plans {
      display: grid;
      gap: 0.75rem;
    }
    .plan-card {
      width: 100%;
      text-align: left;
      border: 1px solid var(--line);
      border-radius: 0.75rem;
      background: #101014;
      color: var(--text);
      padding: 0.9rem;
      cursor: pointer;
      transition: border-color 0.15s ease, transform 0.15s ease;
    }
    .plan-card:hover {
      border-color: var(--brand);
      transform: translateY(-1px);
    }
    .plan-card.selected {
      border-color: var(--brand-strong);
      box-shadow: 0 0 0 1px color-mix(in oklab, var(--brand-strong) 45%, transparent 55%);
    }
    .plan-tag {
      margin: 0;
      color: var(--brand-strong);
      font-size: 0.8rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .plan-card h3 {
      margin: 0.35rem 0 0;
      font-size: 1.6rem;
    }
    .plan-card h3 span {
      font-size: 0.95rem;
      font-weight: 500;
      color: var(--muted);
      margin-left: 0.2rem;
    }
    .plan-description {
      color: var(--muted);
      margin: 0.5rem 0;
    }
    .plan-card ul {
      margin: 0;
      padding-left: 1rem;
      color: #d4d4d8;
      display: grid;
      gap: 0.2rem;
      font-size: 0.92rem;
    }
    form {
      display: grid;
      gap: 0.8rem;
    }
    .row {
      display: grid;
      gap: 0.7rem;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    label {
      display: grid;
      gap: 0.35rem;
      font-size: 0.87rem;
      color: #e4e4e7;
    }
    input, textarea, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 0.65rem;
      background: #0f0f12;
      color: var(--text);
      padding: 0.55rem 0.65rem;
      font: inherit;
    }
    textarea {
      min-height: 90px;
      resize: vertical;
    }
    .channels {
      display: grid;
      gap: 0.35rem 0.8rem;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      margin-top: 0.25rem;
    }
    .channels label {
      display: flex;
      align-items: center;
      gap: 0.45rem;
      font-size: 0.86rem;
      color: #d4d4d8;
    }
    .channels input {
      width: auto;
      margin: 0;
    }
    .cta {
      border: none;
      border-radius: 0.7rem;
      background: linear-gradient(120deg, var(--brand), #4f46e5);
      color: white;
      font: inherit;
      font-weight: 600;
      padding: 0.68rem 0.9rem;
      cursor: pointer;
    }
    .cta[disabled] {
      opacity: 0.65;
      cursor: wait;
    }
    .selected-plan {
      margin: 0;
      color: var(--muted);
      font-size: 0.9rem;
    }
    .status {
      margin: 0;
      min-height: 1.25rem;
      font-size: 0.9rem;
    }
    .status.error { color: var(--danger); }
    .status.ok { color: var(--ok); }
    .result {
      margin-top: 1rem;
      border-top: 1px solid var(--line);
      padding-top: 1rem;
      display: grid;
      gap: 0.85rem;
    }
    .result h3 {
      margin: 0;
      font-size: 1rem;
    }
    .result p {
      margin: 0;
      color: #d4d4d8;
      font-size: 0.9rem;
    }
    .result ol {
      margin: 0;
      padding-left: 1.25rem;
      display: grid;
      gap: 0.25rem;
      color: #d4d4d8;
      font-size: 0.92rem;
    }
    pre {
      margin: 0;
      border: 1px solid var(--line);
      border-radius: 0.65rem;
      background: #0c0c0f;
      padding: 0.7rem;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 0.83rem;
      line-height: 1.45;
    }
    @media (max-width: 900px) {
      .grid {
        grid-template-columns: 1fr;
      }
    }
    @media (max-width: 560px) {
      .row, .channels {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="hero">
      <h1>Buy NanoClaw and set up your agent in minutes</h1>
      <p>
        Choose a plan, connect your channels, and get instant setup commands for your tenant.
        This checkout flow provisions limits and gives you production-ready API calls.
      </p>
    </header>
    <main class="grid">
      <section class="panel">
        <h2>1) Choose a plan</h2>
        <div class="plans">
          ${renderPlanCards()}
        </div>
      </section>
      <section class="panel">
        <h2>2) Checkout + setup details</h2>
        <form id="purchase-form">
          <input type="hidden" name="planId" id="planId" value="starter" />
          <p class="selected-plan">
            Selected plan: <strong id="selected-plan-name">Starter</strong>
            (<span id="selected-plan-price">$29/month</span>)
          </p>
          <div class="row">
            <label>Full name
              <input name="fullName" required autocomplete="name" placeholder="Ada Lovelace" />
            </label>
            <label>Email
              <input name="email" required type="email" autocomplete="email" placeholder="ada@company.com" />
            </label>
          </div>
          <div class="row">
            <label>Company
              <input name="company" required autocomplete="organization" placeholder="Acme Robotics" />
            </label>
            <label>Assistant name
              <input name="assistantName" required value="Andy" placeholder="Andy" />
            </label>
          </div>
          <div class="row">
            <label>Timezone
              <input name="timezone" required value="UTC" placeholder="America/New_York" />
            </label>
            <label>Primary use case
              <input name="useCase" required placeholder="Customer support triage + follow-up scheduling" />
            </label>
          </div>
          <label>Channels to enable
            <div class="channels">
              <label><input type="checkbox" name="channels" value="whatsapp" checked /> WhatsApp</label>
              <label><input type="checkbox" name="channels" value="telegram" /> Telegram</label>
              <label><input type="checkbox" name="channels" value="slack" /> Slack</label>
              <label><input type="checkbox" name="channels" value="discord" /> Discord</label>
              <label><input type="checkbox" name="channels" value="gmail" /> Gmail</label>
            </div>
          </label>
          <button type="submit" class="cta" id="submit-btn">Buy and provision agent</button>
          <p id="status" class="status"></p>
        </form>
        <section id="result" class="result" hidden>
          <h3>3) Provisioning complete</h3>
          <p>Order: <strong id="order-id"></strong></p>
          <p>Tenant: <strong id="tenant-id"></strong></p>
          <p>Next steps:</p>
          <ol id="setup-steps"></ol>
          <p>Quickstart task API call:</p>
          <pre id="quickstart-command"></pre>
          <p>Sample webhook event:</p>
          <pre id="sample-webhook"></pre>
        </section>
      </section>
    </main>
  </div>
  <script type="module">
    const plans = ${JSON.stringify(planSummary)};
    const planIdInput = document.getElementById('planId');
    const selectedPlanName = document.getElementById('selected-plan-name');
    const selectedPlanPrice = document.getElementById('selected-plan-price');
    const statusEl = document.getElementById('status');
    const form = document.getElementById('purchase-form');
    const submitButton = document.getElementById('submit-btn');
    const result = document.getElementById('result');
    const orderIdEl = document.getElementById('order-id');
    const tenantIdEl = document.getElementById('tenant-id');
    const setupStepsEl = document.getElementById('setup-steps');
    const quickstartEl = document.getElementById('quickstart-command');
    const webhookEl = document.getElementById('sample-webhook');
    const planCards = Array.from(document.querySelectorAll('.plan-card'));

    function getPlan(planId) {
      return plans.find((plan) => plan.id === planId) || plans[0];
    }

    function setPlan(planId) {
      const nextPlan = getPlan(planId);
      planIdInput.value = nextPlan.id;
      selectedPlanName.textContent = nextPlan.name;
      selectedPlanPrice.textContent = '$' + nextPlan.priceUsdMonthly + '/month';
      planCards.forEach((node) => {
        node.classList.toggle('selected', node.dataset.plan === nextPlan.id);
      });
    }

    function setStatus(text, mode) {
      statusEl.textContent = text;
      statusEl.classList.remove('error', 'ok');
      if (mode) statusEl.classList.add(mode);
    }

    planCards.forEach((node) => {
      node.addEventListener('click', () => setPlan(node.dataset.plan || 'starter'));
    });
    setPlan('starter');

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      submitButton.disabled = true;
      setStatus('Processing checkout and provisioning tenant...');
      try {
        const data = new FormData(form);
        const payload = {
          fullName: String(data.get('fullName') || ''),
          email: String(data.get('email') || ''),
          company: String(data.get('company') || ''),
          planId: String(data.get('planId') || ''),
          assistantName: String(data.get('assistantName') || ''),
          timezone: String(data.get('timezone') || 'UTC'),
          useCase: String(data.get('useCase') || ''),
          channels: data.getAll('channels').map((value) => String(value)),
        };

        const response = await fetch('/api/purchase', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const body = await response.json();
        if (!response.ok) {
          throw new Error(body.error || 'Purchase failed');
        }

        orderIdEl.textContent = body.orderId;
        tenantIdEl.textContent = body.tenantId;
        quickstartEl.textContent = body.setup.quickstartCommand;
        webhookEl.textContent = body.setup.sampleWebhookCommand;

        while (setupStepsEl.firstChild) {
          setupStepsEl.removeChild(setupStepsEl.firstChild);
        }
        (body.setup.steps || []).forEach((step) => {
          const li = document.createElement('li');
          li.textContent = step;
          setupStepsEl.appendChild(li);
        });

        result.hidden = false;
        setStatus('Agent purchased and tenant provisioned.', 'ok');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Purchase failed';
        setStatus(message, 'error');
      } finally {
        submitButton.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}
