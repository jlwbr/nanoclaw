import {
  InboundEventRecord,
  OutboundDeliveryRecord,
  RunRecord,
  TaskRecord,
  TenantRecord,
  UsageSnapshotRecord,
} from '../../domain-models.js';
import {
  BillingReferenceRepository,
  InboundEventRepository,
  OutboundRepository,
  PlatformRepositories,
  RunRepository,
  TaskRepository,
  TenantRepository,
  UsageRepository,
} from '../../ports/database.js';
import { SqlClient } from './client.js';

function toTenantRecord(row: Record<string, unknown>): TenantRecord {
  return {
    tenantId: String(row.tenant_id),
    displayName: String(row.display_name),
    status: row.status as TenantRecord['status'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    autumnCustomerId:
      row.autumn_customer_id === null || row.autumn_customer_id === undefined
        ? undefined
        : String(row.autumn_customer_id),
    subscriptionRef:
      row.subscription_ref === null || row.subscription_ref === undefined
        ? undefined
        : String(row.subscription_ref),
    entitlementCacheUntil:
      row.entitlement_cache_until === null ||
      row.entitlement_cache_until === undefined
        ? undefined
        : String(row.entitlement_cache_until),
    monthlyBudgetUsd:
      row.monthly_budget_usd === null || row.monthly_budget_usd === undefined
        ? undefined
        : Number(row.monthly_budget_usd),
  };
}

function toTaskRecord(row: Record<string, unknown>): TaskRecord {
  return {
    taskId: String(row.task_id),
    tenantId: String(row.tenant_id),
    prompt: String(row.prompt),
    scheduleType: row.schedule_type as TaskRecord['scheduleType'],
    scheduleValue: String(row.schedule_value),
    nextRunAt:
      row.next_run_at === null || row.next_run_at === undefined
        ? null
        : String(row.next_run_at),
    status: row.status as TaskRecord['status'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastRunAt:
      row.last_run_at === null || row.last_run_at === undefined
        ? undefined
        : String(row.last_run_at),
  };
}

function toRunRecord(row: Record<string, unknown>): RunRecord {
  return {
    runId: String(row.run_id),
    tenantId: String(row.tenant_id),
    taskId:
      row.task_id === null || row.task_id === undefined
        ? undefined
        : String(row.task_id),
    sourceEventId:
      row.source_event_id === null || row.source_event_id === undefined
        ? undefined
        : String(row.source_event_id),
    status: row.status as RunRecord['status'],
    idempotencyKey: String(row.idempotency_key),
    prompt: String(row.prompt),
    queuedAt: String(row.queued_at),
    startedAt:
      row.started_at === null || row.started_at === undefined
        ? undefined
        : String(row.started_at),
    finishedAt:
      row.finished_at === null || row.finished_at === undefined
        ? undefined
        : String(row.finished_at),
    resultJson:
      row.result_json === null || row.result_json === undefined
        ? undefined
        : String(row.result_json),
    errorCode:
      row.error_code === null || row.error_code === undefined
        ? undefined
        : String(row.error_code),
    errorMessage:
      row.error_message === null || row.error_message === undefined
        ? undefined
        : String(row.error_message),
    usageInputTokens:
      row.usage_input_tokens === null || row.usage_input_tokens === undefined
        ? undefined
        : Number(row.usage_input_tokens),
    usageOutputTokens:
      row.usage_output_tokens === null || row.usage_output_tokens === undefined
        ? undefined
        : Number(row.usage_output_tokens),
    runtimeMs:
      row.runtime_ms === null || row.runtime_ms === undefined
        ? undefined
        : Number(row.runtime_ms),
  };
}

function toOutboundRecord(row: Record<string, unknown>): OutboundDeliveryRecord {
  return {
    deliveryId: String(row.delivery_id),
    tenantId: String(row.tenant_id),
    runId: String(row.run_id),
    channel: String(row.channel),
    target: String(row.target),
    payloadJson: String(row.payload_json),
    status: row.status as OutboundDeliveryRecord['status'],
    attemptCount: Number(row.attempt_count),
    nextAttemptAt:
      row.next_attempt_at === null || row.next_attempt_at === undefined
        ? undefined
        : String(row.next_attempt_at),
    lastError:
      row.last_error === null || row.last_error === undefined
        ? undefined
        : String(row.last_error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

class D1TenantRepository implements TenantRepository {
  constructor(private readonly sql: SqlClient) {}

  async get(tenantId: string): Promise<TenantRecord | null> {
    const row = await this.sql.one<Record<string, unknown>>(
      'SELECT * FROM tenants WHERE tenant_id = ?',
      [tenantId],
    );
    return row ? toTenantRecord(row) : null;
  }

  async upsert(tenant: TenantRecord): Promise<void> {
    await this.sql.run(
      `INSERT INTO tenants (
        tenant_id, display_name, status, created_at, updated_at,
        autumn_customer_id, subscription_ref, entitlement_cache_until, monthly_budget_usd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id) DO UPDATE SET
        display_name = excluded.display_name,
        status = excluded.status,
        updated_at = excluded.updated_at,
        autumn_customer_id = excluded.autumn_customer_id,
        subscription_ref = excluded.subscription_ref,
        entitlement_cache_until = excluded.entitlement_cache_until,
        monthly_budget_usd = excluded.monthly_budget_usd`,
      [
        tenant.tenantId,
        tenant.displayName,
        tenant.status,
        tenant.createdAt,
        tenant.updatedAt,
        tenant.autumnCustomerId ?? null,
        tenant.subscriptionRef ?? null,
        tenant.entitlementCacheUntil ?? null,
        tenant.monthlyBudgetUsd ?? null,
      ],
    );
  }

  async list(limit: number): Promise<TenantRecord[]> {
    const rows = await this.sql.all<Record<string, unknown>>(
      'SELECT * FROM tenants ORDER BY updated_at DESC LIMIT ?',
      [limit],
    );
    return rows.map(toTenantRecord);
  }

  async updateBillingReferences(
    tenantId: string,
    refs: {
      autumnCustomerId?: string;
      subscriptionRef?: string;
      entitlementCacheUntil?: string;
    },
  ): Promise<void> {
    await this.sql.run(
      `UPDATE tenants SET
        autumn_customer_id = COALESCE(?, autumn_customer_id),
        subscription_ref = COALESCE(?, subscription_ref),
        entitlement_cache_until = COALESCE(?, entitlement_cache_until),
        updated_at = ?
      WHERE tenant_id = ?`,
      [
        refs.autumnCustomerId ?? null,
        refs.subscriptionRef ?? null,
        refs.entitlementCacheUntil ?? null,
        new Date().toISOString(),
        tenantId,
      ],
    );
  }
}

class D1TaskRepository implements TaskRepository {
  constructor(private readonly sql: SqlClient) {}

  async create(task: TaskRecord): Promise<void> {
    await this.sql.run(
      `INSERT INTO tasks (
        task_id, tenant_id, prompt, schedule_type, schedule_value, next_run_at,
        status, created_at, updated_at, last_run_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        task.taskId,
        task.tenantId,
        task.prompt,
        task.scheduleType,
        task.scheduleValue,
        task.nextRunAt,
        task.status,
        task.createdAt,
        task.updatedAt,
        task.lastRunAt ?? null,
      ],
    );
  }

  async get(taskId: string): Promise<TaskRecord | null> {
    const row = await this.sql.one<Record<string, unknown>>(
      'SELECT * FROM tasks WHERE task_id = ?',
      [taskId],
    );
    return row ? toTaskRecord(row) : null;
  }

  async listByTenant(tenantId: string, limit: number): Promise<TaskRecord[]> {
    const rows = await this.sql.all<Record<string, unknown>>(
      'SELECT * FROM tasks WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?',
      [tenantId, limit],
    );
    return rows.map(toTaskRecord);
  }

  async listDue(
    tenantId: string,
    dueBefore: string,
    limit: number,
  ): Promise<TaskRecord[]> {
    const rows = await this.sql.all<Record<string, unknown>>(
      `SELECT * FROM tasks
       WHERE tenant_id = ? AND status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
       ORDER BY next_run_at ASC
       LIMIT ?`,
      [tenantId, dueBefore, limit],
    );
    return rows.map(toTaskRecord);
  }

  async updateStatus(taskId: string, status: TaskRecord['status']): Promise<void> {
    await this.sql.run(
      'UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?',
      [status, new Date().toISOString(), taskId],
    );
  }

  async updateSchedule(taskId: string, nextRunAt: string | null): Promise<void> {
    await this.sql.run(
      'UPDATE tasks SET next_run_at = ?, updated_at = ? WHERE task_id = ?',
      [nextRunAt, new Date().toISOString(), taskId],
    );
  }

  async touchRun(taskId: string, lastRunAt: string): Promise<void> {
    await this.sql.run(
      'UPDATE tasks SET last_run_at = ?, updated_at = ? WHERE task_id = ?',
      [lastRunAt, new Date().toISOString(), taskId],
    );
  }
}

class D1RunRepository implements RunRepository {
  constructor(private readonly sql: SqlClient) {}

  async create(run: RunRecord): Promise<void> {
    await this.sql.run(
      `INSERT INTO run_jobs (
        run_id, tenant_id, task_id, source_event_id, status, idempotency_key, prompt,
        queued_at, started_at, finished_at, result_json, error_code, error_message,
        usage_input_tokens, usage_output_tokens, runtime_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.runId,
        run.tenantId,
        run.taskId ?? null,
        run.sourceEventId ?? null,
        run.status,
        run.idempotencyKey,
        run.prompt,
        run.queuedAt,
        run.startedAt ?? null,
        run.finishedAt ?? null,
        run.resultJson ?? null,
        run.errorCode ?? null,
        run.errorMessage ?? null,
        run.usageInputTokens ?? null,
        run.usageOutputTokens ?? null,
        run.runtimeMs ?? null,
      ],
    );
  }

  async get(runId: string): Promise<RunRecord | null> {
    const row = await this.sql.one<Record<string, unknown>>(
      'SELECT * FROM run_jobs WHERE run_id = ?',
      [runId],
    );
    return row ? toRunRecord(row) : null;
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<RunRecord | null> {
    const row = await this.sql.one<Record<string, unknown>>(
      'SELECT * FROM run_jobs WHERE idempotency_key = ?',
      [idempotencyKey],
    );
    return row ? toRunRecord(row) : null;
  }

  async listByTenant(tenantId: string, limit: number): Promise<RunRecord[]> {
    const rows = await this.sql.all<Record<string, unknown>>(
      'SELECT * FROM run_jobs WHERE tenant_id = ? ORDER BY queued_at DESC LIMIT ?',
      [tenantId, limit],
    );
    return rows.map(toRunRecord);
  }

  async markRunning(runId: string, startedAt: string): Promise<void> {
    await this.sql.run(
      "UPDATE run_jobs SET status = 'running', started_at = ? WHERE run_id = ?",
      [startedAt, runId],
    );
  }

  async markSucceeded(
    runId: string,
    params: {
      finishedAt: string;
      resultJson: string;
      usageInputTokens: number;
      usageOutputTokens: number;
      runtimeMs: number;
    },
  ): Promise<void> {
    await this.sql.run(
      `UPDATE run_jobs SET
        status = 'succeeded',
        finished_at = ?,
        result_json = ?,
        usage_input_tokens = ?,
        usage_output_tokens = ?,
        runtime_ms = ?
       WHERE run_id = ?`,
      [
        params.finishedAt,
        params.resultJson,
        params.usageInputTokens,
        params.usageOutputTokens,
        params.runtimeMs,
        runId,
      ],
    );
  }

  async markFailed(
    runId: string,
    params: {
      finishedAt: string;
      errorCode: string;
      errorMessage: string;
      runtimeMs: number;
    },
  ): Promise<void> {
    const status = params.errorCode === 'RUNTIME_TIMEOUT' ? 'timed_out' : 'failed';
    await this.sql.run(
      `UPDATE run_jobs SET
        status = ?,
        finished_at = ?,
        error_code = ?,
        error_message = ?,
        runtime_ms = ?
       WHERE run_id = ?`,
      [
        status,
        params.finishedAt,
        params.errorCode,
        params.errorMessage,
        params.runtimeMs,
        runId,
      ],
    );
  }
}

class D1UsageRepository implements UsageRepository {
  constructor(private readonly sql: SqlClient) {}

  async create(snapshot: UsageSnapshotRecord): Promise<void> {
    await this.sql.run(
      `INSERT INTO usage_snapshots (
        snapshot_id, tenant_id, run_id, metric, quantity,
        reported_to_billing, billing_report_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.snapshotId,
        snapshot.tenantId,
        snapshot.runId,
        snapshot.metric,
        snapshot.quantity,
        snapshot.reportedToBilling ? 1 : 0,
        snapshot.billingReportKey ?? null,
        snapshot.createdAt,
      ],
    );
  }

  async sumByTenant(
    tenantId: string,
    sinceIso: string,
  ): Promise<Array<{ metric: string; quantity: number }>> {
    const rows = await this.sql.all<Record<string, unknown>>(
      `SELECT metric, SUM(quantity) AS quantity
       FROM usage_snapshots
       WHERE tenant_id = ? AND created_at >= ?
       GROUP BY metric
       ORDER BY metric ASC`,
      [tenantId, sinceIso],
    );
    return rows.map((row) => ({
      metric: String(row.metric),
      quantity: Number(row.quantity),
    }));
  }

  async markReported(snapshotId: string, billingReportKey: string): Promise<void> {
    await this.sql.run(
      `UPDATE usage_snapshots
       SET reported_to_billing = 1, billing_report_key = ?
       WHERE snapshot_id = ?`,
      [billingReportKey, snapshotId],
    );
  }
}

class D1OutboundRepository implements OutboundRepository {
  constructor(private readonly sql: SqlClient) {}

  async create(delivery: OutboundDeliveryRecord): Promise<void> {
    await this.sql.run(
      `INSERT INTO outbound_deliveries (
        delivery_id, tenant_id, run_id, channel, target, payload_json,
        status, attempt_count, next_attempt_at, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        delivery.deliveryId,
        delivery.tenantId,
        delivery.runId,
        delivery.channel,
        delivery.target,
        delivery.payloadJson,
        delivery.status,
        delivery.attemptCount,
        delivery.nextAttemptAt ?? null,
        delivery.lastError ?? null,
        delivery.createdAt,
        delivery.updatedAt,
      ],
    );
  }

  async get(deliveryId: string): Promise<OutboundDeliveryRecord | null> {
    const row = await this.sql.one<Record<string, unknown>>(
      'SELECT * FROM outbound_deliveries WHERE delivery_id = ?',
      [deliveryId],
    );
    return row ? toOutboundRecord(row) : null;
  }

  async listByTenant(
    tenantId: string,
    status: OutboundDeliveryRecord['status'] | 'all',
    limit: number,
  ): Promise<OutboundDeliveryRecord[]> {
    const rows = await (status === 'all'
      ? this.sql.all<Record<string, unknown>>(
          `SELECT * FROM outbound_deliveries
           WHERE tenant_id = ?
           ORDER BY updated_at DESC
           LIMIT ?`,
          [tenantId, limit],
        )
      : this.sql.all<Record<string, unknown>>(
          `SELECT * FROM outbound_deliveries
           WHERE tenant_id = ? AND status = ?
           ORDER BY updated_at DESC
           LIMIT ?`,
          [tenantId, status, limit],
        ));
    return rows.map(toOutboundRecord);
  }

  async updateState(
    deliveryId: string,
    patch: {
      status: OutboundDeliveryRecord['status'];
      attemptCount?: number;
      nextAttemptAt?: string;
      lastError?: string;
      updatedAt: string;
    },
  ): Promise<void> {
    await this.sql.run(
      `UPDATE outbound_deliveries SET
        status = ?,
        attempt_count = COALESCE(?, attempt_count),
        next_attempt_at = ?,
        last_error = ?,
        updated_at = ?
       WHERE delivery_id = ?`,
      [
        patch.status,
        patch.attemptCount ?? null,
        patch.nextAttemptAt ?? null,
        patch.lastError ?? null,
        patch.updatedAt,
        deliveryId,
      ],
    );
  }

  async addDeadLetter(
    deliveryId: string,
    tenantId: string,
    reason: string,
    payloadJson: string,
    failedAt: string,
  ): Promise<void> {
    await this.sql.run(
      `INSERT INTO outbound_dead_letter (
        delivery_id, tenant_id, reason, payload_json, failed_at
      ) VALUES (?, ?, ?, ?, ?)`,
      [deliveryId, tenantId, reason, payloadJson, failedAt],
    );
  }
}

class D1InboundEventRepository implements InboundEventRepository {
  constructor(private readonly sql: SqlClient) {}

  async record(event: InboundEventRecord): Promise<'inserted' | 'duplicate'> {
    try {
      await this.sql.run(
        `INSERT INTO inbound_events (tenant_id, event_id, payload_json, received_at)
         VALUES (?, ?, ?, ?)`,
        [event.tenantId, event.eventId, event.payloadJson, event.receivedAt],
      );
      return 'inserted';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes('UNIQUE constraint failed') ||
        message.includes('PRIMARY KEY') ||
        message.includes('SQLITE_CONSTRAINT')
      ) {
        return 'duplicate';
      }
      throw error;
    }
  }
}

class D1BillingReferenceRepository implements BillingReferenceRepository {
  constructor(private readonly sql: SqlClient) {}

  async upsertUsageReport(
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
  ): Promise<void> {
    await this.sql.run(
      `INSERT INTO billing_usage_reports (
        report_key, tenant_id, run_id, metric, quantity, status,
        provider_ref, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(report_key) DO UPDATE SET
        status = excluded.status,
        provider_ref = excluded.provider_ref,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at`,
      [
        reportKey,
        row.tenantId,
        row.runId,
        row.metric,
        row.quantity,
        row.status,
        row.providerRef ?? null,
        row.lastError ?? null,
        row.createdAt,
        row.updatedAt,
      ],
    );
  }

  async getUsageReport(reportKey: string): Promise<{
    reportKey: string;
    status: 'pending' | 'reported' | 'failed';
    providerRef?: string;
    lastError?: string;
  } | null> {
    const row = await this.sql.one<Record<string, unknown>>(
      'SELECT report_key, status, provider_ref, last_error FROM billing_usage_reports WHERE report_key = ?',
      [reportKey],
    );
    if (!row) {
      return null;
    }
    return {
      reportKey: String(row.report_key),
      status: row.status as 'pending' | 'reported' | 'failed',
      providerRef:
        row.provider_ref === null || row.provider_ref === undefined
          ? undefined
          : String(row.provider_ref),
      lastError:
        row.last_error === null || row.last_error === undefined
          ? undefined
          : String(row.last_error),
    };
  }
}

export function createD1Repositories(sql: SqlClient): PlatformRepositories {
  return {
    tenants: new D1TenantRepository(sql),
    tasks: new D1TaskRepository(sql),
    runs: new D1RunRepository(sql),
    usage: new D1UsageRepository(sql),
    outbound: new D1OutboundRepository(sql),
    inboundEvents: new D1InboundEventRepository(sql),
    billingRefs: new D1BillingReferenceRepository(sql),
  };
}
