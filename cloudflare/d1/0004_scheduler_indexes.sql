CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_tenant_status_next_run
  ON scheduled_tasks (tenant_id, status, next_run);

CREATE INDEX IF NOT EXISTS idx_agent_run_jobs_tenant_status_updated
  ON agent_run_jobs (tenant_id, status, updated_at);
