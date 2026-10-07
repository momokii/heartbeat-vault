## Project Phase

Standard-profile v1 implementation complete and deployed. Active work: maintenance sweep
(dependency updates, docs/state refresh, GHSA review).

## Completed

- [x] Full product: TypeScript monorepo (Fastify API + React web + Postgres + Caddy), auth with TOTP/WebAuthn/recovery, switches, heartbeat + trigger engine, delivery channels (email/webhook/Telegram), audit trail with details/filters/export, reports ledger + export dialog, admin navigation, consistent list pagination/search
- [x] Gates green at HEAD: format, lint, typecheck, full test suites, build, security verifier, live smoke
- [x] Deployed stack healthy (api/caddy/db) at http://100.124.184.116; repo pushed to origin/main (momokii/heartbeat-vault)
- [x] ADR 009 (auth libraries) accepted as shipped
- [x] Dependency sweep: pg 8.23.1, drizzle-orm 0.45.3, nodemailer 10.0.16, fastify/cookie, argon2, jsdom, tsx, typescript-eslint, root dev tooling — each gated and committed
- [x] E2E bootstrap journey repaired (selector disambiguation) and passing

## In Progress

- [ ] Maintenance sweep: docs/state refresh, GHSA ignore-list review, deferred-upgrade records (vite 8, eslint 10, TS 7, vitest engine, nobles/webauthn/testcontainers majors)

## Blocked

None.

## Open Questions (require user decisions)

- Phase 0 design approval was never formally recorded (historical; not fabricated)
- Hardened Vault/OpenBao profile: deferred by decision (ADR-007)
- License: MIT vs Apache never finally picked
- BACKUP_ENCRYPTION_KEY unset → installer backups unencrypted
- Node baseline: repo allows Node 20 (.nvmrc), CI/local run 22 — vitest 5.0.3 needs ≥22.12, so its bump is deferred until the baseline is decided
- Backup + restore never exercised against real production data

## Security Notes

- Security standards apply from first commit; no suppressions in app code (`as any`/`ts-ignore` absent)
- All current `pnpm audit` findings are dev-only paths (testcontainers/vite/eslint chains); zero production reachability — verified per-finding
- 18 historical GHSA ignores under review in this sweep

## Last Updated

- Maintenance sweep session: baseline green, pg/drizzle/nodemailer/cookie/argon2/jsdom/tsx/dev-tooling bumped with gates, e2e repaired, docs corrections committed (uninstall message, SESSION_SECRET wording, ADR 009).
  [Agent must update this timestamp and append a session summary after every session.]
