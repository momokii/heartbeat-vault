# Architecture Decision Records

This directory holds Architecture Decision Records for Heartbeat Vault. Each ADR records a significant choice, the alternatives we weighed, and the impact. Every choice traces to `docs/BRIEF.md` and is summarized in `docs/DESIGN.md` §§1-2 before it lands here.

## How to use this index

- Statuses are Proposed, Accepted, Deprecated, or Superseded.
- New ADRs get the next number, keep the `adr-` prefix out of the file name, and use `NNN-short-slug.md`.
- Proposed ADRs listed in `docs/DESIGN.md` §9 remain proposed until the task that owns them lands.

## Index

| ADR | Title | Status | Date |
| --- | --- | --- | --- |
| 001 | [Monorepo with pnpm workspaces and Turborepo](001-monorepo-pnpm-turborepo.md) | Accepted | 2026-09-20 |
| 002 | [Postgres as the queue with SKIP LOCKED, transactional outbox, and LISTEN/NOTIFY](002-postgres-as-queue.md) | Accepted | 2026-09-20 |
| 003 | [Fail-safe release default with per-switch typed opt-out](003-fail-safe-default.md) | Accepted | 2026-09-20 |
| 004 | [Clock contract: DB-authoritative time, monotonic durations, skew hold](004-clock-contract.md) | Accepted | 2026-09-20 |
| 005 | Envelope crypto suite and rotation procedure | Proposed | — |
| 006 | Server side release v1, shares deferred | Proposed | — |
| 007 | [Hardened key service, OpenBao MPL-2.0 candidate default vs Vault CE BSL alternative](007-hardened-openbao-vs-vault.md) | Accepted as direction, implementation DEFERRED | 2026-09-20 |
| 008 | [Reverse proxy, Caddy candidate vs Traefik](008-caddy-vs-traefik.md) | Accepted as direction, implementation DEFERRED | 2026-09-20 |
| 009 | Auth libraries, Argon2id, TOTP, WebAuthn, rate limit | Proposed | — |
| 010 | Release process, release-please plus GHCR plus keyless signing | Proposed | — |

ADRs 005, 006, and 009 through 010 remain Proposed and are tracked in `docs/DESIGN.md` §9. ADRs 007 and 008 landed in T6.1 as direction only, implementation DEFERRED.

## Conventions

- One ADR per file, numbers never reused.
- Each ADR has Context, Decision, Alternatives considered, Rationale, Impacts, Security implications, and References.
- Every ADR cites the brief or design section it implements, so review can trace the choice back to the source.
