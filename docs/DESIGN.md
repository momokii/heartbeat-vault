# Heartbeat Vault — Phase 0 Design Document

> Status: PROPOSED — awaiting user approval (Phase 0 gate). No implementation before approval.
> Sources: `docs/BRIEF.md`, 5 librarian research briefs (2026-09-20), user answers 2026-09-20.
> User decisions (binding): single-household deployment · Email+Webhook+Telegram v1 ·
> GitHub Actions + GHCR · English-only · permissive license (MIT/Apache-2.0 family, exact pick pending) ·
> threat priority data-at-rest · server-side automatic release · standard-only v1, hardened deferred to next-development todo.

## 1. Architecture (standard profile, v1)

```
browser (React + Tailwind + shadcn/ui)
  │ HTTPS (Caddy reverse proxy, automatic TLS; `tls internal` for LAN, LE / BYO for public)
  ▼
API + worker (single TypeScript image, two roles: api / scheduler-worker, N replicas)
  │  scheduler loop (materialize due triggers, idempotent) · worker pool (SKIP LOCKED claim)
  │  sweeper (advisory-lock-elected, reclaims stale leases, promotes vault_waits)
  ▼
PostgreSQL 16/17 (source of truth: vaults, trigger_jobs, delivery_jobs, vault_waits,
scheduler_heartbeat, audit_log hash-chained, dead_letter_jobs)
  │  out-of-band doubles in dev/CI: Mailpit (SMTP), MockServer (webhook/Telegram)
```

- Monorepo: pnpm workspaces + Turborepo; packages `web`, `api`/`worker`, `db` (migrations), `crypto`, `channels`, `e2e`. ADR per choice.
- Queue: Postgres only (transactional outbox enqueue, `FOR UPDATE SKIP LOCKED` claim, `LISTEN/NOTIFY` wake + 2–5 s poll fallback). No Redis/RabbitMQ in v1.
- Scalability: single host first; documented HA path (N api/worker replicas + Postgres HA options) — no code for HA in v1 beyond multi-instance-safe primitives.
- Hardened profile: NOT in v1. Deferred todo: OpenBao (MPL-2.0) default candidate vs Vault CE (BSL) alternative + Caddy; envelope+queue design already keeps the key service off the hot release path (cached wrapped DEKs, queue+retry+alert). ADRs recorded now, implementation later.

## 2. Threat model (summary; full STRIDE + OWASP ASVS map in `docs/THREAT_MODEL.md`, Phase 12)

Priority order per user: (1) stolen data at rest → (2) coerced/false release → (3) server compromise. All three mapped; v1 hardens in that order.

| STRIDE                 | Control (v1)                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spoofing               | Argon2id passwords, TOTP 2FA + passkey step-up, opaque revocable sessions, single-use hashed setup/invite tokens, per-channel webhook HMAC                                            |
| Tampering              | AEAD everywhere (XChaCha20-Poly1305 default, AES-256-GCM alt), AAD-bound envelope (`kid/kekVersion/tenant/switch`), audit hash chain, signed releases (cosign, keyless)               |
| Repudiation            | Append-only `audit_log` (no UPDATE/DELETE grants), delivery receipts, dead-letter audit                                                                                               |
| Information disclosure | Envelope encryption (per-secret DEK, KEK server-side v1), ciphertext-only DB, secrets never logged, TLS + strict headers/CSP, least-privilege DB roles, non-root read-only containers |
| Denial of service      | Rate limits (per-IP + per-user, Postgres-backed), lockout, backoff+jitter retries, DLQ instead of silent drop, operator alerting                                                      |
| Elevation of privilege | Roles (instance admin vs standard user), server-side authz on every privileged op, default-deny, IDOR tests                                                                           |

Explicitly NOT protected in v1: operator-at-runtime readability (server-side KEK means a compromised running host can decrypt — documented honestly, not marketed as zero-knowledge); physical host seizure (fail-safe = stays locked, but ciphertext is present); endpoint compromise of owner or recipients; SMS-grade channel confidentiality (guidance: prefer encrypted-blob + split-key over raw secrets on weak channels).

