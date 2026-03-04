import {
  AgentRunRequest,
  AgentRunRequestSchema,
  AgentRunResult,
  OutboundDeliveryRequest,
  OutboundDeliveryRequestSchema,
  parseContract,
} from '../contracts.js';
import { log } from '../logging.js';
import { incrementCounter, recordTiming } from '../metrics.js';
import { BillingPort } from '../ports/billing.js';
import { PlatformRepositories } from '../ports/database.js';
import {
  computeRetryDelaySeconds,
  QueuePort,
  QueueRetryPolicy,
} from '../ports/queue.js';
import { RuntimePort } from '../ports/runtime.js';
import { ArtifactStoragePort } from '../ports/storage.js';
import { OutboundTransportPort } from '../ports/outbound.js';
import { createId, stableNowIso } from '../utils.js';

export interface QueueHandlerOutcome {
  action: 'ack' | 'retry';
  delaySeconds?: number;
}

interface QueuePipelineDeps {
  repos: PlatformRepositories;
  runtime: RuntimePort;
  billing: BillingPort;
  queue: QueuePort;
  artifacts: ArtifactStoragePort;
  outboundTransport: OutboundTransportPort;
  retryPolicy: QueueRetryPolicy;
  outboundMaxAttempts: number;
}

export class QueuePipelineService {
  constructor(private readonly deps: QueuePipelineDeps) {}

  async handleAgentRun(
    body: unknown,
    attempts: number,
  ): Promise<QueueHandlerOutcome> {
    const request = parseContract(AgentRunRequestSchema, body, 'AgentRunRequest');
    const run = await this.deps.repos.runs.get(request.runId);
    if (!run) {
      incrementCounter('agent_run_missing', { tenantId: request.tenantId });
      log({
        event: 'queue.agent_run.missing',
        level: 'warn',
        message: 'Run record not found; acknowledging message',
        correlation: request.correlation,
      });
      return { action: 'ack' };
    }
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'timed_out') {
      incrementCounter('agent_run_duplicate_terminal', { tenantId: request.tenantId });
      return { action: 'ack' };
    }

    const startedAt = stableNowIso();
    await this.deps.repos.runs.markRunning(run.runId, startedAt);
    const startedMs = Date.now();

