import { AgentRunRequest, OutboundDeliveryRequest } from '../contracts.js';
import { WorkerEnv } from '../env.js';
import { QueuePort } from '../ports/queue.js';

export class CloudflareQueueAdapter implements QueuePort {
  constructor(private readonly env: WorkerEnv) {}

  async enqueueAgentRun(request: AgentRunRequest): Promise<void> {
    await this.env.AGENT_RUN_QUEUE.send(request);
  }

  async enqueueOutboundDelivery(request: OutboundDeliveryRequest): Promise<void> {
    await this.env.OUTBOUND_DELIVERY_QUEUE.send({
      kind: 'outbound_delivery',
      payload: request,
    });
  }
}
