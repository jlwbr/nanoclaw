# NanoClaw Cloudflare Event-Driven Migration Roadmap

Status: Draft v1  
Owner: Platform/Infra  
Last updated: 2026-03-03

---

## 1) Goal

Convert NanoClaw from a host-polling, local-Docker architecture into a Cloudflare-hosted, event-driven architecture where:

- inbound messages arrive via webhooks/events
- tenant state is persisted in Cloudflare data products
- orchestration is triggered by events (not polling loops)
- agent execution runs in isolated Cloudflare containerized runtime
- billing can be measured by token usage and usage events

This roadmap assumes **shared Cloudflare account infrastructure** with **logical tenant isolation** (tenant IDs), not one Cloudflare account per customer.

---

## 2) Current state (baseline)

Today, core behavior relies on:

- `src/index.ts`: polling message loop + scheduler + IPC watcher startup
- `src/db.ts`: local SQLite (`store/messages.db`)
- `src/container-runner.ts` + `src/container-runtime.ts`: local Docker lifecycle
- `src/group-queue.ts`: in-memory queue + per-group process tracking
- `src/ipc.ts`: filesystem IPC (`data/ipc/...`)
- local filesystem state:
  - `groups/*` (memory and files)
  - `data/sessions/*` (Claude session state)
  - `store/*` (SQLite + auth)

The target architecture removes polling and host-local assumptions.

---

## 3) Target architecture (Cloudflare)

### 3.1 Control/data flow

1. Channel webhook -> Worker route (HTTP event)
2. Worker validates signature and writes canonical event
3. Worker forwards to per-tenant Durable Object (DO)
4. DO deduplicates, updates tenant state, and enqueues run request
5. Queue consumer invokes containerized agent runtime
6. Runtime streams outputs back via DO callback endpoint
7. DO persists conversation/task state and sends outbound channel reply

### 3.2 Cloudflare components

- **Workers**: HTTP ingress/egress, API endpoints, queue consumers
- **Durable Objects**: per-tenant orchestrator and deterministic coordination
- **D1**: relational metadata (messages index, groups, tasks, sessions pointers)
- **R2**: large artifacts and per-group files (`CLAUDE.md`, transcripts, logs)
- **Queues**: async agent run jobs, retries, dead-letter patterns
- **Containers (Beta)**: isolated runtime for agent execution and tools
- **AI Gateway (optional but recommended)**: model routing, analytics, rate controls

---

## 4) Migration principles

1. **Event-driven first**: no polling loops in production data path
2. **Idempotency everywhere**: all webhook and queue handlers must be safe to replay
3. **Tenant isolation by design**: every table key and object path scoped by `tenant_id`
4. **Durable state off ephemeral runtime**: container disk treated as disposable
5. **Incremental rollout**: channel-by-channel and tenant cohort migration

---

## 5) Phased roadmap

## Phase 0 - Decision freeze and architecture spec

### Deliverables

- ADR describing final Cloudflare topology
- supported channels for first launch
- tenant identity and auth strategy
- security and compliance boundary document

### Required decisions

- Which channels ship first (recommended: Slack/Discord/Telegram webhook-first)
- WhatsApp strategy (recommended: official Cloud API only, no Baileys for SaaS)
- Session persistence strategy for agent runtime
- Container usage policy while Cloudflare Containers is in Beta

### Exit criteria

- Architecture RFC approved
- Risks accepted and owners assigned

---

## Phase 1 - Cloudflare project bootstrap

### Tasks

1. Create Worker project skeleton (`workers/` or repo root migration)
2. Add `wrangler` config with bindings for:
   - D1
   - R2
   - Queues
   - Durable Objects
   - Containers binding
3. Add environments (`dev`, `staging`, `prod`) with isolated resources
4. Add secrets management and rotation procedure
5. Add CI deploy pipeline for Worker and migration scripts

### Code touchpoints

- New Cloudflare app entrypoint (`src/cloudflare/index.ts` or equivalent)
- `wrangler.toml` / `wrangler.jsonc`
- deployment scripts in `scripts/`

### Exit criteria

- `dev` environment deploys cleanly
- test request reaches Worker endpoint

---

## Phase 2 - Data model redesign (tenant-aware)

### Tasks

