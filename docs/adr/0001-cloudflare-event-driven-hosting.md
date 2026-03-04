# ADR 0001: Cloudflare Event-Driven Hosting Topology

Status: accepted  
Date: 2026-03-03

## Context

NanoClaw currently runs as a single host process with local Docker, local SQLite, polling loops, and filesystem IPC. Hosted SaaS requires tenant isolation, webhook-first execution, and usage-based billing.

## Decision

Adopt a Cloudflare-native event-driven architecture:

- Worker for HTTP ingress/API and queue consumers
- Durable Objects for per-tenant orchestration and deterministic coordination
- D1 for tenant-scoped metadata/state
- R2 for tenant artifacts and group/session files
- Queues for run dispatch, retries, and outbound delivery
- Runtime execution via service binding (`AGENT_RUNTIME`) with HTTP fallback

## Channel launch scope

Launch channels: Slack, Telegram, Discord (webhook-first).  
WhatsApp strategy: official Cloud API only for hosted SaaS.

## Tenant identity/auth strategy

- `tenant_id` required on all ingress requests
- Signature verification by channel secret
- Per-tenant policy row controls quotas and hard blocks

## Security/compliance boundary

- Every D1 query and R2 key path is tenant-scoped
- Security audit log persisted for rate-limit, budget, dead-letter, and hard-block events
- No filesystem IPC in cloud runtime path

## Consequences

- Significant reduction in always-on infrastructure costs
- Increased dependency on Cloudflare primitives
- Requires migration scripts and careful rollout (shadow + canary)
