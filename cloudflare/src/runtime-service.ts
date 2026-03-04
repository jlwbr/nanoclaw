import {
  AgentRunRequestSchema,
  AgentRunResult,
  parseContract,
} from './contracts.js';
import { jsonResponse, stableNowIso } from './utils.js';

interface RuntimeServiceEnv {
  APP_VERSION?: string;
  AGENT_RUNTIME_TIMEOUT_MS?: string;
}

function tokenEstimate(input: string): number {
  const words = input.trim().split(/\s+/g).filter(Boolean).length;
  return Math.max(1, Math.ceil(words * 1.3));
}

async function executeAgent(request: {
  prompt: string;
  runId: string;
  tenantId: string;
}): Promise<{
  outputText: string;
  inputTokens: number;
  outputTokens: number;
}> {
  const outputText = `Processed run ${request.runId} for tenant ${request.tenantId}: ${request.prompt}`;
  return {
    outputText,
    inputTokens: tokenEstimate(request.prompt),
    outputTokens: tokenEstimate(outputText),
  };
}

const runtimeWorker = {
  async fetch(request: Request, env: RuntimeServiceEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return jsonResponse({
        status: 'ok',
        version: env.APP_VERSION ?? '0.0.0-dev',
      });
    }
    if (request.method !== 'POST' || url.pathname !== '/execute') {
      return jsonResponse(
        {
          error: {
            code: 'NOT_FOUND',
            message: 'Route not found',
          },
        },
        { status: 404 },
      );
    }

    const timeoutMs = parseInt(env.AGENT_RUNTIME_TIMEOUT_MS ?? '45000', 10);
    const startedAt = Date.now();

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse(
        {
          status: 'error',
          runId: 'unknown',
          code: 'RUNTIME_BAD_RESPONSE',
          message: 'Request body must be valid JSON',
          retriable: false,
          correlation: {
            requestId: crypto.randomUUID(),
            tenantId: 'unknown',
          },
          completedAt: stableNowIso(),
        },
        { status: 400 },
      );
    }

    const runRequest = parseContract(
      AgentRunRequestSchema,
      payload,
      'AgentRunRequest',
    );

    try {
      const result = await Promise.race([
        executeAgent({
          prompt: runRequest.prompt,
          runId: runRequest.runId,
          tenantId: runRequest.tenantId,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), timeoutMs),
        ),
      ]);

      const response: AgentRunResult = {
        status: 'ok',
        runId: runRequest.runId,
        outputText: result.outputText,
        artifacts: [],
        usage: {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          runtimeMs: Date.now() - startedAt,
        },
        correlation: runRequest.correlation,
        completedAt: stableNowIso(),
      };
      return jsonResponse(response, { status: 200 });
    } catch (error) {
      const isTimeout =
        error instanceof Error && error.message.toLowerCase().includes('timeout');
      const response: AgentRunResult = {
        status: 'error',
        runId: runRequest.runId,
        code: isTimeout ? 'RUNTIME_TIMEOUT' : 'RUNTIME_EXECUTION_FAILED',
        message: isTimeout
          ? 'Runtime execution exceeded timeout'
          : error instanceof Error
            ? error.message
            : String(error),
        retriable: true,
        correlation: runRequest.correlation,
        completedAt: stableNowIso(),
      };
      return jsonResponse(response, { status: isTimeout ? 504 : 500 });
    }
  },
};

export default runtimeWorker;
