import {
  InboundEventRecord,
  OutboundDeliveryRecord,
  RunRecord,
  TaskRecord,
  TenantRecord,
  UsageSnapshotRecord,
} from '../domain-models.js';

export interface TenantRepository {
  get(tenantId: string): Promise<TenantRecord | null>;
  upsert(tenant: TenantRecord): Promise<void>;
  list(limit: number): Promise<TenantRecord[]>;
  updateBillingReferences(
    tenantId: string,
    refs: {
      autumnCustomerId?: string;
      subscriptionRef?: string;
      entitlementCacheUntil?: string;
    },
  ): Promise<void>;
}

export interface TaskRepository {
  create(task: TaskRecord): Promise<void>;
  get(taskId: string): Promise<TaskRecord | null>;
  listByTenant(tenantId: string, limit: number): Promise<TaskRecord[]>;
  listDue(tenantId: string, dueBefore: string, limit: number): Promise<TaskRecord[]>;
  updateStatus(taskId: string, status: TaskRecord['status']): Promise<void>;
  updateSchedule(taskId: string, nextRunAt: string | null): Promise<void>;
  touchRun(taskId: string, lastRunAt: string): Promise<void>;
}

export interface RunRepository {
  create(run: RunRecord): Promise<void>;
  get(runId: string): Promise<RunRecord | null>;
  getByIdempotencyKey(idempotencyKey: string): Promise<RunRecord | null>;
  listByTenant(tenantId: string, limit: number): Promise<RunRecord[]>;
  markRunning(runId: string, startedAt: string): Promise<void>;
  markSucceeded(
    runId: string,
    params: {
      finishedAt: string;
      resultJson: string;
      usageInputTokens: number;
      usageOutputTokens: number;
      runtimeMs: number;
    },
  ): Promise<void>;
  markFailed(
    runId: string,
    params: {
      finishedAt: string;
      errorCode: string;
      errorMessage: string;
      runtimeMs: number;
    },
  ): Promise<void>;
}

export interface UsageRepository {
  create(snapshot: UsageSnapshotRecord): Promise<void>;
  sumByTenant(
    tenantId: string,
    sinceIso: string,
  ): Promise<Array<{ metric: string; quantity: number }>>;
  markReported(snapshotId: string, billingReportKey: string): Promise<void>;
}

export interface OutboundRepository {
  create(delivery: OutboundDeliveryRecord): Promise<void>;
  get(deliveryId: string): Promise<OutboundDeliveryRecord | null>;
  listByTenant(
    tenantId: string,
    status: OutboundDeliveryRecord['status'] | 'all',
    limit: number,
  ): Promise<OutboundDeliveryRecord[]>;
  updateState(
    deliveryId: string,
    patch: {
      status: OutboundDeliveryRecord['status'];
      attemptCount?: number;
      nextAttemptAt?: string;
      lastError?: string;
      updatedAt: string;
    },
  ): Promise<void>;
  addDeadLetter(
    deliveryId: string,
    tenantId: string,
    reason: string,
    payloadJson: string,
    failedAt: string,
  ): Promise<void>;
}

export interface InboundEventRepository {
  record(event: InboundEventRecord): Promise<'inserted' | 'duplicate'>;
}

export interface BillingReferenceRepository {
  upsertUsageReport(
    reportKey: string,
    row: {
      tenantId: string;
      runId: string;
      metric: string;
      quantity: number;
      status: 'pending' | 'reported' | 'failed';
      providerRef?: string;
      lastError?: string;
      createdAt: string;
      updatedAt: string;
    },
  ): Promise<void>;
  getUsageReport(reportKey: string): Promise<{
    reportKey: string;
    status: 'pending' | 'reported' | 'failed';
    providerRef?: string;
    lastError?: string;
  } | null>;
}

export interface PlatformRepositories {
  tenants: TenantRepository;
  tasks: TaskRepository;
  runs: RunRepository;
  usage: UsageRepository;
  outbound: OutboundRepository;
  inboundEvents: InboundEventRepository;
  billingRefs: BillingReferenceRepository;
}
