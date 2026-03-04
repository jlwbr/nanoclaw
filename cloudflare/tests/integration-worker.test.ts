import { describe, expect, it, vi } from 'vitest';

import worker from '../src/index.js';
import { TenantOrchestratorDurableObject } from '../src/durable-objects/tenant-orchestrator.js';
import { createPlatform } from '../src/factory.js';
import { hmacSha256Hex } from '../src/utils.js';
import { MemoryDurableObjectState } from './helpers/do-state.js';
import { createBaseEnv } from './helpers/sqlite-d1.js';

describe('worker integration flow', () => {
  it('runs webhook -> DO -> queue -> runtime -> D1 end-to-end', async () => {
    const env = createBaseEnv();

    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/entitlements/check')) {
        return new Response(
          JSON.stringify({
            allowed: true,
            reason: 'ok',
            cached_until: new Date(Date.now() + 60_000).toISOString(),
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/usage-events')) {
        return new Response(
          JSON.stringify({ id: 'usage_evt_1', accepted: true }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const platform = createPlatform(env);
    const now = new Date().toISOString();
    await platform.repos.tenants.upsert({
      tenantId: 'tenant_demo',
      displayName: 'Demo',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      autumnCustomerId: 'cust_demo',
    });

    const doState = new MemoryDurableObjectState('tenant_demo');
    const orchestrator = new TenantOrchestratorDurableObject(doState, env);
    env.__doNamespace.register('tenant_demo', {
      fetch: (input, init) =>
        orchestrator.fetch(new Request(String(input), init)),
    });

    const inboundBody = JSON.stringify({
      eventId: 'evt_1',
      tenantId: 'tenant_demo',
      source: 'whatsapp',
      channel: 'whatsapp',
      receivedAt: now,
      payload: {
        sender: '1234',
        senderName: 'User',
        text: 'hello runtime',
        chatId: 'chat_1',
      },
    });
    const signature = await hmacSha256Hex(
      env.INBOUND_WEBHOOK_SECRET ?? '',
      inboundBody,
    );

    const response = await worker.fetch(
      new Request('https://example.com/webhook/inbound', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-nanoclaw-signature': signature,
        },
        body: inboundBody,
      }),
      env,
    );
    expect(response.status).toBe(202);
    expect(env.__agentRunQueue.sent).toHaveLength(1);

    const queuedMessage = env.__agentRunQueue.sent[0].message as Record<string, unknown>;
    const ack = vi.fn();
    const retry = vi.fn();
    await worker.queue(
      {
        queue: 'agent_run',
        messages: [
          {
            id: 'qmsg_1',
            timestamp: new Date(),
            attempts: 1,
            body: queuedMessage,
            ack,
            retry,
          },
        ],
      },
      env,
    );
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledTimes(0);

    const runId = String(queuedMessage.runId);
    const run = await platform.repos.runs.get(runId);
    expect(run?.status).toBe('succeeded');
    expect(run?.resultJson).toContain('runtime:hello runtime');
  });

  it('deduplicates duplicate webhook events', async () => {
    const env = createBaseEnv();
    const platform = createPlatform(env);
    const now = new Date().toISOString();
    await platform.repos.tenants.upsert({
      tenantId: 'tenant_dup',
      displayName: 'Dup',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      autumnCustomerId: 'cust_dup',
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
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
    });
    vi.stubGlobal('fetch', fetchMock);

    const doState = new MemoryDurableObjectState('tenant_dup');
    const orchestrator = new TenantOrchestratorDurableObject(doState, env);
    env.__doNamespace.register('tenant_dup', {
      fetch: (input, init) =>
        orchestrator.fetch(new Request(String(input), init)),
    });

    const body = JSON.stringify({
      eventId: 'evt_dup',
      tenantId: 'tenant_dup',
      source: 'slack',
      channel: 'slack',
      receivedAt: new Date().toISOString(),
      payload: {
        sender: 'u1',
        senderName: 'Alice',
        text: 'hello',
        chatId: 'c1',
      },
    });
    const signature = await hmacSha256Hex(
      env.INBOUND_WEBHOOK_SECRET ?? '',
      body,
    );

    const request = () =>
      worker.fetch(
        new Request('https://example.com/webhook/inbound', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-nanoclaw-signature': signature,
          },
          body,
        }),
        env,
      );

    const first = await request();
    const second = await request();
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(env.__agentRunQueue.sent).toHaveLength(1);
  });
});