Fail-safe default (fail-closed): missed heartbeat → wait for `grace_until`, notify, release only at grace end; scheduler downtime → extend grace, compensate at-most-once, never fire inside grace; clock uncertainty → hold dispatch + alert; DB unavailable → hold locked + audit. Per-vault `fail_deadly` opt-in behind typed confirmation (ADR, later phase).

## 3. Data model (sketch; DDL lands in Phase 2)

`users` (argon2id PHC, totp_secret encrypted, passkey credentials, recovery-code hashes) ·
`recipients` (verification state: invited → accepted required before arming) ·
`switches` (mode: `asymmetric_key` | `direct_delivery`; status: active/paused/released; interval, grace, escalation config, dry-run flag) ·
`sealed_payloads` (envelope blob: kid + kekVersion + wrappedDEK + payload nonce/ct/tag + AAD) ·
`heartbeats`, `trigger_jobs` (UNIQUE(vault_id, deadline_at), idempotency_key, lease owner/expires, attempts) ·
`vault_waits` (post-recovery grace durable sleep) · `delivery_jobs` (channel, idempotency_key, backoff, receipts) ·
`dead_letter_jobs` · `scheduler_heartbeat` (outage detection) · `audit_log` (hash-chained) ·
`invites`, `sessions`, `app_config` (setup_token_hash, setup_completed → 410 Gone thereafter).
All timestamps `timestamptz` UTC written by DB `clock_timestamp()`; user zones presentation-only.

## 4. Crypto design (normative, audited primitives only)

| Use                 | Primitive                                                                                              | Library (TS)                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Bulk AEAD           | XChaCha20-Poly1305 default; AES-256-GCM alt (FIPS/interop)                                             | `@noble/ciphers` (Cure53-audited) or `libsodium-wrappers`                |
| DEK                 | 32 B CSPRNG per secret, zeroized after use                                                             | `randomBytes` / `sodium.randombytes_buf` + `memzero`                     |
| KEK wrap            | AAD-bound AEAD wrap (`{kid,kekVersion,tenant,switch}`), version-in-blob prefix                         | same as above                                                            |
| Passphrase → KEK    | Argon2id OWASP baseline `m=19456,t=2,p=1`, salt 16 B, pepper via env                                   | `@node-rs/argon2` (PHC + `needsRehash`)                                  |
| Asymmetric (Type 1) | X25519 ECDH → HKDF-SHA256 → ChaCha20-Poly1305; sealed box (1 recipient) / age (multi-recipient, files) | `libsodium-wrappers` `crypto_box_seal`, `age-encryption` (X25519 stanza) |
| Threshold           | Shamir t-of-n over GF(2⁸), honest-dealer + `BLAKE2b(secret)` commitment check                          | `shamir-secret-sharing` (Cure53 + Zellic audited)                        |
| Hash/HKDF/HMAC      | HKDF-SHA256, HMAC-SHA256, BLAKE2b, SHA-256                                                             | `@noble/hashes` / libsodium                                              |

Rotation: new KEK version decrypt-only-old, writers flip, `rewrap` sweep (`SKIP LOCKED` batches), retire only at zero stale rows; DEK compromise requires payload re-encrypt (documented). KAT vectors pinned (XChaCha draft §A.3.1, NIST GCM, RFC 3394/5649, RFC 5869/4231/7914, Wycheproof adversarial) + round-trip/negative/tamper/nonce-reuse/differential tests; CI blocks on KAT drift. Backups: same envelope (age file or re-wrap under backup KEK), restore tested in CI.

Type 1 custody (server-side release, per user decision): server holds wrapped private-key material, releases to verified recipients at trigger. Recipient-held Shamir shares deferred (option, not v1).

## 5. Heartbeat / escalation defaults (tunable, instrumented)

