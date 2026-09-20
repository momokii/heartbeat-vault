# ADR 007: Hardened key service, OpenBao MPL-2.0 candidate default vs Vault CE BSL alternative

- Status: Accepted as direction, implementation DEFERRED (ADR only, zero runtime code)
- Date: 2026-09-20
- Deciders: Phase 0 design review
- Sources: `docs/BRIEF.md` §6, §7.1, §9, §10, `docs/DESIGN.md` §§1-2, `docs/research/2026-09-20-foundation-research.md` §§6-8, `docs/research/crypto-primitives-2026.md` §§3, 5

> DEFERRED: This ADR records direction only. No Compose service, no Dockerfile, no Vault or OpenBao client dependency, no runtime code ships in v1. Standard profile remains app plus Postgres plus Caddy. Hardened profile implementation lands after v1 when the standard profile is stable. Lint guard in `eslint.config.mjs` blocks premature imports.

## Context

Brief §7.1 defines the hardening problem. The product must run on a single host for a single household in its standard profile, with only the app, Postgres, and a reverse proxy. A hardened profile may add proven, free, self hostable services through Compose profiles. The primary candidate is HashiCorp Vault. The evaluation must also cover OpenBao, the open source fork. The ADR compares licensing, maturity, and API compatibility, and it must show how the key service avoids becoming a single point of failure on the release path.

Brief §6 requires envelope encryption. Each secret gets a per secret 32 byte DEK, wrapped by a KEK. The KEK can live in a file or Docker secret, a passphrase unwrap at boot, an external Transit service, or a cloud KMS. Rotation must be supported. Design §1 already makes the choice that the envelope and queue design keeps the key service off the hot release path, with cached wrapped DEKs and queue plus retry plus alert. Design §2 adds the fail safe default, the release must not be silently lost and must not fire incorrectly when the system was down.

The user decision for v1 is clear from `docs/PROGRESS.md` and `docs/DESIGN.md` §1. Hardened is not in v1. It is the next development todo, after the standard profile ships. This ADR records the intended default so later work has a stable target, without pulling runtime deps into v1.

Three constraints shape the choice.

1. License must fit a permissive project that intends MIT or Apache 2.0. Vault Community Edition is source available under BSL, not an OSI approved license. OpenBao is MPL 2.0, which is OSI approved and file level copyleft but compatible with permissive use when kept as a separate service.
2. Operational cost on a single host must stay low. One extra service is already a cost, a cluster or paid feature set is more.
3. Release correctness is non negotiable. Brief §5.1 says a trigger must never be silently lost. Brief §7.1 §3 says if Vault is sealed or unreachable at trigger time, the release must still complete safely, with auto unseal, HA options, retry and queueing, operator alerting, and recovery, and it must never cause a false trigger.

## Decision

When the hardened profile ships, OpenBao is the candidate default for the key service. HashiCorp Vault Community Edition is the documented alternative.

Both expose the same intended surface for Heartbeat Vault.

- Transit engine as the primary use, with the key never leaving the service boundary. App calls encrypt, decrypt, and rewrap. Raw KEK material stays inside Transit.
- KV v2 for small secrets that benefit from versioning, PKI for internal certs if needed, dynamic database credentials for short lived Postgres roles, audit devices for request logging, and seal and unseal for at rest protection of the Transit keys.
- API compatibility is high because OpenBao tracks the Vault API. App code can target one client shape. Token format caveat applies, see below.

This decision is direction only. No `node-vault`, `vault`, or `openbao` client is added to any package in this change. No Compose profile, no Dockerfile stage, no env var for `VAULT_ADDR` is added. The lint rule in `eslint.config.mjs` enforces that boundary until implementation is explicitly unblocked.

## How the selected surface would be used (deferred design, not code)

### Transit key never leaves model

Transit is the only KEK path through the hardened service. The per secret DEK is generated in the app as 32 random bytes, used once to AEAD encrypt the payload, then wrapped via Transit encrypt with AAD bound to `{kid, kekVersion, tenantId, switchId}`. The wrapped DEK is stored in Postgres, the plaintext DEK is zeroed. On read, the app asks Transit to decrypt the wrapped DEK, then decrypts the payload locally. Rekey uses Transit rewrap without exposing plaintext, and `min_decryption_version` keeps older DEKs readable during a rolling rewrap sweep.

This keeps the KEK inside the service boundary. Compromise of the app host alone does not expose the KEK, but a running app that can call Transit can still decrypt, which `docs/DESIGN.md` §2 documents honestly as operator readable at runtime. Transit does not make the deploy zero knowledge, it narrows the blast radius and gives central rotation and audit.

### KV, PKI, dynamic DB creds, audit, seal and unseal

