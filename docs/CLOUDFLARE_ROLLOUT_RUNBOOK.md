# Cloudflare Event-Driven Rollout Runbook

## 1. Shadow mode

- Mirror inbound webhooks to `/webhooks/:channel` in staging tenant IDs.
- Process full pipeline but suppress external outbound sends (`OUTBOUND_MODE=stub`).
- Compare run outputs and latency with legacy path.

## 2. Canary tenants

- Enable `OUTBOUND_MODE=http` for internal low-risk tenants.
- Monitor:
  - queue retries
  - dead-letter counts
  - p95 latency
  - token usage drift

## 3. Progressive rollout

- Move one channel at a time (Slack -> Telegram -> Discord -> WhatsApp Cloud API).
- Increase traffic in fixed cohorts (5% / 20% / 50% / 100%).
- Keep rollback switch ready (`hard_block` + channel routing rollback).

## 4. Rollback

- Set tenant/channel routing back to legacy path.
- Keep shadow mirror enabled for diagnostics.
- Re-drive dead letters only after fix deployment.

## 5. Decommission criteria

- no production polling loop usage
- no local Docker dependency in production path
- no filesystem IPC in production path
- stable SLO compliance for 30 days
