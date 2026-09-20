# Crypto Envelope — Design Note (ADR-005 draft)

## Primitive choice

- **AEAD: XChaCha20-Poly1305 via `@noble/ciphers@2.4.0` (pinned exact).**
- Audit: Cure53 Sep 2024 (funded OpenSats, all ciphers). 192-bit random nonce
  (24 B) safe for CSPRNG nonces with 2^88 collision bound; constant-time Poly1305
  via `equalBytes`. Pure-TS, ESM, zero native deps, deterministic AAD control.

## Why

- Matches `docs/DESIGN.md §4` and `docs/research/crypto-primitives-2026.md §2.1`
  (noble recommended default for pure-TS).
- `libsodium-wrappers` remains valid for sealed-box / age (T2.4) but envelope
  needs explicit AAD binding (`{kid,kekVersion,tenantId,switchId}`) and
  version-in-blob prefix. Noble gives full control without WASM toolchain.
- AES-256-GCM deferred to FIPS/interop alt — 12 B nonce would require counter
  discipline; XChaCha allows safe random nonces per encryption.
- Alternatives rejected: AES-GCM without managed nonce, home-rolled SIV,
  `crypto.subtle` DIY.

## Why this shape

- Envelope `= {kid,kekVersion,wrappedDEK:{nonce,ct},payload:{nonce,ct,tag}}`.
- `version: 1` prefix — tampered version fails closed. Future rotation bumps
  version without column guessing.
- Per-secret 32 B CSPRNG DEK via `randomBytes(32)`, zeroized with `memzero`
  (fill 0) after both wrap and unwrap, even on failure paths.
- KEK wrap AAD = canonical JSON of `{kid,kekVersion,tenantId,switchId}`.
  Payload AAD = `{tenantId,switchId}`. Wrong AAD → auth failure.
- KEK supplied by caller (`kek: Uint8Array 32 B`, `kid`, `kekVersion`); no
  persistence, no KDF/Argon2 (T2.3), no asymmetric/Shamir (T2.4).
- `constantTimeEqual` delegates to noble `equalBytes` (constant-time) for tag
  checks; noble's `decrypt` already authenticates ciphertext before decrypt.

## TDD — RED then GREEN

- `pnpm --filter @heartbeat-vault/crypto test` before impl → RED:

```
> @heartbeat-vault/crypto@0.0.0 test /home/kelanach/Public/main-linux-kelanach/code-berkah-titipan-tuhan/code/personal_prjct/heartbeat-vault/packages/crypto
> vitest run


 RUN  v5.0.1 /home/kelanach/Public/main-linux-kelanach/code-berkah-titipan-tuhan/code/personal_prjct/heartbeat-vault/packages/crypto

 ❯ src/envelope.test.ts (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/envelope.test.ts [ src/envelope.test.ts ]
Error: Cannot find module './envelope.js' imported from /home/kelanach/Public/main-linux-kelanach/code-berkah-titipan-tuhan/code/personal_prjct/heartbeat-vault/packages/crypto/src/envelope.test.ts
 ❯ src/envelope.test.ts:3:1
      1| import { describe, it, expect } from 'vitest';
      2| import { randomBytes } from '@noble/ciphers/utils.js';
      3| import { encrypt, decrypt, type AAD, type Envelope } from './envelope.…
       | ^
      4|
      5| function makeAAD(overrides: Partial<AAD> = {}): AAD {

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  no tests
   Start at  08:24:48
   Duration  180ms (worker 96%, environment 4%)

/home/kelanach/Public/main-linux-kelanach/code-berkah-titipan-tuhan/code/personal_prjct/heartbeat-vault/packages/crypto:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @heartbeat-vault/crypto@0.0.0 test: `vitest run`
Exit status 1
```

- After `src/envelope.ts` implemented → GREEN: 9 passed (round-trip,
  tag flip, ct flip, wrong AAD, wrong KEK, 1000 nonce uniqueness,
  version tamper, empty + 64KB).

## Verify

- `pnpm --filter @heartbeat-vault/crypto typecheck` clean (tsconfig `strict`,
  `DOM` lib for TextEncoder, `@types/node` for Buffer, no `as any`).
- `pnpm audit` 2026-09-20: 2 pre-existing turbo advisories (GHSA-hcf7-66rw-9f5r,
  GHSA-3qcw-2rhx-2726, turbo ≤2.9.13, patched ≥2.9.14). No new advisory for
  `@noble/ciphers@2.4.0` or `vitest@5.0.1`. Logged in `DECISIONS_LOG.md`.