- KV v2 would hold operator bootstrap values and small service secrets with versioning, not vault payloads.
- PKI would issue short lived internal certs for service to service TLS if the deploy needs it, backed by the same seal.
- Dynamic database credentials would issue short lived Postgres roles per app instance, replacing a long lived `DATABASE_URL` password. This maps to Design §2 least privilege DB roles.
- Audit devices would be required to be enabled, with file or syslog sink, so every Transit decrypt and rewrap has a trail for `audit_log` correlation and for `scripts/verify-security.sh`.
- Seal and unseal protects Transit keys at rest. Init would use Shamir t of n, 3 of 5 in the reference plan, with shares printed once, never logged, and split via `shamir-secret-sharing` patterns already slated for other threshold use. Auto unseal would be documented as an alternative for unattended restart, with the tradeoff noted in Rationale.

All of the above are deferred. The verify script, the installer, and the Testcontainers suite would gain hardened aware checks only when the profile ships, per Brief §9 and §10. Nothing in the standard profile depends on them.

### API compatibility and token format caveat

OpenBao aims for Vault API compatibility for the engines Heartbeat Vault needs. Transit encrypt, decrypt, rewrap, rotate, and `sys/seal-status` share the same paths and payload shapes. That is why a single app abstraction can cover both.

One caveat survives. Vault enterprise token formats and some auth method responses have diverged since the fork, and Seal wrapping token handling has small differences in edge cases. The app would pin to the common subset, use AppRole or token with short TTL and explicit `num_uses` where needed, and avoid Vault only token wrapping features. Integration tests against both containers would catch drift, and the ADR would be revisited if a needed Transit feature moves out of the shared surface.

### Licensing, maturity, operational cost

| Axis | OpenBao (candidate default) | Vault CE (alternative) |
| --- | --- | --- |
| License | MPL 2.0, OSI approved, file level copyleft, suitable for self hosted alongside MIT or Apache 2.0 app when run as a separate process | BSL 1.1, source available, not OSI approved, commercial use restriction that reverts to open after 4 years, adds legal review for redistribution |
| Maturity as of 2026 | Fork from Vault, active, tracks Vault API, smaller community, fewer third party runbooks | Original, larger community, longer audit history, more public failure reports to learn from |
| Operational cost on single host | Same container shape as Vault, same storage and HA options, no license cost, community support only | Same container shape, no license cost for self hosted CE, but BSL adds compliance cost if you distribute or offer hosted |
| Why it fits the project default | License aligns with the permissive project intent from `docs/PROGRESS.md` key decisions, without forcing users through BSL review | Useful alternative for teams that already run Vault and prefer its larger ecosystem, kept as a switch not a second code path |

The license question was left pending in Design §9. This ADR picks OpenBao as the candidate default because it keeps the permissive project posture simple, while keeping Vault CE as a supported alternative behind the same API shape. If the maintainer later confirms a BSL preference, the ADR can be superseded with a one line swap of default, without changing the Transit contract.

### Off hot release path design (the SPOF guard)

Brief §7.1 §3 and Design §1 require that hardened never becomes a release path SPOF. The deferred design meets it with three layers, all visible in `docs/DESIGN.md` §§1-2 patterns.

1. Cached wrapped DEKs. Postgres holds ciphertext and `wrappedDEK` plus `kekVersion` and AAD. Once a DEK is unwrapped, the app can cache the plaintext DEK in memory for the delivery attempt window, so Transit is not on every byte of a large release. The cache is bounded and zeroed after use. Rewrap sweep is the only bulk Transit caller.

2. Queue, retry, alert on sealed or unreachable. The trigger path is Postgres queued via `SKIP LOCKED` and transactional outbox. If Transit is sealed or unreachable at fire time, the job is not failed and not silently lost. It stays in `trigger_jobs` or `delivery_jobs` with `next_run_at` pushed by exponential backoff with jitter, and the operator gets an alert. This reuses the same backoff, DLQ, and alert plumbing that already exists for channel failures. Brief §5.1 never silently lost rule applies equally to KEK failures.

3. Recovery without false trigger. Downtime compensation and post recovery grace from Design §2 apply. If the scheduler or Transit was down through a `grace_until`, affected timers move to `vault_waits` with an extended grace, and the owner is notified. The job fires only after the grace window, not immediately on recovery.

Failure injection in Phase 8 would cover Transit sealed, unreachable, and restart at trigger time, plus DB restart and duplicate workers, all against real containers via Testcontainers. The verify script would check `sys/seal-status` is unsealed, audit device enabled, TLS on, no root token in use, and app policy is least privilege, but only when the hardened profile is active.

## Alternatives considered

### Vault CE as default, OpenBao as alt (inverted)

This would give the larger community and longer audit trail as the default. The downside is license friction. BSL requires extra review for anyone who redistributes or offers the product, which fights the permissive license intent recorded in `docs/PROGRESS.md`. Operationally the two are similar, so the inversion is a tradeoff of community size against license simplicity. Kept as the alt for Vault native teams.

### Cloud KMS (AWS KMS re encrypt, GCP decrypt plus encrypt)

Cloud KMS removes seal and unseal ops entirely and gives provider managed rotation and HSM backing. The trade is Brief §7.1 §2, on premise friendly with no mandatory cloud. KMS would tie the release path to the network path to the cloud, a new failure mode for a dead man switch on a single host. Deferred as an optional pluggable KEK source alongside Transit, not a replacement for the self hosted hardened profile.

