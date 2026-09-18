# Environment Guide

> **Self-update instruction:** Once the actual stack and Docker setup are
> established, replace placeholder commands below with real, verified commands.

## Environment Definitions

| Environment | Purpose | Characteristics |
|---|---|---|
| `development` | Local development and feature work | Debug mode on, verbose logging, hot reload, relaxed auth optional, no real external services required |
| `staging` | Pre-production validation | Mirrors production config, uses real (sandboxed) services, no debug mode |
| `production` | Live system | No debug, minimal logging, hardened config, real services and secrets |

## Agent Behavior by Environment

### In `development`

- Verbose logging is acceptable and encouraged for debugging.
- Debug ports and tools may be exposed (e.g., database GUIs, profilers).
- Seed data scripts and fixtures may be run freely.
- Hot reload and volume mounts are expected in Docker Compose.

### In `staging` or `production`

- Never run destructive commands (`DROP`, `DELETE`, `TRUNCATE`, irreversible
  migrations) without explicit written confirmation from the user.
- Never directly modify production config files or secrets.
- Any proposed change must be presented as a written plan first — not executed
  immediately.
- Flag explicitly if you detect you are operating in a non-development context.

## Docker Compose Environment Pattern

All Docker-based projects must follow this override pattern:

- `docker-compose.yml` — base service definitions, environment-agnostic.
- `docker-compose.override.yml` — development overrides: hot reload, debug
  ports, volume mounts for live code; loaded automatically by Docker Compose.
- `docker-compose.prod.yml` — production overrides: no volume mounts, resource
  limits, restart policies, no exposed debug ports; loaded explicitly with `-f`.

```bash
# Development (automatic — docker-compose.override.yml is loaded by default)
docker-compose up

# Production (explicit — only base + prod override)
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

The agent must always know which command applies to the current context and must
**always ask** before running any Compose command that is not clearly development.

## `.env` File Pattern

```text
.env.example        # Committed to repo — all keys with placeholder values + comments
.env                # Never committed — actual development secrets
.env.staging        # Never committed — staging secrets
.env.production     # Never committed — production secrets
```

Rules:

- `.env` (and all real secret files) must be listed in `.gitignore` before the
  first commit of any session. Verify with `git check-ignore .env`.
- `.env.example` must list every required variable with a placeholder value and
  a one-line comment describing each.
- Application code reads config from the environment, never from a committed
  secrets file.

## Health-Check / Test Commands (fill in once known)

| Purpose | Command (placeholder) |
|---|---|
| Health check / startup | _TBD_ — record real command after first setup |
| Run full test suite | _TBD_ — record real command after first setup |
| Lint / typecheck | _TBD_ |
