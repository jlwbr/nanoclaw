import { AgentRunRequest, OutboundDeliveryRequest } from '../contracts.js';

export interface QueuePort {
  enqueueAgentRun(request: AgentRunRequest): Promise<void>;
  enqueueOutboundDelivery(request: OutboundDeliveryRequest): Promise<void>;
}

export interface QueueRetryPolicy {
  maxAttempts: number;
  baseDelaySeconds: number;
  maxDelaySeconds: number;
}

export function computeRetryDelaySeconds(
  attempt: number,
  policy: QueueRetryPolicy,
): number {
  if (attempt <= 0) {
    return policy.baseDelaySeconds;
  }
  const unbounded = policy.baseDelaySeconds * 2 ** (attempt - 1);
  return Math.min(unbounded, policy.maxDelaySeconds);
}
