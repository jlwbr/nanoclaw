export type TaskStatus =
  | 'active'
  | 'paused'
  | 'cancelled'
  | 'completed'
  | 'dead_letter';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'blocked'
  | 'cancelled';

export type DeliveryStatus =
  | 'pending'
  | 'delivered'
  | 'retrying'
  | 'dead_letter';

export interface TenantRecord {
  tenantId: string;
  displayName: string;
  status: 'active' | 'paused' | 'suspended';
  createdAt: string;
  updatedAt: string;
  autumnCustomerId?: string;
  subscriptionRef?: string;
  entitlementCacheUntil?: string;
  monthlyBudgetUsd?: number;
}

export interface TaskRecord {
  taskId: string;
  tenantId: string;
  prompt: string;
  scheduleType: 'cron' | 'interval' | 'once';
  scheduleValue: string;
  nextRunAt: string | null;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
}

export interface RunRecord {
  runId: string;
  tenantId: string;
  taskId?: string;
  sourceEventId?: string;
  status: RunStatus;
  idempotencyKey: string;
  prompt: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  resultJson?: string;
  errorCode?: string;
  errorMessage?: string;
  usageInputTokens?: number;
  usageOutputTokens?: number;
  runtimeMs?: number;
}

export interface UsageSnapshotRecord {
  snapshotId: string;
  tenantId: string;
  runId: string;
  metric: string;
  quantity: number;
  reportedToBilling: boolean;
  billingReportKey?: string;
  createdAt: string;
}

export interface OutboundDeliveryRecord {
  deliveryId: string;
  tenantId: string;
  runId: string;
  channel: string;
  target: string;
  payloadJson: string;
  status: DeliveryStatus;
  attemptCount: number;
  nextAttemptAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface InboundEventRecord {
  tenantId: string;
  eventId: string;
  payloadJson: string;
  receivedAt: string;
}
