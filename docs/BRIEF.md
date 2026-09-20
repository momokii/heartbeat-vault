# Project Brief: Self-Hosted Dead Man's Switch (High-Security, HA-Aware)

> SOURCE OF TRUTH — saved verbatim per Section 14. Do not edit. All implementation must trace to this brief.

## 1. Role

You are a principal engineer and security practitioner with a long career at top global companies. You have built and operated high-availability, high-security systems, so apply that standard to every decision here. Prefer well-established, audited cryptographic primitives and libraries. Never invent custom cryptography.

## 2. Objective

Build, from scratch and end to end, a **self-hosted Dead Man's Switch application**. A user stores critical credentials or secrets and configures a liveness (heartbeat) mechanism. If the user stops proving they are alive or reachable, and the trigger conditions are met, the system releases the configured data to pre-approved recipients.

The result must be production-grade, well tested, well documented, and free of known bugs and errors. Take as much time as you need. After the Phase 0 approval, do not stop before every phase in this brief is complete and verified.

## 3. Background and Motivation

This idea was inspired by a public post in which a well-known Indonesian tech executive shared a public key. Many people read it as a dead man's switch, where the matching private key would be released at some future point. This is background only: do not mention this person or post anywhere in the code, documentation, or commit messages.

The app generalises that idea so a user can prepare for the case where something goes wrong. Recipients they have approved then receive what the user wants them to have.

## 4. Core Concept: Two Output Types

Support both output types as first-class, selectable modes per secret or "switch".

### Type 1: Asymmetric Key Mode (public/private key)

- The user generates or imports a key pair. The **public key can be shared openly**, so anyone who later receives the corresponding private key understands what it is and what is expected of them (general awareness).
- Secrets are encrypted to the public key. On trigger, the **private key** (or the material needed to reconstruct it) is released to the designated recipients.
- Deterrence use case: a user under threat can generate and publish a public key. This signals that a switch exists without revealing its contents.
- Research and decide the safest design for key custody, for example: client-side key generation, age/X25519 or libsodium sealed boxes, and optionally Shamir's Secret Sharing so no single party holds the full key. Document the threat model and trade-offs.

### Type 2: Direct Delivery Mode

- Fully self-configured. When the trigger condition is reached, the system delivers the stored data directly to the predefined targets over the configured channels.

## 5. Functional Requirements

For each area below, **research current best practices for dead-man's-switch and secret-release systems**. Then implement **multiple user-selectable options**, so users can tailor their own configuration. Document the reasoning behind defaults.

### 5.1 Heartbeat / Liveness Check

Design this properly. Options to evaluate and offer (extend as your research suggests):

- Manual check-in (web button, authenticated) and signed one-time links (email)
- Check-in via API token or webhook, plus a Telegram or chat bot reply
- Step-up confirmation (TOTP or passkey) for check-in
- Configurable interval, escalating reminder schedule, grace periods, and multi-stage escalation (reminders → warning → pending-trigger → final grace → fire)
- Pause/vacation mode, plus an explicit "test / dry-run" mode that exercises the full pipeline without releasing real data

Critical correctness concerns to handle explicitly:

- **False-trigger prevention**: if the server itself was down, the system must not fire on recovery. Implement downtime compensation and a post-recovery grace window.
- Scheduling must be **durable, crash-safe, idempotent, and safe under multiple instances** (persist state in PostgreSQL; use advisory locks or leader election). Decide fail-safe vs fail-deadly behavior deliberately and document it.
- Do not trust wall-clock time naively. Handle clock drift and time-zone edge cases.
- **Release-path availability**: every component the release depends on (database, key service, delivery channels) must have a defined failure behavior. A trigger must never be silently lost. Queue it, retry it, alert the operator, and document the recovery procedure.

### 5.2 Trigger Configuration

Offer selectable trigger types, for example: missed-heartbeat threshold, fixed date/time, manual "panic" trigger, and optional multi-party confirmation (quorum of trusted contacts). Allow different triggers per switch and a per-switch pre-fire cancellation window.

### 5.3 Delivery Channels

Implement a **pluggable channel/provider architecture** (SMTP email first, plus webhook and Telegram at minimum; propose others such as SFTP or Matrix based on research). Require:

- Retries with backoff, idempotency, delivery receipts, and a dead-letter/failed-delivery queue
- Recipient verification and pre-approval (recipients explicitly consent or are verified before the switch is armed)
- Clear per-channel security guidance (for example, never send raw secrets over weak channels; prefer sending a decryption link plus a separate key or share)
- Payload options: encrypted blob plus separate key delivery, one-time-view link with expiry, or direct payload where the user accepts the risk

### 5.4 Accounts, Roles, and Bootstrap

Apply security best practices here:

- **First-run bootstrap** on a fresh deployment: a setup wizard or CLI protected by a one-time, expiring setup token generated by the installer. The first account becomes the instance admin, and the user must know clearly how to obtain and use that first account. After bootstrap, the setup endpoint must be permanently disabled.
- **Multi-account support** with role separation (for example, instance admin vs. standard user). Define the roles and their permission boundaries.
- Account creation options: admin-invite (single-use, expiring links) as the secure default, with optional open registration behind an explicit admin setting.
- Authentication: Argon2id password hashing, TOTP 2FA, WebAuthn/passkeys, recovery codes, session management and revocation, rate limiting, lockout/anti-bruteforce, and a full audit log.

## 6. Security Requirements (Non-Negotiable)

Treat this as a security product handling highly sensitive data:

- **Encryption at rest** using envelope encryption: per-secret data keys wrapped by a master key. Use authenticated encryption (for example AES-256-GCM or XChaCha20-Poly1305) and Argon2id for any passphrase-derived keys.
- Master key management options (research and offer): file/Docker secret, passphrase unseal at startup, an external key service such as HashiCorp Vault or OpenBao Transit (see Section 7.1), and optional cloud KMS. Support key rotation.
- **Encrypted backups** with documented restore procedure.
- Secure defaults everywhere: TLS, strict security headers/CSP, CSRF protection, input validation, parameterized queries, secrets never logged, least-privilege DB roles, non-root containers, minimal images.
- Use a documented **threat model** (STRIDE or similar) and map controls to OWASP ASVS. Explicitly document what the system does and does not protect against.
- Supply-chain hygiene: pinned dependencies, lockfiles, dependency and container vulnerability scanning, secret scanning, SBOM.

## 7. Tech Stack

Choose the stack that is **easiest to debug and maintain**, with a rich ecosystem of libraries and UI components for fast development. Hard requirements:

- **PostgreSQL** as the primary database (SQL-based).
- **Monorepo** structure (adjust only if you can justify a better approach).
- Everything **Docker-based**.

Unless your research justifies otherwise, default to a TypeScript-end-to-end monorepo (for example pnpm workspaces + Turborepo; a typed API backend; a React-based UI with Tailwind and shadcn/ui; a type-safe ORM/query builder with migrations; a Postgres-backed job queue). Record every significant technology choice as an **Architecture Decision Record (ADR)** in `docs/adr/`, including alternatives considered.

### 7.1 Optional Security-Hardening Services (Crucial: Evaluate Seriously)

Beyond the core stack, evaluate **proven, free, self-hostable external services deployed alongside the app** that measurably improve security. Base decisions on real-world adoption and results, not novelty.

- **Primary candidate: HashiCorp Vault**, deployed together with the app. Consider its Transit engine (encryption and key-wrapping where the key never leaves Vault), KV secrets, PKI, dynamic database credentials, audit devices, and seal/unseal mechanisms. Also evaluate **OpenBao**, the open-source fork. Compare licensing (Vault Community Edition is source-available under BSL; OpenBao uses MPL 2.0), maturity, and API compatibility, and record the outcome in an ADR. Ask me for my licensing preference in Phase 0.
- Evaluate other candidates only where they add real value (for example an automatic-TLS reverse proxy, intrusion or brute-force protection, image and dependency scanners).
- Rules for any such service:
  1. **Optional and layered.** A "standard" profile must work with only the app, PostgreSQL, and the reverse proxy. A "hardened" profile adds these services through Docker Compose profiles.
  2. **On-premise friendly.** No mandatory cloud or SaaS dependency.
  3. **No new single point of failure in the release path.** Example: if Vault is sealed or unreachable at trigger time, the release must still complete safely. Design and document auto-unseal, HA options, retry and queueing, operator alerting, and recovery. It must never cause a false trigger or silently lose a release.
  4. **Secure the service itself**: TLS, least-privilege policies with AppRole or equivalent, short-lived tokens, no root token in the app, audit logging enabled, and init/unseal keys handled safely (never written to logs, displayed once, split via Shamir).
  5. Each service gets an ADR covering the security benefit, threat-model impact, and operational cost.
  6. The tests (Section 9), the verification script (Section 10), and the installer (Section 11) must cover these services when enabled.

