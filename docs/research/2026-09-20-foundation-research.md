# Foundation Research — Heartbeat Vault (2026-09-20)

> **Purpose**: Best-practice investigation for Phases 1–12 of the self-hosted dead-man's-switch (Brief §5–12 + §7.1). Trace: every pattern below maps to a phase gate in `docs/PROGRESS.md`. Date: 2026-09-20 — all claims verified against 2026 sources (Prisma 7, Turborepo 2.x, pnpm 10/11, Caddy 2.11, libsodium, cosign/sigstore keyless).

**Status**: Informational — feeds `docs/DESIGN.md` and ADRs. No implementation before Phase 0 approval.

---

## 1. TypeScript Monorepo: pnpm + Turborepo (Phase 1)

### Verdict (2026)

**pnpm 10/11 + Turborepo 2.x at root** is the default for greenfield TS monorepos that need fast CI and zero version drift. Publish/version with `changesets` + npm OIDC trusted publishing if you ever publish internal packages; otherwise skip publishing entirely.

### Key patterns

**Workspace layout** — `pnpm-workspace.yaml` at root (not `package.json` workspaces):

```yaml
packages:
  - 'apps/*' # deployables: web, api, worker
  - 'packages/*'
catalog:
  typescript: ^5.9.0
  drizzle-orm: ^0.44.0
  zod: ^3.23.0
catalogMode: strict # 2026: require every dep via catalog → no drift
```

- Root `package.json`: `private: true`, `packageManager: "pnpm@10.x"`, scripts only delegate to `turbo run`. Shared TS/ESLint live in `packages/config/*`, consumed via `extends`.

**Internal links — `workspace:*` always:**

```json
// apps/api/package.json
{ "dependencies": { "@repo/db": "workspace:*", "@repo/crypto": "workspace:*" } }
```

`pnpm install` creates symlinks; `pnpm publish` rewrites to concrete versions. Prevents accidental registry fetch.

**`turbo.json` — `tasks` (not `pipeline`) in 2.x:**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "inputs": ["$TURBO_DEFAULT$", "!**/*.md"],
      "outputs": ["dist/**", ".next/**", "!.next/cache/**"]
    },
    "test": { "dependsOn": ["^build"], "outputs": ["coverage/**"] },
    "lint": { "dependsOn": ["^build"] },
    "typecheck": { "dependsOn": ["^build"] },
    "dev": { "cache": false, "persistent": true }
  }
}
```

- `^build` = build upstream deps first; `build` without `^` = same package. Forgo `dependsOn` on lint/typecheck if you import `.ts` source directly (faster CI).
- Always declare `outputs` or cache restores nothing (classic rookie bug). Exclude `.next/cache`.
- Declare `env: ["NODE_ENV","DATABASE_URL"]` if builds inline env vars — otherwise cached prod build leaks into dev.

**Repo hygiene 2026:**

- Pin `turbo` version, add `allowBuilds` (pnpm 11 blocks postinstall scripts by default — need approval for `esbuild` etc.):
  ```yaml
  # pnpm-workspace.yaml
  allowedBuilds:
    esbuild: true
  ```
- `Corepack` + `packageManager` field guarantees same pnpm in CI and dev machines. Don't hoist React/frameworks into internal packages — declare as `peerDependencies`.

### Pitfalls

| Pitfall                                                        | Consequence                                   | Fix                                                                                      |
| -------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Using `pipeline` key                                           | Hard error / silent no-cache in 2.x           | Search-replace → `tasks`                                                                 |
| Missing `outputs: ["dist/**"]`                                 | Cache hit restores empty `dist/`              | Always declare outputs                                                                   |
| `version:` in `compose.yaml` or bare `Caddyfile:ro` file mount | Deprecated / breaks `caddy reload` inode swap | Mount `./caddy:/etc/caddy` directory, not single file                                    |
| Shallow `fetch-depth: 1` + `turbo --affected`                  | Every package looks changed                   | `fetch-depth: 0` in CI                                                                   |
| 50 micro-packages on day 1                                     | Graph traversal overhead, slow CI             | Start 3–5: `ui`, `db`, `config`, `utils`, `crypto` — split when versioning/build differs |
| Env vars not in `env` array                                    | Wrong env baked into cached build             | List every inlined var                                                                   |

### Phased mapping

Phase 1 creates `apps/web`, `apps/api`, `packages/{config,db,crypto,ui}` + `pnpm-workspace.yaml` + `turbo.json` + `.npmrc` (`dedupe-peer-dependents=true`). Add remote cache later (Vercel free tier → self-hosted `ducktors` if needed).

---

## 2. PostgreSQL + Type-Safe ORM (Phase 2)

### Verdict for Heartbeat Vault (2026)

**Drizzle ORM is the default for this project** — reasons that outweigh Prisma here:

- Schema lives in TypeScript (same graph as monorepo, no `prisma generate` gate in CI for every model tweak).
- Near-raw-SQL queries — critical when trigger/scheduler queries must be `EXPLAIN ANALYZE`-able (`SKIP LOCKED`, partial indexes, advisory locks).
- Tiny runtime, zero deps — fits Docker + potential edge/worker.
- No PSL second language; easier to enforce deep-module boundaries.

**Stay Prisma if** your team already standardizes on it or needs Studio-heavy ops — Prisma 7 (Nov 2025, Rust-free WASM client, ~90% smaller) closed the old cold-start gap and is now production-viable. But for Heartbeat Vault's scheduler correctness, Drizzle's transparency wins.

### Patterns (either ORM)

**Shared `packages/db` pattern:**

```
packages/db/
  src/schema/vault.ts   # pgTable definitions
  src/client.ts         # pool / drizzle instance
  drizzle.config.ts
  migrations/           # reviewable SQL, checked in
