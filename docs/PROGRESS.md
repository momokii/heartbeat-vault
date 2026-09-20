# Heartbeat Vault — Progress Tracker

> Memory across long sessions. Read `CLAUDE.md`, `docs/BRIEF.md`, then this file first on resume.
> Updated at each phase gate per Brief Section 14.

## Phase 0: Discovery and Design Gate — IN PROGRESS (started 2026-09-20)

- [x] Save brief verbatim to `docs/BRIEF.md`
- [x] Init git repo (pre-existing bootstrap commits `651fcae`, `693d6e5` on `main`)
- [x] Research best practices (Sections 5–12 + 7.1) — 5 librarian briefs collected 2026-09-20
- [x] Clarifying questions asked — user answered 2026-09-20 (see Key decisions)
- [x] Design document produced (`docs/DESIGN.md`: architecture, threat model, data model, crypto, ADR list)
- [ ] User approval received — GATE, no implementation before this
- [ ] Assumptions recorded in `docs/ASSUMPTIONS.md` (defaults only where user cannot answer)
- [ ] Commit Phase 0 gate (Conventional Commits)

## Phase 1: Repo and tooling foundation — IN PROGRESS (started 2026-09-20, T1.1 monorepo skeleton)

- Gate: monorepo layout, lint/typecheck/test tooling, Docker base, `docs/PROGRESS.md` updated, committed.
- [x] T1.1 monorepo skeleton — pnpm workspaces + Turborepo + tsconfig.base.json strict + 6 package skeletons (no app code)
- [x] T1.2 lint/typecheck/format/hooks — ESLint 9.39.5 flat + typescript-eslint 8.70.0 + globals 16.5.0 + eslint-config-prettier 10.1.8 + Prettier 3.9.8 + lint-staged 17.5.1 + Husky 9.1.7 + .editorconfig; `pnpm lint` (eslint .), `pnpm typecheck` (turbo → tsc --noEmit), `pnpm format:check` (prettier --check) pass; lint-staged + Husky pre-commit (`pnpm exec lint-staged`); all deps pinned exact; `pnpm audit` logged in DECISIONS_LOG 2026-09-20 (2 turbo advisories noted); `.claude/ENVIRONMENT_GUIDE.md` updated; no `as any`/`@ts-ignore`
- [x] T1.3 Docker base (standard profile) — `docker-compose.yml` (api + postgres:17-alpine@sha256:18cfe... + caddy:2-alpine@sha256:de23de... all pinned, no `latest`), `docker-compose.override.yml` (dev: 127.0.0.1-bound DB/API/admin ports, LOG_LEVEL debug), `docker-compose.prod.yml` (restart unless-stopped, resource limits, no dev mounts/ports, json-file rotation), `apps/api/Dockerfile` multi-stage node@sha256:b6f26b... non-root `USER node` + `tini` + placeholder `server.mjs` (`/health` 200, TODO Phase 3+), `Caddyfile` (`tls internal` LAN default, HSTS/CSP/headers, `reverse_proxy api:3000`), `.env.example` extended (all ports, DB/app/auth/MASTER_KEY, TLS options, channel placeholders); healthchecks `pg_isready` + caddy admin ping + api Node http; `docker compose config` (both base and prod) valid; `docker compose up -d --build` healthy (all 3); DB internal-only (no ports in base/prod, 127.0.0.1-only in override); containers least-privilege; staged only, no commit (2026-09-20)
- [x] T1.4 ADRs 001-002 plus docs scaffold — `docs/adr/001-monorepo-pnpm-turborepo.md`, `docs/adr/002-postgres-as-queue.md`, `docs/adr/README.md`, stub `docs/ARCHITECTURE.md` + `docs/SECURITY.md` (each one paragraph scope plus pointer to `docs/DESIGN.md`, no invented details); grounded in `docs/DESIGN.md` §§1-2 and `docs/BRIEF.md` §§7/7.1; prose only, no code or Docker or ADRs 003-010

## Phase 2: Data model and crypto core — IN PROGRESS (T2.1 DB done, T2.2-2.4 envelope/KDF/asymmetric done 2026-09-20)

