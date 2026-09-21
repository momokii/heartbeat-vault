# Security

This document describes the security properties implemented in Heartbeat Vault v1, how to verify them, and—equally important—what they do not provide. The authoritative implementation is the code and tests in `packages/crypto`, `apps/api`, `scripts/verify-security.sh`, and the Compose configuration.

## Stored-data protection

Payload plaintext is encrypted before it is inserted into PostgreSQL. The envelope uses a fresh 32-byte DEK for each secret and XChaCha20-Poly1305 authenticated encryption. The DEK is itself wrapped by a versioned server-side KEK. Authenticated associated data binds the envelope to its tenant and switch identity, preventing a valid ciphertext from being transplanted to another switch without detection.

The database stores the envelope's key metadata, wrapped-DEK fields, nonces, ciphertext, tag, and associated-data representation. It does not store payload plaintext. The static and runtime checks in `scripts/verify-security.sh` make this observable without printing secrets.

The v1 KEK comes from `MASTER_KEY` in `.env`; `install.sh` creates it when the placeholder is still present and sets `.env` mode to `0600`. Do not put this key in source control, logs, tickets, or delivery channels. Keep a separate protected copy: loss of the KEK makes encrypted payloads unrecoverable.

## Authentication and authorization

- Passwords use Argon2id and are never stored as plaintext.
- Sessions are opaque, revocable, and delivered in strict `__Host-` cookies; stored session material is hashed.
- TOTP enrollment, verification, challenge, disablement, recovery-code regeneration, and WebAuthn/passkey option and verification endpoints support step-up authentication.
- Setup and invite tokens are random, hashed before persistence, and single-use. Completing bootstrap permanently disables `POST /api/setup`.
- Users can revoke their sessions, and administrators can manage users, settings, and user session revocation.
- Every privileged switch operation performs server-side ownership or administrator authorization. The API does not rely on the browser to enforce access control.
- PostgreSQL-backed rate limits and lockout behavior protect authentication paths; audit events are recorded for security-relevant actions.

## Release safety

A switch requires an encrypted payload and an accepted recipient before it can arm. The default is fail-safe: during database unavailability, clock uncertainty, or scheduler recovery after downtime, the system holds rather than releases. Delivery jobs are claimed durably, retried with backoff, and moved to a dead-letter queue when attempts are exhausted.

`fail_deadly` is an explicit higher-risk policy that requires confirmation by the switch identifier at arm time. It should be used only when the owner understands that availability failure can increase the chance of release. See [ADR-003](adr/003-fail-safe-default.md) and [ADR-004](adr/004-clock-contract.md).

## Transport, host, and supply-chain controls

- Caddy terminates TLS and sets HSTS, CSP, frame, content-type, referrer, and permissions-policy headers.
- The database is private to the Compose network. The base profile publishes only Caddy ports, bound to `127.0.0.1` by default; `CADDY_BIND_IP` may bind them to exactly one configured host IP (commonly a Tailnet address). The verifier FAILs any other non-loopback publication, wildcard binds (`0.0.0.0`/`::`), and any non-loopback API/DB/admin exposure.
- API containers run non-root; production overrides provide restart policies and resource limits.
- Compose images and Dockerfile base images are digest-pinned. CI runs dependency audit, gitleaks, CodeQL, and release scanning. Release workflow artifacts include an SPDX SBOM and keyless cosign signing when executed on GitHub.
- Application and migrator database roles are designed for scoped privileges; the verification script checks that they are not superusers in a running stack.

## What this does not protect against

Heartbeat Vault v1 is **not zero knowledge**. A party that compromises the running host and obtains the server-side `MASTER_KEY` can decrypt payloads. It also cannot protect an owner or recipient whose endpoint, password, browser, or email account is compromised. Physical seizure of the host can expose ciphertext and configuration backups. Legal compulsion, malicious administrators, and recipient-side copying of released material are outside the technical guarantees.

Do not treat email, ordinary webhooks, or Telegram as confidential payload stores. Prefer an encrypted blob plus separately shared key material when channel confidentiality matters. The application cannot guarantee a real-world outcome, prove that someone is unreachable, or make a release irreversible after a recipient receives it.

## Verification and response

Run the read-only verification script after install and after meaningful deployment changes:

```bash
scripts/verify-security.sh
scripts/verify-security.sh --json
```

Exit code `0` means no FAIL result; WARN results need operator review. The script never prints secret values and does not restart or change the stack. A fresh install is expected to warn that bootstrap is still open and that no ciphertext payload row exists yet. Complete setup, store a test payload, and run it again for stronger runtime evidence.

For a suspected key or host compromise: pause/disarm affected switches if safe, preserve logs and database evidence, rotate credentials and `MASTER_KEY` through the supported rewrap process before retiring old key material, and assume any payload decryptable on the compromised host may have been exposed. Restore only from a known-good, protected backup.