```

Apps import `@repo/db`, never raw `pg`.

**Migration discipline (both tools):**

- `drizzle-kit generate` → review SQL → `migrate` in CI. Never `drizzle-kit push` against production — implicated in open RLS-disable bug (#4948: silently emits `DISABLE ROW LEVEL SECURITY` on re-push). Same for `prisma db push` — prod must be `migrate deploy`.
- For large tables, add `NOT NULL` columns as nullable → backfill → add constraint; index with `CONCURRENTLY` outside ORM migration when needed.

**Postgres operational:**

- Pool via `pg` + `pgBouncer` or Neon/Supabase pooler; set pool size per container.
- Partial index on hot queue: `CREATE INDEX ... WHERE status='pending'` keeps dequeue O(kB) even at 10M rows.
- Set `isolation level` explicitly on scheduler transactions; retry on serialization failures yourself (neither ORM retries).

**Drizzle gotchas 2026:**

- Relations: `Queries API` nests reads; mutations require explicit SQL-like joins (more verbose, less surprising N+1 — Prisma's `include` can silently fan out to 16 queries).
- JSONB: Drizzle `jsonb` + `sql` helper exposes full Postgres 17 `jsonb_path_query` with typed paths; Prisma `Json` is opaque and forces `queryRaw` for the same.

### Pitfalls

- Skipping reviewable migration files → invisible DDL in prod.
- Using `Json` for secrets payload without per-row IV + AEAD — leaks determinism.
- Not indexing scheduler columns (`status`, `next_run_at` / `scheduled_at`) → sequential scans under load.

---

## 3. Docker Compose + Caddy Reverse Proxy (Phases 1, 10)

### Verdict

**Caddy 2.11+ as the only exposed service** — automatic HTTPS (ACME HTTP-01 by default), zero certbot cron, ~15 MB idle, HTTP/3 built-in.

### Patterns

**Single Compose project, one shared network, Caddy front door:**

```yaml
services:
  caddy:
    image: caddy:2.11-alpine
    restart: unless-stopped
    cap_add: [NET_ADMIN] # for HTTP/3 UDP buffer sizing
    ports: ['80:80', '443:443', '443:443/udp']
    volumes:
      - ./caddy:/etc/caddy # directory, not single file
      - caddy_data:/data # certs — non-ephemeral!
      - caddy_config:/config
    networks: [edge]

  api:
    image: heartbeat-vault-api:${TAG}
    expose: ['3000'] # no host ports — only Caddy is public
    networks: [edge]
    healthcheck: { test: ['CMD', 'wget', '-qO-', 'http://localhost:3000/health'], interval: 10s }

  postgres:
    image: postgres:17-alpine
    expose: ['5432'] # never publish to host
    volumes: [pgdata:/var/lib/postgresql/data]
    networks: [edge]