    try {
      const result = await this.deps.runtime.execute(request);
      return this.completeRun(request, result, startedMs);
    } catch (error) {
      const runtimeMs = Date.now() - startedMs;
      recordTiming('agent_run_runtime_ms', runtimeMs, {
        tenantId: request.tenantId,
        outcome: 'error',
      });
      const errorMessage = error instanceof Error ? error.message : String(error);
      const code = 'RUNTIME_EXECUTION_FAILED';
      await this.deps.repos.runs.markFailed(run.runId, {
        finishedAt: stableNowIso(),
        errorCode: code,
        errorMessage,
        runtimeMs,
      });

      const shouldRetry = attempts < this.deps.retryPolicy.maxAttempts;
      if (shouldRetry) {
        incrementCounter('agent_run_retry_scheduled', { tenantId: request.tenantId });
        const delay = computeRetryDelaySeconds(attempts, this.deps.retryPolicy);
        return {
          action: 'retry',
          delaySeconds: delay,
        };
      }
      return { action: 'ack' };
    }
  }

  async handleOutboundDelivery(
    body: unknown,
    attempts: number,
  ): Promise<QueueHandlerOutcome> {
    const wrapper =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
    const payload =
      wrapper && wrapper.kind === 'outbound_delivery' ? wrapper.payload : body;
    const request = parseContract(
      OutboundDeliveryRequestSchema,
      payload,
      'OutboundDeliveryRequest',
    );

    const delivery = await this.deps.repos.outbound.get(request.deliveryId);
    if (!delivery) {
      return { action: 'ack' };
    }
    if (delivery.status === 'delivered' || delivery.status === 'dead_letter') {
      incrementCounter('outbound_terminal_skip', { tenantId: request.tenantId });
      return { action: 'ack' };
    }

    const outcome = await this.deps.outboundTransport.deliver(request);
    if (outcome.ok) {
      incrementCounter('outbound_delivered', { tenantId: request.tenantId });
      await this.deps.repos.outbound.updateState(request.deliveryId, {
        status: 'delivered',
        attemptCount: attempts,
        updatedAt: stableNowIso(),
      });
      return { action: 'ack' };
    }

    const shouldRetry =
      outcome.retryable && attempts < Math.min(this.deps.retryPolicy.maxAttempts, this.deps.outboundMaxAttempts);
    if (shouldRetry) {
      incrementCounter('outbound_retry_scheduled', { tenantId: request.tenantId });
      const delaySeconds = computeRetryDelaySeconds(attempts, this.deps.retryPolicy);
      await this.deps.repos.outbound.updateState(request.deliveryId, {
        status: 'retrying',
        attemptCount: attempts,
        nextAttemptAt: new Date(Date.now() + delaySeconds * 1000).toISOString(),
        lastError: outcome.error ?? 'delivery_failed',
        updatedAt: stableNowIso(),
      });
      return { action: 'retry', delaySeconds };
    }

    incrementCounter('outbound_dead_letter', { tenantId: request.tenantId });
    await this.deps.repos.outbound.updateState(request.deliveryId, {
      status: 'dead_letter',
      attemptCount: attempts,
      lastError: outcome.error ?? 'delivery_failed',
      updatedAt: stableNowIso(),
    });
    await this.deps.repos.outbound.addDeadLetter(
      request.deliveryId,
      request.tenantId,
      outcome.error ?? 'delivery_failed',
      JSON.stringify(request),
      stableNowIso(),
    );
    return { action: 'ack' };
  }

  private async completeRun(
    request: AgentRunRequest,
    result: AgentRunResult,
    startedMs: number,
  ): Promise<QueueHandlerOutcome> {
    const runtimeMs = Date.now() - startedMs;
    if (result.status === 'error') {
      incrementCounter('agent_run_failed', {
        tenantId: request.tenantId,
        code: result.code,
      });
      recordTiming('agent_run_runtime_ms', runtimeMs, {
        tenantId: request.tenantId,
        outcome: 'failed',
      });
      await this.deps.repos.runs.markFailed(request.runId, {
        finishedAt: result.completedAt,
        errorCode: result.code,
        errorMessage: result.message,
        runtimeMs,
      });
      if (result.retriable) {
        return { action: 'retry', delaySeconds: this.deps.retryPolicy.baseDelaySeconds };
      }
      return { action: 'ack' };
    }

    const artifacts = [];
    for (const artifact of result.artifacts) {
      const stored = await this.deps.artifacts.put({
        tenantId: request.tenantId,
        runId: request.runId,
        artifactId: artifact.artifactId,
        contentType: artifact.contentType,
        body: `artifact:${artifact.artifactId}`,
      });
      artifacts.push(stored);
    }

    await this.deps.repos.runs.markSucceeded(request.runId, {
      finishedAt: result.completedAt,
      resultJson: JSON.stringify({
        outputText: result.outputText,
        artifacts,
      }),
      usageInputTokens: result.usage.inputTokens,
      usageOutputTokens: result.usage.outputTokens,
      runtimeMs: result.usage.runtimeMs || runtimeMs,
    });

    await this.recordUsageAndReport(request, result, runtimeMs);
    incrementCounter('agent_run_succeeded', { tenantId: request.tenantId });
    recordTiming('agent_run_runtime_ms', runtimeMs, {
      tenantId: request.tenantId,
      outcome: 'ok',
    });

    if (result.outputText.trim().length > 0) {
      const deliveryId = createId('delivery');
      const now = stableNowIso();
      const payloadJson = JSON.stringify({ text: result.outputText });
      await this.deps.repos.outbound.create({
        deliveryId,
        tenantId: request.tenantId,
        runId: request.runId,
        channel: 'hosted-ui',
        target: request.tenantId,
        payloadJson,
        status: 'pending',
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      await this.deps.queue.enqueueOutboundDelivery({
        deliveryId,
        tenantId: request.tenantId,
        runId: request.runId,
        channel: 'hosted-ui',
        target: request.tenantId,
        payload: {
          text: result.outputText,
          metadata: {},
        },
        attempt: 1,
        correlation: {
          requestId: request.correlation.requestId,
          tenantId: request.tenantId,
          runId: request.runId,
          deliveryId,
          eventId: request.correlation.eventId,
        },
      });
    }

    return { action: 'ack' };
  }

  private async recordUsageAndReport(
    request: AgentRunRequest,
    result: Extract<AgentRunResult, { status: 'ok' }>,
    runtimeMs: number,
  ): Promise<void> {
    const usageMetrics = [
      { metric: 'input_tokens', quantity: result.usage.inputTokens },
      { metric: 'output_tokens', quantity: result.usage.outputTokens },
      { metric: 'runtime_ms', quantity: runtimeMs },
      {
        metric: 'usd',
        quantity:
          result.usage.inputTokens * 0.000002 +
          result.usage.outputTokens * 0.000006,
      },
    ];

    for (const metric of usageMetrics) {
      const snapshotId = createId('usage');
      await this.deps.repos.usage.create({
        snapshotId,
        tenantId: request.tenantId,
        runId: request.runId,
        metric: metric.metric,
        quantity: metric.quantity,
        reportedToBilling: false,
        createdAt: stableNowIso(),
      });

      const reportKey = `${request.runId}:${metric.metric}`;
      const reportResult = await this.deps.billing.reportUsage({
        tenantId: request.tenantId,
        runId: request.runId,
        metric: metric.metric,
        quantity: metric.quantity,
        idempotencyKey: reportKey,
        occurredAt: stableNowIso(),
        correlation: {
          requestId: request.correlation.requestId,
          tenantId: request.tenantId,
          runId: request.runId,
          eventId: request.correlation.eventId,
        },
      });
      if (reportResult.accepted) {
        await this.deps.repos.usage.markReported(snapshotId, reportKey);
      } else {
        log({
          event: 'billing.usage.report.failed',
          level: reportResult.retryable ? 'warn' : 'error',
          message: reportResult.message,
          correlation: request.correlation,
          data: {
            reportKey,
            metric: metric.metric,
          },
        });
      }
    }
  }
}
