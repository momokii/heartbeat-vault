# Coding Standards (Stack-Agnostic v1)

> **Self-update instruction:** When the tech stack is confirmed, replace this
> file's general rules with language/framework-specific conventions, linting
> config references, and actual patterns observed in the codebase. Keep the
> general principles section; append a stack-specific section below it.

## General Principles

- **Clarity over cleverness** — code is read more than it is written. Prefer the
  boring, obvious implementation.
- **One responsibility** per function, file, and module. If you need "and" to
  describe it, split it.
- **Explicit is better than implicit** — no magic globals, no hidden side effects.
- **Fail fast and loudly** — surface errors at the earliest possible point with
  enough context to reproduce.

## Naming Conventions (General)

- **Files:** `kebab-case` for most ecosystems; follow the established pattern
  once determined.
- **Functions/methods:** descriptive verb-noun pairs (`getUserById`, `validateInput`).
- **Constants:** `UPPER_SNAKE_CASE`.
- **Booleans:** prefix with `is`, `has`, `should`, `can` (`isActive`, `hasToken`).
- Avoid single-letter names except for short loop indices or well-known
  conventions (`x`, `y` in geometry; `i` in a 3-line loop).

## Structure & Style

- Keep functions small: if it does not fit on one screen, consider splitting.
- Keep nesting shallow (max ~3 levels); extract helpers instead of nesting deeper.
- No dead code, no commented-out blocks — delete; version control remembers.
- Follow the formatter/linter of the stack once established; no hand-formatting
  wars. If no linter exists yet, propose one and log it in `DECISIONS_LOG.md`.

## Error Handling

- Never silently swallow errors. Every `catch` either handles, re-throws with
  context, or logs with context.
- All errors must be logged with sufficient context to reproduce (what was
  attempted, with which inputs — never including secrets).
- User-facing errors must never expose internal stack traces or system details;
  map internals to a generic message + error code.

## Testing

- Every new feature must include at least one test.
- Every bug fix must include a regression test.
- Tests must be runnable with a single command (record the real command in
  `ENVIRONMENT_GUIDE.md` / `CURRENT_STATUS.md` once known).
- Tests must be deterministic — no reliance on wall-clock time, random data, or
  execution order unless explicitly controlled.

## Documentation

- Every public function must have a descriptive comment or docstring (purpose,
  params, return, errors raised).
- Every non-obvious decision in code must have an inline comment explaining *why*,
  not *what*.
- Update user-facing docs (README, API contract) in the same change that alters
  behavior — never "docs later."

## Git Commit Convention (Conventional Commits — mandatory)

Every commit must follow [Conventional Commits v1.0.0](https://www.conventionalcommits.org/):

```text
<type>(<scope>): <subject>

[optional body]

[optional footer(s)]
```

**Allowed types:** `feat` (new feature), `fix` (bug fix), `docs` (docs only),
`refactor` (no behavior change), `test` (tests only), `chore` (tooling/config),
`perf`, `ci`, `build`, `revert`.

**Rules:**

- `scope` is optional but encouraged (`feat(auth):`, `fix(api):`); use the
  module/area name in lowercase.
- `subject` is imperative, lowercase, no trailing period, max 72 chars
  (`add login rate limit`, not `added login rate limit.`).
- One logical change per commit — never mix `feat` + `fix` + `refactor` in one commit.
- `BREAKING CHANGE:` in the footer when an API/schema contract breaks.
- Reference the task ID in the body when one exists (`Refs: TASK-001`).

**Examples:**

```text
feat(auth): add login rate limit

Enforces 5 attempts/minute per IP via middleware.
Refs: TASK-003
```

```text
fix(api): return 404 for unknown user id

Previously returned 500 with an unhandled exception.
```

## Stack-Specific Section (to be filled once stack is known)

- Language + version: _TBD_
- Framework: _TBD_
- Linter / formatter + config path: _TBD_
- Test runner + single test command: _TBD_
- Observed codebase patterns: _TBD_
