CREATE TABLE IF NOT EXISTS tenants (
  tenant_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'suspended')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  autumn_customer_id TEXT,
  subscription_ref TEXT,
  entitlement_cache_until TEXT,
  monthly_budget_usd REAL
);

CREATE TABLE IF NOT EXISTS inbound_events (
  tenant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, event_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule_type TEXT NOT NULL CHECK (schedule_type IN ('cron', 'interval', 'once')),
  schedule_value TEXT NOT NULL,
  next_run_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'cancelled', 'completed', 'dead_letter')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_run_at TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_tenant_status_due
  ON tasks(tenant_id, status, next_run_at);

CREATE TABLE IF NOT EXISTS run_jobs (
  run_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  task_id TEXT,
  source_event_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'succeeded', 'failed', 'timed_out', 'blocked', 'cancelled')
  ),
  idempotency_key TEXT NOT NULL UNIQUE,
  prompt TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  usage_input_tokens INTEGER,
  usage_output_tokens INTEGER,
  runtime_ms INTEGER,
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
  FOREIGN KEY (task_id) REFERENCES tasks(task_id)
);

CREATE INDEX IF NOT EXISTS idx_run_jobs_tenant_queued
  ON run_jobs(tenant_id, queued_at DESC);

CREATE TABLE IF NOT EXISTS usage_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  quantity REAL NOT NULL,
  reported_to_billing INTEGER NOT NULL DEFAULT 0,
  billing_report_key TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
  FOREIGN KEY (run_id) REFERENCES run_jobs(run_id)
);

CREATE INDEX IF NOT EXISTS idx_usage_snapshots_tenant_created
  ON usage_snapshots(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS outbound_deliveries (
  delivery_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  target TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'retrying', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
  FOREIGN KEY (run_id) REFERENCES run_jobs(run_id)
);

CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_tenant_status
  ON outbound_deliveries(tenant_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS outbound_dead_letter (
  dead_id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  failed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_usage_reports (
  report_key TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  quantity REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'reported', 'failed')),
  provider_ref TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
  FOREIGN KEY (run_id) REFERENCES run_jobs(run_id)
);

CREATE INDEX IF NOT EXISTS idx_billing_reports_tenant_status
  ON billing_usage_reports(tenant_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
  FOREIGN KEY (run_id) REFERENCES run_jobs(run_id)
);

CREATE INDEX IF NOT EXISTS idx_artifacts_tenant_run
  ON artifacts(tenant_id, run_id);