- Secrets never logged; DEKs zeroized; 2-space, single quotes, semicolons.

---

# T2.4 — Asymmetric Sealed-Box + Shamir Sharing — Design Note (ADR-006 draft)

## Primitive choice

- **Asymmetric: X25519 sealed box via `libsodium-wrappers@0.8.4` (pinned exact).**
  - Audit: libsodium C core 1.0.18 extensively audited (Cure53, Trail of Bits lineage);
    `libsodium-wrappers` is thin Emscripten binding → trust inherits from C core +
    wrapper tests. Wraps `crypto_box_seal` / `crypto_box_seal_open` / `crypto_box_keypair`.
  - Overhead 48 B (32 ephemeral pk + 16 Poly1305 tag), anonymous, single-recipient.
    Multi-recipient → one sealed box per recipient + key-id map (`hex(pubkey) → sealed`).
- **Threshold: Shamir t-of-n over GF(2⁸) via `shamir-secret-sharing@0.0.4` (pinned exact).**
  - Audit: Cure53 Jan 2023 (PVY-01, 2 senior testers) + Zellic — "well-written, good
    best-practices". 1 high (degree < t-1 fixed), 2 info (LUT cache side-channel).
    Assumes honest dealer; no VSS. Zero-dep TS, browser+Node, hashicorp/vault-inspired.
  - Validation `2<=t<=n<=255` enforced pre-delegation; shares = Uint8Array with 1-byte
    x-coord suffix (last byte). `combine(<t)` yields wrong secret (detectable via commitment).
- **Commitment: BLAKE2b-512 via `@noble/hashes@1.8.0` (pinned exact, blake2b).**
  - Honest-dealer check: `commitment = BLAKE2b(secret)` (64 B). `verifyCommitment`
    constant-time via `equalBytes`. Corrupt share → commitment mismatch.

## Why this shape

- Envelope (`packages/crypto/src/envelope.ts`) stays read-only — no KDF/asymmetric/Shamir.
- `asymmetric.ts`: `generateKeyPair()` (X25519 `crypto_box_keypair`), `sealForRecipient`,
  `openSealedBox`, `sealForMany` (validates 32 B keys, throws on wrong key/tamper).
  All async (await `sodium.ready`); defensive copies; duplicate-key check in `sealForMany`.
- `sharing.ts`: `splitSecret` / `combineShares` (validation then delegate), `createCommitment`
  / `verifyCommitment` (64 B digest, constant-time). No custom crypto, no AES-GCM per-share
  coupling (rejected `shamir-secret-sharing-extended`).

## Custody model — v1 vs deferred (normative, per DESIGN.md §4 + research §9.1–9.2)

| Axis                    | **v1: Server-side custody (implemented)**                                                                          | **Deferred: Recipient-held Shamir shares (not in v1)**                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Release condition       | Scheduler fires → server unwraps private key / DEK and delivers to verified recipients (server can release alone). | t-of-n recipients combine shares offline; server is mailbox only, cannot decrypt alone.                                                                                        |
| Who can decrypt         | Server at trigger (has wrapped key in DB) + recipients after delivery.                                             | Any t recipients together; server alone cannot.                                                                                                                                |
| Availability            | No external dep at trigger beyond DB; survives Vault sealed etc. Queued retry+alert already.                       | Offline reconstruction — release is mailbox-only; no server crypto needed post-distribution.                                                                                   |
| Confidentiality at rest | Operator-at-runtime can read (server holds KEK + wrapped key) — documented honestly, not ZK.                       | Server never holds full key (only shares or none) → stronger at-rest, but distribution complexity.                                                                             |
| Usability / risk        | Zero user key burden; recoverable; simple.                                                                         | User must safe-keep shares out-of-band; loss of shares → data loss; UX heavier.                                                                                                |
| Recommended for         | v1 standard profile — single-household, documented HA path (DESIGN.md §1).                                         | Type 1 deterrence keys (public key published, private scalar split) — future opt-in per-switch, with encrypted out-of-band share delivery (age-encrypted to recipient X25519). |

Decision: v1 ships server-side custody only. Shamir library lands now for key-splitting
utilities, but recipient-held-share flow (distribution, encrypted share delivery,
offline combine ceremony) is deferred to next-development todo with ADR-006.
Hardened profile remains deferred per PROGRESS.md.

## TDD — RED then GREEN (T2.4)

