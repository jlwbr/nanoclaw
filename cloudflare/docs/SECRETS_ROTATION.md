# Cloudflare Secrets Rotation

Rotate these secrets on a fixed cadence (recommended: every 90 days) and after any incident:

- `WEBHOOK_SHARED_SECRET`
- `SLACK_SIGNING_SECRET`
- `TELEGRAM_WEBHOOK_SECRET`
- `DISCORD_WEBHOOK_SECRET`
- `AGENT_RUNTIME_HTTP_URL` auth headers/tokens (if HTTP mode)
- `OUTBOUND_HTTP_URL` auth headers/tokens (if HTTP mode)

## Procedure

1. Generate new secrets in your secret manager.
2. Set secrets in the target Cloudflare environment:

```bash
wrangler secret put WEBHOOK_SHARED_SECRET --env staging --config cloudflare/wrangler.toml
wrangler secret put WEBHOOK_SHARED_SECRET --env prod --config cloudflare/wrangler.toml
```

3. Rotate upstream provider configuration (Slack/Telegram/Discord webhook secrets) to match.
4. Deploy worker to staging, run smoke checks, then deploy prod.
5. Invalidate old secrets in provider dashboards and secret manager.
6. Record rotation date + operator in internal audit log.

## Verification checklist

- [ ] `POST /health` still returns `ok: true`
- [ ] webhook signatures validate with new secret
- [ ] old signature is rejected
- [ ] queue processing and outbound delivery continue normally
