import { describe, expect, it } from 'vitest';

import { createRuntimeAdapter } from '../src/adapters/runtime.js';
import { WorkerEnv } from '../src/env.js';
import { createBaseEnv } from './helpers/sqlite-d1.js';

describe('RuntimeAdapter', () => {
  it('executes via service binding in service mode', async () => {
    const env = createBaseEnv();
    const adapter = createRuntimeAdapter(env, {
      AGENT_RUNTIME_MODE: 'service',
      AGENT_RUNTIME_HTTP_URL: env.AGENT_RUNTIME_HTTP_URL,
      RUNTIME_MIN_VERSION: '1.0.0',
      CIRCUIT_BREAKER_WINDOW_SIZE: 5,
      CIRCUIT_BREAKER_ERROR_THRESHOLD: 0.5,
    });

    const output = await adapter.execute({
      runId: 'run_runtime',
      tenantId: 'tenant_runtime',
      idempotencyKey: 'idem_runtime',
      prompt: 'hello',
      context: { isScheduledTask: false },
      correlation: {
        requestId: 'req_runtime',
        tenantId: 'tenant_runtime',
      },
      createdAt: new Date().toISOString(),
    });
    expect(output.status).toBe('ok');
  });

  it('marks runtime health as degraded when version is below minimum', async () => {
    const env = createBaseEnv();
    const adapter = createRuntimeAdapter(
      {
        ...env,
        AGENT_RUNTIME: {
          async execute(request) {
            return {
              status: 'ok',
              runId: request.runId,
              outputText: 'ok',
              artifacts: [],
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                runtimeMs: 1,
              },
              correlation: request.correlation,
              completedAt: new Date().toISOString(),
            };
          },
          async healthcheck() {
            return {
              status: 'ok',
              version: '0.9.0',
            };
          },
        },
      } as WorkerEnv,
      {
        AGENT_RUNTIME_MODE: 'service',
        AGENT_RUNTIME_HTTP_URL: env.AGENT_RUNTIME_HTTP_URL,
        RUNTIME_MIN_VERSION: '1.0.0',
        CIRCUIT_BREAKER_WINDOW_SIZE: 5,
        CIRCUIT_BREAKER_ERROR_THRESHOLD: 0.5,
      },
    );
    const health = await adapter.healthcheck();
    expect(health.status).toBe('degraded');
    expect(health.reason).toContain('runtime_version_too_old');
  });
});
