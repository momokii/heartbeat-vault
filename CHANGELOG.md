# Changelog

All notable changes to Heartbeat Vault are documented here. Future entries are
maintained by release-please from Conventional Commits.

## 0.0.0 (2026-10-07)

This baseline records the repository's initial development history; no prior
release tag exists.

### Features

- Added encrypted payload storage with schema migrations, envelope KDF, sealed-box, and Shamir support (`feat(db-crypto)`).
- Added authentication, sessions, rate limiting, lockout, TOTP, WebAuthn, recovery, RBAC, invitations, and password resets (`feat(auth)`, `feat(crypto-auth)`).
- Added switch creation, recipients, payloads, arming guards, check-ins, escalation stages, durable jobs, leases, dead-letter handling, downtime compensation, clock-skew protection, quorum triggers, and cancellation windows (`feat(switch)`, `feat(heartbeat)`, `feat(trigger)`).
- Added audit-chain recording, scoped and administrator activity views, safe details, filtering, exports, and an export job ledger (`feat(audit)`, `feat(db)`, `feat(api)`, `feat(web)`).
- Added dashboard, administration, recipient, invitation, password-reset, switch, activity, and reports interfaces (`feat(web)`, `feat(admin)`).
- Added the standard Compose profile with PostgreSQL, Caddy, installer flows, backups, security verification, and opt-in Tailnet publishing (`feat(compose)`, `feat(install)`, `feat(scripts)`).

### Fixes

- Hardened authentication, switch deletion, Caddy publishing, setup probes, audit writes, pagination, search matching, and report filtering (`fix(*)`).
- Added coverage for authentication navigation and invitation feedback (`test(web)`).

### Documentation and tooling

- Added architecture, threat-model, security, operations, API, delivery-channel, and ADR documentation (`docs(*)`).
- Added strict TypeScript, ESLint, Prettier, Husky, pnpm workspace, and dependency maintenance configuration (`chore(*)`).
