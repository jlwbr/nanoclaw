import {
  CanonicalInboundEventSchema,
  parseContract,
} from '../contracts.js';
import { DurableObjectState, ExecutionContext } from '../cf-types.js';
import { createAutumnBillingAdapter } from '../adapters/autumn-billing.js';
import { createD1SqlClient } from '../adapters/d1/client.js';
import { createD1Repositories } from '../adapters/d1/repositories.js';
import { CloudflareQueueAdapter } from '../adapters/queue.js';
import { WorkerEnv } from '../env.js';
import { log, logError } from '../logging.js';
import { SchedulerPort } from '../ports/scheduler.js';
import { TenantOrchestrationService } from '../services/orchestration.js';
import { jsonResponse } from '../utils.js';

interface SchedulePayload {
  type: 'wakeup' | 'reconcile';
  runAtIso?: string;
  afterSeconds?: number;
}

export class TenantOrchestratorDurableObject {
  private readonly orchestration: TenantOrchestrationService;
  private readonly scheduler: SchedulerPort;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: WorkerEnv,
  ) {
    const sql = createD1SqlClient(env.DB);
    const repos = createD1Repositories(sql);
    const queue = new CloudflareQueueAdapter(env);
    const billing = createAutumnBillingAdapter(env, repos);
    this.scheduler = {
      scheduleWakeup: async (_tenantId, runAtIso) => {
        await this.state.storage.setAlarm(new Date(runAtIso));
      },
      scheduleReconcile: async (_tenantId, afterSeconds) => {
        await this.state.storage.setAlarm(Date.now() + afterSeconds * 1000);
      },
    };
    this.orchestration = new TenantOrchestrationService({
      repos,
      queue,
      billing,
      scheduler: this.scheduler,
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        const alarmAt = await this.state.storage.getAlarm();
        return jsonResponse({
          status: 'ok',
          durableObjectId: this.state.id.toString(),
          alarmAt: alarmAt ? new Date(alarmAt).toISOString() : null,
        });
      }

      if (request.method === 'POST' && url.pathname === '/orchestrate/inbound') {
        const body = await request.json();
        const event = parseContract(
          CanonicalInboundEventSchema,
          body,
          'CanonicalInboundEvent',
        );
        await this.state.storage.put('tenantId', event.tenantId);
        await this.state.storage.put(`event:${event.eventId}`, event.receivedAt);
        const outcome = await this.orchestration.ingestCanonicalEvent(event);
        return jsonResponse(outcome, { status: outcome.accepted ? 202 : 403 });
      }

      if (request.method === 'POST' && url.pathname === '/orchestrate/reconcile') {
        const body = (await request.json()) as { tenantId: string };
        const tenantId = body.tenantId || (await this.state.storage.get<string>('tenantId'));
        if (!tenantId) {
          return jsonResponse(
            { error: { code: 'INVALID_REQUEST', message: 'tenantId is required' } },
            { status: 400 },
          );
        }
        const enqueued = await this.orchestration.enqueueDueTasks(
          tenantId,
          new Date().toISOString(),
        );
        return jsonResponse({ enqueuedCount: enqueued.length, runIds: enqueued });
      }

      if (request.method === 'POST' && url.pathname === '/internal/schedule') {
        const payload = (await request.json()) as SchedulePayload;
        if (payload.type === 'wakeup') {
          if (!payload.runAtIso) {
            return jsonResponse(
              { error: { code: 'INVALID_REQUEST', message: 'runAtIso is required' } },
              { status: 400 },
            );
          }
          await this.state.storage.setAlarm(new Date(payload.runAtIso));
        } else {
          const afterSeconds = payload.afterSeconds ?? 30;
          await this.state.storage.setAlarm(Date.now() + afterSeconds * 1000);
        }
        return jsonResponse({ scheduled: true });
      }

      return jsonResponse(
        {
          error: {
            code: 'NOT_FOUND',
            message: `Route not found: ${request.method} ${url.pathname}`,
          },
        },
        { status: 404 },
      );
    } catch (error) {
      logError(
        'tenant_orchestrator.fetch.error',
        'Durable object request failed',
        error,
      );
      return jsonResponse(
        {
          error: {
            code: 'INTERNAL_ERROR',
            message: error instanceof Error ? error.message : String(error),
          },
        },
        { status: 500 },
      );
    }
  }

  async alarm(): Promise<void> {
    const tenantId = await this.state.storage.get<string>('tenantId');
    if (!tenantId) {
      log({
        event: 'tenant_orchestrator.alarm.no_tenant',
        level: 'warn',
        message: 'Alarm fired without tenant context',
      });
      return;
    }

    try {
      const runIds = await this.orchestration.enqueueDueTasks(
        tenantId,
        new Date().toISOString(),
      );
      log({
        event: 'tenant_orchestrator.alarm.reconcile',
        message: 'Alarm reconciliation completed',
        correlation: {
          requestId: `alarm-${Date.now()}`,
          tenantId,
        },
        data: {
          enqueuedRunCount: runIds.length,
        },
      });
      await this.state.storage.setAlarm(Date.now() + 60_000);
    } catch (error) {
      logError(
        'tenant_orchestrator.alarm.error',
        'Alarm reconciliation failed',
        error,
        {
          requestId: `alarm-${Date.now()}`,
          tenantId,
        },
      );
      await this.state.storage.setAlarm(Date.now() + 120_000);
    }
  }
}

export type DurableObjectConstructor = new (
  state: DurableObjectState,
  env: WorkerEnv,
  ctx?: ExecutionContext,
) => TenantOrchestratorDurableObject;
