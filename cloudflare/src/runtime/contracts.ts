export interface AgentRuntimeExecuteRequest {
  runId: string;
  tenantId: string;
  eventId: string;
  channel: string;
  chatJid: string;
  content?: string;
  enqueuedAt: string;
}

export interface AgentRuntimeExecuteSuccess {
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

export interface AgentRuntimeExecuteFailure {
  ok: false;
  error: string;
  retryable: boolean;
  errorType: 'timeout' | 'validation' | 'upstream' | 'rate_limit' | 'internal';
}

export type AgentRuntimeExecuteResponse =
  | AgentRuntimeExecuteSuccess
  | AgentRuntimeExecuteFailure;
