import { describe, expect, it, vi } from 'vitest';

import worker from '../src/index.js';
import { createAutumnBillingAdapter } from '../src/adapters/autumn-billing.js';
import { createD1SqlClient } from '../src/adapters/d1/client.js';
import { createD1Repositories } from '../src/adapters/d1/repositories.js';
import { createPlatform } from '../src/factory.js';
import { createBaseEnv, createSqliteD1FromMigrations } from './helpers/sqlite-d1.js';

describe('failure paths', () => {
  it('rejects invalid inbound webhook signatures deterministically', async () => {
    const env = createBaseEnv();
    const response = await worker.fetch(
      new Request('https://example.com/webhook/inbound', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-nanoclaw-signature': 'bad-signature',
        },
        body: JSON.stringify({
          eventId: 'evt_bad',
          tenantId: 'tenant_bad',
          source: 'x',
          channel: 'x',
          receivedAt: new Date().toISOString(),
          payload: {
            sender: 'u',
            text: 'hello',
            chatId: 'c',
          },
        }),
      }),
      env,
    );
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('retries when runtime returns timeout and marks terminal on exhaustion', async () => {
    const env = createBaseEnv();
    const now = new Date().toISOString();
    const platform = createPlatform({
      ...env,
      AGENT_RUNTIME: {
        async execute(request) {
          return {
            status: 'error',
            runId: request.runId,
            code: 'RUNTIME_TIMEOUT',
            message: 'timed out',
            retriable: true,
            correlation: request.correlation,
            completedAt: now,
          };
        },
        async healthcheck() {
          return { status: 'ok', version: '1.2.0' as const };
        },
      },
    });

    await platform.repos.tenants.upsert({
      tenantId: 'tenant_timeout',
      displayName: 'Timeout',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      autumnCustomerId: 'cust_timeout',
    });
    await platform.repos.runs.create({
      runId: 'run_timeout',
      tenantId: 'tenant_timeout',
      status: 'queued',
      idempotencyKey: 'idem_timeout',
      prompt: 'slow call',
      queuedAt: now,
    });

    const first = await platform.pipelines.handleAgentRun(
      {
        runId: 'run_timeout',
        tenantId: 'tenant_timeout',
        idempotencyKey: 'idem_timeout',
        prompt: 'slow call',
        context: { isScheduledTask: false },
        correlation: {
          requestId: 'req_timeout',
          tenantId: 'tenant_timeout',
        },
        createdAt: now,
      },
      1,
    );
    const terminal = await platform.pipelines.handleAgentRun(
      {
        runId: 'run_timeout',
        tenantId: 'tenant_timeout',
        idempotencyKey: 'idem_timeout',
        prompt: 'slow call',
        context: { isScheduledTask: false },
        correlation: {
          requestId: 'req_timeout',
          tenantId: 'tenant_timeout',
        },
        createdAt: now,
      },
      6,
    );

    expect(first.action).toBe('retry');
    expect(terminal.action).toBe('ack');
    const run = await platform.repos.runs.get('run_timeout');
    expect(run?.status).toBe('timed_out');
  });

  it('returns retryable billing failure on Autumn transient outage', async () => {
    const env = createBaseEnv();
    const db = createSqliteD1FromMigrations();
    const repos = createD1Repositories(createD1SqlClient(db));
    const adapter = createAutumnBillingAdapter(
      {
        ...env,
        DB: db,
      },
      repos,
    );
    const now = new Date().toISOString();
    await repos.tenants.upsert({
      tenantId: 'tenant_bill',
      displayName: 'Billing',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      autumnCustomerId: 'cust_bill',
    });
    await repos.runs.create({
      runId: 'run_bill',
      tenantId: 'tenant_bill',
      status: 'queued',
      idempotencyKey: 'idem_bill',
      prompt: 'billing test',
      queuedAt: now,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream unavailable', { status: 503 })),
    );

    const result = await adapter.reportUsage({
      tenantId: 'tenant_bill',
      runId: 'run_bill',
      metric: 'input_tokens',
      quantity: 3,
      idempotencyKey: 'run_bill:input_tokens',
      occurredAt: now,
      correlation: {
        requestId: 'req_bill',
        tenantId: 'tenant_bill',
      },
    });
    expect(result.accepted).toBe(false);
    expect(result.retryable).toBe(true);
  });
});
