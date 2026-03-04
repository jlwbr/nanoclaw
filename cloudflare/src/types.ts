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

export interface AgentRunJobMessage {
  runId: string;
  tenantId: string;
  eventId: string;
  channel: string;
  chatJid: string;
  content?: string;
  enqueuedAt: string;
}

export interface InboundEventRequest {
  type: 'inbound_event';
  event: CanonicalInboundEvent;
}

export interface RunStatusUpdateRequest {
  type: 'run_status_update';
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
}

export type TenantOrchestratorRequest = InboundEventRequest | RunStatusUpdateRequest;

export interface TenantOrchestratorResponse {
  ok: boolean;
  duplicate: boolean;
  eventId: string;
  tenantId: string;
  message: string;
  runId?: string;
}

export interface Env {
  TENANT_ORCHESTRATOR: DurableObjectNamespace;
  AGENT_RUN_QUEUE: Queue<AgentRunJobMessage>;
  DB: D1Database;
  APP_ENV?: string;
  WEBHOOK_SHARED_SECRET?: string;
  AGENT_RUNTIME_MODE?: 'stub' | 'http';
  AGENT_RUNTIME_HTTP_URL?: string;
  AGENT_QUEUE_MAX_ATTEMPTS?: string;
}