### File or Docker secret KEK only, no Transit

A 32 byte file on `0600` perms or Docker secret is the standard profile today and is enough for many single household deploys. It has zero extra ops and no sealed state. The gap is rotation, audit, and blast radius, all of which Transit handles. Keeping file KEK as the standard profile and Transit as hardened gives both, which is exactly what Design §1 does.

### Not adding a hardened profile at all

This would keep the standard profile simple. The reason to keep hardened as a deferred ADR is Brief §7.1 itself, the brief asks for serious evaluation of Vault and OpenBao. Recording the direction now avoids re debating it later and lets the envelope plus queue design stay correct whether Transit exists or not.

## Rationale

We picked OpenBao as the candidate default for three reasons that trace to the brief.

First, it satisfies the security benefit without adding a new failure mode. Transit gives key never leaves wrapping, rewrap without plaintext exposure, versioned rotation, and audit. KV, PKI, and dynamic DB creds add least privilege and short lived credentials. All of those are optional and layered, so the standard profile still works with only app plus Postgres plus Caddy, per Brief §7.1 §1.

Second, it respects the no SPOF rule with a design that already exists elsewhere. Cached wrapped DEKs plus Postgres queue plus retry plus alert is the same pattern the scheduler and delivery paths already use. Putting Transit off the hot path means sealed or unreachable delays a release and alerts the operator, it does not lose the job or fire incorrectly. That maps to Design §2 fail safe and Brief §5.1 queue it, retry it, alert the operator.

Third, the license fits the project. MPL 2.0 keeps a permissive app alongside an open source service without the BSL review burden. API compatibility keeps the code cost of supporting both low, a single Transit abstraction with a caveat on token formats. The choice can be flipped later with minimal code change if the maintainer states a BSL preference.

## Impacts

### Positive

- One Transit abstraction covers both OpenBao and Vault CE, so the hardened profile can be documented as "OpenBao default, Vault CE also supported" without two code paths.
- Envelope stays portable. Secrets written under file KEK today can be re wrapped under Transit later via the same `kekVersion` plus AAD sweep, no payload re encrypt.
- Rotation, audit, and dynamic creds have a home when the user opts in, without touching the standard profile.

### Negative and mitigations

- One more service to back up, monitor, and unseal. Mitigation is Compose profiles, standard profile does not run it, and the off hot path guard keeps releases safe when it is down.
- Shamir init and unseal shares add operator ceremony. Mitigation is the installer handling init, Shamir split via audited library, and printed once handling, plus documented auto unseal option with its own threat tradeoff.
- Token and wrapping format drift between the forks could break a future Transit feature. Mitigation is pinning to the common subset, testing against both containers, and noting the caveat in this ADR.

### Follow on work (all deferred, none in this change)

- Compose profile `hardened` that adds OpenBao or Vault, TLS, audit device, and AppRole plus short lived tokens, with no root token in the app.
- App Transit client behind the same envelope interface, with decrypt, rewrap, rotate, and `sys/seal-status` checks, plus a memory bounded DEK cache.
- Installer support for `standard` vs `hardened` choice, safe init and unseal with shares shown once and never logged.
- Tests: Testcontainers against real OpenBao and Vault, failure injection for sealed, unreachable, restart at trigger time.
- Verify script: hardened checks for seal status, TLS, audit, no root token, least privilege policy, only when the profile is active.

## Security implications

- Threat model per `docs/DESIGN.md` §2. Transit narrows but does not remove operator readability at runtime. A compromised running host that can call Transit can still decrypt. Document this honestly, do not claim zero knowledge.
- STRIDE mapping: Tampering is covered by AEAD plus Transit rewrap integrity, Information disclosure is reduced by key never leaves plus short lived DB creds, Repudiation is improved by Transit audit plus append only `audit_log`, Elevation of privilege is addressed by least privilege AppRole plus short lived tokens.
- No new SPOF on the release path is a security property. The queue plus retry plus alert guard is what preserves it, not the choice of OpenBao versus Vault CE.

## References

- `docs/BRIEF.md` §6 envelope encryption, rotation
- `docs/BRIEF.md` §7.1 hardened services, Transit, KV, PKI, dynamic DB creds, audit, seal and unseal, optional and layered, no SPOF
- `docs/BRIEF.md` §9 Testcontainers plus failure injection plus Vault or OpenBao integration
- `docs/BRIEF.md` §10 verify script hardened checks
- `docs/DESIGN.md` §1 monorepo plus single image two roles plus Postgres queue plus Caddy, hardened deferred with cached wrapped DEKs plus queue plus retry plus alert
- `docs/DESIGN.md` §2 fail safe default, downtime compensation, clock uncertainty hold, DB unavailable hold plus audit
- `docs/research/2026-09-20-foundation-research.md` §§1, 3, 6 hardened deferred, Compose plus Caddy patterns
- `docs/research/crypto-primitives-2026.md` §§3, 5 envelope shape, KEK sources, rotation, no custom crypto

---

*Implementation status: DEFERRED. This file is the only artifact for this decision in Phase 6. No runtime code, no deps, no Compose changes ship with it.*
