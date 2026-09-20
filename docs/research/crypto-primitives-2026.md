# Crypto Primitives Research — Heartbeat Vault (Phase 0, 2026-09-20)

> Status: Design gate input — awaiting user approval. No code. No custom crypto.
> Every recommendation → audited library + spec. Trade-offs documented for ADR.

---

## 1. Executive Decision Summary

| Layer                                                                      | Recommended Primitive                                                         | Recommended Library (Node/TS)                                                                                                                              | Why (one line)                                                                                                                                       |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Symmetric data at rest (DEK use)**                                    | **XChaCha20-Poly1305** (default), AES-256-GCM (FIPS/interop alt)              | `@noble/ciphers` (pure TS, audited) **or** `libsodium-wrappers` (WASM, high-level)                                                                         | XChaCha = 192-bit random nonce safe (2⁸⁸ collision bound), constant-time everywhere, no AES-NI dependency; AES-GCM kept for managed-KMS & compliance |
| **B. KDF from passphrase (unwrap path)**                                   | **Argon2id** (RFC 9106)                                                       | `argon2` npm (`ranisalt/node-argon2` binding, Cremains `/p-h-c/phc-winner-argon2`) **or** `@noble/hashes` argon2 (pure JS, same vectors)                   | OWASP first-choice memory-hard KDF; GPU/ASIC + side-channel hybrid; PHC string encodes params for future re-hash                                     |
| **C. Master-key wrap / envelope**                                          | **AAD-bound AEAD wrap** or **AES-KW / XChaCha wrap** of 32-byte DEKs          | App-level envelope via `@noble/ciphers` or `libsodium-wrappers` (`crypto_aead_*` + `crypto_kdf`); optionally offload to **Vault/OpenBao Transit** `rewrap` | Keeps KEK in one trust boundary (env/file or HSM/Transit); AAD binds tenant+keyVersion so a stolen blob can't be moved                               |
| **D. Asymmetric (public-key encrypt, server never sees plaintext option)** | **X25519 + HKDF-SHA256 + ChaCha20-Poly1305** (Sealed Box / age X25519)        | `libsodium-wrappers` `crypto_box_seal` / `age-encryption` (`typage`, built on noble)                                                                       | Anonymous sender, 48-byte overhead (32 ephemeral pk +16 tag), single-recipient per blob; age adds multi-recipient file format + plugin model         |
| **E. Post-quantum future-proof (optional)**                                | **X25519 + ML-KEM-768 hybrid** (age v1.3 `age1pq1…` / `AGE-SECRET-KEY-PQ-1…`) | `age-encryption` ≥0.3 (supports PQ hybrid); native `age` CLI 1.3                                                                                           | Harvest-now-decrypt-later defence without re-architecting the format                                                                                 |
| **F. Threshold split of the private key / KEK shard**                      | **Shamir (t-of-n) over GF(2⁸)**                                               | `shamir-secret-sharing` (Privy, 0.0.4) — **independently audited by Cure53 + Zellic**                                                                      | Zero-dep TS, browser+Node, inspired by hashicorp/vault, 2-of-N to 255 shares; used only to split _key material_, never as encryption                 |
| **G. Hash / HKDF / HMAC**                                                  | SHA-256, HKDF-SHA256, HMAC-SHA256, BLAKE2b                                    | `@noble/hashes` (audited) or libsodium equiv. (`crypto_hash`, `crypto_kdf`, `crypto_auth`)                                                                 | Wire-format HKDF vectors (RFC 5869 A.1), canonicalization (RFC 8785)                                                                                 |

**Never use:** custom S-boxes, home-rolled KDF iterations, unauthenticated encryption (`AES-CBC/CTR/ECB` alone), or ad-hoc secret sharing (xor without threshold math).

---

## 2. Library Scorecard (audited, 2026-09 current)

### 2.1 `@noble/*` family (paulmillr/noble) — **RECOMMENDED default for pure-TS**

- **What:** `noble-ciphers` (Salsa/ChaCha/AES-GCM/SIV, AES-KW/KWP, `managedNonce`), `noble-hashes` (SHA, BLAKE, HMAC, HKDF, PBKDF2, Scrypt, Argon2), `noble-curves` (X25519/Ed25519 at 2.3.0+), `noble-post-quantum` (ML-KEM/ML-DSA hybrids).
- **Audit:** 6 independent audits total as of Apr 2026. Ciphers 1.0.0 audited Sep 2024 by **Cure53** (funded OpenSats, scope everything); Curves 2.3.0 audited Aug 2026 by **Trail of Bits** (Patch the Planet w/ OpenAI, scope everything). Post-quantum self-audited Apr 2026. Self-audit 2026-04 found more minor issues than all third-party audits combined — hardened releases shipped.
- **Purity:** Zero/min deps, readable TS, ESM-only v2 (2025-08), tree-shakeable, PGP-signed releases, Wycheproof + ACVP + property-based vectors, fuzzed in `paulmillr/fuzzing`.
- **Permalinks:** `https://github.com/paulmillr/noble-ciphers` (main), `https://paulmillr.com/noble/`, `https://github.com/paulmillr/noble-ciphers/compare/1.0.0..main` (changes since Cure53), `https://github.com/paulmillr/noble-curves` (Trail of Bits scope).
- **When to pick noble vs libsodium:** noble when you want _small, auditable, pure-TS_ with no WASM toolchain, easy vendoring of vectors, and WebCrypto-compatible fallback. Choose libsodium when you want the _NaCl ergonomic ceiling_ (seal, secretbox, pwhash) and a single battle-tested C core.

### 2.2 `libsodium-wrappers` / `libsodium-wrappers-sumo` (jedisct1/libsodium.js) — **RECOMMENDED sealed-box + high-level AEAD**

