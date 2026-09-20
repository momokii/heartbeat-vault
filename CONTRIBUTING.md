# Contributing

Thank you for improving Heartbeat Vault. This project handles security-sensitive data and release behavior, so correctness and reviewability matter more than speed.

## Local setup

Prerequisites are Node/pnpm compatible with the repository, Docker Engine with Compose v2, `curl`, and `openssl`.

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm lint
pnpm typecheck
pnpm test
```

Use `./install.sh install` to exercise the Docker deployment path. Never commit `.env`, generated backups, setup tokens, database dumps, or real credentials.

## Development rules

- Follow the repository's TypeScript, security, and agent rules in `.claude/`.
- Keep types strict. Do not suppress errors with `any`, `@ts-ignore`, or `@ts-expect-error`.
- Use test-first development for behavior changes: write a failing test, implement the minimal fix, then refactor with tests green.
- Prefer small, focused changes. Do not mix unrelated cleanup into a security or lifecycle fix.
- Use Conventional Commits: `<type>(<scope>): <subject>`.
- Never invent cryptography. Use the audited primitives and envelope formats already present in `packages/crypto`.

## Tests and validation

Run the closest tests while developing, then run repository gates before proposing a change:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm audit --audit-level=low
scripts/verify-security.sh
```

The test suite includes crypto known-answer/tamper tests, real PostgreSQL integration coverage, scheduler and delivery failure behavior, and a Playwright/Mailpit end-to-end journey. Do not delete or weaken a failing test to make a change pass.

## Security changes

Changes touching encryption, authentication, authorization, scheduling, delivery, Docker, database roles, or secret handling need explicit threat-model consideration. Document changed assumptions in `docs/SECURITY.md`, `docs/THREAT_MODEL.md`, or an ADR as appropriate. Preserve fail-safe behavior unless a reviewed product decision explicitly changes it.

Do not log payload plaintext, keys, session tokens, invitation tokens, recovery codes, or passwords. Keep production and staging operations deliberate: migrations, destructive restore, publishing, and registry pushes require the relevant human authorization.

## Documentation and review

Update user-facing documentation alongside changes to installation, APIs, configuration, security behavior, operational procedures, or limitations. Review your diff for accidentally committed generated files and secrets. A reviewer should be able to trace a security claim to code, tests, or an executable verification command.
