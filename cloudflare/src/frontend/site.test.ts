import { describe, expect, it } from 'vitest';

import {
  buildSetupGuide,
  createTenantId,
  getPlanById,
  parsePurchasePayload,
} from './site';

describe('parsePurchasePayload', () => {
  it('accepts a valid payload and normalizes channels', () => {
    const result = parsePurchasePayload({
      fullName: 'Ada Lovelace',
      email: 'ADA@EXAMPLE.COM',
      company: 'Analytical Engines',
      planId: 'growth',
      assistantName: 'Andy',
      channels: ['slack', 'discord', 'slack', 'unknown'],
      timezone: 'America/New_York',
      useCase: 'Automate triage and standups',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.email).toBe('ada@example.com');
    expect(result.value.channels).toEqual(['slack', 'discord']);
  });

  it('rejects invalid emails', () => {
    const result = parsePurchasePayload({
      fullName: 'Ada Lovelace',
      email: 'not-an-email',
      company: 'Analytical Engines',
      planId: 'growth',
      assistantName: 'Andy',
      channels: ['slack'],
      timezone: 'UTC',
      useCase: 'Automate triage',
    });

    expect(result).toEqual({ ok: false, error: 'Email address is invalid' });
  });

  it('requires at least one channel', () => {
    const result = parsePurchasePayload({
      fullName: 'Ada Lovelace',
      email: 'ada@example.com',
      company: 'Analytical Engines',
      planId: 'growth',
      assistantName: 'Andy',
      channels: [],
      timezone: 'UTC',
      useCase: 'Automate triage',
    });

    expect(result).toEqual({
      ok: false,
      error: 'Select at least one channel for your agent',
    });
  });
});

describe('createTenantId', () => {
  it('creates tenant IDs with a deterministic slug prefix', () => {
    const tenantId = createTenantId({
      company: 'Acme Robotics',
      email: 'ops@acme.example',
    });

    expect(tenantId).toMatch(/^acme-robotics-[0-9a-f]{8}$/);
  });
});

describe('buildSetupGuide', () => {
  it('creates setup commands wired to the tenant and channel', () => {
    const plan = getPlanById('starter');
    expect(plan).toBeDefined();
    if (!plan) return;

    const guide = buildSetupGuide({
      origin: 'https://example.com/',
      tenantId: 'tenant-demo-1234',
      assistantName: 'Nova',
      channels: ['telegram', 'slack'],
      timezone: 'UTC',
      plan,
    });

    expect(guide.quickstartCommand).toContain('/tenants/tenant-demo-1234/tasks');
    expect(guide.sampleWebhookCommand).toContain('/webhooks/telegram');
    expect(guide.steps[0]).toContain('Starter');
  });
});