## 8. UI/UX

Clean, modern, minimalist, and visually polished. Optimise for **on-premise deployments** and ease of use: a guided first-run experience, a clear dashboard showing switch status, next check-in, and armed/unarmed state, and dangerous actions behind explicit confirmation. Include dark/light themes, accessibility (WCAG AA), and responsive layouts.

## 9. Testing (End to End, No Shortcuts)

Data integrity and secrecy are critical, so test thoroughly:

- Unit tests, plus integration tests against a real PostgreSQL (for example Testcontainers)
- End-to-end UI tests (Playwright) covering bootstrap, login, creating and arming a switch, heartbeat, trigger, and delivery
- Cryptography tests with known-answer vectors and round-trip and negative tests
- **Failure-injection tests** for the scheduler and release path: crash mid-trigger, duplicate workers, DB restart, clock skew, downtime recovery, and (when enabled) Vault or OpenBao sealed, unreachable, or restarted at trigger time
- Integration tests against a real Vault or OpenBao container for the hardened profile
- Security tests: authz/IDOR checks, rate-limit checks, and SAST, dependency, container, and secret scanning in CI
- Enforce coverage thresholds on critical modules (crypto, auth, scheduler, delivery)
- Use **local test doubles** for external services (for example a local SMTP catcher such as Mailpit, and mock Telegram/webhook servers). Never require real third-party accounts to run the test suite.

## 10. Security Verification Script

Provide a user-runnable script (for example `scripts/verify-security.sh`, also exposed as a make target or CLI command) that lets a user **independently prove the deployment is secure**. It must be read-only, non-destructive, and must never print secrets. Suggested checks (extend as appropriate):

- Container hardening (non-root, capabilities, read-only filesystem where possible, no unnecessary published ports)
- TLS configuration and security headers
- Database not exposed externally, and DB roles are least-privilege
- Secret and file permissions, and no default or weak credentials
- **Encryption-at-rest proof**: inspect stored rows and confirm only ciphertext is present
- Crypto self-test (round-trip and known-answer)
- Image digest, checksum, and signature verification against the published release
- Bootstrap endpoint is disabled after setup
- Backup encryption check
- When the hardened profile is enabled: Vault/OpenBao seal status, TLS, audit device enabled, no root token in use, and app policies are least-privilege

Output a human-readable report (PASS/WARN/FAIL with explanations) plus machine-readable JSON, with meaningful exit codes.

## 11. Deployment

- A **one-command, all-in-one installer** (for example `install.sh`) that is idempotent and does: preflight checks (Docker and Compose versions, ports, resources), generates all secrets securely, writes config with restrictive permissions, brings up the stack via Docker Compose, waits for healthchecks, and prints the first-run setup URL and one-time token.
- Let the user choose the **standard** or **hardened** profile at install time. For the hardened profile, the installer initialises and configures the key service safely, with unseal keys and tokens shown once and never logged.
- The installer must not modify the host beyond Docker resources and the project's own directory. It must be safe to re-run.
- Reverse proxy with automatic TLS. Offer options: self-signed/internal CA for LAN and on-prem, Let's Encrypt, or bring-your-own certificate.
- Companion commands: upgrade, backup, restore, status, and uninstall.
- Healthchecks, restart policies, and a documented HA/scale-out path (multiple app instances, PostgreSQL HA options).

## 12. Versioning and CI/CD

- Set up a pipeline with **Git tag–based semantic versioning** (Conventional Commits with release-please or semantic-release), an auto-generated `CHANGELOG.md`, and releases that build and publish signed, multi-arch Docker images with SBOMs.
- CI gates: lint, typecheck, tests, security scans, and build must pass before merge or release.
- Default to GitHub Actions with GHCR unless I specify otherwise in Phase 0.
- Publishing, signing, and registry pushes require credentials you will not have. Implement the pipelines fully, document exactly which secrets and settings I must configure, and do not fabricate results.

