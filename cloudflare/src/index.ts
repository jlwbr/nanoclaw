import { Hono } from 'hono';

import {
  RuntimeExecutionFailure,
  executeRunJob,
} from './runtime/executor';
import { TenantOrchestrator } from './durable-objects/tenant-orchestrator';
import {
  AgentRunJobMessage,
  CanonicalInboundEvent,
  Env,
  TaskContextMode,
  TaskScheduleType,
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
  return routeTenantRequest(env, event.tenantId, {
    type: 'inbound_event',
    event,
  });
}

async function routeTenantRequest(
  env: Env,
  tenantId: string,
  requestBody: TenantOrchestratorRequest,
): Promise<Response> {
  const id = env.TENANT_ORCHESTRATOR.idFromName(tenantId);
  const stub = env.TENANT_ORCHESTRATOR.get(id);

  return stub.fetch('https://tenant-orchestrator/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
}

function parseTaskScheduleType(raw: string): TaskScheduleType | null {
  if (raw === 'cron' || raw === 'interval' || raw === 'once') return raw;
  return null;
}

function parseTaskContextMode(raw: unknown): TaskContextMode | null {
  if (raw === undefined || raw === null) return 'isolated';
  if (raw === 'group' || raw === 'isolated') return raw;
  return null;
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
  updates: Omit<
    Extract<TenantOrchestratorRequest, { type: 'run_status_update' }>,
    'type' | 'runId' | 'tenantId' | 'status' | 'processedAt'
  > = {},
): Promise<void> {
  const id = env.TENANT_ORCHESTRATOR.idFromName(job.tenantId);
  const stub = env.TENANT_ORCHESTRATOR.get(id);

  const requestBody: TenantOrchestratorRequest = {
    type: 'run_status_update',
    runId: job.runId,
    tenantId: job.tenantId,
    status,
    processedAt: new Date().toISOString(),
    ...updates,
  };

  await stub.fetch('https://tenant-orchestrator/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
}

function parseMaxAttempts(env: Env): number {
  const raw = env.AGENT_QUEUE_MAX_ATTEMPTS;
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 5;
  return parsed;
}

function retryDelaySeconds(attempts: number): number {
  return Math.min(60, Math.max(2, 2 ** attempts));
}

async function processRunJob(
  env: Env,
  job: AgentRunJobMessage,
): Promise<{ ok: true } | RuntimeExecutionFailure> {
  const startedAt = Date.now();
  await updateRunStatus(env, job, 'processing');

  const result = await executeRunJob(env, job);
  if (!result.ok) {
    return result;
  }

  await updateRunStatus(env, job, 'completed', {
    detail: result.detail,
    outputText: result.outputText,
    output: result.output,
    model: result.model,
    usageInputTokens: result.usageInputTokens,
    usageOutputTokens: result.usageOutputTokens,
    usageCachedInputTokens: result.usageCachedInputTokens,
    runtimeMs: result.runtimeMs ?? Date.now() - startedAt,
  });

  return { ok: true };
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

app.post('/tenants/:tenantId/tasks', async (c) => {
  const tenantId = c.req.param('tenantId');
  let payload: Record<string, unknown>;
  try {
    payload = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const chatJid =
    typeof payload.chatJid === 'string' ? payload.chatJid : undefined;
  const groupFolder =
    typeof payload.groupFolder === 'string' ? payload.groupFolder : undefined;
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : undefined;
  const scheduleType = parseTaskScheduleType(
    typeof payload.scheduleType === 'string' ? payload.scheduleType : '',
  );
  const scheduleValue =
    typeof payload.scheduleValue === 'string' ? payload.scheduleValue : undefined;
  const contextMode = parseTaskContextMode(payload.contextMode);

  if (!chatJid || !groupFolder || !prompt || !scheduleType || !scheduleValue) {
    return c.json({ error: 'Missing or invalid task fields' }, 400);
  }
  if (!contextMode) {
    return c.json({ error: 'Invalid contextMode' }, 400);
  }

  return routeTenantRequest(c.env, tenantId, {
    type: 'schedule_task',
    tenantId,
    chatJid,
    groupFolder,
    prompt,
    scheduleType,
    scheduleValue,
    contextMode,
  });
});

app.get('/tenants/:tenantId/tasks', async (c) => {
  const tenantId = c.req.param('tenantId');
  const statusRaw = c.req.query('status');
  const status =
    statusRaw === 'active' || statusRaw === 'paused' || statusRaw === 'completed'
      ? statusRaw
      : undefined;

  if (statusRaw && !status) {
    return c.json({ error: 'Invalid status filter' }, 400);
  }

  return routeTenantRequest(c.env, tenantId, {
    type: 'list_tasks',
    tenantId,
    status,
  });
});

app.post('/tenants/:tenantId/tasks/reconcile', async (c) => {
  const tenantId = c.req.param('tenantId');
  return routeTenantRequest(c.env, tenantId, {
    type: 'reconcile_tasks',
    tenantId,
    reason: 'http_reconcile',
  });
});

app.post('/tenants/:tenantId/tasks/:taskId/:action', async (c) => {
  const tenantId = c.req.param('tenantId');
  const taskId = c.req.param('taskId');
  const actionRaw = c.req.param('action');
  if (
    actionRaw !== 'pause' &&
    actionRaw !== 'resume' &&
    actionRaw !== 'cancel' &&
    actionRaw !== 'run_now'
  ) {
    return c.json({ error: 'Invalid task action' }, 400);
  }

  return routeTenantRequest(c.env, tenantId, {
    type: 'task_action',
    tenantId,
    taskId,
    action: actionRaw,
  });
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  console.error('request failed', err);
  return c.json({ error: 'Internal server error' }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const now = new Date().toISOString();
    const dueTenants = await env.DB.prepare(
      `SELECT DISTINCT tenant_id
       FROM scheduled_tasks
       WHERE status = 'active'
         AND next_run IS NOT NULL
         AND next_run <= ?1
       LIMIT 1000`,
    )
      .bind(now)
      .all<{ tenant_id: string }>();

    await Promise.allSettled(
      dueTenants.results.map(async (row) => {
        const response = await routeTenantRequest(env, row.tenant_id, {
          type: 'reconcile_tasks',
          tenantId: row.tenant_id,
          reason: `cron:${controller.cron}`,
        });
        if (!response.ok) {
          const text = await response.text();
          console.error('tenant reconcile failed', {
            tenantId: row.tenant_id,
            status: response.status,
            body: text,
          });
        }
      }),
    );
  },
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const maxAttempts = parseMaxAttempts(env);
    for (const message of batch.messages) {
      const parsed = parseRunJob(message.body);
      if (!parsed) {
        // Drop malformed payloads; they are not retriable.
        message.ack();
        continue;
      }

      try {
        const result = await processRunJob(env, parsed);
        if (result.ok) {
          message.ack();
          continue;
        }

        const shouldRetry =
          result.retryable && message.attempts < maxAttempts;
        if (shouldRetry) {
          await updateRunStatus(env, parsed, 'awaiting_runtime', {
            detail: result.error,
          });
          message.retry({
            delaySeconds: retryDelaySeconds(message.attempts),
          });
        } else {
          await updateRunStatus(env, parsed, 'failed', {
            detail: result.error,
          });
          message.ack();
        }
      } catch (err) {
        const runId = parsed.runId;
        console.error('queue process failed', {
          runId,
          tenantId: parsed.tenantId,
          err,
          attempts: message.attempts,
        });

        const detail =
          err instanceof Error
            ? err.message
            : 'Unhandled queue processing error';
        if (message.attempts < maxAttempts) {
          await updateRunStatus(env, parsed, 'awaiting_runtime', { detail });
          message.retry({
            delaySeconds: retryDelaySeconds(message.attempts),
          });
        } else {
          await updateRunStatus(env, parsed, 'failed', { detail });
          message.ack();
        }
      }
    }
  },
} satisfies ExportedHandler<Env>;

export { TenantOrchestrator };