- Envelope encryption (per-secret DEK + master key), Argon2id, AEAD (AES-256-GCM / XChaCha20-Poly1305), rotation.
- Gate: unit + known-answer-vector crypto tests pass, coverage threshold enforced.
- [x] T2.1 DB package schema + migrations — `packages/db/src/schema.ts` (14 tables per DESIGN.md §3: users/recipients/switches/sealed_payloads/heartbeats/trigger_jobs/vault_waits/delivery_jobs/dead_letter_jobs/scheduler_heartbeat/audit_log/invites/sessions/app_config; all timestamptz `clock_timestamp()`, bytea via customType, intervals, checks, FK cascades, UNIQUEs) + `drizzle.config.ts` + `drizzle/0000_brown_titania.sql` (`CREATE EXTENSION pgcrypto`, roles `migrator`/`app`, least-privilege GRANTs, `REVOKE UPDATE,DELETE ON audit_log FROM app`, default privileges) + `src/migrate.ts` runner (drizzle-orm migrator) + `src/seed.ts` idempotent `app_config` defaults only (ON CONFLICT DO NOTHING) + `test/helpers.ts` (`PostgreSqlContainer postgres:17-alpine` pinned via `@testcontainers/postgresql@10.14.0`, `createTestDb`/`getDb`/`truncateAll`/`destroyTestDb`) + `src/schema.test.ts` vitest+Testcontainers 7 tests (tables exist, UNIQUE(switch_id,deadline_at) enforced, audit_log REVOKE via non-superuser app_tester, timestamptz UTC, singleton check, sealed_payloads unique, idempotency_key unique); TDD RED→GREEN; `drizzle-orm@0.45.2`+`pg@8.13.3` exact, `drizzle-kit@0.31.4`+`testcontainers@10.14.0`+`@testcontainers/postgresql@10.14.0` pinned; `pnpm --filter @heartbeat-vault/db typecheck` clean strict no `as any`; `pnpm --filter @heartbeat-vault/db test` 7/7 green on real Postgres; `pnpm audit` 2026-09-20 logged (turbo GHSA-hcf7/GHSA-3qcw pre-existing, undici/tar-fs/esbuild via testcontainers dev-only noted); `.prettierrc.json` singleQuote→true to satisfy 2-space single-quote 100-width; no crypto/auth/scheduler code, no git commit (2026-09-20)
- [x] T2.2 envelope AEAD core — `packages/crypto/src/envelope.ts` TDD RED→GREEN (XChaCha20-Poly1305 via `@noble/ciphers@2.4.0` pinned, 32 B DEK per encrypt memzero, KEK wrap AAD `{kid,kekVersion,tenantId,switchId}`, version 1 prefix, constant-time tag via `equalBytes`); `envelope.test.ts` 9 tests (round-trip, 1-bit tag flip, ciphertext flip, wrong AAD, wrong KEK, nonce uniqueness 1000, version tamper, empty + 64KB); `pnpm --filter @heartbeat-vault/crypto typecheck` clean (strict, no `as any`); `pnpm audit` no new advisories on new deps; `DESIGN-NOTE.md` (ADR-005 draft + RED paste); no DB/KDF/Shamir code (T2.3/T2.4 deferred)
- [x] T2.3 KEK rotation + Argon2id KDF — `packages/crypto/src/kdf.ts` (`hashPassword`/`verifyPassword`/`deriveKEK`/`deriveKEKAsync`/`needsRehash` via `@node-rs/argon2@2.2.1` pinned, OWASP `m=19456,t=2,p=1`, 16 B salt, 32 B output, pepper `KEK_PEPPER` fail-closed via `requirePepper` option, no default) + `packages/crypto/src/rotation.ts` (`rotateKEK` pure re-wrap `wrappedDEK` + `needsRotation`, batch-friendly, idempotent, AAD-aware) TDD RED→GREEN (RED: `kdf.js`/`rotation.js` missing → 2 failed, 9 envelope passed; GREEN: 21 passed — envelope 9 + kdf 7 + rotation 5: PHC round-trip, wrong password, malformed PHC throws, needsRehash old m=4096, pepper changes output, missing pepper throws, derive deterministic 32B, re-wrap preserves decryptability, idempotent double-rotate, old KEK retained, needsRotation, batch); `pnpm --filter @heartbeat-vault/crypto typecheck` clean (strict, verbatimModuleSyntax workaround); `pnpm audit` 2026-09-20 no new advisory for `@node-rs/argon2@2.2.1` (pre-existing: turbo GHSA-hcf7+GHSA-3qcw, undici via testcontainers); `DESIGN-NOTE.md` ADR-005 extended + RED paste; envelope.ts read-only (index.ts exports added)
- [x] T2.4 asymmetric + Shamir — `packages/crypto/src/asymmetric.ts` (X25519 `libsodium-wrappers@0.8.4` pinned, `generateKeyPair`/`sealForRecipient`/`openSealedBox`/`sealForMany` 48B overhead, anonymous) + `packages/crypto/src/sharing.ts` (Shamir `shamir-secret-sharing@0.0.4` pinned, `splitSecret(n=5,t=3)`/`combineShares` validation `2<=t<=n<=255`, `createCommitment=BLAKE2b` via `@noble/hashes@1.8.0` + `verifyCommitment` constant-time); `asymmetric.test.ts` 5 tests (round-trip, wrong key fails, tamper fails, multi-recipient each opens, 48B overhead) + `sharing.test.ts` 5 tests (n=5,t=3, <t fails commitment, corrupt share fails, invalid n/t throws, commitment helper); TDD RED→GREEN 19 passed; `pnpm --filter @heartbeat-vault/crypto exec vitest run src/envelope.test.ts src/asymmetric.test.ts src/sharing.test.ts` + `typecheck` clean strict; `DESIGN-NOTE.md` updated (ADR-006 draft, custody v1 vs deferred); `pnpm audit` no new advisories on new deps (turbo/vite/tar-fs advisories pre-existing); envelope.ts untouched (2026-09-20)

