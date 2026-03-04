# Cloudflare Event-Driven Bootstrap

This directory contains the first implementation slice for migrating NanoClaw to an event-driven Cloudflare architecture.

## What is included

- Worker entrypoint (`src/index.ts`) for:
  - health endpoint
  - webhook ingest endpoint (`POST /webhooks/:channel`)
  - task management endpoints (`/tenants/:tenantId/tasks*`)
  - canonical event normalization and forwarding to per-tenant Durable Object
  - queue consumer for agent run dispatch lifecycle updates
  - cron-trigger reconciliation sweep for due scheduled tasks
- Durable Object skeleton (`src/durable-objects/tenant-orchestrator.ts`) for:
  - idempotent event ingestion
  - basic persistence into D1
  - enqueueing run jobs to Cloudflare Queues
  - task CRUD operations and alarm-based scheduling
- Initial tenant-aware D1 schema migration (`d1/0001_tenant_core.sql`)
- Queue run tracking schema migration (`d1/0002_agent_run_jobs.sql`)
- Run output/token usage schema migration (`d1/0003_agent_run_results.sql`)
- Scheduler/query performance indexes (`d1/0004_scheduler_indexes.sql`)
- Wrangler configuration scaffold (`wrangler.toml`)

## Why this is high-impact

This is the foundation that unblocks:

1. replacing polling with event ingress
2. introducing tenant-aware persistence
3. moving orchestrator logic into Durable Objects

## Current scope

This bootstrap is intentionally minimal and does **not** yet include:

- Cloudflare Containers runtime invocation
- channel-specific signature verification logic for each provider
- outbound message delivery adapters

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
```

## Runtime execution modes

Queue jobs are executed through a runtime abstraction:

- `AGENT_RUNTIME_MODE=stub` (default): marks jobs completed with deterministic stub output.
- `AGENT_RUNTIME_MODE=http`: sends run payload to `AGENT_RUNTIME_HTTP_URL` and maps response fields into run status/output tables.

`AGENT_QUEUE_MAX_ATTEMPTS` controls bounded queue retries before terminal failure.

## Scheduler APIs

- `POST /tenants/:tenantId/tasks` create task
- `GET /tenants/:tenantId/tasks?status=active|paused|completed` list tasks
- `POST /tenants/:tenantId/tasks/:taskId/pause`
- `POST /tenants/:tenantId/tasks/:taskId/resume`
- `POST /tenants/:tenantId/tasks/:taskId/cancel`
- `POST /tenants/:tenantId/tasks/:taskId/run_now`
- `POST /tenants/:tenantId/tasks/reconcile` force reconciliation sweep

Primary wakeups happen with Durable Object alarms; cron is a fallback safety sweep.

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

