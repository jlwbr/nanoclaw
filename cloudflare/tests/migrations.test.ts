import { describe, expect, it } from 'vitest';

import { createSqliteD1FromMigrations } from './helpers/sqlite-d1.js';

describe('migrations', () => {
  it('applies schema from empty state and supports key queries', async () => {
    const db = createSqliteD1FromMigrations();

    await db
      .prepare(
        `INSERT INTO tenants (tenant_id, display_name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        'tenant_demo',
        'Demo',
        'active',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      )
      .run();

    await db
      .prepare(
        `INSERT INTO tasks (
          task_id, tenant_id, prompt, schedule_type, schedule_value, next_run_at, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        'task_1',
        'tenant_demo',
        'Run report',
        'once',
        '2026-01-02T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        'active',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      )
      .run();

    const tenant = await db
      .prepare('SELECT tenant_id, display_name FROM tenants WHERE tenant_id = ?')
      .bind('tenant_demo')
      .first<{ tenant_id: string; display_name: string }>();

    expect(tenant?.tenant_id).toBe('tenant_demo');
    expect(tenant?.display_name).toBe('Demo');

    const dueTasks = await db
      .prepare(
        `SELECT task_id FROM tasks WHERE tenant_id = ? AND status = 'active' AND next_run_at <= ?`,
      )
      .bind('tenant_demo', '2026-01-03T00:00:00.000Z')
      .all<{ task_id: string }>();

    expect(dueTasks.results?.map((row) => row.task_id)).toEqual(['task_1']);
  });
});
