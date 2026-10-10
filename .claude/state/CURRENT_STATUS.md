## Project Phase

Standard-profile v1 implementation complete and deployed. Ultrawork loop delivered: encrypted backup + isolated restore (drilled with evidence), owner reminders, bulk check-in, delegates, duplicate-as-template, urgency display, test release, release automation config, CI observability. Active: none except owner-blocked CI items below.

## Completed

- [x] Full product: TypeScript monorepo (Fastify API + React web + Postgres + Caddy), auth with TOTP/WebAuthn/recovery, switches, heartbeat + trigger engine, delivery channels (email/webhook/Telegram), audit trail with details/filters/export, reports ledger + export dialog, admin navigation, consistent list pagination/search
- [x] Gates green at HEAD: format, lint, typecheck, full test suites (API 221, web 118, crypto 64, DB 16, e2e journey), build, security verifier (20 PASS / 2 WARN / 0 FAIL), live smoke
- [x] Deployed stack healthy (api/caddy/db) at http://100.124.184.116; repo pushed to origin/main (momokii/heartbeat-vault)
- [x] ADR 009 (auth libraries) accepted as shipped
- [x] Dependency sweep: pg 8.23.1, drizzle-orm 0.45.3, nodemailer 10.0.16, fastify/cookie, argon2, jsdom, tsx, typescript-eslint, root dev tooling — each gated and committed
- [x] E2E bootstrap journey repaired (selector disambiguation) and passing
- [x] BACKUP_ENCRYPTION_KEY set (mode 600, gitignored); encrypted backup created; isolated restore drill executed with evidence (live DB proven untouched, zero leftovers); stale plaintext backup shredded
- [x] GHSA ignore list reviewed per-finding (22 entries, all dev-only paths, zero production reachability) and documented in docs/SECURITY.md
- [x] CI observability: per-package matrix jobs, JUnit annotations, phantom workspace dep fixed (CI typecheck/build green), Caddy smoke fixed (green), audit gate green
- [x] Oracle reviews passed with VERIFIED verdicts: backup split, reminder delivery, scheduler isolation, delegate auth (incl. ambiguity + cancel flaws found and fixed), redaction, final gap review

## In Progress

- [ ] None autonomous. Owner-blocked: CI `tests (api)` job red without public logs (green locally in every configuration); release-please red (likely Actions token permissions).

## Blocked

- CI failure logs + Actions token-permission check require owner GitHub access (TASK-005).

## Open Questions (require user decisions)

- Phase 0 design approval was never formally recorded (historical; not fabricated)
- Hardened Vault/OpenBao profile: deferred by decision (ADR-007)
- License: MIT vs Apache never finally picked
- Node baseline: repo allows Node 20 (.nvmrc), CI/local run 22 — vitest 5.0.3 needs ≥22.12, so its bump is deferred until the baseline is decided

## Security Notes

- Security standards apply from first commit; no suppressions in app code (`as any`/`ts-ignore` absent)
- All current `pnpm audit` findings are dev-only paths (testcontainers/vite/eslint chains); zero production reachability — verified per-finding
- Workspace hygiene: no tracked secrets; `.env` mode 0600; stale plaintext backup shredded; no leftover QA containers/networks/volumes

## Last Updated

- Ultrawork loop session: all waves implemented, Oracle-verified, deployed, and pushed; CI green except api-job (needs owner logs) and release-please (needs owner token check); workspace cleaned.
  [Agent must update this timestamp and append a session summary after every session.]