## 13. Documentation

- A thorough `README.md` explaining the app end to end for users: purpose, how it works, the threat model in plain language, architecture diagram (Mermaid), quick start, first-account bootstrap, configuration options (including standard vs. hardened profile), heartbeat/trigger/channel guides, key management, backup/restore, upgrade, verification script usage, FAQ, and honest limitations and disclaimers (including responsible-use and legal considerations).
- Additional docs in `docs/`: `ARCHITECTURE.md`, `SECURITY.md`, `THREAT_MODEL.md`, `OPERATIONS.md`, ADRs, API reference, and `CONTRIBUTING.md`.
- Security-relevant behavior must be documented end to end, including how stored data is protected.

## 14. Repository Scaffolding and Progress Tracking

- **First action, before anything else**: save this entire brief verbatim to `docs/BRIEF.md` as the source of truth for the project. If file writes are not yet permitted (for example a read-only planning mode), start with research and questions and save it as soon as writes are allowed.
- Initialise a git repository. Commit at every phase gate using Conventional Commits.
- Create `CLAUDE.md` and a `.claude/` directory (project conventions, coding and security rules, common commands, testing instructions, and a pointer to `docs/BRIEF.md`) so future agent sessions stay consistent with this brief.
- Maintain `docs/PROGRESS.md`: a checklist of every phase and requirement in this brief, updated at each gate with status, key decisions, and open issues. This is your memory across long sessions. If your context is compacted or a session resumes, **read `CLAUDE.md`, `docs/BRIEF.md`, and `docs/PROGRESS.md` first** and continue from where you left off.

## 15. Working Method

### Phase 0: Discovery and Design Gate (no implementation yet)

1. Save the brief to `docs/BRIEF.md` and create `docs/PROGRESS.md` (see Section 14).
2. Research current best practices for the areas in Sections 5 to 12, including Section 7.1 (use web search and fetch tools if available; if not, say so and flag anything that needs verification).
3. Ask me **all clarifying questions**, grouped by topic and each with your recommended default so I can answer quickly. Cover at least: expected deployment size, needed delivery channels, CI/registry platform, UI and README language(s), open-source license for the project, threat model priorities, whether server-side release without the user is acceptable vs. recipient-held key shares, and whether to include the hardened profile (Vault vs. OpenBao, licensing preference). Ask follow-up rounds if my answers open new questions.
4. Produce a concise design document: architecture, threat model, data model, crypto design, and the ADR list. Wait for my approval.
5. If I cannot answer (for example, a non-interactive session), proceed with your recommended defaults and record every assumption in `docs/ASSUMPTIONS.md`.

### Phases 1 to N: Implementation

Suggested order: repo and tooling foundation → data model and crypto core → auth, bootstrap, and roles → switches, heartbeat, trigger engine → delivery channels → hardened-profile services → UI → tests → verification script → installer and deployment → CI/CD and versioning → documentation.

Each phase ends with a **gate**: its tests pass, lint and typecheck are clean, docs and `docs/PROGRESS.md` are updated, and the work is committed. Do not proceed with a failing gate. After Phase 0 approval, continue autonomously through all phases without stopping to ask permission.

### Final Phase: Recursive Self-Audit

1. Build a requirements traceability checklist from this entire brief and verify every item against the actual code, tests, and docs.
2. Run the full test suite, the security verification script, and a clean install from scratch (both standard and hardened profiles).
3. Review your own work adversarially as a security auditor. Fix all gaps, then repeat the audit until it finds nothing.
4. Only then produce a final report: what was built, decisions made, what was verified vs. what could not be verified in this environment, known limitations, and how I can verify it myself.

## 16. Initiative and Constraints

- You may add features or safeguards you judge necessary for a secure and reliable system. Flag each addition and explain why.
- Never fake or stub security-critical behavior. If something is unfinished or unverifiable here, say so explicitly rather than claiming success.
- Never commit secrets, and never log sensitive data.
- Do not run destructive commands outside the project directory.
- Prioritize correctness and security over speed.