## Phase 3: Auth, bootstrap, roles — NOT STARTED

- One-time expiring setup token, first-account-becomes-admin, setup endpoint permanently disabled; admin-invite default; Argon2id, TOTP 2FA, WebAuthn/passkeys, recovery codes, sessions/revocation, rate limit, lockout, audit log.

## Phase 4: Switches, heartbeat, trigger engine — NOT STARTED

- Modes: asymmetric-key + direct-delivery. Heartbeat options (button, signed email link, API token/webhook, Telegram, TOTP/passkey step-up), interval + escalation (reminders → warning → pending-trigger → final grace → fire), pause/vacation, dry-run. Triggers: missed-heartbeat, fixed datetime, panic, quorum. Pre-fire cancellation window.
- Correctness: downtime compensation + post-recovery grace (fail-safe default, documented), durable crash-safe idempotent multi-instance scheduling (Postgres advisory locks / leader election), no naive wall-clock trust, release-path queue/retry/alert (never silently lost).

## Phase 5: Delivery channels — NOT STARTED

- Pluggable architecture: SMTP first + webhook + Telegram minimum; retry/backoff, idempotency, receipts, dead-letter queue; recipient pre-approval; per-channel security guidance; payload options (encrypted blob + split key, one-time-view link, direct with explicit risk accept).

## Phase 6: Hardened-profile services — ADR-ONLY (T6.1 done 2026-09-20, implementation DEFERRED)

- Vault vs OpenBao ADR + licensing question; standard profile = app + Postgres + proxy only; hardened adds services via Compose profiles; no new SPOF in release path; least-privilege AppRole, short-lived tokens, audit device, Shamir-handled init/unseal. Tests + verify script + installer cover hardened when enabled.
- Gate: ADR-only wave, zero runtime code. No Compose service, no Dockerfile, no Vault/OpenBao client dep.
- [x] T6.1 hardened-profile ADRs + lint guard — `docs/adr/007-hardened-openbao-vs-vault.md` (OpenBao MPL-2.0 candidate default vs Vault CE BSL alternative: Transit key-never-leaves, KV/PKI/dynamic DB creds/audit/seal-unseal, API compat plus token-format caveat, licensing/maturity/operational cost, off-hot-release-path via cached wrapped DEKs plus queue/retry/alert on sealed or unreachable) + `docs/adr/008-caddy-vs-traefik.md` (Caddy 2.11 Alpine candidate: automatic TLS plus `tls internal` LAN plus LE/BYO, Traefik alt for dynamic scale, operational cost); `docs/adr/README.md` index 007/008 Accepted as direction, implementation DEFERRED; `eslint.config.mjs` `no-restricted-imports` guard banning `vault`/`openbao`/`node-vault` project-wide with ADR-007 DEFERRED message, verified by temp import of `vault` (eslint failed) then deleted; grounded in `docs/DESIGN.md` §§1-2, Brief §7.1, and research briefs; explicit DEFERRED markers, no runtime code or deps

## Phase 7: UI — IN PROGRESS (T7.1 shell done 2026-09-20)

