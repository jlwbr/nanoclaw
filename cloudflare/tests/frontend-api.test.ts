import { describe, expect, it, vi } from 'vitest';

import worker from '../src/index.js';
import { createPlatform } from '../src/factory.js';
import { createBaseEnv } from './helpers/sqlite-d1.js';

describe('frontend + api integration', () => {
  it('serves minimal hosted frontend shell', async () => {
    const env = createBaseEnv();
    const page = await worker.fetch(new Request('https://example.com/'), env);
    const appJs = await worker.fetch(new Request('https://example.com/app.js'), env);

    expect(page.status).toBe(200);
    expect(await page.text()).toContain('NanoClaw Hosted');
    expect(appJs.status).toBe(200);
    expect(await appJs.text()).toContain('loadDashboard');
  });

  it('supports dashboard + task lifecycle + billing portal flows', async () => {
    const env = createBaseEnv();
    const now = new Date().toISOString();
    const platform = createPlatform(env);
    await platform.repos.tenants.upsert({
      tenantId: 'tenant_ui',
      displayName: 'Tenant UI',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      autumnCustomerId: 'cust_ui',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
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

    const createTaskResponse = await worker.fetch(
      new Request('https://example.com/api/tenants/tenant_ui/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Generate morning summary',
          scheduleType: 'once',
          scheduleValue: new Date(Date.now() + 30_000).toISOString(),
        }),
      }),
      env,
    );
    expect(createTaskResponse.status).toBe(201);
    const created = await createTaskResponse.json();
    const taskId = created.createdTaskId as string;
    expect(taskId).toMatch(/^task_/);

    const dashboard = await worker.fetch(
      new Request('https://example.com/api/tenants/tenant_ui/dashboard'),
      env,
    );
    expect(dashboard.status).toBe(200);
    const dashboardJson = await dashboard.json();
    expect(dashboardJson.taskSummary.total).toBeGreaterThanOrEqual(1);

    const pause = await worker.fetch(
      new Request(
        `https://example.com/api/tenants/tenant_ui/tasks/${taskId}/pause`,
        {
          method: 'POST',
        },
      ),
      env,
    );
    expect(pause.status).toBe(200);

    const runNow = await worker.fetch(
      new Request(
        `https://example.com/api/tenants/tenant_ui/tasks/${taskId}/run_now`,
        {
          method: 'POST',
        },
      ),
      env,
    );
    expect(runNow.status).toBe(200);
    const runNowJson = await runNow.json();
    expect(runNowJson.runId).toMatch(/^run_/);

    const summary = await worker.fetch(
      new Request('https://example.com/api/tenants/tenant_ui/billing/summary'),
      env,
    );
    expect(summary.status).toBe(200);
    const summaryJson = await summary.json();
    expect(summaryJson.subscription.status).toBe('active');

    const portal = await worker.fetch(
      new Request(
        'https://example.com/api/tenants/tenant_ui/billing/portal-session',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ returnUrl: 'https://example.com/' }),
        },
      ),
      env,
    );
    expect(portal.status).toBe(200);
    const portalJson = await portal.json();
    expect(portalJson.url).toContain('/portal/');
  });
});
