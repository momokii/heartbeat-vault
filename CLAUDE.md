# CLAUDE.md — Heartbeat Vault

> Project conventions for all agent sessions. Read first, every session.

## Source of truth

- `docs/BRIEF.md` — the full project brief, verbatim. All work must trace to it.
- `docs/PROGRESS.md` — phase checklist + gate status. Update at every gate.
- `docs/ASSUMPTIONS.md` — every default adopted without explicit user answer.

## Session-start protocol

1. Read `.claude/README.md`, `.claude/HOW_TO_RESUME.md`.
2. Read `.claude/state/CURRENT_STATUS.md`, `.claude/state/TASK_QUEUE.md`.
3. Read `.claude/AGENT_RULES.md`, `.claude/CODING_STANDARDS.md`, `.claude/SECURITY_STANDARDS.md`, `.claude/ENVIRONMENT_GUIDE.md`.
4. Read `docs/BRIEF.md` (once per session minimum), `docs/PROGRESS.md` (resume point).
5. Identify `APP_ENV` (default `development`). Staging/production: written plan + explicit confirmation before any change/migration/destructive op.

## Non-negotiable rules

- Phase 0 gate: the design document's formal approval was never separately recorded; implementation proceeded under explicit user direction (see `docs/PROGRESS.md` Open issues — do not fabricate an approval event). Treat `docs/BRIEF.md` plus current user direction as the authority for new work.
- Never invent custom crypto. Audited primitives/libraries only (AEAD: AES-256-GCM or XChaCha20-Poly1305; KDF: Argon2id; asymmetric: X25519 / age / libsodium sealed boxes; sharing: Shamir).
- Never commit secrets; never log sensitive data; never run destructive commands outside the project directory.
- Conventional Commits (`<type>(<scope>): <subject>`), one logical change per commit. Never commit without explicit user request (per `.claude/AGENT_RULES.md`).
- Never weaken `.claude/SECURITY_STANDARDS.md` without user approval + `DECISIONS_LOG.md` entry.
- Do not mention the background inspiration (person/post) anywhere in code, docs, or commits.
- Correctness over speed. Never fake/stub security-critical behavior — say explicitly what is unfinished or unverifiable.

## Architecture (shipped: standard profile v1)

- Shipped: TypeScript monorepo (pnpm + Turborepo), Fastify typed API backend, React + Tailwind + shadcn/ui, Drizzle ORM + migrations, Postgres-backed durable job queue, Caddy reverse proxy. Every significant choice gets an ADR in `docs/adr/`.
- Hard requirements: PostgreSQL primary DB, monorepo (or justified alternative), everything Docker-based.
- Profiles: `standard` (app + Postgres + reverse proxy) vs `hardened` (+ Vault/OpenBao etc. via Compose profiles). Hardened must never become a release-path SPOF.

## Common commands

| Purpose         | Command                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| Env setup       | `cp .env.example .env` (never commit `.env`)                                  |
| Health check    | `curl -s http://127.0.0.1:18080/api/health` (dev) or `./install.sh status`    |
| Tests           | `pnpm test` (or per-package: `pnpm --filter @heartbeat-vault/api test`)       |
| Verify security | `scripts/verify-security.sh` (`--json` for machine output)                    |
| Install         | `./install.sh install` (idempotent; standard profile only, hardened deferred) |

## Testing instructions

- Test-first on every behavior change (RED → GREEN → SURFACE); characterization tests before refactors.
- Coverage thresholds enforced on crypto, auth, scheduler, delivery.
- Real Postgres (Testcontainers), Playwright E2E, Mailpit + mock Telegram/webhook doubles; no real third-party accounts.
- Failure-injection for scheduler/release path (crash mid-trigger, duplicate workers, DB restart, clock skew, downtime recovery, Vault sealed/unreachable/restart).

## Docs map

- `README.md` (user end-to-end) · `docs/ARCHITECTURE.md` · `docs/SECURITY.md` · `docs/THREAT_MODEL.md` · `docs/OPERATIONS.md` · `docs/adr/` · API reference · `CONTRIBUTING.md` (all Phase 12).
