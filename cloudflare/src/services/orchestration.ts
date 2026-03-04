import {
  AgentRunRequest,
  AgentRunRequestSchema,
  CanonicalInboundEvent,
  CorrelationContext,
  parseContract,
} from '../contracts.js';
import { TaskRecord, TenantRecord } from '../domain-models.js';
import { AppError } from '../errors.js';
import { log } from '../logging.js';
import { BillingPort } from '../ports/billing.js';
import { PlatformRepositories } from '../ports/database.js';
import { QueuePort } from '../ports/queue.js';
import { SchedulerPort } from '../ports/scheduler.js';
import { createId, stableNowIso } from '../utils.js';

export interface IngestResult {
  accepted: boolean;
  reason: 'enqueued' | 'duplicate' | 'entitlement_denied' | 'quota_exceeded';
  runId?: string;
}

interface OrchestrationDeps {
  repos: PlatformRepositories;
  queue: QueuePort;
  billing: BillingPort;
  scheduler: SchedulerPort;
  nowIso?: () => string;
}

export class TenantOrchestrationService {
  private readonly nowIso: () => string;

  constructor(private readonly deps: OrchestrationDeps) {
    this.nowIso = deps.nowIso ?? (() => stableNowIso());
  }

  async ensureTenantExists(tenantId: string): Promise<TenantRecord> {
    const existing = await this.deps.repos.tenants.get(tenantId);
    if (existing) {
      return existing;
    }
    const now = this.nowIso();
    const tenant: TenantRecord = {
      tenantId,
      displayName: tenantId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.repos.tenants.upsert(tenant);
    return tenant;
  }

  async ingestCanonicalEvent(input: CanonicalInboundEvent): Promise<IngestResult> {
    await this.ensureTenantExists(input.tenantId);
    const dedupeResult = await this.deps.repos.inboundEvents.record({
      tenantId: input.tenantId,
      eventId: input.eventId,
      payloadJson: JSON.stringify(input),
      receivedAt: input.receivedAt,
    });
    if (dedupeResult === 'duplicate') {
      log({
        event: 'orchestrator.ingest.duplicate',
        message: 'Inbound event deduplicated',
        correlation: {
          tenantId: input.tenantId,
          eventId: input.eventId,
          requestId: input.eventId,
        },
      });
      return {
        accepted: true,
        reason: 'duplicate',
      };
    }

    const correlation: CorrelationContext = {
      requestId: input.eventId,
      tenantId: input.tenantId,
      eventId: input.eventId,
    };

    const entitlement = await this.deps.billing.checkEntitlement({
      tenantId: input.tenantId,
      feature: 'agent_run',
      quantity: 1,
      correlation,
    });
    if (!entitlement.allowed) {
      return {
        accepted: false,
        reason: 'entitlement_denied',
      };
    }

    const tenant = await this.deps.repos.tenants.get(input.tenantId);
    if (tenant?.monthlyBudgetUsd !== undefined) {
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const usage = await this.deps.repos.usage.sumByTenant(
        input.tenantId,
        monthStart.toISOString(),
      );
      const usdUsed = usage
        .filter((item) => item.metric === 'usd')
        .reduce((sum, item) => sum + item.quantity, 0);
      if (usdUsed >= tenant.monthlyBudgetUsd) {
        return {
          accepted: false,
          reason: 'quota_exceeded',
        };
      }
    }

    const runId = createId('run');
    const now = this.nowIso();
    await this.deps.repos.runs.create({
      runId,
      tenantId: input.tenantId,
      sourceEventId: input.eventId,
      status: 'queued',
      idempotencyKey: `inbound:${input.tenantId}:${input.eventId}`,
      prompt: input.payload.text,
      queuedAt: now,
    });

    const runRequest: AgentRunRequest = parseContract(
      AgentRunRequestSchema,
      {
        runId,
        tenantId: input.tenantId,
        idempotencyKey: `inbound:${input.tenantId}:${input.eventId}`,
        prompt: input.payload.text,
        context: {
          isScheduledTask: false,
        },
        correlation: {
          requestId: input.eventId,
          tenantId: input.tenantId,
          eventId: input.eventId,
          runId,
        },
        createdAt: now,
      },
      'AgentRunRequest',
    );
    await this.deps.queue.enqueueAgentRun(runRequest);
    await this.deps.scheduler.scheduleReconcile(input.tenantId, 30);

    return {
      accepted: true,
      reason: 'enqueued',
      runId,
    };
  }

  async enqueueDueTasks(tenantId: string, dueBeforeIso: string): Promise<string[]> {
    const due = await this.deps.repos.tasks.listDue(tenantId, dueBeforeIso, 100);
    const enqueuedRunIds: string[] = [];
    for (const task of due) {
      const runId = await this.enqueueTaskRun(task);
      enqueuedRunIds.push(runId);
    }
    return enqueuedRunIds;
  }

  async enqueueTaskRun(task: TaskRecord): Promise<string> {
    const now = this.nowIso();
    const runId = createId('run');
    const idempotencyKey = `task:${task.taskId}:${task.nextRunAt ?? now}`;
    const existing = await this.deps.repos.runs.getByIdempotencyKey(idempotencyKey);
    if (existing) {
      return existing.runId;
    }

    const correlation: CorrelationContext = {
      requestId: task.taskId,
      tenantId: task.tenantId,
      runId,
    };

    const entitlement = await this.deps.billing.checkEntitlement({
      tenantId: task.tenantId,
      feature: 'scheduled_task_run',
      quantity: 1,
      correlation,
    });
    if (!entitlement.allowed) {
      throw new AppError({
        code: 'ENTITLEMENT_DENIED',
        message: `Task ${task.taskId} blocked by entitlement: ${entitlement.reason}`,
        status: 402,
        retryable: false,
      });
    }

    await this.deps.repos.runs.create({
      runId,
      tenantId: task.tenantId,
      taskId: task.taskId,
      status: 'queued',
      idempotencyKey,
      prompt: task.prompt,
      queuedAt: now,
    });

    await this.deps.queue.enqueueAgentRun({
      runId,
      tenantId: task.tenantId,
      taskId: task.taskId,
      idempotencyKey,
      prompt: task.prompt,
      context: {
        isScheduledTask: true,
      },
      correlation: {
        requestId: task.taskId,
        tenantId: task.tenantId,
        runId,
      },
      createdAt: now,
    });

    await this.deps.repos.tasks.touchRun(task.taskId, now);
    return runId;
  }
}
