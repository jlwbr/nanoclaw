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

export interface OutboundDeliveryMessage {
  deliveryId: string;
  tenantId: string;
  runId: string;
  channel: string;
  chatJid: string;
  text: string;
  enqueuedAt: string;
}

export type TaskScheduleType = 'cron' | 'interval' | 'once';
export type TaskStatus = 'active' | 'paused' | 'completed';
export type TaskContextMode = 'group' | 'isolated';

export interface ScheduleTaskRequest {
  type: 'schedule_task';
  tenantId: string;
  chatJid: string;
  groupFolder: string;
  prompt: string;
  scheduleType: TaskScheduleType;
  scheduleValue: string;
  contextMode?: TaskContextMode;
}

export interface ListTasksRequest {
  type: 'list_tasks';
  tenantId: string;
  status?: TaskStatus;
}

export interface TaskActionRequest {
  type: 'task_action';
  tenantId: string;
  taskId: string;
  action: 'pause' | 'resume' | 'cancel' | 'run_now';
}

export interface ReconcileTasksRequest {
  type: 'reconcile_tasks';
  tenantId: string;
  reason?: string;
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

export type TenantOrchestratorRequest =
  | InboundEventRequest
  | RunStatusUpdateRequest
  | ScheduleTaskRequest
  | ListTasksRequest
  | TaskActionRequest
  | ReconcileTasksRequest;

export interface TenantOrchestratorResponse {
  ok: boolean;
  duplicate: boolean;
  eventId: string;
  tenantId: string;
  message: string;
  runId?: string;
  taskId?: string;
  tasks?: Array<{
    id: string;
    group_folder: string;
    chat_jid: string;
    prompt: string;
    schedule_type: TaskScheduleType;
    schedule_value: string;
    context_mode: TaskContextMode;
    next_run: string | null;
    last_run: string | null;
    last_result: string | null;
    status: TaskStatus;
    created_at: string;
  }>;
}

export interface Env {
  TENANT_ORCHESTRATOR: DurableObjectNamespace;
  AGENT_RUN_QUEUE: Queue<AgentRunJobMessage>;
  OUTBOUND_QUEUE: Queue<OutboundDeliveryMessage>;
  DB: D1Database;
  TENANT_FILES?: R2Bucket;
  AGENT_RUNTIME?: Fetcher;
  APP_ENV?: string;
  WEBHOOK_SHARED_SECRET?: string;
  SLACK_SIGNING_SECRET?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  DISCORD_WEBHOOK_SECRET?: string;
  AGENT_RUNTIME_MODE?: 'stub' | 'http' | 'service';
  AGENT_RUNTIME_HTTP_URL?: string;
  AGENT_QUEUE_MAX_ATTEMPTS?: string;
  OUTBOUND_MODE?: 'stub' | 'http';
  OUTBOUND_HTTP_URL?: string;
  OUTBOUND_ALLOWED_CHANNELS?: string;
  OUTBOUND_QUEUE_MAX_ATTEMPTS?: string;
  TIMEZONE?: string;
}
