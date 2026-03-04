import {
  AgentRunJobMessage,
  CanonicalInboundEvent,
  Env,
  TenantOrchestratorRequest,
  TenantOrchestratorResponse,
} from '../types';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * Per-tenant orchestrator primitive.
 *
 * This class intentionally starts small: idempotent event ingest + persistence.
 * Queue scheduling and agent runtime dispatch are added in later phases.
 */
export class TenantOrchestrator {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'TenantOrchestrator' });
    }

    if (request.method !== 'POST' || url.pathname !== '/events') {
      return json({ error: 'Not found' }, 404);
    }

    let body: TenantOrchestratorRequest;
    try {
      body = (await request.json()) as TenantOrchestratorRequest;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    switch (body.type) {
      case 'inbound_event': {
        const event = body.event;
        if (
          !event.eventId ||
          !event.tenantId ||
          !event.channel ||
          !event.receivedAt
        ) {
          return json({ error: 'Missing required event fields' }, 400);
        }
        return this.handleInboundEvent(event);
      }
      case 'run_status_update': {
        if (
          !body.runId ||
          !body.tenantId ||
          !body.status ||
          !body.processedAt
        ) {
          return json({ error: 'Missing required run status fields' }, 400);
        }
        return this.handleRunStatusUpdate(body);
      }
      default:
        return json({ error: 'Unsupported request type' }, 400);
    }
  }

  private buildRunJob(event: CanonicalInboundEvent): AgentRunJobMessage {
    return {
      runId: crypto.randomUUID(),
      tenantId: event.tenantId,
      eventId: event.eventId,
      channel: event.channel,
      chatJid: event.chatJid,
      content: event.content,
      enqueuedAt: new Date().toISOString(),
    };
  }

  private async handleRunStatusUpdate(body: {
    runId: string;
    tenantId: string;
    status: 'processing' | 'awaiting_runtime' | 'completed' | 'failed';
    detail?: string;
    processedAt: string;
    outputText?: string;
    output?: unknown;
    model?: string;
    usageInputTokens?: number;
    usageOutputTokens?: number;
    usageCachedInputTokens?: number;
    runtimeMs?: number;
  }): Promise<Response> {
    const terminalStatus = body.status === 'completed' || body.status === 'failed';

    const result = await this.env.DB.prepare(
      `UPDATE agent_run_jobs
       SET status = ?1,
           last_error = CASE WHEN ?1 = 'failed' THEN COALESCE(?2, last_error) ELSE last_error END,
           attempt_count = CASE
             WHEN ?1 = 'processing' THEN attempt_count + 1
             ELSE attempt_count
           END,
           started_at = CASE
             WHEN ?1 = 'processing' AND started_at IS NULL THEN ?3
             ELSE started_at
           END,
           finished_at = CASE
             WHEN ?4 = 1 THEN ?3
             ELSE finished_at
           END,
           updated_at = ?3
       WHERE tenant_id = ?5 AND run_id = ?6`,
    )
      .bind(
        body.status,
        body.detail ?? null,
        body.processedAt,
        terminalStatus ? 1 : 0,
        body.tenantId,
        body.runId,
      )
      .run();

    if ((result.meta.changes ?? 0) === 0) {
      return json({ ok: false, error: 'Run not found' }, 404);
    }

    if (body.status === 'completed') {
      await this.env.DB.prepare(
        `INSERT INTO agent_run_results (
           tenant_id, run_id, output_text, output_json, model,
           usage_input_tokens, usage_output_tokens, usage_cached_input_tokens,
           runtime_ms, completed_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
         ON CONFLICT(tenant_id, run_id) DO UPDATE SET
           output_text = excluded.output_text,
           output_json = excluded.output_json,
           model = excluded.model,
           usage_input_tokens = excluded.usage_input_tokens,
           usage_output_tokens = excluded.usage_output_tokens,
           usage_cached_input_tokens = excluded.usage_cached_input_tokens,
           runtime_ms = excluded.runtime_ms,
           completed_at = excluded.completed_at,
           updated_at = excluded.updated_at`,
      )
        .bind(
          body.tenantId,
          body.runId,
          body.outputText ?? null,
          body.output === undefined ? null : JSON.stringify(body.output),
          body.model ?? null,
          body.usageInputTokens ?? null,
          body.usageOutputTokens ?? null,
          body.usageCachedInputTokens ?? null,
          body.runtimeMs ?? null,
          body.processedAt,
        )
        .run();
    }

    return json({
      ok: true,
      runId: body.runId,
      tenantId: body.tenantId,
      status: body.status,
    });
  }

  private async handleInboundEvent(
    event: CanonicalInboundEvent,
  ): Promise<Response> {
    const dedupeKey = `event:${event.eventId}`;
    const existing = await this.state.storage.get<string>(dedupeKey);
    if (existing) {
      const duplicateResponse: TenantOrchestratorResponse = {
        ok: true,
        duplicate: true,
        eventId: event.eventId,
        tenantId: event.tenantId,
        message: 'Duplicate event ignored',
      };
      return json(duplicateResponse, 200);
    }

    // Mark as seen before side effects to prevent duplicate processing during retries.
    await this.state.storage.put(dedupeKey, event.receivedAt);

    const now = new Date().toISOString();
    const runJob = this.buildRunJob(event);

    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO tenants (tenant_id, created_at, updated_at)
         VALUES (?1, ?2, ?2)`,
      ).bind(event.tenantId, now),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO idempotency_keys (tenant_id, scope, key, created_at)
         VALUES (?1, 'inbound_event', ?2, ?3)`,
      ).bind(event.tenantId, event.eventId, now),
      this.env.DB.prepare(
        `INSERT INTO inbound_events (
           tenant_id, event_id, channel, chat_jid, sender, sender_name, content, payload_json, received_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      ).bind(
        event.tenantId,
        event.eventId,
        event.channel,
        event.chatJid,
        event.sender ?? null,
        event.senderName ?? null,
        event.content ?? null,
        JSON.stringify(event.payload ?? {}),
        event.receivedAt,
      ),
      this.env.DB.prepare(
        `INSERT INTO agent_run_jobs (
           tenant_id, run_id, event_id, channel, chat_jid, status, attempt_count, queued_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, 'queued', 0, ?6, ?6)`,
      ).bind(
        event.tenantId,
        runJob.runId,
        event.eventId,
        event.channel,
        event.chatJid,
        runJob.enqueuedAt,
      ),
    ]);

    try {
      await this.env.AGENT_RUN_QUEUE.send(runJob);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.env.DB.prepare(
        `UPDATE agent_run_jobs
         SET status = 'enqueue_failed', last_error = ?1, updated_at = ?2
         WHERE tenant_id = ?3 AND run_id = ?4`,
      )
        .bind(message, new Date().toISOString(), event.tenantId, runJob.runId)
        .run();

      return json(
        {
          ok: false,
          duplicate: false,
          eventId: event.eventId,
          tenantId: event.tenantId,
          runId: runJob.runId,
          message: 'Failed to enqueue agent run',
          error: message,
        },
        500,
      );
    }

    const response: TenantOrchestratorResponse = {
      ok: true,
      duplicate: false,
      eventId: event.eventId,
      tenantId: event.tenantId,
      message: 'Event accepted',
      runId: runJob.runId,
    };

    return json(response, 202);
  }
}

