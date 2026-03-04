import { Hono } from 'hono';

import { TenantOrchestrator } from './durable-objects/tenant-orchestrator';
import {
  AgentRunJobMessage,
  CanonicalInboundEvent,
  Env,
  TenantOrchestratorRequest,
} from './types';

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

async function computeHmacSha256Hex(
  key: string,
  payload: string,
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    new TextEncoder().encode(payload),
  );
  const bytes = new Uint8Array(signature);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

async function verifySharedSignature(
  request: Request,
  env: Env,
  rawBody: string,
): Promise<boolean> {
  if (!env.WEBHOOK_SHARED_SECRET) return true;

  const signature = request.headers.get('x-webhook-signature');
  if (!signature) return false;

  const expected = await computeHmacSha256Hex(env.WEBHOOK_SHARED_SECRET, rawBody);
  // Keep comparison simple for now; channel-specific verifiers are added later.
  return signature === expected;
}

function buildCanonicalEvent(args: {
  tenantId: string;
  channel: string;
  eventId: string;
  payload: Record<string, unknown>;
}): CanonicalInboundEvent {
  const payload = args.payload;
  const chatJid =
    (typeof payload.chat_jid === 'string' && payload.chat_jid) ||
    (typeof payload.chatJid === 'string' && payload.chatJid) ||
    'unknown';

  const sender =
    (typeof payload.sender === 'string' && payload.sender) ||
    (typeof payload.from === 'string' && payload.from) ||
    undefined;

  const senderName =
    (typeof payload.sender_name === 'string' && payload.sender_name) ||
    (typeof payload.senderName === 'string' && payload.senderName) ||
    undefined;

  const content =
    (typeof payload.content === 'string' && payload.content) ||
    (typeof payload.text === 'string' && payload.text) ||
    undefined;

  return {
    eventId: args.eventId,
    tenantId: args.tenantId,
    channel: args.channel,
    receivedAt: new Date().toISOString(),
    chatJid,
    sender,
    senderName,
    content,
    payload,
  };
}

async function routeInboundEvent(
  env: Env,
  event: CanonicalInboundEvent,
): Promise<Response> {
  const id = env.TENANT_ORCHESTRATOR.idFromName(event.tenantId);
  const stub = env.TENANT_ORCHESTRATOR.get(id);

  const requestBody: TenantOrchestratorRequest = {
    type: 'inbound_event',
    event,
  };

  return stub.fetch('https://tenant-orchestrator/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
}

function parseRunJob(
  body: unknown,
): AgentRunJobMessage | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;
  if (
    typeof raw.runId !== 'string' ||
    typeof raw.tenantId !== 'string' ||
    typeof raw.eventId !== 'string' ||
    typeof raw.channel !== 'string' ||
    typeof raw.chatJid !== 'string' ||
    typeof raw.enqueuedAt !== 'string'
  ) {
    return null;
  }
  return {
    runId: raw.runId,
    tenantId: raw.tenantId,
    eventId: raw.eventId,
    channel: raw.channel,
    chatJid: raw.chatJid,
    content: typeof raw.content === 'string' ? raw.content : undefined,
    enqueuedAt: raw.enqueuedAt,
  };
}

async function updateRunStatus(
  env: Env,
  job: AgentRunJobMessage,
  status: 'processing' | 'awaiting_runtime' | 'completed' | 'failed',
  detail?: string,
): Promise<void> {
  const id = env.TENANT_ORCHESTRATOR.idFromName(job.tenantId);
  const stub = env.TENANT_ORCHESTRATOR.get(id);

  const requestBody: TenantOrchestratorRequest = {
    type: 'run_status_update',
    runId: job.runId,
    tenantId: job.tenantId,
    status,
    detail,
    processedAt: new Date().toISOString(),
  };

  await stub.fetch('https://tenant-orchestrator/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
}

async function processRunJob(env: Env, job: AgentRunJobMessage): Promise<void> {
  await updateRunStatus(env, job, 'processing');

  // Runtime invocation is implemented in a later phase.
  // For now, mark the run as accepted by the queue pipeline.
  await updateRunStatus(
    env,
    job,
    'awaiting_runtime',
    'Queue dispatch succeeded; runtime integration pending',
  );
}

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) =>
  c.json({
    ok: true,
    service: 'nanoclaw-event-driven',
    env: c.env.APP_ENV ?? 'unknown',
  }),
);

app.on(
  ['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  '/webhooks/:channel',
  (c) => c.json({ error: 'Method not allowed' }, 405),
);

app.post('/webhooks/:channel', async (c) => {
  const channel = c.req.param('channel');
  const tenantId = c.req.header('x-tenant-id');
  if (!tenantId) {
    return c.json({ error: 'Missing x-tenant-id header' }, 400);
  }

  const rawBody = await c.req.text();
  if (!(await verifySharedSignature(c.req.raw, c.env, rawBody))) {
    return c.json({ error: 'Invalid webhook signature' }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const eventIdHeader = c.req.header('x-event-id');
  const eventId =
    eventIdHeader ?? (await sha256Hex(`${tenantId}:${channel}:${rawBody}`)).slice(0, 32);

  const canonical = buildCanonicalEvent({
    tenantId,
    channel,
    eventId,
    payload,
  });

  const response = await routeInboundEvent(c.env, canonical);
  return response;
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  console.error('request failed', err);
  return c.json({ error: 'Internal server error' }, 500);
});

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const parsed = parseRunJob(message.body);
      if (!parsed) {
        // Drop malformed payloads; they are not retriable.
        message.ack();
        continue;
      }

      try {
        await processRunJob(env, parsed);
        message.ack();
      } catch (err) {
        const runId = parsed.runId;
        console.error('queue process failed', {
          runId,
          tenantId: parsed.tenantId,
          err,
        });
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env>;

export { TenantOrchestrator };

