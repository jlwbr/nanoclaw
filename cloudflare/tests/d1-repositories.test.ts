import { describe, expect, it } from 'vitest';

import { createD1SqlClient } from '../src/adapters/d1/client.js';
import { createD1Repositories } from '../src/adapters/d1/repositories.js';
import { createSqliteD1FromMigrations } from './helpers/sqlite-d1.js';

describe('D1 repositories', () => {
  it('deduplicates inbound event ingest', async () => {
    const db = createSqliteD1FromMigrations();
    const repos = createD1Repositories(createD1SqlClient(db));
    const now = new Date().toISOString();

    const first = await repos.inboundEvents.record({
      tenantId: 'tenant_a',
      eventId: 'evt_1',
      payloadJson: '{"hello":"world"}',
      receivedAt: now,
    });
    const second = await repos.inboundEvents.record({
      tenantId: 'tenant_a',
      eventId: 'evt_1',
      payloadJson: '{"hello":"world"}',
      receivedAt: now,
    });

    expect(first).toBe('inserted');
    expect(second).toBe('duplicate');
  });

  it('stores and resolves run by idempotency key', async () => {
    const db = createSqliteD1FromMigrations();
    const repos = createD1Repositories(createD1SqlClient(db));
    const now = new Date().toISOString();

    await repos.tenants.upsert({
      tenantId: 'tenant_a',
      displayName: 'Tenant A',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    await repos.runs.create({
      runId: 'run_1',
      tenantId: 'tenant_a',
      status: 'queued',
      idempotencyKey: 'idem_1',
      prompt: 'hello',
      queuedAt: now,
    });

    const found = await repos.runs.getByIdempotencyKey('idem_1');
    expect(found?.runId).toBe('run_1');
    expect(found?.status).toBe('queued');
  });
});