1. Design D1 schema with explicit `tenant_id`:
   - `messages`
   - `chats`
   - `registered_groups`
   - `sessions`
   - `router_state`
   - `scheduled_tasks`
   - `task_run_logs`
   - `idempotency_keys`
2. Add composite indexes for hot paths (`tenant_id`, `chat_jid`, `timestamp`)
3. Map filesystem state to R2 key conventions:
   - `tenants/{tenant_id}/groups/{group}/CLAUDE.md`
   - `tenants/{tenant_id}/sessions/...`
   - `tenants/{tenant_id}/logs/...`
4. Create migration tooling for existing local SQLite/files data import

### Code touchpoints

- Replace/parallelize `src/db.ts` with D1 data access layer
- Add storage abstraction module (`src/storage/*`)

### Exit criteria

- All required queries run against D1
- sample tenant data restored from migration scripts

---

## Phase 3 - Event ingress and canonical event pipeline

### Tasks

1. Implement webhook endpoints per channel
2. Verify signatures and normalize payloads to canonical `InboundEvent`
3. Add deterministic event IDs for dedupe
4. Persist inbound event envelope before orchestration
5. Route event to tenant DO

### Code touchpoints

- replace long-lived channel clients under `src/channels/*` with webhook adapters
- new `src/events/normalize.ts`, `src/events/validate.ts`

### Exit criteria

- Duplicate webhook deliveries do not duplicate responses
- Event replay test passes

---

## Phase 4 - Durable Object orchestration (replace polling loop)

### Tasks

1. Implement `TenantOrchestratorDO` with methods:
   - `ingestEvent`
   - `triggerAgentRun`
   - `handleAgentOutput`
   - `scheduleTask` / `cancelTask`
2. Move logic from `src/index.ts` polling loop into event handlers
3. Move queue logic from `src/group-queue.ts` into DO state + Queue handoff
4. Replace timestamp cursor logic with event offsets/idempotency records

### Code touchpoints

- `src/index.ts` (major decomposition/replacement)
- `src/group-queue.ts` (retire or re-implement as DO workflow logic)

### Exit criteria

- No periodic polling required for message processing
- Concurrency control remains per-tenant/per-group deterministic

---

## Phase 5 - Scheduler migration (DO alarms + Cron triggers)

### Tasks

1. Port scheduler behavior from `src/task-scheduler.ts`
2. Use DO alarms for near-term job wakeups
3. Use Cron trigger only for safety reconciliation sweeps
4. Maintain task run logs and retry policy in D1

### Exit criteria

- all task CRUD operations available
- missed execution recovery path verified

---

## Phase 6 - Agent runtime migration to Cloudflare containerized execution

### Tasks

1. Convert `container/agent-runner` to stateless request worker:
   - input from request payload/R2 refs
   - output as streamed events/callbacks
2. Replace local Docker spawn code:
   - retire `src/container-runtime.ts` local runtime assumptions
   - rewrite `src/container-runner.ts` to call Cloudflare Containers binding
3. Move mount-based filesystem assumptions to R2 fetch/sync model
4. Define runtime contract:
   - request schema
   - output event schema
   - error taxonomy

### Exit criteria

- end-to-end run invoked via Cloudflare Containers
- retry and timeout behavior matches or improves current guarantees

---

## Phase 7 - IPC removal and transport redesign

### Tasks

1. Remove filesystem IPC (`data/ipc`) dependency
2. Replace with:
   - queue messages for async commands
   - DO RPC or HTTP callbacks for sync events
3. Port authorization checks from `src/ipc.ts` into DO command handlers

### Exit criteria

- no `data/ipc/*` runtime path usage
- authorization matrix parity with current implementation

---

## Phase 8 - Outbound channel adapters and delivery guarantees

### Tasks

1. Build per-channel outbound send adapters with retries/backoff
2. Add delivery status tracking table
3. Add dead-letter handling and re-drive tooling
4. Preserve trigger semantics (`requiresTrigger`, `isMain`) at tenant/group level

### Exit criteria

- outbound reliability SLO defined and measured
- duplicate-send prevention validated

---

## Phase 9 - Security, isolation, and abuse controls

### Tasks

1. Enforce strict tenant scoping in all D1 queries and R2 paths
2. Add per-tenant quotas:
   - requests/min
   - token budget/day
   - max concurrent runs
3. Add ingress validation hardening and replay windows
4. Add egress policy guardrails for runtime where feasible
5. Add security audit logs and incident runbooks