volumes: { caddy_data, caddy_config, pgdata }
networks: { edge: {} }
```

**Caddyfile — snippets + directory mount:**

```caddy
{
  email {$ACME_EMAIL}
  admin 127.0.0.1:2019
}
(security) {
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
    X-Content-Type-Options "nosniff"
    X-Frame-Options "DENY"
    Referrer-Policy "strict-origin-when-cross-origin"
    Permissions-Policy "camera=(), geolocation=(), microphone=()"
    -Server
  }
}
vault.example.com {
  import security
  encode gzip zstd
  reverse_proxy api:3000
}
```

- One hostname block → one auto-provisioned LE cert. `reverse_proxy` target is `service_name:internal_port` (Docker DNS), never `localhost` inside container.
- Persist `caddy_data` — deleting it re-issues every cert and hits LE rate limit (5 per exact hostname/week). Test against staging CA: `acme_ca https://acme-staging-v02.api.letsencrypt.org/directory`.
- Reload zero-downtime: `docker compose exec -w /etc/caddy caddy caddy reload` (atomic, connection-draining). Editing `Caddyfile` via file-mount breaks reload due to inode swap — directory mount fixes it.

**Hardened variant:** DNS-01 wildcard via Cloudflare (`tls { dns cloudflare {env.CLOUDFLARE_API_TOKEN} }`) requires `xcaddy` custom image.

### Pitfalls

- Closing port 80 after setup — renewal fails 60 days later (HTTP-01 needs 80).
- `https://` prefix in site block disables auto-TLS.
- Not sharing a network → `dial tcp: lookup api on ... no such host` — every service must join `edge`.
- Storing TLS certs ephemerally → LE rate-limit lockout + downtime.

---

## 4. Dead-Man's-Switch Trigger Engine (Phase 4) — Critical

This is the correctness core. Research converges on **Postgres as the coordination layer** (no Redis/SQS needed at <5k jobs/s) + `FOR UPDATE SKIP LOCKED` + lease/sweeper + `LISTEN/NOTIFY` wakeup.

### State machine (per vault/switch)

```
armed ──(heartbeat)──▶ armed (next_checkin_at = now + interval)
  │  missed reminder
  ▼
reminding ──(escalating reminders)──▶ warning ──▶ pending_trigger ──▶ final_grace ──▶ firing
  ▲                                                                     │
  └────────────────── cancellation window (any stage) ──────────────────┘
  │
  └── system downtime ──▶ compensation (see below)
```

- Configurable: `heartbeat_interval` (e.g., 7d), `reminder_schedule` (e.g., T-3d, T-1d, T-12h), `grace_periods` array, `pre_fire_cancellation_window` (e.g., 24h).
- Modes: `manual button`, `signed email link` (HMAC, single-use, expiring), `API token/webhook`, `Telegram reply`, plus step-up `TOTP/passkey` for check-in.
- Triggers selectable per switch: `missed_heartbeat_threshold`, `fixed_datetime`, `panic` (manual immediate), `quorum` (m-of-n trusted contacts confirm).

### Postgres scheduler — the proven primitive

**Table (simplified):**

```sql
CREATE TYPE switch_status AS ENUM ('armed','reminding','warning','pending_trigger','final_grace','firing','fired','paused','disarmed');
CREATE TABLE vault_switches (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  status switch_status NOT NULL,
  heartbeat_interval interval NOT NULL,
  next_checkin_at timestamptz NOT NULL,
  grace_until timestamptz,
  locked_by text, locked_at timestamptz, lease_expires timestamptz,
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_switches_due ON vault_switches (next_checkin_at, grace_until) WHERE status IN ('armed','reminding','warning','pending_trigger','final_grace');
```

**Claim — `SKIP LOCKED` (zero double-fire, non-blocking):**

```sql
BEGIN;
WITH claimed AS (
  SELECT id FROM vault_switches
  WHERE status IN ('armed','reminding','warning','pending_trigger','final_grace')
    AND COALESCE(grace_until, next_checkin_at) <= now()
  ORDER BY COALESCE(grace_until, next_checkin_at)
  LIMIT 10
  FOR UPDATE SKIP LOCKED
)
UPDATE vault_switches s
SET status = CASE WHEN s.status='final_grace' THEN 'firing' ELSE s.status END,
    locked_by = $1, locked_at = now(), lease_expires = now() + interval '30 seconds',
    updated_at = now(), version = version + 1
FROM claimed WHERE s.id = claimed.id
RETURNING s.*;
COMMIT;
-- processing happens OUTSIDE this tx
```

