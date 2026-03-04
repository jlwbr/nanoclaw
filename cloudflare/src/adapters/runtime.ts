import {
  AgentRunRequest,
  AgentRunResult,
  AgentRunResultSchema,
  parseContract,
} from '../contracts.js';
import { AppError } from '../errors.js';
import {
  AgentRuntimeServiceBinding,
  ValidatedRuntimeEnv,
  WorkerEnv,
} from '../env.js';
import { log } from '../logging.js';
import { RuntimeHealth, RuntimePort } from '../ports/runtime.js';

class CircuitBreaker {
  private readonly outcomes: boolean[] = [];
  private openUntil = 0;

  constructor(
    private readonly windowSize: number,
    private readonly errorThreshold: number,
  ) {}

  isOpen(nowMs: number): boolean {
    return nowMs < this.openUntil;
  }

  record(success: boolean, nowMs: number): void {
    this.outcomes.push(success);
    while (this.outcomes.length > this.windowSize) {
      this.outcomes.shift();
    }
    if (this.outcomes.length < this.windowSize) {
      return;
    }
    const failures = this.outcomes.filter((value) => !value).length;
    const ratio = failures / this.outcomes.length;
    if (ratio >= this.errorThreshold) {
      this.openUntil = nowMs + 30_000;
    }
  }
}

function compareSemver(a: string, b: string): number {
  const left = a.split('.').map((segment) => parseInt(segment, 10) || 0);
  const right = b.split('.').map((segment) => parseInt(segment, 10) || 0);
  const max = Math.max(left.length, right.length);
  for (let index = 0; index < max; index += 1) {
    const lv = left[index] ?? 0;
    const rv = right[index] ?? 0;
    if (lv > rv) {
      return 1;
    }
    if (lv < rv) {
      return -1;
    }
  }
  return 0;
}

export class RuntimeAdapter implements RuntimePort {
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly env: WorkerEnv,
    private readonly config: Pick<
      ValidatedRuntimeEnv,
      | 'AGENT_RUNTIME_MODE'
      | 'AGENT_RUNTIME_HTTP_URL'
      | 'RUNTIME_MIN_VERSION'
      | 'CIRCUIT_BREAKER_WINDOW_SIZE'
      | 'CIRCUIT_BREAKER_ERROR_THRESHOLD'
    >,
  ) {
    this.breaker = new CircuitBreaker(
      config.CIRCUIT_BREAKER_WINDOW_SIZE,
      config.CIRCUIT_BREAKER_ERROR_THRESHOLD,
    );
  }

  async execute(request: AgentRunRequest): Promise<AgentRunResult> {
    const nowMs = Date.now();
    if (this.breaker.isOpen(nowMs)) {
      throw new AppError({
        code: 'CIRCUIT_OPEN',
        message: 'Agent runtime circuit is open',
        status: 503,
        retryable: true,
      });
    }

    try {
      const result =
        this.config.AGENT_RUNTIME_MODE === 'service'
          ? await this.executeViaServiceBinding(request)
          : await this.executeViaHttp(request);
      this.breaker.record(true, nowMs);
      return result;
    } catch (error) {
      this.breaker.record(false, nowMs);
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError({
        code: 'RUNTIME_FAILURE',
        message: error instanceof Error ? error.message : String(error),
        status: 502,
        retryable: true,
        cause: error,
      });
    }
  }

  async healthcheck(): Promise<RuntimeHealth> {
    const started = Date.now();
    try {
      const health =
        this.config.AGENT_RUNTIME_MODE === 'service'
          ? await this.healthViaServiceBinding()
          : await this.healthViaHttp();
      const latencyMs = Date.now() - started;
      if (compareSemver(health.version, this.config.RUNTIME_MIN_VERSION) < 0) {
        return {
          status: 'degraded',
          latencyMs,
          version: health.version,
          reason: `runtime_version_too_old:min=${this.config.RUNTIME_MIN_VERSION}`,
        };
      }
      return {
        ...health,
        latencyMs,
      };
    } catch (error) {
      return {
        status: 'down',
        version: 'unknown',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async executeViaServiceBinding(
    request: AgentRunRequest,
  ): Promise<AgentRunResult> {
    const service = this.env.AGENT_RUNTIME as AgentRuntimeServiceBinding | undefined;
    if (!service) {
      throw new AppError({
        code: 'RUNTIME_FAILURE',
        message: 'AGENT_RUNTIME service binding is not configured',
        status: 500,
        retryable: false,
      });
    }
    const result = await service.execute(request);
    return parseContract(AgentRunResultSchema, result, 'AgentRunResult');
  }

  private async executeViaHttp(request: AgentRunRequest): Promise<AgentRunResult> {
    const url = this.config.AGENT_RUNTIME_HTTP_URL;
    if (!url) {
      throw new AppError({
        code: 'RUNTIME_FAILURE',
        message: 'AGENT_RUNTIME_HTTP_URL is not configured',
        status: 500,
        retryable: false,
      });
    }
    const response = await fetch(`${url.replace(/\/$/, '')}/execute`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new AppError({
        code: 'RUNTIME_FAILURE',
        message: `Runtime HTTP request failed (${response.status})`,
        status: 502,
        retryable: response.status >= 500,
      });
    }
    const body = await response.json();
    return parseContract(AgentRunResultSchema, body, 'AgentRunResult');
  }

  private async healthViaServiceBinding(): Promise<RuntimeHealth> {
    const service = this.env.AGENT_RUNTIME as AgentRuntimeServiceBinding | undefined;
    if (!service?.healthcheck) {
      return { status: 'ok', version: 'unknown' };
    }
    return service.healthcheck();
  }

  private async healthViaHttp(): Promise<RuntimeHealth> {
    const url = this.config.AGENT_RUNTIME_HTTP_URL;
    if (!url) {
      throw new Error('AGENT_RUNTIME_HTTP_URL is missing');
    }
    const response = await fetch(`${url.replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error(`runtime healthcheck failed (${response.status})`);
    }
    const body = (await response.json()) as {
      status: 'ok' | 'degraded' | 'down';
      version: string;
    };
    return {
      status: body.status,
      version: body.version,
    };
  }
}

export function createRuntimeAdapter(
  env: WorkerEnv,
  config: Pick<
    ValidatedRuntimeEnv,
    | 'AGENT_RUNTIME_MODE'
    | 'AGENT_RUNTIME_HTTP_URL'
    | 'RUNTIME_MIN_VERSION'
    | 'CIRCUIT_BREAKER_WINDOW_SIZE'
    | 'CIRCUIT_BREAKER_ERROR_THRESHOLD'
  >,
): RuntimePort {
  log({
    event: 'runtime.adapter.init',
    message: 'Runtime adapter initialized',
    data: {
      mode: config.AGENT_RUNTIME_MODE,
      minVersion: config.RUNTIME_MIN_VERSION,
    },
  });
  return new RuntimeAdapter(env, config);
}
