import { Hono } from 'hono';

import { RuntimeExecutionFailure, executeRunJob } from './runtime/executor';
import { executeOutboundDelivery } from './outbound/executor';
import { TenantOrchestrator } from './durable-objects/tenant-orchestrator';
import { normalizeInboundEvent } from './events/normalize';
import { verifyInboundSignature } from './events/validate';
import {
  AgentRunJobMessage,
  CanonicalInboundEvent,
  Env,
  OutboundDeliveryMessage,
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

function logStructured(
  message: string,
  context: Record<string, unknown>,
): void {
  console.log(
    JSON.stringify({
      level: 'info',
      message,
      ts: new Date().toISOString(),
      ...context,
    }),
  );
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.floor((p / 100) * sortedValues.length)),
  );
  return sortedValues[index] ?? 0;
}

async function ensureTenantSetup(env: Env, tenantId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO tenants (tenant_id, created_at, updated_at)
       VALUES (?1, ?2, ?2)`,
    ).bind(tenantId, now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO tenant_limits (
         tenant_id, requests_per_minute, token_budget_daily, max_concurrent_runs, hard_block, created_at, updated_at
       ) VALUES (?1, 120, 1000000, 4, 0, ?2, ?2)`,
    ).bind(tenantId, now),
  ]);
}

async function insertSecurityAudit(args: {
  env: Env;
  tenantId: string;
  eventType: string;
  severity: 'info' | 'warn' | 'error';
  detail?: string;
  correlationId?: string;
}): Promise<void> {
  await args.env.DB.prepare(
    `INSERT INTO security_audit_logs (
       tenant_id, event_type, severity, detail, correlation_id, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(
      args.tenantId,
      args.eventType,
      args.severity,
      args.detail ?? null,
      args.correlationId ?? null,
      new Date().toISOString(),
    )
    .run();
}

function minuteBucketIso(now: Date): string {
  const minuteStart = new Date(now);
  minuteStart.setSeconds(0, 0);
  return minuteStart.toISOString();
}

function usageDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

async function enforceIngressPolicy(args: {
  env: Env;
  tenantId: string;
  correlationId?: string;
}): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const now = new Date();
  const nowIso = now.toISOString();
  const minuteStart = minuteBucketIso(now);
  const today = usageDate(now);
  await ensureTenantSetup(args.env, args.tenantId);

  const limits = await args.env.DB.prepare(
    `SELECT requests_per_minute, token_budget_daily, hard_block
     FROM tenant_limits
     WHERE tenant_id = ?1`,
  )
    .bind(args.tenantId)
    .first<{
      requests_per_minute: number;
      token_budget_daily: number;
      hard_block: number;
    }>();

  if (!limits) {
    return { ok: false, status: 500, error: 'Tenant policy unavailable' };
  }
  if (limits.hard_block === 1) {
    await insertSecurityAudit({
      env: args.env,
      tenantId: args.tenantId,
      eventType: 'ingress_hard_block',
      severity: 'warn',
      detail: 'Inbound request rejected due to hard block',
      correlationId: args.correlationId,
    });
    return { ok: false, status: 403, error: 'Tenant is blocked' };
  }

  await args.env.DB.prepare(
    `INSERT INTO tenant_minute_usage (
       tenant_id, minute_start, request_count, created_at, updated_at
     ) VALUES (?1, ?2, 1, ?3, ?3)
     ON CONFLICT(tenant_id, minute_start) DO UPDATE SET
       request_count = request_count + 1,
       updated_at = excluded.updated_at`,
  )
    .bind(args.tenantId, minuteStart, nowIso)
    .run();

  const minuteUsage = await args.env.DB.prepare(
    `SELECT request_count
     FROM tenant_minute_usage
     WHERE tenant_id = ?1 AND minute_start = ?2`,
  )
    .bind(args.tenantId, minuteStart)
    .first<{ request_count: number }>();
  const requestCount = minuteUsage?.request_count ?? 0;
  if (
    limits.requests_per_minute > 0 &&
    requestCount > limits.requests_per_minute
  ) {
    await insertSecurityAudit({
      env: args.env,
      tenantId: args.tenantId,
      eventType: 'ingress_rate_limited',
      severity: 'warn',
      detail: `request_count=${requestCount} limit=${limits.requests_per_minute}`,
      correlationId: args.correlationId,
    });
    return { ok: false, status: 429, error: 'Rate limit exceeded' };
  }

  if (limits.token_budget_daily > 0) {
    const daily = await args.env.DB.prepare(
      `SELECT input_tokens, output_tokens, cached_input_tokens
       FROM tenant_daily_usage
       WHERE tenant_id = ?1 AND usage_date = ?2`,
    )
      .bind(args.tenantId, today)
      .first<{
        input_tokens: number;
        output_tokens: number;
        cached_input_tokens: number;
      }>();
    const usedTokens =
      (daily?.input_tokens ?? 0) +
      (daily?.output_tokens ?? 0) +
      (daily?.cached_input_tokens ?? 0);
    if (usedTokens >= limits.token_budget_daily) {
      await insertSecurityAudit({
        env: args.env,
        tenantId: args.tenantId,
        eventType: 'daily_budget_block',
        severity: 'warn',
        detail: `used_tokens=${usedTokens} budget=${limits.token_budget_daily}`,
        correlationId: args.correlationId,
      });
      return {
        ok: false,
        status: 402,
        error: 'Daily token budget exhausted',
      };
    }
  }

  return { ok: true };
}

async function canStartRun(
  env: Env,
  tenantId: string,
): Promise<
  { ok: true } | { ok: false; maxConcurrentRuns: number; activeRuns: number }
> {
  await ensureTenantSetup(env, tenantId);
  const limits = await env.DB.prepare(
    `SELECT max_concurrent_runs
     FROM tenant_limits
     WHERE tenant_id = ?1`,
  )
    .bind(tenantId)
    .first<{ max_concurrent_runs: number }>();
  const maxConcurrentRuns = limits?.max_concurrent_runs ?? 4;

  const active = await env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM agent_run_jobs
     WHERE tenant_id = ?1
       AND status = 'processing'`,
  )
    .bind(tenantId)
    .first<{ count: number }>();
  const activeRuns = active?.count ?? 0;
  if (maxConcurrentRuns > 0 && activeRuns >= maxConcurrentRuns) {
    return { ok: false, maxConcurrentRuns, activeRuns };
  }
  return { ok: true };
}

