import { describe, expect, it } from 'vitest';

import { QueuePipelineService } from '../src/services/queue-pipelines.js';
import { createPlatform } from '../src/factory.js';
import { createBaseEnv } from './helpers/sqlite-d1.js';

describe('QueuePipelineService outbound retries', () => {
  it('applies retry then dead-letter semantics deterministically', async () => {
    const env = createBaseEnv();
    const now = new Date().toISOString();
    const platform = createPlatform(env);
    await platform.repos.tenants.upsert({
      tenantId: 'tenant_outbound',
      displayName: 'Outbound',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      autumnCustomerId: 'cust_outbound',
    });
    await platform.repos.runs.create({
      runId: 'run_outbound',
      tenantId: 'tenant_outbound',
      status: 'queued',
      idempotencyKey: 'idem_outbound',
      prompt: 'x',
      queuedAt: now,
    });
    await platform.repos.outbound.create({
      deliveryId: 'delivery_outbound',
      tenantId: 'tenant_outbound',
      runId: 'run_outbound',
      channel: 'slack',
      target: 'channel-1',
      payloadJson: JSON.stringify({ text: 'hello' }),
      status: 'pending',
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    const pipeline = new QueuePipelineService({
      repos: platform.repos,
      runtime: platform.runtime,
      billing: platform.billing,
      queue: platform.queue,
      artifacts: platform.artifacts,
      outboundTransport: {
        async deliver() {
          return {
            ok: false,
            retryable: true,
            error: 'transport_down',
          };
        },
      },
      retryPolicy: {
        maxAttempts: 3,
        baseDelaySeconds: 2,
        maxDelaySeconds: 8,
      },
      outboundMaxAttempts: 3,
    });

    const first = await pipeline.handleOutboundDelivery(
      {
        deliveryId: 'delivery_outbound',
        tenantId: 'tenant_outbound',
        runId: 'run_outbound',
        channel: 'slack',
        target: 'channel-1',
        payload: {
          text: 'hello',
          metadata: {},
        },
        attempt: 1,
        correlation: {
          requestId: 'req_1',
          tenantId: 'tenant_outbound',
          deliveryId: 'delivery_outbound',
        },
      },
      1,
    );
    expect(first.action).toBe('retry');
    const retrying = await platform.repos.outbound.get('delivery_outbound');
    expect(retrying?.status).toBe('retrying');

    const terminal = await pipeline.handleOutboundDelivery(
      {
        deliveryId: 'delivery_outbound',
        tenantId: 'tenant_outbound',
        runId: 'run_outbound',
        channel: 'slack',
        target: 'channel-1',
        payload: {
          text: 'hello',
          metadata: {},
        },
        attempt: 3,
        correlation: {
          requestId: 'req_2',
          tenantId: 'tenant_outbound',
          deliveryId: 'delivery_outbound',
        },
      },
      3,
    );
    expect(terminal.action).toBe('ack');
    const dead = await platform.repos.outbound.get('delivery_outbound');
    expect(dead?.status).toBe('dead_letter');
  });
});
