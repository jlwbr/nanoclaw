import { WorkerEnv } from '../env.js';
import { SchedulerPort } from '../ports/scheduler.js';

export class DurableObjectSchedulerAdapter implements SchedulerPort {
  constructor(private readonly env: WorkerEnv) {}

  async scheduleWakeup(tenantId: string, runAtIso: string): Promise<void> {
    const id = this.env.TENANT_ORCHESTRATOR.idFromName(tenantId);
    const stub = this.env.TENANT_ORCHESTRATOR.get(id);
    await stub.fetch('https://tenant-orchestrator/internal/schedule', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'wakeup', runAtIso }),
    });
  }

  async scheduleReconcile(tenantId: string, afterSeconds: number): Promise<void> {
    const id = this.env.TENANT_ORCHESTRATOR.idFromName(tenantId);
    const stub = this.env.TENANT_ORCHESTRATOR.get(id);
    await stub.fetch('https://tenant-orchestrator/internal/schedule', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'reconcile', afterSeconds }),
    });
  }
}
