## Cursor Cloud specific instructions

NanoClaw is a single Node.js process that routes messages from chat channels to Claude AI agents running in Docker containers. See `CLAUDE.md` for key files and development commands.

### Services

| Service | How to run | Notes |
|---------|-----------|-------|
| Orchestrator (dev) | `npm run dev` | Requires Docker running + at least one channel configured |
| Docker daemon | `sudo dockerd` | Must be running before the orchestrator starts |

### Dev commands

Standard commands are in `package.json` scripts:

- `npm run dev` — run with hot reload (tsx)
- `npm run build` — compile TypeScript
- `npm test` — run all vitest tests (297 tests, no Docker required)
- `npm run typecheck` — TypeScript type checking
- `npm run format:check` — prettier format check
- `npm run format:fix` — auto-fix formatting

### Caveats

- **No channels by default.** A fresh clone has no messaging channels installed. The app will exit with `"No channels connected"` — this is expected. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are added via Claude Code skills like `/add-whatsapp`.
- **Docker is required at startup.** The orchestrator calls `docker info` at boot and fatally exits if Docker is unreachable. In Cloud Agent environments, Docker must be started manually (`sudo dockerd &`) before running the app.
- **`better-sqlite3` is a native addon.** It compiles during `npm install` and requires gcc/make/python3 (pre-installed in Cloud Agent VMs). If `npm install` fails on this module, check build tools.
- **Tests use in-memory SQLite.** Unit/integration tests do not require Docker or any external services.
- **Pre-commit hook runs `npm run format:fix`** via husky. This auto-formats staged files before commit.
