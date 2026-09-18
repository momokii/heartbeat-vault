# Agent Rules — Non-Negotiable

These rules apply in **every session, without exception**. If a rule blocks you,
document the blocker and ask the user. Do not silently bypass a rule.

## Session Start — Mandatory Before Any Action

- Read `HOW_TO_RESUME.md` before doing anything else.
- Read `state/CURRENT_STATUS.md` to understand exact current state.
- Read `state/TASK_QUEUE.md` to identify the next task.
- Read `CODING_STANDARDS.md` — internalize conventions before writing any code.
- Read `SECURITY_STANDARDS.md` — internalize all security requirements.
- Identify the active environment before running any command — consult
  `ENVIRONMENT_GUIDE.md` if in doubt.
- Confirm the working environment is functional before writing any code
  (health-check / startup command; record the real command once known).

## During Implementation

- Never make changes outside the scope of the current task.
- Never delete or overwrite existing files without explicit instruction.
- Never introduce a new dependency, change a schema, or make an architectural
  decision without surfacing the proposal to the user and receiving explicit
  confirmation first.
- Always apply the zero-regression rule: existing passing tests must remain
  passing after any change.
- Always follow the patterns and conventions in `CODING_STANDARDS.md` — do not
  introduce new patterns without logging them in `state/DECISIONS_LOG.md`.
- Use the checklist in `templates/` matching the work type
  (`new_feature.md`, `new_endpoint.md`, `new_test.md`, `bug_fix.md`).
- Every commit must follow the Conventional Commits format defined in
  `CODING_STANDARDS.md` (`<type>(<scope>): <subject>`) — never commit with a
  free-form message. Never commit without explicit user request.

## Security Rules — Non-Negotiable

- Never write code that stores, logs, or exposes secrets, tokens, or credentials
  in any form — not in source code, not in test fixtures, not in log output.
- Always validate and sanitize all external input at the boundary layer before
  it reaches any business logic.
- Never implement an auth bypass "to be fixed later" — incomplete auth is a
  blocker, not a deferrable item. Raise it immediately.
- Before adding any dependency, check for known vulnerabilities using the
  appropriate tool for this stack and document the check in
  `state/DECISIONS_LOG.md`.
- Consult `SECURITY_STANDARDS.md` before implementing any feature involving
  input handling, authentication, external services, or data storage.

## Environment Awareness Rules

- Always identify the active environment before running any command.
- In `development`: proceed with the standard workflow.
- In `staging` or `production`: present a written plan and receive explicit
  confirmation before executing any change, migration, or destructive operation.
- Never expose debug ports, seed scripts, or development tooling in production
  configuration.
- Verify `.env` is properly gitignored before the first commit of any session.
- Consult `ENVIRONMENT_GUIDE.md` when in doubt about environment-specific behavior.

## Session End — Mandatory Before Closing

- Update `state/CURRENT_STATUS.md` with accurate current state and a session summary.
- Update `state/TASK_QUEUE.md` — mark completed tasks, add newly discovered tasks.
- Log any significant decision made in `state/DECISIONS_LOG.md`.
- Update `CODING_STANDARDS.md` if new patterns or conventions were established.
- Update `SECURITY_STANDARDS.md` if new security patterns were established or the
  stack-specific security guidance was extended.
- Update `ENVIRONMENT_GUIDE.md` if environment configuration changed.
- Update `README.md` if project-level context changed.

## Self-Maintenance Directive

- As the project evolves, proactively update all `.claude/` files to replace
  general content with accurate, project-specific content.
- When a tech stack is determined: update `CODING_STANDARDS.md` and
  `SECURITY_STANDARDS.md` immediately with stack-specific guidance.
- When architecture is decided: update `README.md` and log in `DECISIONS_LOG.md`.
- When Docker setup is established: update `ENVIRONMENT_GUIDE.md` with real commands.
- This is not optional — keeping `.claude/` accurate is part of every task.

## Escalation Rule

- When blocked, uncertain about scope, or facing a decision with significant
  architectural, security, or UX impact: document the blocker in
  `state/CURRENT_STATUS.md` and ask the user rather than assume.
