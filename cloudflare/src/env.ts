import { z } from 'zod';

import {
  D1Database,
  DurableObjectNamespace,
  Queue,
  R2Bucket,
} from './cf-types.js';
import { AgentRunRequest, AgentRunResult } from './contracts.js';

export interface AgentRuntimeServiceBinding {
  execute(request: AgentRunRequest): Promise<AgentRunResult>;
  healthcheck?(): Promise<{ status: 'ok' | 'degraded' | 'down'; version: string }>;
}

export interface WorkerEnv {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  TENANT_ORCHESTRATOR: DurableObjectNamespace;
  AGENT_RUN_QUEUE: Queue<AgentRunRequest>;
  OUTBOUND_DELIVERY_QUEUE: Queue<Record<string, unknown>>;
  AGENT_RUNTIME?: AgentRuntimeServiceBinding;
  AGENT_RUNTIME_MODE?: string;
  AGENT_RUNTIME_HTTP_URL?: string;
  APP_VERSION?: string;
  RUNTIME_MIN_VERSION?: string;
  AUTUMN_API_KEY?: string;
  AUTUMN_BASE_URL?: string;
  AUTUMN_WEBHOOK_SECRET?: string;
  AUTUMN_PRODUCT_ID?: string;
  INBOUND_WEBHOOK_SECRET?: string;
  OUTBOUND_MAX_ATTEMPTS?: string;
  CIRCUIT_BREAKER_WINDOW_SIZE?: string;
  CIRCUIT_BREAKER_ERROR_THRESHOLD?: string;
}

const WorkerEnvSchema = z.object({
  AGENT_RUNTIME_MODE: z.enum(['service', 'http']).default('service'),
  AGENT_RUNTIME_HTTP_URL: z.string().url().optional(),
  APP_VERSION: z.string().min(1).default('0.0.0-dev'),
  RUNTIME_MIN_VERSION: z.string().min(1).default('0.0.0'),
  AUTUMN_API_KEY: z.string().min(1).default('dev-autumn-key'),
  AUTUMN_BASE_URL: z.string().url().default('https://api.useautumn.com/v1'),
  AUTUMN_WEBHOOK_SECRET: z.string().min(1).default('dev-autumn-webhook-secret'),
  AUTUMN_PRODUCT_ID: z.string().min(1).default('nanoclaw-hosted'),
  INBOUND_WEBHOOK_SECRET: z.string().min(1).default('dev-inbound-secret'),
  OUTBOUND_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(12).default(5),
  CIRCUIT_BREAKER_WINDOW_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  CIRCUIT_BREAKER_ERROR_THRESHOLD: z.coerce.number().min(0.01).max(1).default(0.5),
});

export type ValidatedRuntimeEnv = z.infer<typeof WorkerEnvSchema>;

export function validateRuntimeEnv(raw: WorkerEnv): ValidatedRuntimeEnv {
  const parsed = WorkerEnvSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid worker environment: ${details}`);
  }
  if (
    parsed.data.AGENT_RUNTIME_MODE === 'service' &&
    typeof raw.AGENT_RUNTIME?.execute !== 'function'
  ) {
    throw new Error(
      'Invalid worker environment: AGENT_RUNTIME service binding is required when AGENT_RUNTIME_MODE=service',
    );
  }
  if (
    parsed.data.AGENT_RUNTIME_MODE === 'http' &&
    !parsed.data.AGENT_RUNTIME_HTTP_URL
  ) {
    throw new Error(
      'Invalid worker environment: AGENT_RUNTIME_HTTP_URL is required when AGENT_RUNTIME_MODE=http',
    );
  }
  return parsed.data;
}
