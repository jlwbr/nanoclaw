export interface CanonicalInboundEvent {
  eventId: string;
  tenantId: string;
  channel: string;
  receivedAt: string;
  chatJid: string;
  sender?: string;
  senderName?: string;
  content?: string;
  payload: unknown;
}

export interface TenantOrchestratorRequest {
  type: 'inbound_event';
  event: CanonicalInboundEvent;
}

export interface TenantOrchestratorResponse {
  ok: boolean;
  duplicate: boolean;
  eventId: string;
  tenantId: string;
  message: string;
}

export interface Env {
  TENANT_ORCHESTRATOR: DurableObjectNamespace;
  DB: D1Database;
  APP_ENV?: string;
  WEBHOOK_SHARED_SECRET?: string;
}

