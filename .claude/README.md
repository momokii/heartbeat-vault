# Heartbeat Vault — Agent Orientation

> **Status:** Blank repository. Stack, purpose, and architecture are not yet determined.
> All `.claude/` files start intentionally general and **must evolve** into
> project-specific guidance as real knowledge is discovered.

## What This Repository Is

Heartbeat Vault is a new project under active definition. Until the first real
working session establishes a PRD / tech stack / architecture, treat every
project-level statement here as a placeholder to be replaced — not as fact.

## Orientation Sequence (read in this order, every session)

1. `.claude/HOW_TO_RESUME.md` — the numbered session-start protocol
2. `.claude/state/CURRENT_STATUS.md` — what is done, in progress, blocked
3. `.claude/state/TASK_QUEUE.md` — the ordered backlog; your next task lives here
4. `.claude/AGENT_RULES.md` — non-negotiable behavioral rules
5. `.claude/CODING_STANDARDS.md` — conventions to follow before writing code
6. `.claude/SECURITY_STANDARDS.md` — security requirements before writing code
7. `.claude/ENVIRONMENT_GUIDE.md` — which environment you are in and how to behave
8. Task-relevant docs (PRD section, API contract, arch doc) for the current task only

## Where Things Live

| Need                                         | Location                          |
| -------------------------------------------- | --------------------------------- |
| Current state / blockers                     | `.claude/state/CURRENT_STATUS.md` |
| Backlog / next task                          | `.claude/state/TASK_QUEUE.md`     |
| Past decisions + rationale                   | `.claude/state/DECISIONS_LOG.md`  |
| Behavior rules                               | `.claude/AGENT_RULES.md`          |
| Coding conventions                           | `.claude/CODING_STANDARDS.md`     |
| Security requirements                        | `.claude/SECURITY_STANDARDS.md`   |
| Environment behavior                         | `.claude/ENVIRONMENT_GUIDE.md`    |
| Checklists (feature / endpoint / test / bug) | `.claude/templates/`              |

## Self-Update Directive (mandatory)

After **every** working session, before closing, the agent must:

- Update `state/CURRENT_STATUS.md` with accurate state + session summary.
- Update `state/TASK_QUEUE.md` (mark done, add discovered work).
- Log significant decisions in `state/DECISIONS_LOG.md`.
- Replace any general content it has now made concrete: `README.md`,
  `CODING_STANDARDS.md`, `SECURITY_STANDARDS.md`, `ENVIRONMENT_GUIDE.md`.

General-first is a starting posture, not a permanent state. If you learned the
stack, the architecture, the real commands — write them down. The next agent
arriving cold depends on it.

## A Note on Evolution

- **Session 0 (now):** everything is stack-agnostic by design.
- **Session 1+:** the moment a stack, pattern, or decision becomes known, update
  the corresponding `.claude/` file immediately. Do not defer it.
- Never invent project specifics to fill placeholders. If it is unknown, say so
  explicitly and record it as an open question in `CURRENT_STATUS.md`.
