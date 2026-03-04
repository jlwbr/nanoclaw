import { AgentRunRequest, AgentRunResult } from '../contracts.js';

export interface RuntimeHealth {
  status: 'ok' | 'degraded' | 'down';
  version: string;
  latencyMs?: number;
  reason?: string;
}

export interface RuntimePort {
  execute(request: AgentRunRequest): Promise<AgentRunResult>;
  healthcheck(): Promise<RuntimeHealth>;
}
