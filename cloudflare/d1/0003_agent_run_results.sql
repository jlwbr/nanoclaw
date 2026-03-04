-- Store runtime outputs and token usage for completed runs.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agent_run_results (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  output_text TEXT,
  output_json TEXT,
  model TEXT,
  usage_input_tokens INTEGER,
  usage_output_tokens INTEGER,
  usage_cached_input_tokens INTEGER,
  runtime_ms INTEGER,
  completed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, run_id),
  FOREIGN KEY (tenant_id, run_id)
    REFERENCES agent_run_jobs(tenant_id, run_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_run_results_tenant_completed
  ON agent_run_results(tenant_id, completed_at);