- Guided first-run, dashboard (status / next check-in / armed), confirmations on dangerous actions, dark/light, WCAG AA, responsive, on-prem friendly.
- Gate: `pnpm --filter @heartbeat-vault/web build` green + typecheck clean, shell renders without feature pages.
- [x] T7.1 web app shell — Vite 6.4.3 + React 19.3.0 + react-router-dom 7.18.4 + Tailwind 4.3.3 + Zod 4.6.5 pinned exact, `@tailwindcss/vite` 4.3.3 + `@vitejs/plugin-react` 4.7.0, TS strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`) via `tsconfig.base.json`; `apps/web` layout shell (`Shell` header/nav/main/footer, skip link, `ThemeToggle` class-strategy persisted to `hv-theme`, responsive `max-w-6xl`), placeholder routes `/` `/login` `/setup` `*` 404, `src/lib/api-client.ts` typed fetch wrapper (env `VITE_API_BASE_URL`, `AbortSignal.any` timeout, Zod validation, `ApiError` typed), `src/lib/utils.ts` `cn` + `src/lib/theme.ts`, `components/ui` primitives hand-written (button/card/input/label/dialog) — no `shadcn` CLI, accessible (landmarks, labels, `focus-visible`, `aria-*`); `index.css` design tokens (zinc/emerald, zinc dark, `Geist` sans) — taste `taste-skill` minimalist trust-first, no purple/neon; `pnpm --filter @heartbeat-vault/web build` green (54 modules, 329 kB JS), `typecheck` clean, `lint` clean; `pnpm audit` 2026-09-20 — 0 new high on web deps (vite 6.4.3 patched, pre-existing turbo GHSA-hcf7/GHSA-3qcw + tar-fs/undici via testcontainers noted, not introduced); staged only
- [ ] T7.2 guided first-run wizard (next)
- [ ] T7.3 dashboard (next)
- [ ] T7.4 switch CRUD (next)
- [ ] T7.5 admin (next)

## Phase 8: Tests — NOT STARTED

- Unit + Testcontainers-Postgres integration, Playwright E2E (bootstrap → login → create/arm → heartbeat → trigger → delivery), crypto KAT/round-trip/negative, failure-injection (crash mid-trigger, duplicate workers, DB restart, clock skew, downtime recovery, Vault sealed/unreachable/restart), Vault/OpenBao container integration, authz/IDOR + rate-limit security tests, SAST/dependency/container/secret scans in CI, coverage thresholds on crypto/auth/scheduler/delivery, Mailpit + mock Telegram/webhook doubles.

## Phase 9: Verification script — NOT STARTED

- `scripts/verify-security.sh` (+ make/CLI target): read-only, non-destructive, never prints secrets; container hardening, TLS/headers, DB exposure + least-privilege roles, file perms + no default/weak creds, encryption-at-rest proof, crypto self-test, image digest/checksum/signature, bootstrap disabled, backup encryption, hardened-profile checks; human PASS/WARN/FAIL + JSON + exit codes.

## Phase 10: Installer and deployment — NOT STARTED

- Idempotent `install.sh`: preflights, secure secret generation, restrictive-perm config, Compose up, healthcheck wait, prints setup URL + one-time token; standard/hardened choice; safe re-run; host untouched beyond Docker + project dir; TLS options (self-signed/internal CA, Let's Encrypt, BYO); upgrade/backup/restore/status/uninstall; healthchecks, restart policies, HA/scale-out docs.

## Phase 11: CI/CD and versioning — NOT STARTED

- Git tag semver (Conventional Commits + release-please/semantic-release), CHANGELOG.md, signed multi-arch images + SBOMs; gates (lint, typecheck, tests, scans, build); default GitHub Actions + GHCR (pending Phase 0 answer); secrets/settings documented, no fabricated results.

## Phase 12: Documentation — NOT STARTED

- README (purpose, how-it-works, plain-language threat model, Mermaid diagram, quickstart, bootstrap, config, guides, key mgmt, backup/restore, upgrade, verify usage, FAQ, limitations/disclaimers incl. responsible-use/legal); docs/: ARCHITECTURE.md, SECURITY.md, THREAT_MODEL.md, OPERATIONS.md, ADRs, API reference, CONTRIBUTING.md; security behavior documented end to end.

## Final Phase: Recursive self-audit — NOT STARTED

- Traceability checklist vs code/tests/docs; full suite + verify script + clean installs (both profiles); adversarial auditor review loop to zero findings; final report (built, decisions, verified vs unverified, limitations, self-verification steps).

## Key decisions

- 2026-09-20 (user answers): deployment = single-household, one host, documented HA path; channels v1 = Email + Webhook + Telegram (Matrix/SFTP deferred); CI = GitHub Actions + GHCR; UI/docs = English only; license = permissive MIT/Apache-2.0 family (exact pick pending); threat priority = stolen-data-at-rest first (full STRIDE + ASVS map still required); release model = server-side automatic release for v1; hardened profile = NOT in v1 — standard-only v1, hardened (Vault vs OpenBao) deferred to next-development todo with ADRs.

## Open issues

- Tech stack unconfirmed (default proposal: TypeScript monorepo per Brief §7; needs approval).
- All Phase 0 clarifying questions unanswered (see design gate turn).
