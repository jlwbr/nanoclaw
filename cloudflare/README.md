# Cloudflare Event-Driven Bootstrap

This directory contains the first implementation slice for migrating NanoClaw to an event-driven Cloudflare architecture.

## What is included

- Worker entrypoint (`src/index.ts`) for:
  - health endpoint
  - webhook ingest endpoint (`POST /webhooks/:channel`)
  - task management endpoints (`/tenants/:tenantId/tasks*`)
  - quota/limit management (`/tenants/:tenantId/limits`)
  - usage/billing export (`/tenants/:tenantId/usage`)
  - outbound delivery admin endpoints (`/tenants/:tenantId/outbound*`)
  - canonical event normalization and forwarding to per-tenant Durable Object
  - queue consumers for runtime and outbound delivery dispatch
  - cron-trigger reconciliation sweep for due scheduled tasks
- Durable Object skeleton (`src/durable-objects/tenant-orchestrator.ts`) for:
  - idempotent event ingestion
  - basic persistence into D1
  - enqueueing run jobs to Cloudflare Queues
  - task CRUD operations and alarm-based scheduling
  - usage ledger updates and outbound reply enqueueing
- Event helpers (`src/events/*`) for:
  - channel signature verification
  - payload normalization to canonical inbound events
- Outbound delivery executor (`src/outbound/executor.ts`)
- R2 key helper module (`src/storage/tenant-storage.ts`)
- Initial tenant-aware D1 schema migration (`d1/0001_tenant_core.sql`)
- Queue run tracking schema migration (`d1/0002_agent_run_jobs.sql`)
- Run output/token usage schema migration (`d1/0003_agent_run_results.sql`)
- Scheduler/query performance indexes (`d1/0004_scheduler_indexes.sql`)
- Governance + billing schema (`d1/0005_governance_and_billing.sql`)
- Outbound delivery + dead-letter schema (`d1/0006_outbound_delivery.sql`)
- Wrangler configuration scaffold (`wrangler.toml`)

## Why this is high-impact

This is the foundation that unblocks:

1. replacing polling with event ingress
2. introducing tenant-aware persistence
3. moving orchestrator logic into Durable Objects

## Current scope

This bootstrap is intentionally minimal and does **not** yet include:

- Cloudflare Containers runtime invocation
- direct provider SDK integrations in outbound mode (`OUTBOUND_MODE=http` expected)
- full rollout automation/runbooks for shadow/canary traffic

Those are tracked in `docs/CLOUDFLARE_EVENT_DRIVEN_ROADMAP.md`.

## Quick start (local)

1. Install Wrangler (if not installed).
2. Configure `wrangler.toml` bindings and IDs.
3. Apply D1 schema:

```bash
wrangler d1 execute nanoclaw --file ./d1/0001_tenant_core.sql
wrangler d1 execute nanoclaw --file ./d1/0002_agent_run_jobs.sql
wrangler d1 execute nanoclaw --file ./d1/0003_agent_run_results.sql
wrangler d1 execute nanoclaw --file ./d1/0004_scheduler_indexes.sql
wrangler d1 execute nanoclaw --file ./d1/0005_governance_and_billing.sql
wrangler d1 execute nanoclaw --file ./d1/0006_outbound_delivery.sql
```

## Runtime execution modes

Queue jobs are executed through a runtime abstraction:

- `AGENT_RUNTIME_MODE=stub` (default): marks jobs completed with deterministic stub output.
- `AGENT_RUNTIME_MODE=http`: sends run payload to `AGENT_RUNTIME_HTTP_URL` and maps response fields into run status/output tables.
- `AGENT_RUNTIME_MODE=service`: calls `AGENT_RUNTIME` service binding (recommended for Cloudflare-native runtime workers/containers).

`AGENT_QUEUE_MAX_ATTEMPTS` controls bounded queue retries before terminal failure.

Outbound delivery uses a similar abstraction:

- `OUTBOUND_MODE=stub`: marks outbound rows as sent with a deterministic provider ID.
- `OUTBOUND_MODE=http`: posts to `OUTBOUND_HTTP_URL`.

`OUTBOUND_QUEUE_MAX_ATTEMPTS` controls retries before dead-lettering.

## Scheduler APIs

- `POST /tenants/:tenantId/tasks` create task
- `GET /tenants/:tenantId/tasks?status=active|paused|completed` list tasks
- `POST /tenants/:tenantId/tasks/:taskId/pause`
- `POST /tenants/:tenantId/tasks/:taskId/resume`
- `POST /tenants/:tenantId/tasks/:taskId/cancel`
- `POST /tenants/:tenantId/tasks/:taskId/run_now`
- `POST /tenants/:tenantId/tasks/reconcile` force reconciliation sweep

Primary wakeups happen with Durable Object alarms; cron is a fallback safety sweep.

## Policy and billing APIs

- `POST /tenants/:tenantId/limits` update per-tenant quotas/budgets
- `GET /tenants/:tenantId/usage` export token/cost ledger + daily aggregates
- `GET /tenants/:tenantId/outbound` inspect delivery state
- `POST /tenants/:tenantId/outbound/:deliveryId/redrive` re-drive dead-lettered outbound delivery

## Local migration helpers

```bash
node cloudflare/scripts/export-local-state.mjs --tenant-id tenant-dev
node cloudflare/scripts/json-export-to-sql.mjs
```

This exports local SQLite + group files and produces SQL for D1 import workflows.

4. Start local dev server:

```bash
wrangler dev
```

5. Test health endpoint:

```bash
curl "http://127.0.0.1:8787/health"
```

6. Test webhook endpoint:

```bash
curl -X POST "http://127.0.0.1:8787/webhooks/test-channel" \
  -H "content-type: application/json" \
  -H "x-tenant-id: tenant-dev" \
  -d '{"chat_jid":"chat-1","sender":"user-1","content":"hello"}'
```
