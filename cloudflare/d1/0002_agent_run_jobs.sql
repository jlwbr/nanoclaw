-- Agent run queue tracking for event-driven dispatch.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agent_run_jobs (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, run_id),
  FOREIGN KEY (tenant_id, event_id)
    REFERENCES inbound_events(tenant_id, event_id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_run_jobs_tenant_event
  ON agent_run_jobs(tenant_id, event_id);

CREATE INDEX IF NOT EXISTS idx_agent_run_jobs_tenant_status
  ON agent_run_jobs(tenant_id, status, queued_at);

