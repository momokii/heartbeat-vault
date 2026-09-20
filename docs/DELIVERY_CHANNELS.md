# Delivery channels

Heartbeat Vault sends a release notice through one or more explicitly accepted recipient channels. Version 1 notices carry release metadata only; they never include plaintext secret material. The durable `delivery_jobs` outbox owns retries, receipts, and dead-lettering.

## Shared behavior

- A delivery job has a unique idempotency key and a per-job retry budget. The dispatcher uses PostgreSQL row locking to prevent concurrent workers from processing the same pending job.
- A successful provider response stores its receipt with the delivery job. Transient outcomes are requeued with jittered backoff; permanent failures and exhausted retry budgets are recorded in `dead_letter_jobs`.
- An external provider can accept a request just before a network failure prevents a receipt from returning. Delivery is therefore at-least-once at the external boundary; consumers must use the channel-specific idempotency reference to tolerate duplicates.
- Release notifications contain no plaintext secret material. Secret retrieval and authenticated, time-limited release artifacts are separate future delivery work.

## Email

Configure `SMTP_HOST`, `SMTP_PORT`, and `SMTP_FROM` together. `SMTP_USER` and `SMTP_PASS` are optional, but must be supplied together. Port 465 enables implicit TLS; production SMTP endpoints should use TLS or STARTTLS and authenticated credentials.

Each message receives a stable SHA-256-derived `Message-ID` from the durable job idempotency key. This lets SMTP infrastructure and recipients recognize retry duplicates. Mailpit backs the integration test, including the message header and dry-run marker. Never use an unencrypted SMTP relay on an untrusted network.

## Webhook

For a webhook recipient, the accepted recipient address is its callback URL. Configure a 32-character-or-longer `WEBHOOK_HMAC_SECRET`; every request includes:

- `Idempotency-Key`: the durable delivery key.
- `X-Heartbeat-Signature`: `sha256=<HMAC-SHA-256 of the exact JSON body>`.

Webhook consumers must require HTTPS in production, validate the HMAC with a constant-time comparison before parsing the body, and store idempotency keys to make duplicates harmless. Ordinary 4xx responses are terminal; timeouts, HTTP 408, HTTP 429, and 5xx responses are retried by the dispatcher.

## Telegram

Configure `TELEGRAM_BOT_TOKEN`; `TELEGRAM_API_BASE_URL` defaults to `https://api.telegram.org` and is overridable only for local test doubles or self-hosted Bot API servers. A recipient address is a pre-approved Telegram chat ID.

Telegram does not offer a provider idempotency key. The database outbox prevents duplicate scheduling, while every notification includes its durable `Reference: <idempotency key>` so recipients can recognize an at-least-once retry. Protect bot tokens as deployment secrets; do not put release material in chat messages.

## Dry runs

Dry-run notices use a visible `[DRY RUN]` marker. They exercise provider routing and receipts without including release material.
