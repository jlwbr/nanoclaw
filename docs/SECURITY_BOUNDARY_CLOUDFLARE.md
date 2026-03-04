# Cloudflare Hosted Security Boundary

## Trust boundaries

1. **Ingress boundary (Worker HTTP routes)**
   - validates webhook signatures
   - enforces tenant-level quotas and replay windows
2. **Orchestration boundary (Durable Object per tenant)**
   - dedupe + idempotency
   - tenant-scoped state transitions
3. **Execution boundary (runtime binding / HTTP runtime)**
   - stateless execution contract
   - no privileged direct database writes
4. **Egress boundary (outbound queue + adapters)**
   - bounded retries
   - dead-letter + re-drive controls

## Tenant isolation rules

- Every D1 write includes `tenant_id`.
- Every D1 read filters on `tenant_id`.
- Every R2 key must start with `tenants/{tenant_id}/`.
- Queue payloads always include `tenantId`.

## Abuse controls

- requests/min limit (`tenant_limits.requests_per_minute`)
- daily token budget (`tenant_limits.token_budget_daily`)
- max concurrent runs (`tenant_limits.max_concurrent_runs`)
- hard block switch (`tenant_limits.hard_block`)

## Auditability

Security-relevant events are recorded in `security_audit_logs`:

- ingress hard block/rate limit
- budget blocks/exceeded thresholds
- run rejection due to concurrency
- outbound dead-letter failures

## Incident response

1. set `hard_block=1` for impacted tenant
2. inspect recent `security_audit_logs`
3. inspect queued and dead-letter outbound rows
4. redrive only after root cause is resolved