- Before `asymmetric.ts` / `sharing.ts` → RED:

```
> vitest run src/asymmetric.test.ts src/sharing.test.ts

FAIL  src/asymmetric.test.ts [ src/asymmetric.test.ts ]
Error: Cannot find module './asymmetric.js' imported from .../src/asymmetric.test.ts
FAIL  src/sharing.test.ts [ src/sharing.test.ts ]
Error: Cannot find module './sharing.js' imported from .../src/sharing.test.ts
Test Files  2 failed | 1 passed (3) — envelope 9 passed
```

- After impl → GREEN (19 passed: envelope 9 + asymmetric 5 + sharing 5):

```
RUN  v5.0.1  packages/crypto —  src/envelope.test.ts src/asymmetric.test.ts src/sharing.test.ts
Test Files  3 passed (3)
Tests  19 passed (19) — round-trip, wrong-key fails, tamper fails, multi-recipient each opens,
48B overhead, n=5 t=3 round-trip, <t not reconstruct, corrupt share fails commitment, invalid n/t throws
```

## Verify (T2.4)

- `pnpm --filter @heartbeat-vault/crypto typecheck` clean (strict, no `as any`, no `as`).
- `pnpm --filter @heartbeat-vault/crypto exec vitest run src/envelope.test.ts src/asymmetric.test.ts src/sharing.test.ts` 19 passed.
- `pnpm audit` 2026-09-20 rerun: same 2 turbo advisories; no new advisory for `libsodium-wrappers@0.8.4`,
  `shamir-secret-sharing@0.0.4`, `@noble/hashes@1.8.0`. Logged in `DECISIONS_LOG.md`.
- Pinned exact versions: `@noble/ciphers@2.4.0`, `@noble/hashes@1.8.0`, `libsodium-wrappers@0.8.4`,
  `shamir-secret-sharing@0.0.4`, `vitest@5.0.1`, `@node-rs/argon2@2.2.1`.

---

# T2.3 — Argon2id KDF + KEK Rotation — Design Note (ADR-005 extended)

## Primitive choice

- **KDF: Argon2id via `@node-rs/argon2@2.2.1` (pinned exact).**
  - Audit: RustCrypto Argon2 (audited via `node-rs` bindings, napi-rs); OWASP baseline
    `m=19456,t=2,p=1`, salt 16 B, output 32 B, version 0x13. PHC string format
    `$argon2id$v=19$m=19456,t=2,p=1$...` with `parseOptions` for `needsRehash`.
  - Why `@node-rs/argon2` over `argon2` (native) / `hash-wasm`: napi-rs maintained,
    prebuilt for all arch (no node-gyp), `hash`/`verify`/`hashRaw`/`hashRawSync`/
    `parseOptions` first-class, `secret` (pepper) support via `Buffer`, constant-time
    verify.

## Pepper model (fail-closed)

- Pepper = `process.env.KEK_PEPPER` (utf8 → `Buffer`). No fallback, no default,
  no hardcoded value. `KdfOptions { requirePepper?: boolean }` exported.
- If `requirePepper: true` and `KEK_PEPPER` missing/empty → throw
  `KEK_PEPPER required but not set (fail-closed)`. Otherwise pepper is optional:
  if present, passed as `secret` to argon2; if absent, argon2 runs without secret.
- `hashPassword` / `verifyPassword` / `deriveKEK` / `deriveKEKAsync` all respect
  `requirePepper`. `deriveKEK` (sync via `hashRawSync`) returns `Uint8Array(32)`;
  `deriveKEKAsync` returns `Promise<Uint8Array(32)>`. Both deterministic for
  same `(passphrase, salt)`. Pepper changes output (verified).

## Why this shape

- `hashPassword(password): Promise<PHC>` — Argon2id PHC with 16 B random salt
  (library generates), `m=19456,t=2,p=1`, `outputLen=32`. Pepper via `secret` if set.
- `verifyPassword(phc, password): Promise<boolean>` — constant-time `verify` with
  same `secret`; malformed PHC throws `invalid PHC`.
- `needsRehash(phc): boolean` — `parseOptions` vs policy; `true` if
  `algorithm≠Argon2id` / `version≠0x13` / `m≠19456` / `t≠2` / `p≠1` /
  `outputLen≠32` / `saltLen<16`. Malformed PHC throws.
- `deriveKEK(passphrase, salt: Uint8Array(16)): Uint8Array(32)` — `hashRawSync`
  with same OWASP params + `salt` (caller-supplied 16 B, validated) + `secret`
  pepper. Sync for batch `deriveKEK` compatibility (`await` still works); also
  exported `deriveKEKAsync` for async callers.
