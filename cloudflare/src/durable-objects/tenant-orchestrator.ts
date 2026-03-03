import {
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

    if (body.type !== 'inbound_event' || !body.event) {
      return json({ error: 'Unsupported request type' }, 400);
    }

    const event = body.event;
    if (!event.eventId || !event.tenantId || !event.channel || !event.receivedAt) {
      return json({ error: 'Missing required event fields' }, 400);
    }

    return this.handleInboundEvent(event);
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
    ]);

    const response: TenantOrchestratorResponse = {
      ok: true,
      duplicate: false,
      eventId: event.eventId,
      tenantId: event.tenantId,
      message: 'Event accepted',
    };

    return json(response, 202);
  }
}

