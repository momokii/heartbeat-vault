# Threat Model

## Scope and priorities

Heartbeat Vault is a single-household, self-hosted service that automatically releases owner-configured material after a missed heartbeat. The priority order is: protect stored data at rest; resist coerced or false release; then reduce the impact of server compromise. It is not designed to be a zero-knowledge hosted service.

The primary assets are payload plaintext, KEKs and session secrets, account credentials, recipient addresses, switch state and deadlines, audit history, and delivery receipts. The main adverse outcomes are disclosure of a payload, premature release, failure to release when intended, and undetected alteration of release history.

## STRIDE controls

| Threat                 | Relevant controls                                                                                                                       | Residual risk                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Spoofing               | Argon2id passwords, opaque revocable sessions, TOTP and passkey step-up, hashed single-use setup/invite tokens, rate limits and lockout | Compromised owner/recipient endpoint or authenticator can still impersonate that party.                 |
| Tampering              | XChaCha20-Poly1305 envelopes, AAD binding to tenant/switch, transactional switch transitions, audit events, digest-pinned images        | A compromised running host with keys can alter application behavior.                                    |
| Repudiation            | Audit log, delivery receipts, durable jobs and dead-letter records                                                                      | The audit log is operational evidence, not an external notarization service.                            |
| Information disclosure | Per-secret envelope encryption, private DB network, TLS/headers, non-root containers, no secret logging                                 | The server-side KEK means a host-level attacker can decrypt while it runs.                              |
| Denial of service      | Durable PostgreSQL queue, leases, idempotency, retry/backoff, DLQ, scheduler heartbeat, fail-safe recovery                              | An attacker can still prevent service availability or delivery.                                         |
| Elevation of privilege | Server-side authz, role checks, ownership checks, IDOR tests, scoped database roles                                                     | An administrator is trusted for administrative actions; a host compromise defeats app-level boundaries. |

## Failure and abuse scenarios

### Stolen database or backup

An attacker with only PostgreSQL data sees encrypted payload envelopes rather than plaintext. This protection depends on keeping `MASTER_KEY` and any backup key separate from the database artifact. An unencrypted installer backup is explicitly warned about; configure `BACKUP_ENCRYPTION_KEY` before keeping real backups.

### Compromised server

Host compromise is not solved by server-side envelope encryption: a capable attacker can read environment variables and memory or modify the running application. Minimize exposure with host patching, restrictive access, separate protected backups, strong owner authentication, and prompt incident response. A future hardened key-service profile is recorded but not shipped in v1.

### False release or scheduler failure

The default scheduler behavior is fail-safe. It waits through grace, holds under clock uncertainty, and extends affected timers after outage recovery. Jobs use durable state, leases, idempotency, retries, and dead-lettering. This reduces accidental or duplicate delivery; it cannot guarantee delivery against a network, provider, or recipient outage.

### Malicious or compromised recipient

Recipients must accept their invitation before a switch can arm. They may receive and copy released material, so choose recipients carefully. The service does not make messages confidential after their configured delivery channel receives them. Recipient voting endpoints support recovery/abort workflows but do not replace human trust.

### Network attacker

Caddy provides TLS and browser security headers. The default LAN certificate requires local trust handling; public deployments must correctly configure ACME or a supplied certificate. TLS does not protect an already compromised browser or server.

## Security assumptions and boundaries

Operators must protect the host, `.env`, database volume, and backups; maintain reliable time; review verification warnings; and choose delivery channels appropriate to the payload. Owners must use strong unique credentials and complete bootstrap promptly. The system's safety semantics deliberately favor withholding a release during uncertainty. This is a product decision, not a guarantee of safety in every real-world situation.

## Review checklist

- Run `scripts/verify-security.sh` and resolve FAIL results before production use.
- Confirm bootstrap is closed after creating the administrator.
- Store a non-sensitive test payload and confirm ciphertext-at-rest evidence.
- Verify backups are encrypted and recoverable in a controlled environment.
- Review recipients, delivery channels, grace period, and `fail_deadly` choices before arming.
- Keep the host and container images updated; use CI release artifacts and SBOMs when publishing.
