import { D1Database } from '../../cf-types.js';

export interface SqlRunResult {
  success: boolean;
  changes?: number;
  lastRowId?: number;
}

export interface SqlClient {
  one<T>(sql: string, params?: unknown[]): Promise<T | null>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<SqlRunResult>;
  transaction<T>(fn: (client: SqlClient) => Promise<T>): Promise<T>;
}

class D1SqlClient implements SqlClient {
  constructor(private readonly db: D1Database) {}

  async one<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    return this.db.prepare(sql).bind(...params).first<T>();
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.db.prepare(sql).bind(...params).all<T>();
    return result.results ?? [];
  }

  async run(sql: string, params: unknown[] = []): Promise<SqlRunResult> {
    const result = await this.db.prepare(sql).bind(...params).run();
    return {
      success: result.success,
      changes: result.meta?.changes,
      lastRowId: result.meta?.last_row_id,
    };
  }

  async transaction<T>(fn: (client: SqlClient) => Promise<T>): Promise<T> {
    await this.db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const output = await fn(this);
      await this.db.exec('COMMIT');
      return output;
    } catch (error) {
      await this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

export function createD1SqlClient(db: D1Database): SqlClient {
  return new D1SqlClient(db);
}
