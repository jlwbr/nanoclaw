import { describe, expect, it, vi } from 'vitest';

import worker from '../src/index.js';
import { createBaseEnv } from './helpers/sqlite-d1.js';

describe('setup flow api integration', () => {
  it('returns setup frontend asset guidance when ASSETS binding is missing', async () => {
    const env = createBaseEnv();
    const page = await worker.fetch(new Request('https://example.com/'), env);

    expect(page.status).toBe(200);
    const body = await page.json();
    expect(body.status).toBe('frontend_not_configured');
  });

  it('supports setup tenant -> starter task -> billing -> finish flow', async () => {
    const env = createBaseEnv();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/customers')) {
          return new Response(
            JSON.stringify({
              id: 'cust_ui',
              email: 'ops@tenant-ui.example',
              external_id: 'tenant_ui_ext',
            }),
            { status: 200 },
          );
        }
        if (url.endsWith('/entitlements/check')) {
          return new Response(
            JSON.stringify({ allowed: true, reason: 'ok' }),
            { status: 200 },
          );
        }
        if (url.endsWith('/customers/cust_ui/subscription')) {
          return new Response(
            JSON.stringify({
              subscription_id: 'sub_ui',
              status: 'active',
              plan_id: 'starter',
              current_period_end: '2026-04-10T00:00:00.000Z',
            }),
            { status: 200 },
          );
        }
        if (url.endsWith('/portal/sessions')) {
          return new Response(
            JSON.stringify({
              url: 'https://billing.autumn.example/portal/session_1',
              expires_at: '2026-04-01T00:00:00.000Z',
            }),
            { status: 200 },
          );
        }
        if (url.endsWith('/usage-events')) {
          return new Response(
            JSON.stringify({ id: 'usage_evt', accepted: true }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch call: ${url}`);
      }),
    );

    const setupTenantResponse = await worker.fetch(
      new Request('https://example.com/api/setup/tenant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenantId: 'tenant_ui',
          displayName: 'Tenant UI',
          email: 'ops@tenant-ui.example',
          externalRef: 'tenant_ui_ext',
        }),
      }),
      env,
    );
    expect(setupTenantResponse.status).toBe(200);
    const setupTenant = await setupTenantResponse.json();
    expect(setupTenant.tenant.tenantId).toBe('tenant_ui');
    expect(setupTenant.customer.providerCustomerId).toBe('cust_ui');

    const createTaskResponse = await worker.fetch(
      new Request('https://example.com/api/setup/starter-task', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenantId: 'tenant_ui',
          prompt: 'Generate morning summary',
          scheduleType: 'once',
          scheduleValue: new Date(Date.now() + 30_000).toISOString(),
        }),
      }),
      env,
    );
    expect(createTaskResponse.status).toBe(201);
    const created = await createTaskResponse.json();
    const taskId = created.taskId as string;
    expect(taskId).toMatch(/^task_/);

    const billingConnectResponse = await worker.fetch(
      new Request('https://example.com/api/setup/billing/customer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenantId: 'tenant_ui',
          email: 'ops@tenant-ui.example',
        }),
      }),
      env,
    );
    expect(billingConnectResponse.status).toBe(200);
    const billingConnectJson = await billingConnectResponse.json();
    expect(billingConnectJson.customer.providerCustomerId).toBe('cust_ui');
    expect(billingConnectJson.subscription.status).toBe('active');

    const status = await worker.fetch(
      new Request(
        'https://example.com/api/setup/status?tenantId=tenant_ui',
      ),
      env,
    );
    expect(status.status).toBe(200);
    const statusJson = await status.json();
    expect(statusJson.setup.hasStarterTask).toBe(true);
    expect(statusJson.webhook.ingestUrl).toContain('/webhook/inbound');

    const portal = await worker.fetch(
      new Request(
        'https://example.com/api/tenants/tenant_ui/billing/portal-session',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ returnUrl: 'https://example.com/setup' }),
        },
      ),
      env,
    );
    expect(portal.status).toBe(200);
    const portalJson = await portal.json();
    expect(portalJson.url).toContain('/portal/');

    const finish = await worker.fetch(
      new Request('https://example.com/api/setup/finish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId: 'tenant_ui' }),
      }),
      env,
    );
    expect(finish.status).toBe(200);
    const finishJson = await finish.json();
    expect(finishJson.ready).toBe(true);

    const tasks = await worker.fetch(
      new Request('https://example.com/api/tenants/tenant_ui/tasks'),
      env,
    );
    expect(tasks.status).toBe(200);
    const tasksJson = await tasks.json();
    expect(tasksJson.tasks[0].taskId).toBe(taskId);
  });
});
