PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS outbound_deliveries (
  tenant_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  queued_at TEXT NOT NULL,
  sent_at TEXT,
  dead_lettered_at TEXT,
  provider_message_id TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, delivery_id),
  FOREIGN KEY (tenant_id, run_id)
    REFERENCES agent_run_jobs(tenant_id, run_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_tenant_status_updated
  ON outbound_deliveries(tenant_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_tenant_run
  ON outbound_deliveries(tenant_id, run_id);
