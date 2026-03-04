export interface SchedulerPort {
  scheduleWakeup(tenantId: string, runAtIso: string): Promise<void>;
  scheduleReconcile(tenantId: string, afterSeconds: number): Promise<void>;
}
