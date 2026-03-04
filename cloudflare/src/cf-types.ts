export interface D1RunMeta {
  changes?: number;
  last_row_id?: number;
}

export interface D1Result<T = Record<string, unknown>> {
  success: boolean;
  meta?: D1RunMeta;
  results?: T[];
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
  exec(query: string): Promise<D1Result>;
}

export interface R2Body {
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2Object {
  key: string;
  size: number;
  etag: string;
  httpEtag?: string;
  uploaded?: Date;
  httpMetadata?: Record<string, string>;
  customMetadata?: Record<string, string>;
  body?: R2Body;
}

export interface R2Bucket {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string | ReadableStream,
    options?: {
      httpMetadata?: Record<string, string>;
      customMetadata?: Record<string, string>;
    },
  ): Promise<R2Object | null>;
  get(key: string): Promise<R2Object | null>;
  delete(key: string): Promise<void>;
}

export interface DurableObjectId {
  toString(): string;
}

export interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  getAlarm(): Promise<number | null>;
}

export interface DurableObjectState {
  readonly id: DurableObjectId;
  readonly storage: DurableObjectStorage;
  waitUntil(promise: Promise<unknown>): void;
}

export interface DurableObjectStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface QueueSendOptions {
  contentType?: string;
  delaySeconds?: number;
}

export interface Queue<T = unknown> {
  send(message: T, options?: QueueSendOptions): Promise<void>;
}

export interface QueueMessage<T = unknown> {
  id: string;
  timestamp: Date;
  attempts: number;
  body: T;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface MessageBatch<T = unknown> {
  queue: string;
  messages: Array<QueueMessage<T>>;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
