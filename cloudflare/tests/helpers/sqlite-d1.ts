import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import {
  D1Database,
  D1PreparedStatement,
  D1Result,
  R2Bucket,
  R2Object,
  Queue,
  QueueSendOptions,
  DurableObjectId,
  DurableObjectNamespace,
  DurableObjectStub,
} from '../../src/cf-types.js';
import { WorkerEnv } from '../../src/env.js';

class SqlitePreparedStatement implements D1PreparedStatement {
  private params: unknown[] = [];

  constructor(
    private readonly db: Database.Database,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.params = values;
    return this;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.db.prepare(this.query).get(...this.params);
    return (row as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const rows = this.db.prepare(this.query).all(...this.params) as T[];
    return {
      success: true,
      results: rows,
    };
  }

  async run(): Promise<D1Result> {
    const result = this.db.prepare(this.query).run(...this.params);
    return {
      success: true,
      meta: {
        changes: result.changes,
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
}

export class SqliteD1Database implements D1Database {
  constructor(private readonly db: Database.Database) {}

  prepare(query: string): D1PreparedStatement {
    return new SqlitePreparedStatement(this.db, query);
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    const results: D1Result[] = [];
    this.db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      for (const statement of statements) {
        results.push(await statement.run());
      }
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async exec(query: string): Promise<D1Result> {
    this.db.exec(query);
    return { success: true };
  }
}

export function createSqliteD1FromMigrations(): SqliteD1Database {
  const db = new Database(':memory:');
  const migrationPath = path.resolve(
    process.cwd(),
    'cloudflare/migrations/0001_initial.sql',
  );
  const migration = fs.readFileSync(migrationPath, 'utf8');
  db.exec(migration);
  return new SqliteD1Database(db);
}

export class MemoryR2Bucket implements R2Bucket {
  private readonly values = new Map<
    string,
    {
      text: string;
      contentType: string;
      customMetadata: Record<string, string>;
    }
  >();

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string | ReadableStream,
    options?: {
      httpMetadata?: Record<string, string>;
      customMetadata?: Record<string, string>;
    },
  ): Promise<R2Object | null> {
    let text: string;
    if (typeof value === 'string') {
      text = value;
    } else if (value instanceof ArrayBuffer) {
      text = new TextDecoder().decode(value);
    } else if (ArrayBuffer.isView(value)) {
      text = new TextDecoder().decode(value);
    } else {
      text = '[stream]';
    }
    this.values.set(key, {
      text,
      contentType: options?.httpMetadata?.contentType ?? 'text/plain',
      customMetadata: options?.customMetadata ?? {},
    });
    return {
      key,
      size: text.length,
      etag: `etag-${key}`,
      body: {
        text: async () => text,
        arrayBuffer: async () => new TextEncoder().encode(text).buffer,
      },
      customMetadata: options?.customMetadata ?? {},
      httpMetadata: options?.httpMetadata ?? {},
    };
  }

  async get(key: string): Promise<R2Object | null> {
    const entry = this.values.get(key);
    if (!entry) {
      return null;
    }
    return {
      key,
      size: entry.text.length,
      etag: `etag-${key}`,
      body: {
        text: async () => entry.text,
        arrayBuffer: async () => new TextEncoder().encode(entry.text).buffer,
      },
      customMetadata: entry.customMetadata,
      httpMetadata: { contentType: entry.contentType },
    };
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

export class MemoryQueue<T> implements Queue<T> {
  readonly sent: Array<{ message: T; options?: QueueSendOptions }> = [];

  async send(message: T, options?: QueueSendOptions): Promise<void> {
    this.sent.push({ message, options });
  }
}

class StaticDurableObjectId implements DurableObjectId {
  constructor(private readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

class MemoryDurableObjectNamespace implements DurableObjectNamespace {
  private readonly stubs = new Map<string, DurableObjectStub>();

  register(name: string, stub: DurableObjectStub): void {
    this.stubs.set(name, stub);
  }

  idFromName(name: string): DurableObjectId {
    return new StaticDurableObjectId(name);
  }

  get(id: DurableObjectId): DurableObjectStub {
    const stub = this.stubs.get(id.toString());
    if (!stub) {
      throw new Error(`Missing durable object stub for ${id.toString()}`);
    }
    return stub;
  }
}

export function createBaseEnv(): WorkerEnv & {
  __agentRunQueue: MemoryQueue<unknown>;
  __outboundQueue: MemoryQueue<unknown>;
  __doNamespace: MemoryDurableObjectNamespace;
} {
  const db = createSqliteD1FromMigrations();
  const agentRunQueue = new MemoryQueue<unknown>();
  const outboundQueue = new MemoryQueue<unknown>();
  const doNamespace = new MemoryDurableObjectNamespace();

  const env: WorkerEnv & {
    __agentRunQueue: MemoryQueue<unknown>;
    __outboundQueue: MemoryQueue<unknown>;
    __doNamespace: MemoryDurableObjectNamespace;
  } = {
    DB: db,
    ARTIFACTS: new MemoryR2Bucket(),
    TENANT_ORCHESTRATOR: doNamespace,
    AGENT_RUN_QUEUE: agentRunQueue as Queue<any>,
    OUTBOUND_DELIVERY_QUEUE: outboundQueue as Queue<any>,
    AGENT_RUNTIME_MODE: 'service',
    AGENT_RUNTIME: {
      async execute(request) {
        return {
          status: 'ok',
          runId: request.runId,
          outputText: `runtime:${request.prompt}`,
          artifacts: [],
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            runtimeMs: 100,
          },
          correlation: request.correlation,
          completedAt: new Date().toISOString(),
        };
      },
      async healthcheck() {
        return {
          status: 'ok',
          version: '1.2.0',
        };
      },
    },
    AGENT_RUNTIME_HTTP_URL: 'http://localhost:8787',
    APP_VERSION: '0.1.0',
    RUNTIME_MIN_VERSION: '1.0.0',
    AUTUMN_API_KEY: 'test-autumn',
    AUTUMN_BASE_URL: 'https://autumn.example.test',
    AUTUMN_WEBHOOK_SECRET: 'autumn-webhook-secret',
    AUTUMN_PRODUCT_ID: 'nanoclaw-hosted',
    INBOUND_WEBHOOK_SECRET: 'inbound-secret',
    OUTBOUND_MAX_ATTEMPTS: '5',
    CIRCUIT_BREAKER_WINDOW_SIZE: '5',
    CIRCUIT_BREAKER_ERROR_THRESHOLD: '0.5',
    __agentRunQueue: agentRunQueue,
    __outboundQueue: outboundQueue,
    __doNamespace: doNamespace,
  };
  return env;
}
