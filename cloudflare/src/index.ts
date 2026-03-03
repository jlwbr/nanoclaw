import { TenantOrchestrator } from './durable-objects/tenant-orchestrator';
import { CanonicalInboundEvent, Env, TenantOrchestratorRequest } from './types';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function normalizeChannel(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 2 && parts[0] === 'webhooks' && parts[1]) {
    return parts[1];
  }
  return null;
}

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({
        ok: true,
        service: 'nanoclaw-event-driven',
        env: env.APP_ENV ?? 'unknown',
      });
    }

    const channel = normalizeChannel(url.pathname);
    if (!channel) {
      return json({ error: 'Not found' }, 404);
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    const tenantId = request.headers.get('x-tenant-id');
    if (!tenantId) {
      return json({ error: 'Missing x-tenant-id header' }, 400);
    }

    const rawBody = await request.text();
    if (!(await verifySharedSignature(request, env, rawBody))) {
      return json({ error: 'Invalid webhook signature' }, 401);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const eventIdHeader = request.headers.get('x-event-id');
    const eventId =
      eventIdHeader ??
      (await sha256Hex(`${tenantId}:${channel}:${rawBody}`)).slice(0, 32);

    const canonical = buildCanonicalEvent({
      tenantId,
      channel,
      eventId,
      payload,
    });

    return routeInboundEvent(env, canonical);
  },
} satisfies ExportedHandler<Env>;

export { TenantOrchestrator };

