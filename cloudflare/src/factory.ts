import { createAutumnBillingAdapter } from './adapters/autumn-billing.js';
import { createD1SqlClient } from './adapters/d1/client.js';
import { createD1Repositories } from './adapters/d1/repositories.js';
import { LoggingOutboundTransportAdapter } from './adapters/outbound.js';
import { CloudflareQueueAdapter } from './adapters/queue.js';
import { R2ArtifactStorageAdapter } from './adapters/r2-artifacts.js';
import { createRuntimeAdapter } from './adapters/runtime.js';
import { DurableObjectSchedulerAdapter } from './adapters/scheduler.js';
import { validateRuntimeEnv, WorkerEnv } from './env.js';
import { BillingPort } from './ports/billing.js';
import { PlatformRepositories } from './ports/database.js';
import { OutboundTransportPort } from './ports/outbound.js';
import { QueuePort } from './ports/queue.js';
import { RuntimePort } from './ports/runtime.js';
import { ArtifactStoragePort } from './ports/storage.js';
import { QueuePipelineService } from './services/queue-pipelines.js';
import { TenantOrchestrationService } from './services/orchestration.js';

export interface PlatformFactoryOutput {
  validatedEnv: ReturnType<typeof validateRuntimeEnv>;
  repos: PlatformRepositories;
  queue: QueuePort;
  runtime: RuntimePort;
  billing: BillingPort;
  artifacts: ArtifactStoragePort;
  outboundTransport: OutboundTransportPort;
  orchestration: TenantOrchestrationService;
  pipelines: QueuePipelineService;
}

export function createPlatform(env: WorkerEnv): PlatformFactoryOutput {
  const validatedEnv = validateRuntimeEnv(env);
  const sql = createD1SqlClient(env.DB);
  const repos = createD1Repositories(sql);
  const queue = new CloudflareQueueAdapter(env);
  const runtime = createRuntimeAdapter(env, validatedEnv);
  const billing = createAutumnBillingAdapter(env, repos);
  const artifacts = new R2ArtifactStorageAdapter(env.ARTIFACTS, sql);
  const outboundTransport = new LoggingOutboundTransportAdapter();
  const scheduler = new DurableObjectSchedulerAdapter(env);

  const orchestration = new TenantOrchestrationService({
    repos,
    queue,
    billing,
    scheduler,
  });

  const pipelines = new QueuePipelineService({
    repos,
    runtime,
    billing,
    queue,
    artifacts,
    outboundTransport,
    retryPolicy: {
      maxAttempts: 5,
      baseDelaySeconds: 5,
      maxDelaySeconds: 300,
    },
    outboundMaxAttempts: validatedEnv.OUTBOUND_MAX_ATTEMPTS,
  });

  return {
    validatedEnv,
    repos,
    queue,
    runtime,
    billing,
    artifacts,
    outboundTransport,
    orchestration,
    pipelines,
  };
}