function parseOutboundDelivery(body: unknown): OutboundDeliveryMessage | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;
  if (
    typeof raw.deliveryId !== 'string' ||
    typeof raw.tenantId !== 'string' ||
    typeof raw.runId !== 'string' ||
    typeof raw.channel !== 'string' ||
    typeof raw.chatJid !== 'string' ||
    typeof raw.text !== 'string' ||
    typeof raw.enqueuedAt !== 'string'
  ) {
    return null;
  }
  return {
    deliveryId: raw.deliveryId,
    tenantId: raw.tenantId,
    runId: raw.runId,
    channel: raw.channel,
    chatJid: raw.chatJid,
    text: raw.text,
    enqueuedAt: raw.enqueuedAt,
  };
}

function parseRunJob(body: unknown): AgentRunJobMessage | null {
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

function parseOutboundMaxAttempts(env: Env): number {
  const raw = env.OUTBOUND_QUEUE_MAX_ATTEMPTS;
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 5;
  return parsed;
}

function retryDelaySeconds(attempts: number): number {
  return Math.min(60, Math.max(2, 2 ** attempts));
}

async function updateOutboundStatus(
  env: Env,
  message: OutboundDeliveryMessage,
  status:
    | 'processing'
    | 'retrying'
    | 'sent'
    | 'failed'
    | 'dead_letter'
    | 'enqueue_failed',
  updates: {
    detail?: string;
    providerMessageId?: string;
  } = {},
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE outbound_deliveries
     SET status = ?1,
         attempt_count = CASE WHEN ?1 = 'processing' THEN attempt_count + 1 ELSE attempt_count END,
         sent_at = CASE WHEN ?1 = 'sent' THEN ?2 ELSE sent_at END,
         dead_lettered_at = CASE WHEN ?1 = 'dead_letter' THEN ?2 ELSE dead_lettered_at END,
         provider_message_id = COALESCE(?3, provider_message_id),
         last_error = CASE
           WHEN ?1 IN ('retrying', 'failed', 'dead_letter', 'enqueue_failed') THEN COALESCE(?4, last_error)
           ELSE last_error
         END,
         updated_at = ?2
     WHERE tenant_id = ?5 AND delivery_id = ?6`,
  )
    .bind(
      status,
      now,
      updates.providerMessageId ?? null,
      updates.detail ?? null,
      message.tenantId,
      message.deliveryId,
    )
    .run();
}

async function processOutboundMessage(
  env: Env,
  message: OutboundDeliveryMessage,
): Promise<{ ok: true } | { ok: false; retryable: boolean; error: string }> {
  if (env.OUTBOUND_ALLOWED_CHANNELS) {
    const allowed = env.OUTBOUND_ALLOWED_CHANNELS.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (
      allowed.length > 0 &&
      !allowed.includes(message.channel.toLowerCase())
    ) {
      return {
        ok: false,
        retryable: false,
        error: `Channel not allowed for outbound delivery: ${message.channel}`,
      };
    }
  }

  await updateOutboundStatus(env, message, 'processing');
  const result = await executeOutboundDelivery(env, message);
  if (!result.ok) {
    return {
      ok: false,
      retryable: result.retryable,
      error: result.error,
    };
  }

  await updateOutboundStatus(env, message, 'sent', {
    detail: result.detail,
    providerMessageId: result.providerMessageId,
  });
  return { ok: true };
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

app.get('/metrics', async (c) => {
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const runtimes = await c.env.DB.prepare(
    `SELECT runtime_ms
     FROM agent_run_results
     WHERE completed_at >= ?1
       AND runtime_ms IS NOT NULL
     ORDER BY completed_at DESC
     LIMIT 5000`,
  )
    .bind(sinceIso)
    .all<{ runtime_ms: number }>();
  const sortedRuntimeMs = runtimes.results
    .map((row) => row.runtime_ms)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  const queued = await c.env.DB.prepare(
    `SELECT queued_at
     FROM agent_run_jobs
     WHERE status IN ('queued', 'awaiting_runtime')
     ORDER BY queued_at ASC
     LIMIT 1`,
  ).first<{ queued_at: string }>();
  const queueLagSeconds = queued?.queued_at
    ? Math.max(
        0,
        Math.floor((Date.now() - new Date(queued.queued_at).getTime()) / 1000),
      )
    : 0;

  const errorByChannel = await c.env.DB.prepare(
    `SELECT channel, COUNT(*) AS count
     FROM agent_run_jobs
     WHERE updated_at >= ?1 AND status = 'failed'
     GROUP BY channel
     ORDER BY count DESC`,
  )
    .bind(sinceIso)
    .all<{ channel: string; count: number }>();

  const timeoutCount = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM agent_run_jobs
     WHERE updated_at >= ?1
       AND status = 'failed'
       AND last_error LIKE '%timeout%'`,
  )
    .bind(sinceIso)
    .first<{ count: number }>();

  return c.json({
    window: '24h',
    latency: {
      p50_ms: percentile(sortedRuntimeMs, 50),
      p95_ms: percentile(sortedRuntimeMs, 95),
      samples: sortedRuntimeMs.length,
    },
    queue: {
      lag_seconds: queueLagSeconds,
    },
    errors: {
      by_channel: errorByChannel.results,
      timeout_count: timeoutCount?.count ?? 0,
    },
  });
});

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
  if (
    !(await verifyInboundSignature({
      request: c.req.raw,
      env: c.env,
      channel,
      rawBody,
    }))
  ) {
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
    eventIdHeader ??
    (await sha256Hex(`${tenantId}:${channel}:${rawBody}`)).slice(0, 32);

  const policy = await enforceIngressPolicy({
    env: c.env,
    tenantId,
    correlationId: eventId,
  });
  if (!policy.ok) {
    return new Response(JSON.stringify({ error: policy.error }), {
      status: policy.status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  const canonical = normalizeInboundEvent({
    tenantId,
    channel,
    eventId,
    payload,
  });

  logStructured('inbound_event_received', {
    tenant_id: tenantId,
    event_id: eventId,
    channel,
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
  const prompt =
    typeof payload.prompt === 'string' ? payload.prompt : undefined;
  const scheduleType = parseTaskScheduleType(
    typeof payload.scheduleType === 'string' ? payload.scheduleType : '',
  );
  const scheduleValue =
    typeof payload.scheduleValue === 'string'
      ? payload.scheduleValue
      : undefined;
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
    statusRaw === 'active' ||
    statusRaw === 'paused' ||
    statusRaw === 'completed'
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

app.get('/tenants/:tenantId/usage', async (c) => {
  const tenantId = c.req.param('tenantId');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const limitRaw = c.req.query('limit');
  const limit = Math.min(
    1000,
    Math.max(1, Number.parseInt(limitRaw ?? '200', 10) || 200),
  );

  const ledger =
    from && to
      ? await c.env.DB.prepare(
          `SELECT run_id, usage_date, model, input_tokens, output_tokens, cached_input_tokens, estimated_cost_usd, created_at
         FROM usage_ledger
         WHERE tenant_id = ?1 AND usage_date >= ?2 AND usage_date <= ?3
         ORDER BY created_at DESC
         LIMIT ?4`,
        )
          .bind(tenantId, from, to, limit)
          .all<{
            run_id: string;
            usage_date: string;
            model: string | null;
            input_tokens: number;
            output_tokens: number;
            cached_input_tokens: number;
            estimated_cost_usd: number;
            created_at: string;
          }>()
      : await c.env.DB.prepare(
          `SELECT run_id, usage_date, model, input_tokens, output_tokens, cached_input_tokens, estimated_cost_usd, created_at
         FROM usage_ledger
         WHERE tenant_id = ?1
         ORDER BY created_at DESC
         LIMIT ?2`,
        )
          .bind(tenantId, limit)
          .all<{
            run_id: string;
            usage_date: string;
            model: string | null;
            input_tokens: number;
            output_tokens: number;
            cached_input_tokens: number;
            estimated_cost_usd: number;
            created_at: string;
          }>();

  const daily =
    from && to
      ? await c.env.DB.prepare(
          `SELECT usage_date, input_tokens, output_tokens, cached_input_tokens, estimated_cost_usd, updated_at
         FROM tenant_daily_usage
         WHERE tenant_id = ?1 AND usage_date >= ?2 AND usage_date <= ?3
         ORDER BY usage_date DESC`,
        )
          .bind(tenantId, from, to)
          .all<{
            usage_date: string;
            input_tokens: number;
            output_tokens: number;
            cached_input_tokens: number;
            estimated_cost_usd: number;
            updated_at: string;
          }>()
      : await c.env.DB.prepare(
          `SELECT usage_date, input_tokens, output_tokens, cached_input_tokens, estimated_cost_usd, updated_at
         FROM tenant_daily_usage
         WHERE tenant_id = ?1
         ORDER BY usage_date DESC
         LIMIT 31`,
        )
          .bind(tenantId)
          .all<{
            usage_date: string;
            input_tokens: number;
            output_tokens: number;
            cached_input_tokens: number;
            estimated_cost_usd: number;
            updated_at: string;
          }>();

  const limits = await c.env.DB.prepare(
    `SELECT requests_per_minute, token_budget_daily, max_concurrent_runs, hard_block
     FROM tenant_limits
     WHERE tenant_id = ?1`,
  )
    .bind(tenantId)
    .first<{
      requests_per_minute: number;
      token_budget_daily: number;
      max_concurrent_runs: number;
      hard_block: number;
    }>();

  return c.json({
    tenantId,
    limits,
    ledger: ledger.results,
    daily: daily.results,
  });
});

app.post('/tenants/:tenantId/limits', async (c) => {
  const tenantId = c.req.param('tenantId');
  await ensureTenantSetup(c.env, tenantId);

  let payload: Record<string, unknown>;
  try {
    payload = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const requestsPerMinute =
    typeof payload.requestsPerMinute === 'number'
      ? Math.max(0, Math.floor(payload.requestsPerMinute))
      : undefined;
  const tokenBudgetDaily =
    typeof payload.tokenBudgetDaily === 'number'
      ? Math.max(0, Math.floor(payload.tokenBudgetDaily))
      : undefined;
  const maxConcurrentRuns =
    typeof payload.maxConcurrentRuns === 'number'
      ? Math.max(0, Math.floor(payload.maxConcurrentRuns))
      : undefined;
  const hardBlock =
    typeof payload.hardBlock === 'boolean'
      ? payload.hardBlock
        ? 1
        : 0
      : undefined;

  if (
    requestsPerMinute === undefined &&
    tokenBudgetDaily === undefined &&
    maxConcurrentRuns === undefined &&
    hardBlock === undefined
  ) {
    return c.json({ error: 'No limit fields provided' }, 400);
  }

  await c.env.DB.prepare(
    `UPDATE tenant_limits
     SET requests_per_minute = COALESCE(?1, requests_per_minute),
         token_budget_daily = COALESCE(?2, token_budget_daily),
         max_concurrent_runs = COALESCE(?3, max_concurrent_runs),
         hard_block = COALESCE(?4, hard_block),
         updated_at = ?5
     WHERE tenant_id = ?6`,
  )
    .bind(
      requestsPerMinute ?? null,
      tokenBudgetDaily ?? null,
      maxConcurrentRuns ?? null,
      hardBlock ?? null,
      new Date().toISOString(),
      tenantId,
    )
    .run();

  const limits = await c.env.DB.prepare(
    `SELECT requests_per_minute, token_budget_daily, max_concurrent_runs, hard_block
     FROM tenant_limits
     WHERE tenant_id = ?1`,
  )
    .bind(tenantId)
    .first();

  return c.json({ tenantId, limits });
});

app.get('/tenants/:tenantId/outbound', async (c) => {
  const tenantId = c.req.param('tenantId');
  const status = c.req.query('status');
  const limit = Math.min(
    1000,
    Math.max(1, Number.parseInt(c.req.query('limit') ?? '200', 10) || 200),
  );

  const result = status
    ? await c.env.DB.prepare(
        `SELECT delivery_id, run_id, channel, chat_jid, payload_json, status, attempt_count,
                queued_at, sent_at, dead_lettered_at, provider_message_id, last_error, updated_at
         FROM outbound_deliveries
         WHERE tenant_id = ?1 AND status = ?2
         ORDER BY updated_at DESC
         LIMIT ?3`,
      )
        .bind(tenantId, status, limit)
        .all()
    : await c.env.DB.prepare(
        `SELECT delivery_id, run_id, channel, chat_jid, payload_json, status, attempt_count,
                queued_at, sent_at, dead_lettered_at, provider_message_id, last_error, updated_at
         FROM outbound_deliveries
         WHERE tenant_id = ?1
         ORDER BY updated_at DESC
         LIMIT ?2`,
      )
        .bind(tenantId, limit)
        .all();

  return c.json({
    tenantId,
    deliveries: result.results,
  });
});

app.post('/tenants/:tenantId/outbound/:deliveryId/redrive', async (c) => {
  const tenantId = c.req.param('tenantId');
  const deliveryId = c.req.param('deliveryId');
  const row = await c.env.DB.prepare(
    `SELECT run_id, channel, chat_jid, payload_json
     FROM outbound_deliveries
     WHERE tenant_id = ?1 AND delivery_id = ?2`,
  )
    .bind(tenantId, deliveryId)
    .first<{
      run_id: string;
      channel: string;
      chat_jid: string;
      payload_json: string;
    }>();
  if (!row) {
    return c.json({ error: 'Delivery not found' }, 404);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'Corrupted payload_json' }, 500);
  }
  const text = typeof payload.text === 'string' ? payload.text : '';
  if (!text) {
    return c.json({ error: 'Delivery payload has no text' }, 400);
  }

  const message: OutboundDeliveryMessage = {
    deliveryId,
    tenantId,
    runId: row.run_id,
    channel: row.channel,
    chatJid: row.chat_jid,
    text,
    enqueuedAt: new Date().toISOString(),
  };

  await c.env.DB.prepare(
    `UPDATE outbound_deliveries
     SET status = 'queued',
         dead_lettered_at = NULL,
         last_error = NULL,
         updated_at = ?1
     WHERE tenant_id = ?2 AND delivery_id = ?3`,
  )
    .bind(new Date().toISOString(), tenantId, deliveryId)
    .run();
  await c.env.OUTBOUND_QUEUE.send(message);
  return c.json({ ok: true, tenantId, deliveryId, redriven: true });
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
        logStructured('scheduler_reconcile_requested', {
          tenant_id: row.tenant_id,
          source: `cron:${controller.cron}`,
        });
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
    const outboundMaxAttempts = parseOutboundMaxAttempts(env);
    for (const message of batch.messages) {
      const runJob = parseRunJob(message.body);
      if (runJob) {
        try {
          const runCapacity = await canStartRun(env, runJob.tenantId);
          if (!runCapacity.ok) {
            const detail = `Concurrency limit reached: active=${runCapacity.activeRuns} max=${runCapacity.maxConcurrentRuns}`;
            if (message.attempts < maxAttempts) {
              await updateRunStatus(env, runJob, 'awaiting_runtime', {
                detail,
              });
              message.retry({
                delaySeconds: retryDelaySeconds(message.attempts),
              });
            } else {
              await updateRunStatus(env, runJob, 'failed', { detail });
              await insertSecurityAudit({
                env,
                tenantId: runJob.tenantId,
                eventType: 'run_rejected_concurrency',
                severity: 'warn',
                detail,
                correlationId: runJob.runId,
              });
              message.ack();
            }
            continue;
          }

          const result = await processRunJob(env, runJob);
          if (result.ok) {
            logStructured('run_job_completed', {
              tenant_id: runJob.tenantId,
              run_id: runJob.runId,
              event_id: runJob.eventId,
            });
            message.ack();
            continue;
          }

          const shouldRetry =
            result.retryable && message.attempts < maxAttempts;
          if (shouldRetry) {
            await updateRunStatus(env, runJob, 'awaiting_runtime', {
              detail: result.error,
              runtimeMs: result.runtimeMs,
            });
            message.retry({
              delaySeconds: retryDelaySeconds(message.attempts),
            });
          } else {
            await updateRunStatus(env, runJob, 'failed', {
              detail: result.error,
              runtimeMs: result.runtimeMs,
            });
            message.ack();
          }
          continue;
        } catch (err) {
          console.error('queue process failed', {
            runId: runJob.runId,
            tenantId: runJob.tenantId,
            err,
            attempts: message.attempts,
          });

          const detail =
            err instanceof Error
              ? err.message
              : 'Unhandled queue processing error';
          if (message.attempts < maxAttempts) {
            await updateRunStatus(env, runJob, 'awaiting_runtime', { detail });
            message.retry({
              delaySeconds: retryDelaySeconds(message.attempts),
            });
          } else {
            await updateRunStatus(env, runJob, 'failed', { detail });
            message.ack();
          }
          continue;
        }
      }

      const outbound = parseOutboundDelivery(message.body);
      if (outbound) {
        try {
          const result = await processOutboundMessage(env, outbound);
          if (result.ok) {
            logStructured('outbound_delivery_sent', {
              tenant_id: outbound.tenantId,
              run_id: outbound.runId,
              delivery_id: outbound.deliveryId,
              channel: outbound.channel,
            });
            message.ack();
            continue;
          }

          const shouldRetry =
            result.retryable && message.attempts < outboundMaxAttempts;
          if (shouldRetry) {
            await updateOutboundStatus(env, outbound, 'retrying', {
              detail: result.error,
            });
            message.retry({
              delaySeconds: retryDelaySeconds(message.attempts),
            });
          } else {
            await updateOutboundStatus(env, outbound, 'dead_letter', {
              detail: result.error,
            });
            await insertSecurityAudit({
              env,
              tenantId: outbound.tenantId,
              eventType: 'outbound_dead_letter',
              severity: 'error',
              detail: result.error,
              correlationId: outbound.deliveryId,
            });
            message.ack();
          }
          continue;
        } catch (err) {
          const detail =
            err instanceof Error
              ? err.message
              : 'Unhandled outbound processing error';
          if (message.attempts < outboundMaxAttempts) {
            await updateOutboundStatus(env, outbound, 'retrying', { detail });
            message.retry({
              delaySeconds: retryDelaySeconds(message.attempts),
            });
          } else {
            await updateOutboundStatus(env, outbound, 'dead_letter', {
              detail,
            });
            message.ack();
          }
          continue;
        }
      }

      // Drop unknown payloads; they are not retriable.
      message.ack();
    }
  },
} satisfies ExportedHandler<Env>;

export { TenantOrchestrator };