### Exit criteria

- isolation tests pass
- abuse and runaway-cost controls enabled by default

---

## Phase 10 - Billing and token economics

### Tasks

1. Persist model usage per run:
   - input tokens
   - output tokens
   - cached input tokens (if available)
2. Compute COGS and margin per tenant, per period
3. Implement billing-ready usage export
4. Add soft/hard budget enforcement and alerts

### Exit criteria

- per-tenant token ledger matches provider invoices within tolerance
- overage and plan limits enforce correctly

---

## Phase 11 - Observability and operations

### Tasks

1. Structured logs with correlation IDs:
   - `tenant_id`
   - `event_id`
   - `run_id`
2. Metrics dashboard:
   - p50/p95 end-to-end latency
   - queue lag
   - error rate by channel/model
   - run timeout rate
3. Tracing across Worker -> DO -> Queue -> Runtime -> channel send
4. Pager and on-call runbooks

### Exit criteria

- operators can identify and remediate failed runs quickly
- rollback and re-drive playbooks tested

---

## Phase 12 - Rollout and cutover

### Steps

1. **Shadow mode**: mirror production webhooks into new pipeline without user responses
2. **Canary tenants**: low-risk internal tenants first
3. **Partial channel cutover**: one channel at a time
4. **Progressive traffic increase** with rollback guardrails
5. **Legacy decommission**:
   - disable polling paths
   - remove local Docker runtime dependencies
   - archive old migration scripts

### Exit criteria

- 100% tenant traffic on new event-driven stack
- legacy host-polling path retired

---

## 6) Module-by-module migration map

| Current module | Action | Target |
|---|---|---|
| `src/index.ts` | Decompose and replace polling startup | Worker route + DO handlers |
| `src/db.ts` | Replace local SQLite driver | D1 repository layer |
| `src/group-queue.ts` | Re-implement queue semantics | DO state + Queues |
| `src/ipc.ts` | Remove filesystem IPC | DO commands + queue callbacks |
| `src/task-scheduler.ts` | Port logic | DO alarms + Cron reconciler |
| `src/container-runner.ts` | Rewrite execution transport | Cloudflare Containers invocation |
| `src/container-runtime.ts` | Retire local Docker coupling | Container binding abstraction |
| `src/channels/*` | Replace long-lived connectors | Webhook adapters + outbound clients |
| `container/agent-runner/*` | Adapt for stateless cloud invocations | runtime request/response contract |

---

## 7) Testing plan by phase

### Unit tests

- canonical event normalization
- D1 query correctness (tenant-scoped)
- dedupe/idempotency behavior
- scheduler time math and retries

### Integration tests

- webhook -> response roundtrip
- queue retry and dead-letter flows
- task scheduling and alarm wakeups
- outbound send retry behavior

### Load tests

- burst message ingress per tenant
- concurrent tenant isolation
- queue lag under sustained traffic

### Security tests

- cross-tenant access attempts
- replayed webhook events
- malformed payloads/signature bypass attempts

---

## 8) Suggested milestone timeline (high-level)

- M1: Phases 0-2 complete (foundations and tenant data model)
- M2: Phases 3-5 complete (event ingestion, orchestration, scheduler)
- M3: Phases 6-8 complete (runtime, IPC removal, channel delivery)
- M4: Phases 9-12 complete (security, billing, observability, full cutover)

Do not commit to a public date until Phase 2 risk and complexity are validated.

---

## 9) Known risks and mitigations

1. **Cloudflare Containers Beta risk**
   - Mitigation: abstraction layer for runtime provider; keep fallback provider option
2. **State migration complexity**
   - Mitigation: dual-write period and replayable migration scripts
3. **Webhook provider inconsistencies (duplicates, ordering)**
   - Mitigation: strict idempotency keys and event versioning
4. **Token cost runaway**
   - Mitigation: per-tenant budgets, output token caps, model routing policies
5. **Channel-specific edge cases**
   - Mitigation: staged channel rollout with canary tenants

---

## 10) Definition of done

Migration is complete when all are true:

- no polling-based message loop in production path
- no host-local Docker dependency for production runs
- no filesystem IPC dependency
- all tenant state and artifacts stored in Cloudflare-managed services
- token usage and billing ledger available per tenant
- canary and full-rollout SLOs met for 30 consecutive days