- **What:** libsodium 1.0.22-stable compiled via Emscripten to WASM + JS, auto-generated wrappers. Standard dist = high-level (`crypto_secretbox`, `crypto_aead_xchacha20poly1305_ietf`, `crypto_box_seal`, `crypto_pwhash_ALG_ARGON2ID13`). Sumo = all low-level + deprecated symbols.
- **NPM:** `libsodium-wrappers` 0.8.4 (2026-04-19, 2.3M/wk, ISC), 721 dependents, `libsodium` peer dep. Must `await sodium.ready`.
- **Docs:** https://doc.libsodium.org / https://libsodium.gitbook.io/doc (GitBook + sitemap at `/llms.txt`, markdown via `?ask=`).
- **Sealed box:** `crypto_box_seal(c,m,mlen,pk)` anonymous; `crypto_box_seal_open(m,c,clen,pk,sk)` — 48-byte overhead; recipient anonymity (can't link ciphertext to recipient without identity).
  Evidence: `https://github.com/jedisct1/libsodium/blob/master/src/libsodium/crypto_box/crypto_box_seal.c` + autodocs at `/crypto-box.md`.
- **Envelope use:** `crypto_aead_xchacha20poly1305_ietf_encrypt/decrypt` or `crypto_secretbox_easy` for DEK use; `crypto_pwhash(type=argon2id)` for passphrase; `crypto_kdf_derive_from_key` for HKDF-like subkeys; `sodium_malloc/sodium_memzero` via sodium-native for `SecureBuffer` on Node.
- **Audit lineage:** libsodium C core has extensive third-party audits (referenced in `sodium-plus` / upstream docs); wrappers are thin Emscripten bindings → trust inherits from C core + wrapper tests.

### 2.3 `sodium-plus` (Paragonie, 0.9.0) & `sodium-native` — **not primary**

- `sodium-plus`: type-safe wrapper over `libsodium-wrappers` (prefers `sodium-native` if installed), `async/await`, key-type branded classes. Last publish 2020-07-23, 21 dependents — **stale, 2020 toolchain**. Use directly `libsodium-wrappers` (2026-04) unless you need its type branding; then vendor it.
- `sodium-native` (node-gyp, N-API): faster, `mlock`/`sodium_memzero` via C, prebuilt binaries. Good for Node ≥22 server if you can carry native addon; not for edge/WebCrypto runtimes. Optional backend behind libsodium wrappers, not required.

### 2.4 `age-encryption` (typage, `jsr:@age/age-encryption`, `FiloSottile/typage`) — **RECOMMENDED for asymmetric file-style envelopes**

- **What:** TypeScript age v1 file format, ESM, Node 20+ / Bun / Deno / browsers, depends only on noble + WebCrypto. Implements **X25519** (`age1…` / `AGE-SECRET-KEY-1…`) and **post-quantum hybrid X25519+ML-KEM-768** (`age1pq1…` / `AGE-SECRET-KEY-PQ-1…`), passphrase (`scrypt` with configurable work factor), armoring, streaming, WebAuthn/passkey + FIDO2 plugin interop. Spec at `age-encryption.org/v1` (C2SP, @benjojo + @FiloSottile). Doc: man `age(1)`/`age-keygen(1)`, 2026-08.
- **Crypto inside `x25519.go`:** ephemeral X25519 → HKDF-SHA256(salt=`ourPub||theirPub`, info=`age-encryption.org/v1/X25519`) → ChaCha20-Poly1305 wrap of `fileKey` (16-byte file key later used for payload). Same KDF on unwrap via recipient secret key. Permalinks: `https://github.com/FiloSottile/age/blob/main/x25519.go` (commit `ae74b61…` Wrap/unwrap shown in §3).
- **When to use vs raw sealed box:** Pick age when you want **multi-recipient envelopes**, **streaming file encryption**, **SSH-key convenience**, or **plugin extensibility** (recipient plugin can decrypt without revealing recipient). Pick `crypto_box_seal` when you need **single-recipient anonymous blob ≤ message size** and no file framing.
- **NPM:** `age-encryption` on npm, typed, ~ES2023, `npm install age-encryption`.

### 2.5 `node-argon2` (`ranisalt/node-argon2`) — **RECOMMENDED for Argon2id on Node**

- **Binding** to `P-H-C/phc-winner-argon2` reference C impl. Default `type=argon2id`, `memoryCost=65536 (64 MiB)`, `timeCost=3`, `parallelism=4`, `hashLength=32`, version 0x13. Verify path: constant-time compare after re-hash with extracted PHC params. Docs: context7 `/ranisalt/node-argon2` + wiki `/Options` + `/security-notes.md`.
- **Fallback pure-JS:** `@noble/hashes` `argon2` for edge/browsers where native binding unavailable (not constant-time in JS — acceptable only outside server hot path).

### 2.6 Shamir

| Package                                                                                                                                                                                      | Audit                                                                                                                                                                              | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`shamir-secret-sharing` (privy-io, 0.0.4, Apache-2.0, 2025-01-10, 29.7k/wk)** — `split(secret, shares, threshold)` / `combine(shares)` over `Uint8Array`, GF(2⁸), Hashicorp/vault-inspired | **Cure53 2023-02 (PVY-01, 2 senior testers) + Zellic** — 1 high (degree < t-1 fixed), 2 info (cache side-channel via look-up tables). Cure53: "well-written, good best-practices." | **Trust, with scope caveat:** assumes honest dealer/participants; no VSS (no ZK proof of dealer honesty); corrupt-share detection only via higher-level hash check. Acceptable for splitting _a single user's own key_ across user-held shares; not for adversarial dealer. See `https://cure53.de/audit-report_privy-sss-library.pdf` + `https://github.com/Zellic/publications/blob/master/Privy_Shamir_Secret_Sharing_-_Zellic_Audit_Report.pdf` |
| `shamir-secret-sharing-extended` (onur-nizam)                                                                                                                                                | none published                                                                                                                                                                     | marketing claims AES-GCM per-share "encryption" — unnecessary coupling, not audited — **do not use**                                                                                                                                                                                                                                                                                                                                                |
| `hashicorp/vault` Shamir (Go)                                                                                                                                                                | internal, battle-tested for Vault unseal                                                                                                                                           | reference impl, not a Node lib — use as vector source only                                                                                                                                                                                                                                                                                                                                                                                          |
| `dsprenkels/sss`                                                                                                                                                                             | cache-side-channel resistant (no LUT)                                                                                                                                              | if cache side-channel is in scope (multi-tenant JS), consider porting; otherwise Privy +operational caution suffices                                                                                                                                                                                                                                                                                                                                |

---

## 3. Primitive-per-Use Table (normative, Phase 0 approved shape)

```
[ plaintext secret (per-switch byte payload) ]
        │ generate 32 random bytes (CSPRNG)
        ▼
       DEK ──AEAD──▶ ciphertext + tag + nonce   (store: envelope.ciphertext)
        │                ▲
        │                │ AAD = { keyVersion, tenantId, switchId, purpose="envelope:v2" }
        │ wrap
        ▼
   wrappedDEK = AEAD_KEK( nonce_wrap , DEK , AAD )   OR  AES-KW(KEK, DEK)  (store: envelope.wrappedDEK)
        │
        ├── KEK source (choose ONE deploy-time, ADR):
        │     a) env/file (Docker secret) — simplest, standard profile
        │     b) passphrase-unseal → Argon2id → KEK (interactive start)
        │     c) Vault/OpenBao Transit (KEK never leaves HSM boundary)
        │     d) cloud KMS (off-prem only if user opts in)
        │
        └── Asymmetric alternative (per-recipient, stored alongside symmetric envelope):
              seal( DEK , RecipientPubKey )  OR  age stanza X25519 → wrappingKey → aeadEncrypt(fileKey)
              (recipient decrypts DEK offline; server never holds recipient secret)
```

| Use                   | Primitive (exact)                                                                  | Nonce / IV                                                                   | Tag / Auth           | Library call                                                                                                                                                           | Notes                                                                                                                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bulk payload**      | **XChaCha20-Poly1305** (IETF, 256-bit key, draft-irtf-cfrg-xchacha §A.3.1 vectors) | 24 random bytes via `randomBytes`/`getRandomValues` + `managedNonce` wrapper | 16 Poly1305          | `xchacha20poly1305(key, nonce).encrypt(plaintext)` (`@noble/ciphers/chacha.js`) or `crypto_aead_xchacha20poly1305_ietf_encrypt` (libsodium)                            | Default. Safe for random nonces, 2⁸⁸ messages before birthday risk. Fallback `AES-256-GCM` 12-byte nonce only if a counter/`MessageCounter` guarantees uniqueness; enforce per-key 2³² cap for AES-GCM.                                   |
| **AES-GCM interop**   | AES-256-GCM (SP 800-38D, NIST vectors 13-16)                                       | 12 bytes CTR-derived                                                         | 16 GHASH             | `gcm`/`gcmsiv` (`@noble/ciphers/aes.js`) or WebCrypto `AES-GCM`                                                                                                        | Use only for KMS/Vault boundary or FIPS demand; constant-time via AES-NI; never reuse nonce — `managedNonce` or DB counter.                                                                                                               |
| **DEK generation**    | CSPRNG 32 bytes                                                                    | —                                                                            | —                    | `randomBytes(32)` (`@noble/ciphers/utils`) / `sodium.randombytes_buf` / `crypto.getRandomValues`                                                                       | One DEK per secret. Generate fresh on create + on re-encrypt (rotation). Zeroize plaintext DEK after use (`sodium_memzero` / `SecureBuffer`).                                                                                             |
| **KEK wrap**          | XChaCha20-Poly1305 **or** AES-KW (RFC 3394) / AES-KWP (RFC 5649)                   | 24 (XChaCha) / deterministic (KW)                                            | 16 (AEAD) / ICV (KW) | `xchacha20poly1305(kek, nonce).encrypt(dek)` with AAD binding `keyVersion` etc.; or `aeskw`/`aeskwp` (`@noble/ciphers/aes.js`) for RFC paths                           | AAD must include `keyVersion` so a wrapper can't be moved across versions without decrypt failure. Store `kek_version` prefix in blob (e.g. `nbe2.v{version}.b64(nonce).b64(ct)`).                                                        |
| **Passphrase → KEK**  | **Argon2id** (RFC 9106), output 32 bytes                                           | —                                                                            | —                    | `argon2.hash(pass, {type: argon2id, memoryCost, timeCost, parallelism})` → raw 32 → KEK; libsodium `crypto_pwhash(32, pass, salt, opslimit, memlimit, alg=ARGON2ID13)` | OWASP 2026 baseline below; PHC string `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>` encodes params for future upgrade. Add per-record 16-byte salt (library-managed) + optional 32-byte **pepper** (env/HSM, not DB) via `secret` param. |
| **Asymmetric (seal)** | X25519 ECDH → HKDF-SHA256 → ChaCha20-Poly1305                                      | 24 (file payload) / ephemeral 32 pk + 16 tag (seal)                          | 16 Poly1305          | `crypto_box_seal(c,m,mlen,pk)` / `crypto_box_seal_open` (libsodium); age `Wrap(fileKey)` stanza `X25519 <ephemeral-pub-b64>` → HKDF(salt=ephemeralPub                  |                                                                                                                                                                                                                                           | recipientPub, info=age-encryption.org/v1/X25519) → `aeadEncrypt(fileKey)` | libsodium seal: ciphertext = ephemeral pk (32) \|\| box (mlen+16). Age: identical KDF label `age-encryption.org/v1/X25519`, plus `fileKeySize` length check on unwrap; anonymous (ciphertext not linkable to recipient w/o identity). |
| **HKDF / KDF**        | HKDF-SHA256 (RFC 5869 A.1), HMAC-SHA256 (RFC 4231 §4.3)                            | —                                                                            | —                    | `@noble/hashes` `hkdf`, `hmac`; libsodium `crypto_kdf_derive_from_key`                                                                                                 | Derive per-tenant subkeys or re-derive without re-encrypting payload when only AAD changes.                                                                                                                                               |
| **Shamir split**      | Shamir t-of-n GF(2⁸)                                                               | —                                                                            | —                    | `split(secretUint8, n, t)` / `combine(shares)` (`shamir-secret-sharing`)                                                                                               | `n≤255, t≤255, t≤n, t≥2`. Shares are `Uint8Array` with 1-byte x-coord prefix; store prefix. Not an encryption — combine returns secret only if ≥t honest shares; validate via `hash(combined)==expected` (Cure53 recommendation).         |
| **Backup encryption** | Same envelope as payload (file-level age or per-row DEK re-wrap under backup KEK)  | —                                                                            | —                    | `age` passphrase or recipient envelope for dump file; or `pg_dump` → XChaCha/AES-GCM stream encrypt with `managedNonce`                                                | Backup ciphertext must be independently decryptable; document restore that re-derives KEK from passphrase/age identity (test restores in CI).                                                                                             |

---

## 4. Argon2id Parameters — OWASP Current (2026)

Source: `OWASP Cheat Sheet Series / cheatsheets/Password_Storage_Cheat_Sheet.md` (canonical), RFC 9106, and `https://go-tools.org/blog/bcrypt-vs-argon2-vs-scrypt-password-hashing` (2026-05-02 summary).

**Baseline (recommended default for this app):**
`m = 19456 KiB (19 MiB), t = 2, p = 1` — minimum OWASP.

**Equivalent-trade-off profiles (same defence, different RAM/CPU balance):**

| m (KiB)   | t     | p     | RAM/hash   | Use                                                                              |
| --------- | ----- | ----- | ---------- | -------------------------------------------------------------------------------- |
| 47104     | 1     | 1     | 46 MiB     | RAM-rich server, low latency                                                     |
| **19456** | **2** | **1** | **19 MiB** | **baseline — default**                                                           |
| 12288     | 3     | 1     | 12 MiB     | tighter RAM budget                                                               |
| 9216      | 4     | 1     | 9 MiB      | constrained                                                                      |
| 7168      | 5     | 1     | 7 MiB      | minimal RAM                                                                      |
| 65536     | 3     | 4     | 64 MiB     | `node-argon2` library default (higher than OWASP min; good when concurrency low) |
| 2 GiB     | 1     | 4     | 2048 MiB   | RFC 9106 FIRST RECOMMENDED (high-security, not for web latency)                  |
| 64 MiB    | 3     | 4     | 64 MiB     | RFC SECOND RECOMMENDED (memory-constrained)                                      |

**Rules:**

- Leave `p=1` unless you've profiled multi-lane on your production CPU (most web frameworks already parallelize per-request; raising `p` helps throughput only if `m` is capped).
- Tune `t` until `argon2.hash` median is **100–500 ms** on prod hardware. Start with `m` = per-login RAM budget = `RAM_available_for_hashing / peak_concurrent_logins`.
- **Salt:** 128-bit (16 bytes) unique per record, generated by library; tag 128–256 bits.
- **Pepper:** 32-byte app-level secret (env/Vault, never DB), passed as `secret` to `argon2.hash`; rotate pepper by re-hashing on next login.
- **Encoding:** PHC `$argon2id$v=19$m=…,t=…,p=…$<salt>$<hash>` — verify via `argon2.verify(phcString, password)` (constant-time). For key-derivation use `raw:true` + explicit `hashLength: 32`.
- **Fallback ladder if Argon2 unavailable:** scrypt `N=2^17, r=8, p=1` (128 MiB) → bcrypt `cost≥10` (limit 72 bytes) legacy-only → PBKDF2-HMAC-SHA256 `600k` iterations FIPS-only. Not recommended for new code.

**Memory-wiping:** enable `sodium_memzero` / `SecureBuffer` on Node; not possible in browser JS (documented limitation — Cure53 notes JS cannot guarantee constant-time).

---

## 5. Envelope Encryption — Pattern & Rotation (zero-downtime, no silent loss)

### 5.1 Shape (per secret, server or client-encrypted)

```ts
type EnvelopeV2 = {
  v: 2; // wire version
  kid: string; // KEK id (maps to Vault/DB key, e.g. "hv-2026-01")
  kekVersion: number; // monotonic int, bumped on KEK rotation
  dekWrap: { alg: 'xchacha20poly1305' | 'aes-kw' | 'aes-kwp'; nonceB64?: string; ctB64: string };
  payload: {
    alg: 'xchacha20poly1305' | 'aes-256-gcm';
    nonceB64: string;
    ctB64: string;
    tagB64?: string;
  };
  aad: { tenantId: string; switchId: string; purpose: 'heartbeat-vault:secret:v2' };
  createdAt: string; // ISO
};
// invariant: dekWrap.ct decryptable ONLY with (kid,kekVersion) + aad; payload decryptable ONLY with unwrapped DEK + its nonce/tag
```

**Write:** `dek = randomBytes(32)` → `payload.ct = AEAD(dek, plaintext, nonce, AAD=switchId)` → `dekWrap = AEAD(kek, dek, wrapNonce, AAD={kid,kekVersion,tenantId,switchId})` → persist `envelope` + ciphertext blob. Zeroize `dek` copy.

**Read:** `kek = resolve(kid, kekVersion)` (fail closed if not found) → `dek = AEAD_decrypt(kek, dekWrap)` (auth failure → generic "decrypt_failed", no oracle) → `plaintext = AEAD_decrypt(dek, payload)` → use, then zeroize.

**Granularity:** **one DEK per secret** (owns blast radius; 1 secret compromised ≠ all). Don't share DEK across users. Rotate DEK only when payload changes or re-wrap sweep touches it.

### 5.2 Where KEK lives (deploy-time choice, record ADR 7.1)

| KEK source                                | Trust boundary          | Read path                                                                                      | Rotation                                                                                                                                      | Failure at trigger                                                                                                                                           |
| ----------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `file`/`DOCKER_SECRET` (standard profile) | host filesystem         | sync unwrap in app                                                                             | bump `kekVersion`, add new key to keyring, re-wrap sweep, retire old file after sweep proves zero `LIKE '…vOLD.%'`                            | no external dep — release never blocked by KMS outage                                                                                                        |
| `passphrase-unseal`                       | operator memory         | Argon2id derive at boot → KEK in `SecureBuffer`                                                | re-derive on next boot with new passphrase; re-hash old PHC on login                                                                          | operator must unseal after restart; scheduler must queue triggers while sealed and alert                                                                     |
| `Vault/OpenBao Transit`                   | Vault cluster (HA Raft) | `Decrypt`/`Rewrap` (single call, DEK plaintext never leaves Vault)                             | `RotateKeyOnDemand` (AWS) / `CryptoKeyVersion` primary flip (GCP) / `rotate`+`min_decryption_version` (Vault); keep `n-1` version decryptable | retry queue + DB advisory lock; never silently drop — `delivery_attempts` + dead-letter + operator alert; auto-unseal (Transit engine needs unseal, not KEK) |
| `cloud KMS`                               | cloud provider          | decrypt+encrypt (GCP, DEK transits worker briefly) or `ReEncrypt` (AWS, no plaintext exposure) | provider-managed rotation period (e.g. 30–90 days)                                                                                            | same queuing; prefer AWS `ReEncrypt`/Vault `rewrap` (no dek plaintext in app memory)                                                                         |

**Rule 7.1.3 (non-negotiable): hardened profile must never be a release-path SPOF.** Even with Vault, the trigger scheduler must complete the release from DB + wrapped DEKs alone — Vault sealed/unreachable → queue + retry + alert, never false-trigger or silent loss.

### 5.3 Rotation procedure (version-in-blob, not sibling column as single source — but support both for query ergonomics)

Inspired by GCP `GenerateDataKey` / `ReEncrypt`, `systemslibrarian/crypto-lab-envelope-kms` visualizer, and `You need to rotate … without a version column` (2026-07-10) + `QueryPlan` runbook (2026-07-18).

1. **Prepare:** Generate new KEK version `v+1`. Keep `v` as `decrypt-only`. Set retention window (≥ sweep duration + 24h). Audit log the rotation intent (hash-chained).
2. **Flip writer:** Writes immediately seal under `v+1`. Reads resolve version from **blob prefix** `nbe2.v{version}.…` (self-describing, the IV pattern) — no blind guess. Optionally also store `kek_version` column for indexed sweep (`WHERE kek_version < current ORDER BY kek_version, id LIMIT $BATCH FOR UPDATE SKIP LOCKED`), but blob is source of truth.
3. **Re-wrap sweep (interruptible, idempotent):**
   ```sql
   SELECT id, kek_version, wrapped_dek FROM secrets
   WHERE kek_version < $target AND rewrapped_at IS NULL
   ORDER BY kek_version, id LIMIT $BATCH FOR UPDATE SKIP LOCKED;
   -- per row: dek = decryptWith(v_old, wrapped_dek)  (or kms.rewrap no-plaintext)
   --          newWrapped = encryptWith(v_new, dek)
   --          UPDATE secrets SET wrapped_dek=newWrapped, kek_version=$target, rewrapped_at=now() WHERE id=$id;
   ```
   Batch size 100–500, `tracer` span `kek.target_version`, `structlog` audit per row, metric `rewrap_progress`.
4. **Hold:** Both versions resident until `stale_rows==0` (`SELECT count(*) WHERE kek_version < current AND rewrapped_at IS NULL` ==0) — proving every row readable. Only then `schedule_key_deletion` / raise `min_decryption_version` / delete file.
5. **Post-rotation proofs:** every row has non-null `kek_version`; no version < floor; no lookup fans out to >1 KEK version; p99 unwrap latency <45ms; unwrap calls decoupled from read volume (DEK cache — unwrap once per store lifetime, re-unwrap only on rotation).

**KEK compromise vs DEK compromise:** KEK leak → total (every DEK wrapped under it). DEK leak (memory) → only that secret; rotation alone insufficient — must **re-encrypt payload** with fresh DEK. Document and test both.

---

## 6. X25519 / Sealed Boxes — When & How

**Use sealed boxes / age X25519 when:** the dead-man release must be **recipient-held** (server can't decrypt on its own) — Type 1 deterrence use-case: public key published openly, private key (or t-of-n shares) released on trigger; server never holds private scalar. This satisfies "never invent asymmetric envelope — use sealed boxes."

**Two equivalent constructions (pick one per switch, ADR):**

**A. libsodium sealed box:**

```
Seal:  c = crypto_box_seal(m, pk)           // 32 ephemeral pk + Poly1305 box
Open:  m = crypto_box_seal_open(c, pk, sk)  // fail -> -1, length clen-48
Overhead 48 bytes, anonymous, no sender key.
TypeScript:
  await sodium.ready;
  const c = sodium.crypto_box_seal(plaintextU8, recipientPk32);
  // store c (base64), on trigger recipient runs crypto_box_seal_open
```

**B. age X25519 stanza (more expressive):**

```
Wrap(fileKey):  ephemeral = random Scalar → ourPub = X25519(ephemeral, Basepoint)
                shared = X25519(ephemeral, theirPub)
                salt = ourPub || theirPub
                wrappingKey = HKDF-SHA256(shared, salt, "age-encryption.org/v1/X25519")  [32]
                wrappedKey = aeadEncrypt(wrappingKey, fileKey)  // ChaCha20-Poly1305
                stanza: {Type:"X25519", Args:[b64(ourPub)], Body:wrappedKey}

Unwrap:        shared = X25519(secretKey, stanza.Args[0])
               same HKDF → try aeadDecrypt; fail -> ErrIncorrectIdentity
Overhead per recipient = 1 stanza (32 pub + 16 tag + fileKey). Multi-recipient → N stanzas.
Permalink: https://github.com/FiloSottile/age/blob/ae74b61b59a5ae5d73abbb631443e5bc46388cd5/x25519.go
TypeScript via age-encryption:
  const e = new age.Encrypter(); e.addRecipient(recipient); const ct = await e.encrypt(plaintext);
  const d = new age.Decrypter(); d.addIdentity(identity);  const pt = await d.decrypt(ct,"text");
```

**Choosing:** single recipient + smallest blob → `crypto_box_seal`; multiple recipients / streaming / SSH-key convenience / future PQ hybrid → `age-encryption`. Both are X25519-based; don't mix with RSA/Ed25519-SSH unless recipient has no native key (age docs warn SSH keys may not be long-term protected).

**Post-quantum variant:** `age-plugin-pq` or `age -pq` hybrid (`X25519 + ML-KEM-768`); recipient `age1pq1…`, identity `AGE-SECRET-KEY-PQ-1…`. Use when harvest-now-decrypt-later matters (secrets valid for decades).

---

## 7. Encrypted Backups

- **Shape:** `pg_dump` (or per-row envelope export) piped into **age** or XChaCha20-Poly1305 stream encrypt. Key = **age recipient** (offline) or **passphrase → Argon2id → KEK** (same params as §4). Backup ciphertext is independent — doesn't need DB KEK to restore.
- **Restore doc must include:** how to re-derive backup KEK (salt stored in backup header, not DB), age identity file location/permissions (0400), and test restores in CI (Testcontainers + real age binary / typage decrypt, not mock).
- **Verify in `scripts/verify-security.sh`:** scan DB rows → no plaintext (SELECT where decrypt without KEK fails); decrypt backup sample with provided identity fails with wrong identity; backup file header contains `age-encryption.org` or `v2` CBOR marker, not plaintext.

---

## 8. KAT / Round-Trip / Negative Test Guidance

> Brief §9 mandates crypto tests with known-answer vectors + round-trip + negative + Wycheproof adversarial vectors, with coverage thresholds on crypto/auth/scheduler/delivery.

### 8.1 Vectors to vendor (pinned, committed in repo)

| Primitive              | Vector source                                                                                           | What to test                                                                                                                                                                              | File suggestion                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **XChaCha20-Poly1305** | `draft-irtf-cfrg-xchacha` §A.3.1 KAT, RFC 8439                                                          | KAT encrypt + decrypt; wrong nonce/tag/AAD → throw                                                                                                                                        | `tests/vectors/xchacha-kat.json`                                                            |
| **AES-256-GCM**        | NIST SP 800-38D / McGrew-Viega cases 13–16, + Wycheproof `aes_gcm_test.json` (iv 96 / tag 128 filtered) | KAT + Wycheproof `valid` decrypt + `invalid` open failure (tag/ciphertext/AAD tamper)                                                                                                     | `tests/vectors/aes-gcm-kat.json`, vendor `C2SP/wycheproof/testvectors_v1/aes_gcm_test.json` |
| **AES-KW/KWP**         | NIST SP 800-38F / RFC 3394 & 5649                                                                       | wrap/unwrap KAT + invalid ICV detection                                                                                                                                                   | `tests/vectors/aes-kw-kat.json`                                                             |
| **ChaCha20-Poly1305**  | Wycheproof `chacha20_poly1305_test.json`                                                                | KAT + invalid tag → failure                                                                                                                                                               | vendored Wycheproof                                                                         |
| **Argon2id**           | libsodium `crypto_pwhash` cross-impl KAT (same m/t/p/salt → same tag), RFC 9106 §5.3                    | raw KAT (hex) + PHC round-trip (`hash`→`verify` ok, wrong password → fail, malformed PHC → fail) + fuzz replay                                                                            | `tests/vectors/argon2id-kat.json`                                                           |
| **PBKDF2-HMAC-SHA256** | RFC 7914 §11                                                                                            | KAT (only if PBKDF2 fallback kept for WebCrypto runtimes)                                                                                                                                 | `tests/vectors/pbkdf2-kat.json`                                                             |
| **HKDF-SHA256**        | RFC 5869 Appendix A.1                                                                                   | KAT                                                                                                                                                                                       | `tests/vectors/hkdf-kat.json`                                                               |
| **HMAC-SHA256**        | RFC 4231 §4.3                                                                                           | KAT                                                                                                                                                                                       | `tests/vectors/hmac-kat.json`                                                               |
| **Shamir**             | Privy repo vectors + RFC draft vectors where available                                                  | split→combine round-trip for thresholds n=5 t=3 etc.; fewer than t shares → no reconstruction (or wrong secret → hash mismatch); corrupt share → detectable via `hash(combine)!=expected` | `tests/vectors/shamir-roundtrip.json`                                                       |
| **Age / sealed box**   | age testdata + libsodium seal vectors                                                                   | round-trip single + multi-recipient; wrong identity → ErrIncorrectIdentity; tampered stanza/body → decrypt failure                                                                        | `tests/vectors/age-roundtrip.json`                                                          |

**Wycheproof coverage model:** follow `rscrypto`-style `test-vector-coverage.md` — prefer Wycheproof when it maps 1-1 to public API; otherwise use standards KAT + explicit negative behavior tests. For AEAD, Wycheproof `result: "invalid"` vectors are expected **decryption failures** (tampered tag/ciphertext/AAD, wrong key/nonce size). Map tag to `ct || tag` vs `tag || ct` per primitive's SIV nuance (`types.md`).

### 8.2 Test suites (what to ship)

```ts
// KAT: golden
for (const v of xchachaKats) {
  expect(encrypt(v.key, v.nonce, v.pt, v.aad)).toEqual(v.ctWithTag);
  expect(decrypt(v.key, v.nonce, v.ctWithTag, v.aad)).toEqual(v.pt);
}
// Wycheproof adversarial: invalid must fail, valid must succeed
for (const v of wycheproofAead) {
  if (v.result === "valid")  expect(decrypt(...)).toEqual(v.pt);
  else                       expect(() => decrypt(v.key, v.nonce, v.ctWithTag, v.aad)).toThrow();
}
// Tamper: flip one bit in tag/ciphertext/AAD/nonce → throws DecryptFailed (constant-time, no oracle)
for (const tamper of [flipTag, flipCt, flipAad, flipNonce, wrongKey, truncatedCt]) {
  expect(() => decrypt(...tamper(ct))).toThrow(DecryptFailed);
}
// Argon2: PHC round-trip + negative
const phc = await argon2.hash(pass); expect(await argon2.verify(phc, pass)).toBe(true);
expect(await argon2.verify(phc, wrongPass)).toBe(false);
expect(() => argon2.verify("malformed", pass)).toThrow();
// Shamir: honest t-of-n + corrupt share
const shares = await split(secret, 5, 3);
expect(await combine(shares.slice(0,3))).toEqual(secret);
expect(await combine(shares.slice(0,2))).not.toEqual(secret); // or throws
const bad = flipByte(shares[0]); expect(hash(await combine([bad, shares[1], shares[2]]))).not.toEqual(hash(secret));
```

- **Differential / oracle:** for AEAD, encrypt then decrypt via second impl (WebCrypto vs noble vs libsodium) and compare — catches dispatch/SIMD divergence.
- **Fuzz:** Wycheproof + NIST ACVP ML-DSA harnesses show harness-per-schema model (`wolfSSL/wychcheck` runners) — adapt for `aead_test.json`, `xchacha_test.json`, `hkdf_test.json` via a single `aead_test.go` equivalent in TS (hex helpers + schema runner).
- **Property:** `fast-check` round-trip: `decrypt(encrypt(random Pt, random Key, random Nonce, random AAD)) == Pt` for thousands of cases; fuzz `schannel` length sweeps.

**CI gate:** run vector suite on every PR, block merge on any KAT drift; publish Wycheproof pass rate in report (`files tested: 48, vectors: 4521 passed, 0 failed` pattern from `wolfSSL/wychcheck`).

### 8.3 Negative / adversarial specifics auditors expect

- AEAD: invalid tag (1-bit flip), truncated ct, wrong AAD, wrong nonce length, wrong key length, low-order point (X25519 — libsodium/age already reject via `curve25519` check, but test it), reused nonce (stateful test: second encrypt with same nonce must be blocked by `MessageCounter`/`managedNonce`, not silently succeed).
- Argon2: empty password, 1-MB password, null byte in password, wrong PHC version field, oversized `m` (>2^32-1 KiB), `p> lanes`.
- Shamir: `n>255`, `t>n`, `t<2`, duplicate share x-coord, single-share combine.

---

## 9. Trade-offs — Documented for ADR

### 9.1 Client-side vs Server-side Key Custody

| Axis                          | Client-side custody (keys never leave browser)                                                                      | Server-side custody (KEK in app env/Vault)                               | Hybrid (envelope + client key option) — **recommended**                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Server breach**             | ciphertext only → useless without client key                                                                        | KEK + ciphertext → total if KEK exfiltrated                              | Default server breach = ciphertext only; per-switch client-key mode adds E2E for sensitive switches; rest use server envelope for operability |
| **Operator / insider**        | cannot read (mathematical, not policy)                                                                              | can read (has KEK in memory)                                             | audit: server side is **operator-readable at runtime** — document honestly, don't claim ZK when self-hosted with server envelope              |
| **Legal compulsion**          | nothing to hand over (no plaintext)                                                                                 | must produce plaintext if compelled (holds KEK)                          | hybrid lets user pick ZK per-switch (deterrence keys) while routine delivery switches stay server-releasable                                  |
| **Recovery / password reset** | impossible without client key/share → data loss if forgotten                                                        | recoverable (rotation without user)                                      | offer Shamir t-of-n escrow for server switches (k-of-n recovery contacts) + explicit loss warning for pure client-key switches                |
| **Features**                  | no server search, no preview, per-recipient re-encrypt, bearer-URL key transport (fragment never sent per RFC 9110) | search/index possible (decrypt server-side), simple share, central audit | envelope payload stays searchable only via metadata (switchId, labels) — never index plaintext                                                |
| **Usability**                 | user must safe-keep key/share out-of-band; UX heavier                                                               | zero user key burden                                                     | Phase 0 default: server envelope (easy) + opt-in client sealed-box (Type 1) — user chooses per switch                                         |

**Guidance:** Brief §5.3 requires pluggable channels with warning "never send raw secrets over weak channels; prefer decryption link + separate key/share." That's a **link + key-split** pattern: send ciphertext / one-time-view link over email/webhook, and deliver DEK / Shamir share over second channel (Signal, in-person, age recipient). Document per-channel matrix in `SECURITY.md`.

**Self-host ≠ ZK warning:** As `vanishingvault.com/blog/self-host-onetimesecret-not-zero-knowledge` (2026-08-02) documents, self-hosting a server-side-encrypt app (OneTimeSecret-style) still leaves the operator in the plaintext path — ZK requires _client-side WebCrypto encrypt before upload, key in URL fragment_. Don't mislabel.

### 9.2 Recipient-Held Shares vs Server Release

| Model                                              | Release condition                                                              | Who can decrypt                                                | Availability risk (`Vault sealed` etc.)                                                                                                                             | Recommended for                                                                                                                                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Recipient-held Shamir shares (t-of-n, offline)** | t shares combined + public metadata; no server crypto needed post-distribution | any t recipients together; server cannot release alone         | **none** — release is offline reconstruction; server is just a mailbox for shares (or shares never touch server at all)                                             | Type 1 (asymmetric private-key escrow). Private scalar `sk` → `split(sk, n, t)` → distribute shares to recipients out-of-band (age-encrypted to each recipient's age1 pubkey or printed QR). On trigger, t recipients combine. |
| **Server-released (envelope, DB + KEK)**           | scheduler reaches `trigger_at` and idempotency guard fires                     | server (has KEK) pushes to recipients over configured channels | **release blocked while KEK unavailable** → queue + retry + alert; must not silently lose. Brief 5.1 "release-path availability" requires defined failure behavior. | Type 2 (direct delivery). Payload always wrapped under KEK; scheduler holds advisory lock, writes `delivery_attempts` + dead-letter, retries with backoff.                                                                     |
| **Hybrid (default to build)**                      | metadata flag `releaseMode: "server"                                           | "shares"` per switch                                           | either                                                                                                                                                              | server mode inherits Vault-risk mitigation above; share mode decoupled                                                                                                                                                         | Support both per-switch. Type 1 defaults to shares (trust-minimized deterrence). Type 2 defaults to server (reliable delivery). Allow converting server switch → shares by re-splitting. |

**Shamir caveats (document in threat model):**

- No integrity against malicious dealer without VSS/ZK proof. Privy is honest-dealer only — fine when _the user is their own dealer splitting their own key_, not when dealer is untrusted.
- No share-validity without extra hash commitment. Add `commit = BLAKE2b(secret)` (or `hash(combined)`) stored alongside envelope; verify on `combine`.
- Shares of size equal to secret length — splitting a 32-byte private key → each share ~33 bytes (x-coord prefix). Don't split bulk payload; split the **DEK/private scalar** only.
- Cache side-channel via LUT acknowledged in Cure53 report — acceptable on isolated Node/browser; flag for multi-tenant JS.
- Malicious combining threshold underflow PVY-01-002 (fixed) — pin `0.0.4` and test `t` enforcement.

---

## 10. Concrete TypeScript Skeleton (illustrative, not yet implemented)

```ts
// --- AEAD (noble, managed nonce) ---
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes, managedNonce } from '@noble/ciphers/utils.js';
import { split, combine } from 'shamir-secret-sharing';
import * as sodium from 'libsodium-wrappers';
import * as age from 'age-encryption';

// XChaCha with safe random nonce
const aead = managedNonce(xchacha20poly1305)(randomBytes(32));
const pt = new TextEncoder().encode('secret payload');
const ct = aead.encrypt(pt); // nonce prepended, tag appended (library-managed)
const pt2 = aead.decrypt(ct);

// libsodium sealed box
await sodium.ready;
const kp = sodium.crypto_box_keypair();
const sealed = sodium.crypto_box_seal(pt, kp.publicKey);
const opened = sodium.crypto_box_seal_open(sealed, kp.publicKey, kp.privateKey);

// age multi-recipient
const id = await age.generateIdentity(); // AGE-SECRET-KEY-1…
const rcpt = await age.identityToRecipient(id); // age1…
const enc = new age.Encrypter();
enc.addRecipient(rcpt);
const ctAge = await enc.encrypt('heartbeat secret');
const dec = new age.Decrypter();
dec.addIdentity(id);
const ptAge = await dec.decrypt(ctAge, 'text');

// Shamir split of the scalar that matters (private key or DEK)
const dek = randomBytes(32);
const shares = await split(dek, 5, 3); // Uint8Array[] length 5, any 3 reconstruct
const recovered = await combine(shares.slice(0, 3));
```

---

## 11. Open Phase-0 Questions for User (needed to lock ADR)

1. **Licensing preference for hardened profile:** Vault CE (BSL) vs OpenBao (MPL 2.0) — which to standardize? (Brief §7.1 asks.)
2. **Hardened profile default:** ship standard (app+PG+proxy) as default and hard-profile opt-in, or make Vault co-deployed from day one? (controls SBOM scanner + installer flags)
3. **Browser trust assumption:** for client-side sealed-box switches, is the served JS bundle considered trusted (SRI + subresource integrity + optional extension), or must it be out-of-scope for threat model?
4. **Recovery vs zero-knowledge line:** for server-envelope switches, should Shamir t-of-n recovery be mandatory for Type 1, optional for Type 2, and what's default `n,t`? (suggest `n=5,t=3`).
5. **Backup key custody:** same KEK as prod or independent offline age identity (suggest offline `age1pq1…` held by operator, not DB).
6. **Locale:** brief mentions README language — confirm English-only or English + Indonesian? (no person/post mention anywhere).

---

## 12. Source Index (high-trust, fetched 2026-09-20)

- libsodium docs + sitemap: https://doc.libsodium.org / https://libsodium.gitbook.io/doc / `llms.txt` + `_autodocs/api-reference/crypto-box.md` (`crypto_box_seal`/`seal_open`)
- noble homepage + repos: https://paulmillr.com/noble/ , https://github.com/paulmillr/noble-ciphers , https://github.com/paulmillr/noble-curves , https://github.com/paulmillr/noble-hashes
- Audits: ciphers 1.0.0 Cure53 2024-09 (funded OpenSats), curves 2.3.0 Trail of Bits 2026-08 (Patch the Planet), Kuzdelski 2023-09, Trail of Bits 2023-02, Cure53 2022-01 / ed25519 2023 — `paulmillr.com/noble` changelog
- age spec & code: https://age-encryption.org/v1 , https://github.com/FiloSottile/age , `x25519.go` `age-encryption.org/v1/X25519` HKDF label, man `age(1)`/`age-keygen(1)` 2026-08, `FiloSottile/typage` (`age-encryption` npm, noble+WebCrypto, supports `age1pq1` hybrid)
- typage docs: `words.filippo.io/passkey-encryption/` (2025-07-14), `FiloSottile/typage` README
- OWASP: `OWASP/CheatSheetSeries` `cheatsheets/Password_Storage_Cheat_Sheet.md` (19 MiB m=19456 t=2 p=1 baseline + equivalents), OWASP ASVS 6.6.2, `go-tools.org/blog/bcrypt-vs-argon2-vs-scrypt-password-hashing` 2026-05-02, RFC 9106 Argon2, libsodium `crypto_pwhash` vectors
- node-argon2: `ranisalt/node-argon2` wiki Options + `security-notes.md` + context7 `/ranisalt/node-argon2` (type argon2id default m=65536 t=3 p=4)
- Shamir: `privy-io/shamir-secret-sharing` (0.0.4, npm 34269/wk), Cure53 `PVY-01` audit `https://cure53.de/audit-report_privy-sss-library.pdf`, Zellic audit `…Privy_Shamir…_Zellic_Audit_Report.pdf`, inspirations `hashicorp/vault/shamir` + `dsprenkels/sss`
- Envelope & rotation: Google Cloud `envelope-encryption` doc, `systemslibrarian/crypto-lab-envelope-kms`, `nlqdb.com/blog/rotate-encryption-key-without-a-version-column` (2026-07-10, version-in-blob), `queryplan.org` rotation runbook (2026-07-18), `docs.nhncloud.com` Secure Key Manager rotation guide
- Wycheproof: `C2SP/wycheproof` (ex-`google/wycheproof`) testvectors_v1, docs `doc/files.md`/`types.md`, @ `wolfSSL/wychcheck` harness, `rscrypto/docs/test-vector-coverage.md` mapping
- XChaCha/GCM comparison: `shattered.io/chacha20-poly1305-vs-aes-256-gcm` (2026-06-22), `de-otio/crypto-envelope` (0.2.0-alpha, noble, CBOR v2, caps), `juanchi.dev/web-crypto-api-browser-nodejs-edge-differences` (2026-06-09, WebCrypto portability — AES-GCM most portable, Ed25519/X25519 edge gating)
- Trust models: `vaulted.fyi/blog/server-side-vs-client-side-encryption` (2026-03-14, fragment never sent per RFC 3986/9110), `alexi.sh/posts/encrypted-cloud-storage-developers-2026` (2026-06-25), `vanishingvault.com/blog/self-host-onetimesecret-not-zero-knowledge` (2026-08-02, self-host ≠ ZK)

---

## 13. ADR Sketch (to promote after approval)

| ADR     | Title                    | Decision                                                                                                                                                                                                 |
| ------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-001 | Symmetric AEAD selection | XChaCha20-Poly1305 default via `@noble/ciphers` + libsodium high-level fallback; AES-256-GCM for KMS/FIPS interop; both validated against Wycheproof                                                     |
| ADR-002 | Envelope & KEK custody   | Per-secret DEK, AAD-bound wrap, kid+kekVersion in envelope; pluggable KEK (file/passphrase/Vault/Transit/KMS); hardened never SPOF                                                                       |
| ADR-003 | Passphrase KDF           | Argon2id OWASP baseline m=19456 t=2 p=1, PHC strings, pepper via `secret`; scrypt/PBKDF2 only for WebCrypto fallback                                                                                     |
| ADR-004 | Asymmetric & threshold   | libsodium `crypto_box_seal` (single recipient) + `age-encryption` X25519 (+PQ hybrid `age1pq1`) for multi-recipient/file mode; Shamir via `privy-io/shamir-secret-sharing` for private-key t-of-n escrow |
| ADR-005 | Key rotation             | Version-in-blob + optional indexed column, dual-read overlap, batch re-wrap with `SKIP LOCKED`, `Rewrap` no-plaintext where available, prove `stale_rows==0` before retiring                             |
| ADR-006 | Backups                  | Independent age/XChaCha-encrypted dump, offline identity, tested restores, verify script proves ciphertext-only rows                                                                                     |
