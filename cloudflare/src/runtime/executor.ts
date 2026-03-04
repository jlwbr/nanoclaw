import { AgentRunJobMessage, Env } from '../types';

export interface RuntimeExecutionSuccess {
  ok: true;
  detail?: string;
  outputText?: string;
  output?: unknown;
  model?: string;
  usageInputTokens?: number;
  usageOutputTokens?: number;
  usageCachedInputTokens?: number;
  runtimeMs?: number;
}

export interface RuntimeExecutionFailure {
  ok: false;
  error: string;
  retryable: boolean;
}

export type RuntimeExecutionResult =
  | RuntimeExecutionSuccess
  | RuntimeExecutionFailure;

function parseMode(env: Env): 'stub' | 'http' {
  return env.AGENT_RUNTIME_MODE === 'http' ? 'http' : 'stub';
}

function asNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) return undefined;
  return value;
}

async function executeStub(job: AgentRunJobMessage): Promise<RuntimeExecutionResult> {
  return {
    ok: true,
    detail: 'Processed by stub runtime',
    outputText: `Stub runtime processed event ${job.eventId} from ${job.channel}`,
    model: 'stub-runtime',
  };
}

async function executeHttp(
  env: Env,
  job: AgentRunJobMessage,
): Promise<RuntimeExecutionResult> {
  if (!env.AGENT_RUNTIME_HTTP_URL) {
    return {
      ok: false,
      error: 'AGENT_RUNTIME_HTTP_URL is required when AGENT_RUNTIME_MODE=http',
      retryable: false,
    };
  }

  let response: Response;
  try {
    response = await fetch(env.AGENT_RUNTIME_HTTP_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: job.runId,
        tenantId: job.tenantId,
        eventId: job.eventId,
        channel: job.channel,
        chatJid: job.chatJid,
        content: job.content,
        enqueuedAt: job.enqueuedAt,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      error: `Runtime HTTP request failed: ${err instanceof Error ? err.message : String(err)}`,
      retryable: true,
    };
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    if (!response.ok) {
      return {
        ok: false,
        error: `Runtime HTTP failed with status ${response.status}`,
        retryable: response.status >= 500,
      };
    }
  }

  if (!response.ok) {
    const errorMessage =
      typeof payload.error === 'string'
        ? payload.error
        : `Runtime HTTP failed with status ${response.status}`;
    return {
      ok: false,
      error: errorMessage,
      retryable: response.status >= 500,
    };
  }

  if (payload.ok === false) {
    return {
      ok: false,
      error:
        typeof payload.error === 'string'
          ? payload.error
          : 'Runtime returned ok=false',
      retryable: payload.retryable === true,
    };
  }

  return {
    ok: true,
    detail: typeof payload.detail === 'string' ? payload.detail : undefined,
    outputText:
      typeof payload.outputText === 'string' ? payload.outputText : undefined,
    output: payload.output,
    model: typeof payload.model === 'string' ? payload.model : undefined,
    usageInputTokens: asNumber(payload.usageInputTokens),
    usageOutputTokens: asNumber(payload.usageOutputTokens),
    usageCachedInputTokens: asNumber(payload.usageCachedInputTokens),
    runtimeMs: asNumber(payload.runtimeMs),
  };
}

export async function executeRunJob(
  env: Env,
  job: AgentRunJobMessage,
): Promise<RuntimeExecutionResult> {
  const mode = parseMode(env);
  if (mode === 'http') {
    return executeHttp(env, job);
  }
  return executeStub(job);
}