Interval default 14 d (presets 7/14/30, range 1–90). Grace = max(2 h, 20–25% of interval) → 3 d at default.
Stages: T+14 d reminder → T+18 d warning (daily + Telegram) → T+21 d pending-trigger (owner + trusted-contact ping; one "reachable" aborts) → T+22 d fire-queued + 48 h cancellation window (TOTP recovery code cancels) → T+24 d release (per-recipient envelope).
Pause: explicit `pause --until` sticky (`manual_resume`); `/extend` with TOTP; trusted-contact snooze (once per contact). Dry-run: first-class (`hv trigger --dry-run`, `[DRY RUN]` footer, preview-as-beneficiary, auto-run after init).
Downtime guard: boot gap check via `scheduler_heartbeat`; affected timers reset to `grace_until` waits, owner notified — never fire on recovery. Checker tick 60 s; scheduler loop 30 s; lease 30 s / heartbeat 10 s; `max_attempts` 5 with full-jitter backoff; clock-skew budget + `CLOCK_UNCERTAIN` hold (DB time authoritative, monotonic for durations).

## 6. Delivery (v1: Email + Webhook + Telegram)

Pluggable provider interface (one interface, three providers in v1; Matrix/SFTP deferred). Per send: idempotency key (email `Message-ID`, webhook `Idempotency-Key`, Telegram retry-key) + DB UNIQUE guard; retries with backoff+jitter; receipts; dead-letter + replay UI; recipient must reach `accepted` (verified invite) before a switch arms; payload options per switch: encrypted-blob + split key (default), one-time-view expiring link, or direct payload behind explicit risk acceptance; per-channel security guidance documented.

## 7. Auth / bootstrap (v1)

`install.sh` generates 32 B setup token (printed once, `0600` file, hashed SHA-256 in `app_config`, 60 min TTL); `POST /api/setup` creates first admin in-TX then `setup_completed=true` → endpoint `410 Gone` forever. Admin-invite default (single-use, 24 h, hashed); open registration only behind explicit admin flag. Argon2id, TOTP (`otplib` v13, replay-protected) + 8–12 hashed recovery codes, WebAuthn/passkeys (`@simplewebauthn/server` v13, server-side challenges), opaque revocable sessions (`__Host-` strict cookies), Postgres-backed rate limits + lockout, full audit log.

## 8. Testing / verification / CI (v1 shape)

Testcontainers Postgres 17 + `@testcontainers/vault`-pattern (used in later hardened phase), Playwright E2E (bootstrap→release), Mailpit + MockServer doubles, failure-injection harness (kill -9 mid-trigger, ×2 workers, DB restart, libfaketime skew — fencing-token + idempotency invariants), coverage thresholds on crypto/auth/scheduler/delivery, `scripts/verify-security.sh` (read-only PASS/WARN/FAIL + JSON), `install.sh` + companion commands, release-please + GHCR signed multi-arch + SBOM (sigstore keyless) with the gate list from research. Operator secrets documented with `CHANGEME` placeholders only.

## 9. ADR list (to be written under `docs/adr/` after approval)

1. TypeScript monorepo (pnpm + Turborepo) vs alternatives — PROPOSED
2. Postgres-as-queue (`SKIP LOCKED`, outbox) vs Redis/RabbitMQ — PROPOSED
3. Fail-safe default + per-vault opt-in — PROPOSED
4. Clock contract (DB time, skew budget, `CLOCK_UNCERTAIN`) — PROPOSED
5. Envelope crypto suite + rotation procedure — PROPOSED
6. Server-side release v1 (shares deferred) — PROPOSED
7. Hardened key service: OpenBao default candidate vs Vault CE alt (license-pending) — DEFERRED impl, ADR now
8. Caddy vs Traefik (Caddy candidate) — DEFERRED impl, ADR now
9. Auth libraries (argon2/TOTP/WebAuthn/rate-limit) — PROPOSED
10. Release process (release-please + GHCR + keyless signing) — PROPOSED

## 10. Gate request

Approve this design (or request changes section-by-section). On approval: Phase 1+ implementation begins autonomously through the phase order in `docs/PROGRESS.md`, each phase gated (tests + lint/typecheck green, docs updated, committed — commits only on your explicit request per repo rules). Hardened profile stays a tracked next-development todo (ADRs, no v1 code).