- Claim tx is tiny — just lock + flip + commit. Never hold `FOR UPDATE` while calling delivery channels.
- Multiple API/worker instances poll concurrently; each skips rows locked by peers. Empty result = 0ms, sleep until next tick.

**Lease + heartbeat + sweeper (crash safety):**

```sql
-- worker heartbeats every lease/3:
UPDATE vault_switches SET lease_expires = now() + interval '30 seconds' WHERE id=$1 AND locked_by=$2;
-- sweeper every 15–60s re-enqueues orphaned:
UPDATE vault_switches SET status='pending_trigger', locked_by=NULL, locked_at=NULL
WHERE status='firing' AND lease_expires < now();
```

Lease too short → live work stolen (safe if idempotent, wasteful); too long → slow recovery. 30s lease + 10s heartbeat + 15s sweeper is a tested default.

**Wakeup — `LISTEN/NOTIFY` + polling fallback:**

```sql
-- on heartbeat or arm: SELECT pg_notify('switch_channel', id::text);
-- workers: LISTEN switch_channel (wake <1s), plus poll every 2–5s as fallback (NOTIFY is best-effort, dropped on restart)
```

### False-trigger prevention (non-negotiable per Brief §5.1)

**Downtime compensation + post-recovery grace:**

- Persist `system_heartbeats` table (or `server_status` row) with `last_healthy_at`. On startup, if `now - last_healthy_at > threshold` (e.g., 5 min), enter recovery mode: do NOT fire anything whose `grace_until` fell inside the downtime. Instead extend `grace_until = now() + post_recovery_grace` (e.g., 24h) and emit operator alert.
- Clock: store all times as `timestamptz` (UTC), never wall-clock naive. Compare with `now()` (server time) + tolerate skew via grace windows. Document NTP requirement.

**Fail-safe vs fail-deadly — decide and document:**

