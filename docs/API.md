# API reference

The browser application is the primary client. This reference is for self-hosted operators and integrations that need to understand the HTTP surface. Routes are mounted under `/api`; JSON request bodies use `Content-Type: application/json`. Authentication uses the application's session cookie unless a route is explicitly token-based.

Error responses commonly use `{ "error": "..." }`. Validate behavior against the installed version before integrating; this document describes the v1 routes registered by `apps/api/src/routes`.

## Public and bootstrap routes

| Method | Path                         | Purpose                                                                                                  |
| ------ | ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/health`                | Service health probe.                                                                                    |
| `POST` | `/api/setup`                 | Create the first administrator using the one-time setup token; permanently unavailable after completion. |
| `POST` | `/api/login`                 | Start password login.                                                                                    |
| `POST` | `/api/login/recover`         | Complete login/recovery flow when additional verification is required.                                   |
| `POST` | `/api/register`              | Register only when an administrator has explicitly enabled open registration.                            |
| `POST` | `/api/invites/consume`       | Consume a hashed, single-use user invitation.                                                            |
| `GET`  | `/api/heartbeat/link/:token` | Inspect a heartbeat-link token flow.                                                                     |
| `POST` | `/api/heartbeat/link/:token` | Submit a heartbeat-link check-in.                                                                        |
| `POST` | `/api/heartbeat/:token`      | Submit token-based heartbeat confirmation.                                                               |
| `POST` | `/api/recipients/accept`     | Accept a recipient invitation.                                                                           |
| `POST` | `/api/recipients/vote`       | Submit a recipient recovery/abort vote.                                                                  |

The setup route returns `410 Gone` once bootstrap is complete. Empty-body probes are safe for observing its `400` (open) or `410` (closed) state, but real setup tokens must be treated like administrator credentials.

## Authenticated account and administration routes

| Method | Path                             | Purpose                                                                |
| ------ | -------------------------------- | ---------------------------------------------------------------------- |
| `GET`  | `/api/me`                        | Current authenticated user/session information.                        |
| `POST` | `/api/logout`                    | Revoke the current session.                                            |
| `POST` | `/api/sessions/revoke-all`       | Revoke all sessions for the current user.                              |
| `GET`  | `/api/users`                     | List users; administrative access required.                            |
| `GET`  | `/api/users/:id`                 | Read a user; permitted for that user or an administrator.              |
| `POST` | `/api/users/:id/revoke-sessions` | Revoke a user's sessions; permitted for that user or an administrator. |
| `POST` | `/api/invites`                   | Create a user invitation; administrative access required.              |
| `PUT`  | `/api/admin/settings`            | Set instance settings; administrative access required.                 |

### Two-factor endpoints

| Method | Path                                 | Purpose                                                   |
| ------ | ------------------------------------ | --------------------------------------------------------- |
| `POST` | `/api/2fa/totp/enroll`               | Begin TOTP enrollment.                                    |
| `POST` | `/api/2fa/totp/verify`               | Verify enrollment or a TOTP code as required by the flow. |
| `POST` | `/api/2fa/totp/challenge`            | Complete a TOTP step-up challenge.                        |
| `POST` | `/api/2fa/totp/disable`              | Disable TOTP through the authenticated step-up flow.      |
| `POST` | `/api/2fa/recovery-codes/regenerate` | Regenerate recovery codes.                                |
| `POST` | `/api/2fa/webauthn/register-options` | Request WebAuthn registration options.                    |
| `POST` | `/api/2fa/webauthn/register-verify`  | Verify a WebAuthn registration response.                  |
| `POST` | `/api/2fa/webauthn/login-options`    | Request WebAuthn login options.                           |
| `POST` | `/api/2fa/webauthn/login-verify`     | Verify a WebAuthn login response.                         |

## Switch lifecycle routes

All switch routes require an authenticated owner or administrator. UUID paths that do not resolve to an accessible switch intentionally produce `404` rather than disclosing ownership.

| Method   | Path                                | Purpose                                                                                               |
| -------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/switches`                     | Create a paused switch.                                                                               |
| `GET`    | `/api/switches`                     | List the caller's switches; an administrator may request all switches with `?all=1`.                  |
| `GET`    | `/api/switches/:id`                 | Read one accessible switch.                                                                           |
| `PATCH`  | `/api/switches/:id`                 | Change editable switch metadata, interval, grace window, or dry-run setting.                          |
| `DELETE` | `/api/switches/:id`                 | Delete a non-released switch.                                                                         |
| `POST`   | `/api/switches/:id/payload`         | Encrypt and store the payload before database persistence.                                            |
| `POST`   | `/api/switches/:id/recipients`      | Add a recipient and issue its invitation flow.                                                        |
| `GET`    | `/api/switches/:id/recipients`      | List recipients.                                                                                      |
| `DELETE` | `/api/switches/:id/recipients/:rid` | Remove a recipient where the lifecycle permits it.                                                    |
| `POST`   | `/api/switches/:id/arm`             | Arm a switch; body requires `confirm: true`, and `fail_deadly` requires typed switch-ID confirmation. |
| `POST`   | `/api/switches/:id/disarm`          | Return an active switch to paused state.                                                              |
| `POST`   | `/api/switches/:id/check-in`        | Record a heartbeat before the deadline.                                                               |
| `POST`   | `/api/switches/:id/trigger`         | Start the trigger path according to the authorized flow.                                              |
| `POST`   | `/api/switches/:id/cancel`          | Cancel a pending trigger according to the authorized flow.                                            |
| `POST`   | `/api/switches/:id/heartbeat-link`  | Create a heartbeat-link flow.                                                                         |
| `POST`   | `/api/switches/:id/heartbeat-token` | Create a token-based heartbeat flow.                                                                  |

The create payload accepts the switch title, mode, heartbeat interval (hours), grace window (hours), dry-run flag, and release policy. Payload storage accepts plaintext only over the authenticated request; the API immediately envelopes it and persists ciphertext fields. Recipient creation accepts a channel (`email`, `webhook`, or `telegram`) and an address. The exact validation constraints and JSON response shapes are enforced by the route schemas.

### Lifecycle constraints

- A switch begins paused.
- Arming is rejected without both a sealed payload and an accepted recipient.
- Released switches are immutable and cannot be deleted or have their payload replaced.
- Only administrators can use the all-switch listing; normal users see their own switches.
- The API records audit events for switch creation, updates, payload storage, arming, disarming, and deletion.

## Integration notes

Use a dedicated application account and the normal invitation/login process rather than copying browser cookies into automation. Never send a payload through a query string or logs. For webhook/Telegram/email delivery behavior and risk guidance, read [DELIVERY_CHANNELS.md](DELIVERY_CHANNELS.md). For full test-backed examples, inspect the API route tests and the Playwright journey in `apps/e2e`.