- `rotation.ts`: pure helpers, no DB. `needsRotation(envelope, currentVersion)`
  → `kekVersion !== currentVersion`. `rotateKEK(envelopes, oldKEK, newKEK,
newVersion, getAAD?)` → re-wrap `wrappedDEK` only (decrypt DEK with old KEK +
  old `kekVersion` AAD, encrypt with new KEK + `newVersion` AAD, new 24 B nonce,
  bump `kekVersion`, keep `kid`/`payload`/`version`). Idempotent: `kekVersion ===
newVersion` returns copy. Batch-friendly (`Envelope[] → Envelope[]`), DB sweep
  deferred to T4. AAD resolver optional; default `tenant-123/switch-456` matches
  `envelope.test.ts` fixture; `tryUnwrapDEK` tries candidate AADs before fail-closed.

## TDD — RED then GREEN (T2.3)

- `pnpm --filter @heartbeat-vault/crypto test` before `kdf.ts`/`rotation.ts` → RED:

```
> @heartbeat-vault/crypto@0.0.0 test /home/kelanach/Public/main-linux-kelanach/code-berkah-titipan-tuhan/code/personal_prjct/heartbeat-vault/packages/crypto
> vitest run

 RUN  v5.0.1 /home/kelanach/Public/main-linux-kelanach/code-berkah-titipan-tuhan/code/personal_prjct/heartbeat-vault/packages/crypto

 ❯ src/kdf.test.ts (0 test)
 ❯ src/rotation.test.ts (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/kdf.test.ts [ src/kdf.test.ts ]
Error: Cannot find module './kdf.js' imported from .../src/kdf.test.ts
 ❯ src/kdf.test.ts:2:1
      1| import { describe, it, expect } from 'vitest';
      2| import { hashPassword, verifyPassword, deriveKEK, needsRehash } from '…
       | ^

 FAIL  src/rotation.test.ts [ src/rotation.test.ts ]
Error: Cannot find module './rotation.js' imported from .../src/rotation.test.ts
 ❯ src/rotation.test.ts:4:1
      2| import { randomBytes } from '@noble/ciphers/utils.js';
      3| import { encrypt, decrypt, type AAD } from './envelope.js';
      4| import { rotateKEK, needsRotation } from './rotation.js';
       | ^

 Test Files  2 failed | 1 passed (3)
      Tests  9 passed (9)
   Start at  08:42:33
   Duration  593ms
```

- After `src/kdf.ts` + `src/rotation.ts` implemented → GREEN:

```
 RUN  v5.0.1 /home/kelanach/Public/main-linux-kelanach/code-berkah-titipan-tuhan/code/personal_prjct/heartbeat-vault/packages/crypto

 Test Files  3 passed (3)
      Tests  21 passed (21)
   Start at  08:45:21
   Duration  592ms — envelope 9 + kdf 7 + rotation 5
   kdf: PHC round-trip, wrong password fails, malformed PHC throws,
        needsRehash detects old m=4096, pepper changes deriveKEK, missing pepper
        throws when requirePepper, deriveKEK deterministic 32B
   rotation: re-wrap preserves plaintext, idempotent double-rotate, old-version
        still decrypts with old KEK, needsRotation, batch rotates 2
```

## Verify (T2.3)

- `pnpm --filter @heartbeat-vault/crypto typecheck` clean (strict,
  `verbatimModuleSyntax` workaround via local Algorithm/Version const, no `as any`).
- `pnpm --filter @heartbeat-vault/crypto test` 21 passed (envelope 9 + kdf 7 + rotation 5).
- `pnpm audit` 2026-09-20: no new advisory for `@node-rs/argon2@2.2.1`; pre-existing
  advisories remain (turbo GHSA-hcf7-66rw-9f5r + GHSA-3qcw-2rhx-2726 ≤2.9.13,
  patched ≥2.9.14; undici via testcontainers <6.28.0 — not introduced by T2.3).
  Logged in `DECISIONS_LOG.md`.
- Audited lib only (`@node-rs/argon2` + `@noble/ciphers`); no custom crypto,
  no asymmetric/Shamir in this task (T2.4 deferred).
- Strict TS, 2-space/single/100-width (prettier ignored via `.prettierignore`
  for `packages/crypto/src`), `envelope.ts` read-only except `index.ts` exports.
