# Security Standards — Mandatory Reference

Consult this file before implementing any feature involving data input,
authentication, external communication, or storage.

> **Self-update instruction:** When the tech stack is confirmed, extend this
> file with language/framework-specific guidance (ORM injection prevention,
> CORS configuration, CSRF protection, rate-limiting middleware, security
> headers). Never weaken a rule here without user approval + a DECISIONS_LOG entry.

## Secrets & Environment Variable Management

- Never hardcode secrets, API keys, tokens, passwords, or any sensitive value
  in source code — not even in test files or fixtures. Use test doubles.
- All secrets must be managed via environment variables loaded from `.env`
  files excluded from version control via `.gitignore`.
- A `.env.example` file must always exist at the root, containing all required
  variable names with placeholder values and a description comment for each —
  this file IS committed to the repository.
- Never log, print, or expose environment variable values in output, error
  messages, or debug statements.
- Verify `.env` is listed in `.gitignore` before writing any code that reads
  from it.

## Environment Configuration

- Three environments must be distinguished: `development`, `staging`, `production`.
- An `APP_ENV` or equivalent variable must control environment-specific behavior.
- Configuration that differs per environment (log level, debug mode, external
  service URLs, rate limits) must be driven by environment variables — never by
  hardcoded conditionals.

## Input Validation & Sanitization

- All external input (HTTP request bodies, query params, headers, file uploads,
  environment variables read at runtime) must be validated and sanitized before
  use in any business logic.
- Validation must happen at the boundary layer (handler/controller) before input
  reaches service or data layers.
- Never trust client-supplied data for authorization decisions.
- Reject with a clear error any input that does not conform to the expected
  schema — do not silently coerce or guess intent.

## Authentication & Authorization

- Auth logic must never be implemented ad-hoc — use the established
  framework/library pattern for this stack once determined.
- All protected routes must enforce auth checks — default to **deny**, not allow.
- Never implement a "skip auth for now, add later" pattern — incomplete auth is
  a blocker and must be raised immediately.
- Session tokens and JWTs must be validated on every request, not just at login.
- Authorization checks must run server-side on every privileged operation, even
  if the client also hides the UI.

## Dependency Security

- Before adding any new dependency, check for known vulnerabilities using the
  appropriate tool for the stack (e.g., `npm audit`, `pip-audit`,
  `govulncheck`, `bundle audit`, `cargo audit`).
- Prefer well-maintained, widely adopted packages over obscure alternatives.
- Pin dependency versions — avoid open-ended ranges that auto-upgrade to
  potentially breaking or vulnerable versions.
- Log every new dependency in `state/DECISIONS_LOG.md` with rationale and
  confirmation that a vulnerability check was performed.

## Docker & Container Security

- Never run application containers as root — use a non-root user in the Dockerfile.
- Do not expose unnecessary ports in production Compose configuration.
- Never commit `.env` files — use Docker secrets or environment variable
  injection at runtime for production deployments.
- Use specific image tags — never `latest` in production configurations.

## Data & Output Hygiene

- Never include secrets, PII, or internal system details in logs, error
  responses, or API payloads.
- Apply the minimum-privilege principle to file permissions, DB roles, and
  service accounts.
- Any checklist in `templates/` includes a Security Review section — completing
  it is mandatory, not optional.
