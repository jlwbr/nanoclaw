# Cloudflare On-Call Runbook

## Primary signals

- `/metrics` latency p95 and queue lag
- `security_audit_logs` spikes
- outbound dead-letter count
- run failure rate by channel/model

## Triage steps

1. Identify impacted tenant(s) using correlation IDs (`tenant_id`, `event_id`, `run_id`).
2. Check queue backlog (`agent_run_jobs` in `queued`/`awaiting_runtime`).
3. Inspect recent runtime failures (`last_error`, `status=failed`).
4. Inspect outbound dead letters (`outbound_deliveries.status='dead_letter'`).

## Immediate containment

- Set `tenant_limits.hard_block=1` for runaway tenants.
- Reduce `max_concurrent_runs` for overloaded tenants.
- Switch to stub modes (`AGENT_RUNTIME_MODE=stub`, `OUTBOUND_MODE=stub`) if providers are degraded.

## Recovery

- Fix runtime/outbound provider issue.
- Re-drive dead letters via `POST /tenants/:tenantId/outbound/:deliveryId/redrive`.
- Verify error rate normalizes and queue lag recovers.

## Escalation

- Runtime provider outage > 15m
- Cross-tenant access anomaly
- sustained budget-abuse attack
