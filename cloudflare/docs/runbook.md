# NanoClaw Cloudflare Hosted Runbook

## Deployment order

1. Deploy runtime service first:
   - `wrangler deploy -c cloudflare/wrangler.runtime.toml`
2. Apply D1 migrations:
   - `wrangler d1 migrations apply nanoclaw-hosted --config cloudflare/wrangler.toml`
3. Deploy main hosted worker:
   - `wrangler deploy -c cloudflare/wrangler.toml`
4. Verify queues are configured:
   - `wrangler queues list`
5. Verify durable object migration tag:
   - `wrangler deployments list -c cloudflare/wrangler.toml`

## Rollback procedure

1. Disable ingress paths using Cloudflare route fail-safe (or temporary maintenance route).
2. Roll back worker to previous deployment version.
3. Keep D1 schema forward-compatible; do not drop columns in hot rollback.
4. Re-enable ingress and replay dead-letter deliveries after health returns.

## Secret rotation

Rotate each secret independently and verify before rotating the next:

- `AUTUMN_API_KEY`
- `AUTUMN_WEBHOOK_SECRET`
- `INBOUND_WEBHOOK_SECRET`

Steps:
1. Add new secret with temporary dual validation support if needed.
2. Validate `/health` and webhook signature acceptance.
3. Remove old secret.

## Migration safety

- Migrations are additive and idempotent.
- Never deploy app code that depends on a migration before applying that migration.
- For rollback, keep columns/tables and roll app logic back first.

## Queue/backpressure operations

- `agent_run` and `outbound_delivery` use bounded retries.
- On repeated runtime failure, circuit breaker opens for 30 seconds.
- If queue lag grows, pause webhook source and reconcile once runtime health is restored.

## Autumn webhook troubleshooting

1. Verify signature header `x-autumn-signature`.
2. Recompute HMAC SHA-256 against raw request body and `AUTUMN_WEBHOOK_SECRET`.
3. Confirm webhook includes `id` and `type`.
4. Inspect logs with correlation fields:
   - `tenant_id`
   - `billing_event_id`
   - `run_id` (if available)
5. If Autumn API is degraded, usage reports remain in `billing_usage_reports` with `failed` status and can be retried by queue redrive flow.

## Traceability checklist

For incident triage, verify all correlation IDs are present in logs:

- inbound event: `event_id`
- run execution: `run_id`
- outbound delivery: `delivery_id`
- billing report: `billing_event_id`

This enables end-to-end trace from webhook ingress to runtime execution and billing usage report.
