import { describe, expect, it, vi } from 'vitest';

import { TenantOrchestratorDurableObject } from '../src/durable-objects/tenant-orchestrator.js';
import { createPlatform } from '../src/factory.js';
import { MemoryDurableObjectState } from './helpers/do-state.js';
import { createBaseEnv } from './helpers/sqlite-d1.js';

describe('TenantOrchestratorDurableObject', () => {
  it('enqueues due tasks exactly once under repeated alarms', async () => {
    const env = createBaseEnv();
    const now = new Date().toISOString();
    const platform = createPlatform(env);
    await platform.repos.tenants.upsert({
      tenantId: 'tenant_alarm',
      displayName: 'Alarm',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      autumnCustomerId: 'cust_alarm',
    });
    await platform.repos.tasks.create({
      taskId: 'task_alarm',
      tenantId: 'tenant_alarm',
      prompt: 'Ping',
      scheduleType: 'once',
      scheduleValue: now,
      nextRunAt: now,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/entitlements/check')) {
          return new Response(
            JSON.stringify({
              allowed: true,
              reason: 'ok',
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch call: ${url}`);
      }),
    );

    const state = new MemoryDurableObjectState('tenant_alarm');
    await state.storage.put('tenantId', 'tenant_alarm');
    const orchestrator = new TenantOrchestratorDurableObject(state, env);

    await orchestrator.alarm();
    await orchestrator.alarm();

    expect(env.__agentRunQueue.sent).toHaveLength(1);
  });
});