- Heartbeat Vault Phase 1 default per PROGRESS.md: **fail-safe (don't fire) when in doubt** (downtime, DB unreachable, delivery infra down) — queue + retry + alert. Fail-deadly (fire anyway) is never the default for a safety app.

**Idempotency + dedup (firing exactly once):**

- `operation_outputs (switch_id, stage)` primary key — DB constraint rejects duplicate finalization; recovering worker reads existing checkpoint.
- Delivery jobs table with `idempotency_key` (e.g., `firing:<switch_id>:<version>`) + unique constraint; webhook/email senders check key before side effect.

**Pause/vacation + dry-run:**

- `paused` status skips scheduler (`WHERE status != 'paused'`). Dry-run traverses same pipeline but delivers to `dry_run_recipients` / logs instead of real payload; expose as explicit button.

### Pitfalls

- Holding claim transaction open during delivery → row lock pinned for minutes, deadlock.
- Sweeper threshold < 2× heartbeat interval → healthy worker reclaimed spuriously (last-writer-wins double-write).
- Trusting `setTimeout`/`setInterval` in Node for firing — process restart loses timers; only Postgres is durable.
- Ignoring advisory locks when a job touches a second resource (e.g., per-user dedup) — `SKIP LOCKED` alone doesn't exclude same-user concurrent rows.
- Multi-instance without `SKIP LOCKED` → blocking pileup; with Redis instead → lose transactional `enqueue + business data` atomicity.

---

## 5. AEAD Crypto + KDF + Shamir (Phases 2, 4)

### Non-negotiables (Brief §6)

Never custom crypto. Audited libs only: `libsodium` (or `libsodium-wrappers` / `@noble/*` with care) for AEAD, `argon2` (via `argon2` npm with native binding or `hash-wasm`) for KDF, `shamir-secret-sharing` / `privy-io/shamir-secret-sharing` for threshold.

### AEAD — choose by CPU

| Primitive                                                                 | Nonce                                                         | Limit/key                                           | When                                                                                                           |
| ------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **XChaCha20-Poly1305** (libsodium `crypto_aead_xchacha20poly1305_ietf_*`) | 192-bit (24 B) — random safe                                  | ~2⁶⁴ bytes, no practical limit                      | **Default for Heartbeat Vault** — portable, no AES-NI needed, random nonce safe                                |
| AES-256-GCM                                                               | 96-bit (12 B) — must be counter/unique, never random at scale | ~350 GB/key (libsodium warning), ~64 GB per message | Use if hardware AES-NI present and interop requires it; counter nonce + frequent rekey                         |
| AEGIS-256 (libsodium ≥1.0.19)                                             | 256-bit                                                       | No practical limit                                  | Consider for new deployments on modern libsodium — libsodium recommends AEGIS-256 when AES acceleration exists |

**Rule**: AEAD only — never CBC/ECB without auth. Tag verifies before decryption (tamper → fail). ChaCha/XChaCha is constant-time in software; AES-GCM without hardware AES-NI risks cache-timing side channels.

**Envelope encryption (per-secret DEK + master key):**

```
DEK (random 32 B) ──AEAD encrypt──▶ ciphertext (iv || tag || ct)
DEK ──wrap with master key (AEAD or Vault Transit)──▶ wrapped_dek (stored)
Master key lives in: Docker secret / file (standard profile) → Vault Transit / OpenBao (hardened, deferred)
```

- Per-row IV: `randomBytes(12)` for GCM, `randomBytes(24)` for XChaCha — never reuse `(key, nonce)`. Store `iv || ciphertext || tag` (or XChaCha `nonce || ct`); IV is not secret but loss = unrecoverable — document wire format.
- Key rotation: re-wrap DEKs with new master key; data re-encryption is lazy (on next write) or bulk job.

**Implementation shape (libsodium-wrappers):**

```ts
await sodium.ready;
const key = sodium.crypto_aead_xchacha20poly1305_ietf_keygen(); // or from KDF
const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(msg, null, null, nonce, key);
// store: base64(nonce + ct)
```

### KDF — Argon2id

OWASP 2026 minimum: `m=19456 KiB (19 MiB), t=2, p=1`. Tuned interactive: `m=64 MiB, t=3, p=4` if hardware allows (measure login latency <500 ms).

```ts
import * as argon2 from 'argon2';
const hash = await argon2.hash(password, {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
});
// hash is PHC string containing salt+params — store as-is; verify via argon2.verify
```

- Never MD5/SHA-256 alone for passwords. `bcrypt` acceptable fallback at cost ≥12 (12 recommended 2026) but truncates at 72 B — Argon2id preferred.
- NIST 800-63B-4: require 8+ chars (15+ for single-factor), don't force character classes, don't mandate 90-day rotation, block leaked passwords via blocklist.

### Asymmetric — Type 1 (public/private key mode)

- Generate client-side when possible (user's browser) → public key uploaded, private key never leaves client until wrapped. If server-generated, wrap private key immediately with envelope encryption.
- Primitives: **X25519** (key exchange) + **age** or **libsodium sealed boxes** (`crypto_box_seal` — X25519 + XSalsa20-Poly1305) for encrypting secrets to public key. Document that sealed boxes hide sender identity.
- Deterrence signal: public key can be published openly; private material only leaves on trigger via Shamir shares or encrypted delivery.

### Shamir's Secret Sharing (Type 1 threshold)

Libraries (all audited/zero-dep, GF(256) / GF(2⁸)):

- `privy-io/shamir-secret-sharing` — minimal, Uint8Array, audit-friendly (recommended for Heartbeat Vault).
- `shamir-secret-sharing-extended` — adds optional AES-GCM per-share encryption at rest.
- `Digital-Defiance/secrets.js` — legacy hex-string API, heavier.

Pattern:

```ts
import { split, combine } from 'shamir-secret-sharing';
const shares = await split(privateKeyBytes, 5, 3); // 5 shares, any 3 reconstruct
const recovered = await combine([shares[0], shares[2], shares[4]]);
```

- Uses CRS; finite field = 2⁸ → max 255 shares. Zero-pad short secrets to ≥128 bits to hide length.
- Distribute shares out-of-band; each share can be additionally AES-GCM encrypted with recipient's password. With <t shares, information-theoretic secrecy holds (share size leaks length → pad).

### Pitfalls

| Pitfall                                                       | Consequence                                      | Fix                                                           |
| ------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| Reusing `(key, nonce)` with AES-GCM/ChaCha20                  | Catastrophic — keystream reuse reveals plaintext | Random XChaCha nonce or atomic counter + rekey before 2³² ops |
| Storing IV separately from ciphertext                         | Loss → unrecoverable                             | Prepend `IV (12/24 B)                                         |     | tag (16 B) |     | ct` and document |
| Single master key for everything, no rotation                 | All data at risk on compromise                   | Envelope + re-wrap, version keys                              |
| Rolling custom Shamir over GF(p) with `Math.random`           | Predictable shares                               | Use audited GF(256) lib with `crypto.getRandomValues`         |
| Encrypt in browser without `sodium.ready` / without WASM init | Silent failure                                   | Await init, test vectors in CI                                |

### Crypto tests (Phase 8)

- Known-answer vectors (from libsodium docs), round-trip encrypt/decrypt, negative (tampered tag → must throw), nonce uniqueness property test.

---

## 6. Delivery Channels — Pluggable (Phase 5)

Brief requires: SMTP first + Webhook + Telegram minimum, pluggable, with retries/backoff, idempotency, receipts, dead-letter, recipient pre-approval.

### Architecture

```
vault_switch firing ──▶ jobs table (status, channel, payload_ref, attempt, run_at)
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
     EmailChannel    WebhookChannel   TelegramChannel
         │                 │                 │
         └────────► shared retry + DLQ ─────┘
```

- Jobs table indexed: `WHERE status='pending' ORDER BY priority DESC, run_at ASC` + `WHERE status IN ('claimed','running')` on `heartbeat_at`.
- Each channel implements `deliver(job): Promise<Receipt>` — throws on failure. Scheduler re-enqueues via exponential backoff: `run_at = now() + base * 2^(attempt-1)` (e.g., 1m→2m→4m), jitter ±25% to avoid thundering herd.

State: `pending → claimed/running → sent | failed → pending (retry) | dead` (after `max_attempts`, e.g., 5). Dead-letter preserves `payload, error, attempts` for manual replay/inspection after root cause fix.

### Per-channel specifics (2026)

**Email (Nodemailer)**

- Transport: SMTP (any provider — Mailpit in tests, SendGrid/SES in prod via SMTP). Rate limit (Gmail 500/day, SendGrid 100/s) — token bucket per channel.
- Templates: `React Email` or Handlebars with `i18n` if needed; store as DB rows for audit.
- Security: never send raw secret over weak channel by default — send one-time-view link (signed, expiring) + separate key share. Document direct-payload risk accept path.
- Verification: sender auth (SPF/DKIM/DMARC) is deployment responsibility; test with Mailpit (no real accounts).

**Webhook**

- `POST destination` with HMAC `X-Gateway-Signature: HMAC-SHA256(secret, body)` + `X-Gateway-Timestamp` + idempotency key header. Verify on receiver.
- Timeout (e.g., 10s), retry on 5xx/timeout, fail fast on 4xx (don't retry client errors). Exponential backoff. Idempotency: receiver dedups on `Idempotency-Key`.

**Telegram**

- Bot API via `node-telegram-bot-api` or raw fetch. Durable SQLite queue survives restart (gateway pattern). Rate limit per chat (30/min default). HMAC-sign outbound webhooks similarly.
- Recipients: `chat_id` pre-approved — `/start` flow collects `chat_id`, operator approves. Public mode off by default.

### Cross-cutting channel hygiene

- **Idempotency**: `idempotency_key = hash(switch_id + version + channel)` unique constraint; duplicate enqueue → skip (`DUPLICATE` log). Redis/Memory store acceptable but Postgres unique constraint is authoritative.
- **Receipts + audit**: append-only `delivery_log` (who, what, when, attempt, error, receipt_id) — powers verify script + ops.
- **Recipient pre-approval**: invite flow — admin invites recipient email → signed, expiring, single-use link → recipient confirms → status `verified` before switch can be armed. Enforce at arming gate.
- **Payload options (user-selectable per switch):**
  1. Encrypted blob + separate key delivery (safest — split channels)
  2. One-time-view link (short-lived, e.g., 24h, burn after read)
  3. Direct payload (explicit risk checkbox + warning)
- **Backpressure**: worker pool via Go-style `chan semaphore` or `p-limit` — bound concurrency to avoid OOM; scheduler slows claiming when workers saturated.

### Pitfalls

- Prior art moved to DLQ without preserving payload → unrecoverable failure context. Always transactionally move to `dead_letter_jobs` with original row.
- Assuming `LISTEN/NOTIFY` is guaranteed — it's best-effort; keep polling fallback.
- No jitter on retry → synchronized retry storm. Always add ±25%.
- Sending secrets in webhook query params / email subject → logged everywhere. Body-only, TLS-only.

---

## 7. GitHub Actions + GHCR + release-please + Cosign/Sigstore (Phase 11)

### Verdict

Default per PROGRESS.md (GitHub Actions + GHCR) is correct for self-hosted oss. Add **release-please** (Conventional Commits → release PR → tag → CHANGELOG) + **cosign keyless (Sigstore OIDC)** + SBOM/provenance.

### Patterns

**release-please — keep publishing in SAME workflow run that cuts the release:**

- Why: a tag created by `GITHUB_TOKEN` does NOT trigger a separate `on: push: tags` workflow (well-known gotcha). Gate downstream jobs on `needs.release-please.outputs.release_created == 'true'`.
- Config: `release-please-config.json` + `.release-please-manifest.json` at root; Conventional Commits (`feat:`, `fix:`, `feat!:`) drive semver.

**GHCR login — ephemeral `GITHUB_TOKEN`, no PAT:**

```yaml
permissions:
  contents: write # release-please tag
  pull-requests: write
  packages: write # GHCR push
  id-token: write # cosign + provenance OIDC
  attestations: write
```

```yaml
- uses: docker/login-action@v3
  with: { registry: ghcr.io, username: ${{ github.actor }}, password: ${{ secrets.GITHUB_TOKEN }} }
```

**Build + sign — by digest, not tag:**

```yaml
- id: meta
  uses: docker/metadata-action@v5
  with:
    images: ghcr.io/${{ github.repository_owner }}/heartbeat-vault
    tags: |
      type=raw,value=latest
      type=raw,value=${{ needs.release-please.outputs.version }}
      type=raw,value=${{ needs.release-please.outputs.tag_name }}
    labels: |
      org.opencontainers.image.title=heartbeat-vault
      org.opencontainers.image.source=https://github.com/${{ github.repository }}

- id: build
  uses: docker/build-push-action@v6
  with:
    context: .
    platforms: linux/amd64,linux/arm64
    push: true
    tags: ${{ steps.meta.outputs.tags }}
    labels: ${{ steps.meta.outputs.labels }}
    provenance: true # SLSA build attestation
    sbom: true
    cache-from: type=gha
    cache-to: type=gha,mode=max

- uses: sigstore/cosign-installer@v3
- run: cosign sign --yes ghcr.io/${{ github.repository }}@${{ steps.build.outputs.digest }}
```

- Fulcio issues ~10 min cert from GitHub OIDC; Rekor transparency log makes signature auditable. Private key is ephemeral — no rotation. Fallback: `COSIGN_PRIVATE_KEY` secret if offline/air-gapped (non-standard for this project).
- Verification consumers run: `cosign verify --certificate-identity-regexp "https://github.com/${{ github.repository }}/.github/workflows/release-please.yml@refs/heads/main" --certificate-oidc-issuer https://token.actions.githubusercontent.com ghcr.io/...@sha256:…`

**CI gates (must pass before merge/release):**

- `pnpm install --frozen-lockfile` → `turbo run lint typecheck test build` (use `--filter` / `--affected` with `fetch-depth: 0`).
- SAST + dependency scan (`Dependabot` + `Trivy`/`Grype`), container scan, secret scan (`gitleaks`/`TruffleHog`).
- Attestation: `actions/attest-build-provenance` (pushes to registry) + `anchore/sbom-action`.

**Supply-chain hardening:**

- Pin actions to full commit SHAs (not `@v3`) for tamper resistance.
- `persist-credentials: false` on checkouts where possible; image tags immutable by digest for verification script.

### Pitfalls

| Pitfall                                     | Consequence                                                    | Fix                                                       |
| ------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------- |
| Signing by tag (`:latest`)                  | Mutable → attacker can move tag, signature becomes meaningless | Always `sign @${{ steps.build.outputs.digest }}`          |
| Separate publish workflow on `on: release`  | Never fires (GITHUB_TOKEN tag doesn't trigger)                 | Single workflow, `if: release_created`                    |
| Missing `id-token: write`                   | `failed to get ID token` / no cert                             | Add permission                                            |
| Using `NPM_TOKEN` long-lived secret in 2026 | Deprecated Dec 2025, rotated out                               | OIDC trusted publishing (`--provenance` on `npm publish`) |
| Not caching between builds                  | Slow CI                                                        | `cache-from/to: type=gha` + `docker/setup-buildx-action`  |

---

## 8. Phased Implementation Plan — Recommended Order (trace to Brief §15)

| Phase                     | Stack anchor                                                                                                            | Sequencing rationale                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **1 Tooling**             | pnpm catalog + Turbo `tasks` + `packages/db` skeleton + Compose (app+pg+caddy) + healthchecks                           | Unblocks all parallel work; verify TLS + DB connectivity     |
| **2 Data + Crypto core**  | Drizzle schema + envelope AEAD (XChaCha) + Argon2id + key-wrap/rotation + backup encryption                             | Crypto vetted before any secrets touch DB; KAT tests gate    |
| **3 Auth & bootstrap**    | One-time setup token, setup-endpoint kill-switch, Argon2id+TOTP/WebAuthn/passkey, sessions, rate-limit, audit log       | Authorizes every later feature                               |
| **4 Trigger engine**      | SKIP LOCKED scheduler + lease/sweeper + downtime compensation + heartbeat variants + triggers + pause/dry-run           | Highest correctness risk; failure-injection tests start here |
| **5 Delivery**            | Pluggable channels (Email first → Webhook → Telegram), retry/DLQ/idempotency, recipient verification, payload-option UI | Delivery path must be queue-backed + never silently lost     |
| **6 Hardened (deferred)** | ADR Vault vs OpenBao (proprietary BSL vs MPL-2.0), Compose profile, Transit wrapping with fallback                      | v1 standard-only per decision — no SPOF in release path      |
| **7 UI**                  | shadcn/ui + Tailwind, dashboard/next-checkin, arm/disarm confirmations, dark/light, WCAG AA                             | Wires to already-solid backend                               |
| **8–11**                  | Tests (Testcontainers + Playwright + failure injection) → verify script → installer → CI/CD                             | Tests lock behavior before hardening                         |

Each phase commits only on green gate (tests + lint + typecheck + `PROGRESS.md`).

---

## 9. ADRs to Record in Phase 0

1. **Monorepo: pnpm + Turborepo 2.x** (vs Nx/Lerna) — rationale: smallest cache/speed win at <50 packages.
2. **ORM: Drizzle** (vs Prisma 7) — rationale: SQL transparency for scheduler correctness; Prisma 7 closing acknowledged.
3. **Reverse proxy: Caddy** (vs Nginx/Traefik) — rationale: automatic HTTPS + low ops.
4. **Scheduler: Postgres SKIP LOCKED + lease/sweeper** (vs Redis/BullMQ) — rationale: transactional, crash-safe, no extra infra at target scale.
5. **AEAD: XChaCha20-Poly1305 default** (vs AES-GCM only) — rationale: random nonce safety + portability; AES-GCM optional.
6. **KDF: Argon2id (OWASP 19 MiB/t2/p1)** — vs bcrypt fallback.
7. **Shamir: `privy-io/shamir-secret-sharing`** — audited, minimal.
8. **CI: GHCR + release-please + cosign keyless** — OIDC, digest-based, no long-lived signing keys.
9. **Hardened: deferred, standard-only v1** (Vault vs OpenBao to be re-evaluated before Phase 6).

---

## 10. Immediate Risks to Mitigate (next design review)

- **Scheduler correctness is easy to get wrong under load** — plan TLA+ or at minimum invariant tests: no double-fire, downtime → grace extension, lease expiry → exactly one reclaim.
- **Crypto wire-format lock-in** — decide `nonce||tag||ct` layout now; migration later is painful.
- **Caddy volume + port 80** — ops docs must call these out or renewal fails silently after 60 days.
- **Channel secret handling** — ensure webhook/Telegram tokens never log and are injected via Docker secrets/env with restrictive file perms (`0400`).
- **Supply chain** — enable Dependabot + Trivy + gitleaks before first real secret enters DB.

---

_Generated for DESIGN.md Phase 0 gate. Sources: Turborepo/pnpm official docs + 2026 community guides; Drizzle/Prisma 2026 comparisons (Prisma 7 WASM, Drizzle RLS bug #4948); Caddy 2.11 Docker guides; Postgres SKIP LOCKED/advisory-lock literature + InfoQ durable-workflows; libsodium AEAD/KDF docs + 2026 OWASP/NIST 800-63B-4; Shamir GF(256) libs; GHCR/cosign/sigstore keyless + release-please workflows._
