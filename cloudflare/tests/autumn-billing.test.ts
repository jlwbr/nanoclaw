import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAutumnBillingAdapter } from '../src/adapters/autumn-billing.js';
import { createD1SqlClient } from '../src/adapters/d1/client.js';
import { createD1Repositories } from '../src/adapters/d1/repositories.js';
import { hmacSha256Hex } from '../src/utils.js';
import { createBaseEnv, createSqliteD1FromMigrations } from './helpers/sqlite-d1.js';

describe('AutumnBillingAdapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('syncs customer and subscription from Autumn', async () => {
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
      tenantId: 'tenant_sync',
      displayName: 'Tenant Sync',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/customers')) {
        return new Response(
          JSON.stringify({
            id: 'cust_123',
            email: 'ops@example.com',
            external_id: 'tenant_sync',
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/customers/cust_123/subscription')) {
        return new Response(
          JSON.stringify({
            subscription_id: 'sub_123',
            status: 'active',
            plan_id: 'pro',
            current_period_end: '2026-04-01T00:00:00.000Z',
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected Autumn API call: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const customer = await adapter.ensureCustomer('tenant_sync', {
      externalRef: 'tenant_sync',
      email: 'ops@example.com',
    });
    const subscription = await adapter.fetchSubscriptionStatus('tenant_sync');

    expect(customer.providerCustomerId).toBe('cust_123');
    expect(subscription.subscriptionRef).toBe('sub_123');
    expect(subscription.status).toBe('active');
  });

  it('reports usage idempotently with stable report keys', async () => {
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
      tenantId: 'tenant_usage',
      displayName: 'Tenant Usage',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      autumnCustomerId: 'cust_usage',
    });
    await repos.runs.create({
      runId: 'run_1',
      tenantId: 'tenant_usage',
      status: 'queued',
      idempotencyKey: 'idem_usage_run',
      prompt: 'usage test',
      queuedAt: now,
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/usage-events')) {
        return new Response(
          JSON.stringify({
            id: 'usage_evt_1',
            accepted: true,
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected Autumn API call: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const input = {
      tenantId: 'tenant_usage',
      runId: 'run_1',
      metric: 'input_tokens',
      quantity: 123,
      idempotencyKey: 'run_1:input_tokens',
      occurredAt: now,
      correlation: {
        requestId: 'req_1',
        tenantId: 'tenant_usage',
        runId: 'run_1',
      },
    } as const;

    const first = await adapter.reportUsage(input);
    const second = await adapter.reportUsage(input);

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    expect(second.message).toBe('already_reported');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('validates Autumn webhook signatures', async () => {
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

    const payload = JSON.stringify({
      id: 'evt_webhook_1',
      type: 'subscription.updated',
      metadata: { tenant_id: 'tenant_webhook' },
      subscription_id: 'sub_9',
    });
    const signature = await hmacSha256Hex(
      env.AUTUMN_WEBHOOK_SECRET ?? '',
      payload,
    );

    const headers = new Headers({
      'x-autumn-signature': signature,
    });
    const parsed = await adapter.verifyAndParseWebhook(headers, payload);
    expect(parsed.id).toBe('evt_webhook_1');
  });
});
