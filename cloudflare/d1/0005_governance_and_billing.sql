PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenant_limits (
  tenant_id TEXT PRIMARY KEY,
  requests_per_minute INTEGER NOT NULL DEFAULT 120,
  token_budget_daily INTEGER NOT NULL DEFAULT 1000000,
  max_concurrent_runs INTEGER NOT NULL DEFAULT 4,
  hard_block INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tenant_minute_usage (
  tenant_id TEXT NOT NULL,
  minute_start TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, minute_start),
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tenant_minute_usage_updated
  ON tenant_minute_usage(updated_at);

CREATE TABLE IF NOT EXISTS tenant_daily_usage (
  tenant_id TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, usage_date),
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS usage_ledger (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, run_id),
  FOREIGN KEY (tenant_id, run_id)
    REFERENCES agent_run_jobs(tenant_id, run_id)
    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_tenant_usage_date
  ON usage_ledger(tenant_id, usage_date, created_at);

CREATE TABLE IF NOT EXISTS security_audit_logs (
  tenant_id TEXT NOT NULL,
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  detail TEXT,
  correlation_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_security_audit_logs_tenant_created
  ON security_audit_logs(tenant_id, created_at);
