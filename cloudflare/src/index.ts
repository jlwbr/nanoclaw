import { handleApiRequest } from './api/routes.js';
import { MessageBatch } from './cf-types.js';
import { TenantOrchestratorDurableObject } from './durable-objects/tenant-orchestrator.js';
import { WorkerEnv } from './env.js';
import { createPlatform } from './factory.js';
import { logError } from './logging.js';

async function handleQueueBatch(
  batch: MessageBatch<unknown>,
  env: WorkerEnv,
): Promise<void> {
  const platform = createPlatform(env);
  for (const message of batch.messages) {
    try {
      if (batch.queue.includes('agent_run')) {
        const outcome = await platform.pipelines.handleAgentRun(
          message.body,
          message.attempts,
        );
        if (outcome.action === 'retry') {
          message.retry({ delaySeconds: outcome.delaySeconds });
        } else {
          message.ack();
        }
        continue;
      }

      if (batch.queue.includes('outbound_delivery')) {
        const outcome = await platform.pipelines.handleOutboundDelivery(
          message.body,
          message.attempts,
        );
        if (outcome.action === 'retry') {
          message.retry({ delaySeconds: outcome.delaySeconds });
        } else {
          message.ack();
        }
        continue;
      }

      message.ack();
    } catch (error) {
      logError('queue.batch.error', 'Queue message processing failed', error, undefined, {
        queue: batch.queue,
        messageId: message.id,
        attempts: message.attempts,
      });
      if (message.attempts < 5) {
        message.retry({ delaySeconds: 15 });
      } else {
        message.ack();
      }
    }
  }
}

const worker = {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return handleApiRequest(request, env);
  },
  queue(batch: MessageBatch<unknown>, env: WorkerEnv): Promise<void> {
    return handleQueueBatch(batch, env);
  },
};

export { TenantOrchestratorDurableObject as TenantOrchestrator };
export default worker;
