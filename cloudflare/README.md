# NanoClaw Cloudflare Hosted Module

This module adds an additive Cloudflare-native hosted runtime without changing the existing local Node.js core behavior.

## Components

- **Ingress/API**: Worker routes in `src/index.ts` and `src/api/routes.ts`
- **Orchestration**: Durable Object per tenant (`TenantOrchestratorDurableObject`)
- **Async pipelines**: Queues (`agent_run`, `outbound_delivery`)
- **Operational DB**: D1 schema in `migrations/0001_initial.sql`
- **Artifacts**: R2 adapter (`src/adapters/r2-artifacts.ts`)
- **Runtime**: Cloudflare service binding `AGENT_RUNTIME` (HTTP fallback in local/dev)
- **Billing**: Autumn adapter (`src/adapters/autumn-billing.ts`)
- **Frontend**: Minimal hosted UI from Worker routes (`/` + `/app.js`)

## Commands

- Build/typecheck hosted module:
  - `npm run build:cloudflare`
- Run hosted test suite:
  - `npm run test:cloudflare`

## API surface

- `GET /health`
- `POST /webhook/inbound`
- `POST /webhook/billing/autumn`
- `GET /api/tenants/:tenantId/dashboard`
- Task APIs:
  - `GET /api/tenants/:tenantId/tasks`
  - `POST /api/tenants/:tenantId/tasks`
  - `POST /api/tenants/:tenantId/tasks/:taskId/pause`
  - `POST /api/tenants/:tenantId/tasks/:taskId/resume`
  - `POST /api/tenants/:tenantId/tasks/:taskId/cancel`
  - `POST /api/tenants/:tenantId/tasks/:taskId/run_now`
  - `POST /api/tenants/:tenantId/reconcile`
- Usage/outbound:
  - `GET /api/tenants/:tenantId/usage`
  - `GET /api/tenants/:tenantId/outbound?status=...`
  - `POST /api/tenants/:tenantId/outbound/:deliveryId/redrive`
- Billing:
  - `GET /api/tenants/:tenantId/billing/summary`
  - `GET /api/tenants/:tenantId/billing/entitlements?feature=...`
  - `POST /api/tenants/:tenantId/billing/portal-session`
