# New API Endpoint Checklist

## Before Starting

- [ ] Endpoint is defined in the API contract doc (if it exists)
- [ ] HTTP method, route, and expected behavior are clear
- [ ] Auth requirements are understood
- [ ] Active environment identified and confirmed as development

## Implementation

- [ ] Route registered in the router/controller layer
- [ ] Handler function created following existing patterns
- [ ] Input validation implemented — reject malformed requests before any logic runs
- [ ] Business logic separated from handler layer
- [ ] Correct HTTP status codes returned for all success and error cases
- [ ] Error responses follow the project's standard error envelope
- [ ] No internal error details or stack traces exposed in error responses
- [ ] Caching layer integrated if applicable and consistent with existing patterns

## Security Review

- [ ] No secrets, tokens, or credentials hardcoded anywhere in new code
- [ ] All external input validated and sanitized at the boundary layer
- [ ] Auth and permission checks enforced on all protected routes
- [ ] Any new dependency checked for known vulnerabilities and logged in DECISIONS_LOG.md
- [ ] No sensitive data exposed in logs, error messages, or API responses
- [ ] `.env.example` updated if new environment variables were introduced
- [ ] Behavior verified correct in both development and production environment configs

## Testing

- [ ] Happy path test written
- [ ] Input validation failure cases tested
- [ ] Auth/permission edge cases tested
- [ ] All tests pass

## Completion

- [ ] API contract documentation updated
- [ ] CURRENT_STATUS.md and TASK_QUEUE.md updated
- [ ] Committed with Conventional Commits format (per CODING_STANDARDS.md) — only if user requested a commit
