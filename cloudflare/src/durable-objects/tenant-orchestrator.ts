import {
  AgentRunJobMessage,
  CanonicalInboundEvent,
  Env,
  ListTasksRequest,
  ReconcileTasksRequest,
  ScheduleTaskRequest,
  TaskActionRequest,
  TaskContextMode,
  TaskScheduleType,
  TaskStatus,
  TenantOrchestratorRequest,
  TenantOrchestratorResponse,
} from '../types';
import { CronExpressionParser } from 'cron-parser';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

class EnqueueRunError extends Error {
  readonly runId: string;

  constructor(runId: string, message: string) {
    super(message);
    this.runId = runId;
  }
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

    switch (body.type) {
      case 'inbound_event': {
        const event = body.event;
        if (
          !event.eventId ||
          !event.tenantId ||
          !event.channel ||
          !event.receivedAt
        ) {
          return json({ error: 'Missing required event fields' }, 400);
        }
        return this.handleInboundEvent(event);
      }
      case 'run_status_update': {
        if (
          !body.runId ||
          !body.tenantId ||
          !body.status ||
          !body.processedAt
        ) {
          return json({ error: 'Missing required run status fields' }, 400);
        }
        return this.handleRunStatusUpdate(body);
      }
      case 'schedule_task': {
        if (
          !body.tenantId ||
          !body.chatJid ||
          !body.groupFolder ||
          !body.prompt ||
          !body.scheduleType ||
          !body.scheduleValue
        ) {
          return json({ error: 'Missing required schedule task fields' }, 400);
        }
        return this.handleScheduleTask(body);
      }
      case 'list_tasks': {
        if (!body.tenantId) {
          return json({ error: 'Missing tenantId' }, 400);
        }
        return this.handleListTasks(body);
      }
      case 'task_action': {
        if (!body.tenantId || !body.taskId || !body.action) {
          return json({ error: 'Missing required task action fields' }, 400);
        }
        return this.handleTaskAction(body);
      }
      case 'reconcile_tasks': {
        if (!body.tenantId) {
          return json({ error: 'Missing tenantId' }, 400);
        }
        return this.handleReconcileTasks(body);
      }
      default:
        return json({ error: 'Unsupported request type' }, 400);
    }
  }

  async alarm(): Promise<void> {
    const tenantId = await this.getTenantId();
    if (!tenantId) return;
    await this.reconcileDueTasks(tenantId, 'alarm');
  }

  private async rememberTenantId(tenantId: string): Promise<void> {
    const existing = await this.state.storage.get<string>('meta:tenantId');
    if (!existing) {
      await this.state.storage.put('meta:tenantId', tenantId);
    }
  }

  private async getTenantId(): Promise<string | null> {
    const tenantId = await this.state.storage.get<string>('meta:tenantId');
    return tenantId ?? null;
  }

  private timezone(): string {
    return this.env.TIMEZONE || 'UTC';
  }

  private computeNextRun(
    scheduleType: TaskScheduleType,
    scheduleValue: string,
    fromDate: Date,
  ): string | null {
    if (scheduleType === 'once') {
      const runAt = new Date(scheduleValue);
      if (Number.isNaN(runAt.getTime())) {
        throw new Error('Invalid once schedule timestamp');
      }
      return runAt.toISOString();
    }
    if (scheduleType === 'interval') {
      const ms = Number.parseInt(scheduleValue, 10);
      if (!Number.isFinite(ms) || ms <= 0) {
        throw new Error('Invalid interval schedule value');
      }
      return new Date(fromDate.getTime() + ms).toISOString();
    }
    if (scheduleType === 'cron') {
      const interval = CronExpressionParser.parse(scheduleValue, {
        tz: this.timezone(),
        currentDate: fromDate,
      });
      return interval.next().toISOString();
    }
    throw new Error(`Unsupported schedule type: ${scheduleType}`);
  }

  private async ensureTenantExists(tenantId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO tenants (tenant_id, created_at, updated_at)
       VALUES (?1, ?2, ?2)`,
    )
      .bind(tenantId, now)
      .run();
  }

  private async refreshAlarmForTenant(tenantId: string): Promise<void> {
    const row = await this.env.DB.prepare(
      `SELECT next_run
       FROM scheduled_tasks
       WHERE tenant_id = ?1
         AND status = 'active'
         AND next_run IS NOT NULL
       ORDER BY next_run ASC
       LIMIT 1`,
    )
      .bind(tenantId)
      .first<{ next_run: string | null }>();

    if (row?.next_run) {
      await this.state.storage.setAlarm(new Date(row.next_run).getTime());
      return;
    }
    await this.state.storage.deleteAlarm();
  }

  private buildRunJob(event: CanonicalInboundEvent): AgentRunJobMessage {
    return {
      runId: crypto.randomUUID(),
      tenantId: event.tenantId,
      eventId: event.eventId,
      channel: event.channel,
      chatJid: event.chatJid,
      content: event.content,
      enqueuedAt: new Date().toISOString(),
    };
  }

  private async enqueueFromEvent(
    event: CanonicalInboundEvent,
  ): Promise<AgentRunJobMessage> {
    const runJob = this.buildRunJob(event);
    await this.env.DB.prepare(
      `INSERT INTO agent_run_jobs (
         tenant_id, run_id, event_id, channel, chat_jid, status, attempt_count, queued_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, 'queued', 0, ?6, ?6)`,
    )
      .bind(
        event.tenantId,
        runJob.runId,
        event.eventId,
        event.channel,
        event.chatJid,
        runJob.enqueuedAt,
      )
      .run();
    try {
      await this.env.AGENT_RUN_QUEUE.send(runJob);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.env.DB.prepare(
        `UPDATE agent_run_jobs
         SET status = 'enqueue_failed', last_error = ?1, updated_at = ?2
         WHERE tenant_id = ?3 AND run_id = ?4`,
      )
        .bind(message, new Date().toISOString(), event.tenantId, runJob.runId)
        .run();
      throw new EnqueueRunError(runJob.runId, message);
    }
    return runJob;
  }

  private async createSyntheticTaskEvent(args: {
    tenantId: string;
    taskId: string;
    chatJid: string;
    prompt: string;
    reason: string;
  }): Promise<CanonicalInboundEvent> {
    const now = new Date().toISOString();
    const eventId = `task:${args.taskId}:${crypto.randomUUID().slice(0, 12)}`;
    const event: CanonicalInboundEvent = {
      eventId,
      tenantId: args.tenantId,
      channel: 'scheduled',
      receivedAt: now,
      chatJid: args.chatJid,
      sender: 'scheduler',
      senderName: 'Scheduler',
      content: args.prompt,
      payload: {
        source: 'scheduled_task',
        taskId: args.taskId,
        reason: args.reason,
      },
    };

    await this.env.DB.prepare(
      `INSERT INTO inbound_events (
         tenant_id, event_id, channel, chat_jid, sender, sender_name, content, payload_json, received_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
      .bind(
        event.tenantId,
        event.eventId,
        event.channel,
        event.chatJid,
        event.sender ?? null,
        event.senderName ?? null,
        event.content ?? null,
        JSON.stringify(event.payload),
        event.receivedAt,
      )
      .run();

    return event;
  }

  private async handleScheduleTask(
    body: ScheduleTaskRequest,
  ): Promise<Response> {
    await this.rememberTenantId(body.tenantId);
    await this.ensureTenantExists(body.tenantId);

    let nextRun: string | null;
    try {
      nextRun = this.computeNextRun(
        body.scheduleType,
        body.scheduleValue,
        new Date(),
      );
    } catch (err) {
      return json(
        {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
        400,
      );
    }

    const taskId = crypto.randomUUID();
    const now = new Date().toISOString();
    const contextMode: TaskContextMode = body.contextMode ?? 'isolated';
    await this.env.DB.prepare(
      `INSERT INTO scheduled_tasks (
         tenant_id, id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode,
         next_run, status, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'active', ?10)`,
    )
      .bind(
        body.tenantId,
        taskId,
        body.groupFolder,
        body.chatJid,
        body.prompt,
        body.scheduleType,
        body.scheduleValue,
        contextMode,
        nextRun,
        now,
      )
      .run();

    await this.refreshAlarmForTenant(body.tenantId);
    return json({
      ok: true,
      duplicate: false,
      eventId: '',
      tenantId: body.tenantId,
      taskId,
      message: 'Task scheduled',
    } satisfies TenantOrchestratorResponse);
  }

  private async handleListTasks(body: ListTasksRequest): Promise<Response> {
    await this.rememberTenantId(body.tenantId);
    const statusFilter = body.status;
    const result = statusFilter
      ? await this.env.DB.prepare(
          `SELECT id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode,
                  next_run, last_run, last_result, status, created_at
           FROM scheduled_tasks
           WHERE tenant_id = ?1 AND status = ?2
           ORDER BY created_at DESC`,
        )
          .bind(body.tenantId, statusFilter)
          .all<{
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
          }>()
      : await this.env.DB.prepare(
          `SELECT id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode,
                  next_run, last_run, last_result, status, created_at
           FROM scheduled_tasks
           WHERE tenant_id = ?1
           ORDER BY created_at DESC`,
        )
          .bind(body.tenantId)
          .all<{
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
          }>();

    return json({
      ok: true,
      duplicate: false,
      eventId: '',
      tenantId: body.tenantId,
      message: 'Tasks loaded',
      tasks: result.results,
    } satisfies TenantOrchestratorResponse);
  }

  private async handleTaskAction(body: TaskActionRequest): Promise<Response> {
    await this.rememberTenantId(body.tenantId);

    const task = await this.env.DB.prepare(
      `SELECT id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode,
              next_run, last_run, last_result, status, created_at
       FROM scheduled_tasks
       WHERE tenant_id = ?1 AND id = ?2`,
    )
      .bind(body.tenantId, body.taskId)
      .first<{
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
      }>();

    if (!task) {
      return json({ ok: false, error: 'Task not found' }, 404);
    }

    const now = new Date();
    const nowIso = now.toISOString();
    if (body.action === 'pause') {
      await this.env.DB.prepare(
        `UPDATE scheduled_tasks
         SET status = 'paused', last_result = 'Paused by user'
         WHERE tenant_id = ?1 AND id = ?2`,
      )
        .bind(body.tenantId, body.taskId)
        .run();
      await this.refreshAlarmForTenant(body.tenantId);
      return json({
        ok: true,
        duplicate: false,
        eventId: '',
        tenantId: body.tenantId,
        taskId: body.taskId,
        message: 'Task paused',
      } satisfies TenantOrchestratorResponse);
    }

    if (body.action === 'resume') {
      let nextRun = task.next_run;
      if (!nextRun && task.schedule_type !== 'once') {
        nextRun = this.computeNextRun(
          task.schedule_type,
          task.schedule_value,
          now,
        );
      }
      if (!nextRun && task.schedule_type === 'once') {
        return json(
          { ok: false, error: 'Cannot resume completed one-time task' },
          400,
        );
      }

      await this.env.DB.prepare(
        `UPDATE scheduled_tasks
         SET status = 'active', next_run = ?1, last_result = 'Resumed by user'
         WHERE tenant_id = ?2 AND id = ?3`,
      )
        .bind(nextRun, body.tenantId, body.taskId)
        .run();
      await this.refreshAlarmForTenant(body.tenantId);
      return json({
        ok: true,
        duplicate: false,
        eventId: '',
        tenantId: body.tenantId,
        taskId: body.taskId,
        message: 'Task resumed',
      } satisfies TenantOrchestratorResponse);
    }

    if (body.action === 'cancel') {
      await this.env.DB.prepare(
        `DELETE FROM scheduled_tasks WHERE tenant_id = ?1 AND id = ?2`,
      )
        .bind(body.tenantId, body.taskId)
        .run();
      await this.refreshAlarmForTenant(body.tenantId);
      return json({
        ok: true,
        duplicate: false,
        eventId: '',
        tenantId: body.tenantId,
        taskId: body.taskId,
        message: 'Task cancelled',
      } satisfies TenantOrchestratorResponse);
    }

    if (body.action === 'run_now') {
      try {
        const event = await this.createSyntheticTaskEvent({
          tenantId: body.tenantId,
          taskId: task.id,
          chatJid: task.chat_jid,
          prompt: task.prompt,
          reason: 'manual_run',
        });
        const runJob = await this.enqueueFromEvent(event);
        await this.env.DB.prepare(
          `UPDATE scheduled_tasks
           SET last_run = ?1, last_result = ?2
           WHERE tenant_id = ?3 AND id = ?4`,
        )
          .bind(
            nowIso,
            `Run-now enqueued: ${runJob.runId}`,
            body.tenantId,
            body.taskId,
          )
          .run();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.env.DB.prepare(
          `UPDATE scheduled_tasks
           SET last_result = ?1
           WHERE tenant_id = ?2 AND id = ?3`,
        )
          .bind(`Run-now enqueue failed: ${message}`, body.tenantId, body.taskId)
          .run();
        return json({ ok: false, error: message }, 500);
      }

      return json({
        ok: true,
        duplicate: false,
        eventId: '',
        tenantId: body.tenantId,
        taskId: body.taskId,
        message: 'Task run enqueued',
      } satisfies TenantOrchestratorResponse);
    }

    return json({ ok: false, error: 'Unsupported task action' }, 400);
  }

  private async handleReconcileTasks(
    body: ReconcileTasksRequest,
  ): Promise<Response> {
    await this.rememberTenantId(body.tenantId);
    const outcome = await this.reconcileDueTasks(
      body.tenantId,
      body.reason ?? 'manual_reconcile',
    );
    return json({
      ok: true,
      duplicate: false,
      eventId: '',
      tenantId: body.tenantId,
      message: `Reconcile complete: due=${outcome.dueCount}, enqueued=${outcome.enqueuedCount}, failed=${outcome.failedCount}`,
    } satisfies TenantOrchestratorResponse);
  }

  private async reconcileDueTasks(
    tenantId: string,
    reason: string,
  ): Promise<{ dueCount: number; enqueuedCount: number; failedCount: number }> {
    await this.ensureTenantExists(tenantId);
    const now = new Date();
    const nowIso = now.toISOString();
    const due = await this.env.DB.prepare(
      `SELECT id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode,
              next_run, last_run, last_result, status, created_at
       FROM scheduled_tasks
       WHERE tenant_id = ?1
         AND status = 'active'
         AND next_run IS NOT NULL
         AND next_run <= ?2
       ORDER BY next_run ASC
       LIMIT 100`,
    )
      .bind(tenantId, nowIso)
      .all<{
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
      }>();

    let enqueuedCount = 0;
    let failedCount = 0;
    for (const task of due.results) {
      let nextRun: string | null = null;
      let nextStatus: TaskStatus = 'active';
      try {
        if (task.schedule_type !== 'once') {
          nextRun = this.computeNextRun(
            task.schedule_type,
            task.schedule_value,
            now,
          );
        } else {
          nextStatus = 'completed';
        }

        const event = await this.createSyntheticTaskEvent({
          tenantId,
          taskId: task.id,
          chatJid: task.chat_jid,
          prompt: task.prompt,
          reason,
        });
        const runJob = await this.enqueueFromEvent(event);
        await this.env.DB.prepare(
          `UPDATE scheduled_tasks
           SET last_run = ?1, next_run = ?2, status = ?3, last_result = ?4
           WHERE tenant_id = ?5 AND id = ?6`,
        )
          .bind(
            nowIso,
            nextRun,
            nextStatus,
            `Scheduled run enqueued: ${runJob.runId}`,
            tenantId,
            task.id,
          )
          .run();
        enqueuedCount += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failedCount += 1;
        try {
          if (task.schedule_type !== 'once') {
            nextRun = this.computeNextRun(
              task.schedule_type,
              task.schedule_value,
              now,
            );
          } else {
            nextStatus = 'completed';
          }
        } catch {
          // Keep current next_run if we cannot parse schedule during failure handling.
          nextRun = task.next_run;
        }
        await this.env.DB.prepare(
          `UPDATE scheduled_tasks
           SET last_run = ?1, next_run = ?2, status = ?3, last_result = ?4
           WHERE tenant_id = ?5 AND id = ?6`,
        )
          .bind(
            nowIso,
            nextRun,
            nextStatus,
            `Scheduled enqueue failed: ${message}`,
            tenantId,
            task.id,
          )
          .run();
      }
    }

    await this.refreshAlarmForTenant(tenantId);
    return {
      dueCount: due.results.length,
      enqueuedCount,
      failedCount,
    };
  }

  private async handleRunStatusUpdate(body: {
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
  }): Promise<Response> {
    const terminalStatus = body.status === 'completed' || body.status === 'failed';

    const result = await this.env.DB.prepare(
      `UPDATE agent_run_jobs
       SET status = ?1,
           last_error = CASE WHEN ?1 = 'failed' THEN COALESCE(?2, last_error) ELSE last_error END,
           attempt_count = CASE
             WHEN ?1 = 'processing' THEN attempt_count + 1
             ELSE attempt_count
           END,
           started_at = CASE
             WHEN ?1 = 'processing' AND started_at IS NULL THEN ?3
             ELSE started_at
           END,
           finished_at = CASE
             WHEN ?4 = 1 THEN ?3
             ELSE finished_at
           END,
           updated_at = ?3
       WHERE tenant_id = ?5 AND run_id = ?6`,
    )
      .bind(
        body.status,
        body.detail ?? null,
        body.processedAt,
        terminalStatus ? 1 : 0,
        body.tenantId,
        body.runId,
      )
      .run();

    if ((result.meta.changes ?? 0) === 0) {
      return json({ ok: false, error: 'Run not found' }, 404);
    }

    if (body.status === 'completed') {
      await this.env.DB.prepare(
        `INSERT INTO agent_run_results (
           tenant_id, run_id, output_text, output_json, model,
           usage_input_tokens, usage_output_tokens, usage_cached_input_tokens,
           runtime_ms, completed_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
         ON CONFLICT(tenant_id, run_id) DO UPDATE SET
           output_text = excluded.output_text,
           output_json = excluded.output_json,
           model = excluded.model,
           usage_input_tokens = excluded.usage_input_tokens,
           usage_output_tokens = excluded.usage_output_tokens,
           usage_cached_input_tokens = excluded.usage_cached_input_tokens,
           runtime_ms = excluded.runtime_ms,
           completed_at = excluded.completed_at,
           updated_at = excluded.updated_at`,
      )
        .bind(
          body.tenantId,
          body.runId,
          body.outputText ?? null,
          body.output === undefined ? null : JSON.stringify(body.output),
          body.model ?? null,
          body.usageInputTokens ?? null,
          body.usageOutputTokens ?? null,
          body.usageCachedInputTokens ?? null,
          body.runtimeMs ?? null,
          body.processedAt,
        )
        .run();
    }

    return json({
      ok: true,
      runId: body.runId,
      tenantId: body.tenantId,
      status: body.status,
    });
  }

  private async handleInboundEvent(
    event: CanonicalInboundEvent,
  ): Promise<Response> {
    await this.rememberTenantId(event.tenantId);
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

    let runId: string | undefined;
    try {
      const runJob = await this.enqueueFromEvent(event);
      runId = runJob.runId;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof EnqueueRunError) {
        runId = err.runId;
      }

      return json(
        {
          ok: false,
          duplicate: false,
          eventId: event.eventId,
          tenantId: event.tenantId,
          runId,
          message: 'Failed to enqueue agent run',
          error: message,
        },
        500,
      );
    }

    const response: TenantOrchestratorResponse = {
      ok: true,
      duplicate: false,
      eventId: event.eventId,
      tenantId: event.tenantId,
      message: 'Event accepted',
      runId,
    };

    return json(response, 202);
  }
}

