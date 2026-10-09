## Task Queue

> Standing user directive (maintenance loop): keep the repo fully updated — dependencies,
> docs/state truthfulness, verification green — without stopping until done.

| Field               | Value                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Task ID             | TASK-001                                                                                                                                |
| Name                | Phase 0 design approval gate                                                                                                            |
| Priority            | High                                                                                                                                    |
| Status              | DONE (with caveat: implementation proceeded on direct user direction; a formal approval event was never recorded and is not fabricated) |
| Complexity          | M                                                                                                                                       |
| Depends On          | None                                                                                                                                    |
| Scope               | Historical gate; superseded by shipped v1                                                                                               |
| Acceptance Criteria | Design exists in docs/DESIGN.md; caveat recorded in docs/PROGRESS.md                                                                    |
| Security Concerns   | None outstanding                                                                                                                        |

| Field               | Value                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------- |
| Task ID             | TASK-002                                                                                  |
| Name                | Hardened profile (OpenBao vs Vault) follow-up                                             |
| Priority            | Medium                                                                                    |
| Status              | TODO (deferred by ADR-007 decision, not started)                                          |
| Complexity          | L                                                                                         |
| Depends On          | v1 standard profile (done)                                                                |
| Scope               | Next-development todo per user: ADRs now, implementation later; never a release-path SPOF |
| Acceptance Criteria | ADR pair written; tracked, not built in v1                                                |
| Security Concerns   | AppRole least-privilege, Shamir unseal handling, audit devices                            |

| Field               | Value                                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task ID             | TASK-003                                                                                                                                                                              |
| Name                | Maintenance sweep: deferred major upgrades                                                                                                                                            |
| Priority            | Medium                                                                                                                                                                                |
| Status              | TODO                                                                                                                                                                                  |
| Complexity          | M                                                                                                                                                                                     |
| Depends On          | None (evaluation only; no implementation until approved)                                                                                                                              |
| Scope               | Decide: vite 8, eslint 10 stack, TypeScript 7, vitest 5.0.3 (needs Node ≥22.12 baseline), @noble/hashes 2, @simplewebauthn 14, testcontainers 12, @types/node 26, @types/nodemailer 8 |
| Acceptance Criteria | Each item has an owner, reason, and re-evaluation trigger                                                                                                                             |
| Security Concerns   | None directly; keeps security-adjacent deps reviewable                                                                                                                                |

| Field               | Value                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------- |
| Task ID             | TASK-004                                                                               |
| Name                | Production backup/restore drill                                                        |
| Priority            | High                                                                                   |
| Status              | DONE (encrypted backup + isolated drill executed 2026-10-10; live DB proven untouched) |
| Complexity          | M                                                                                      |
| Depends On          | BACKUP_ENCRYPTION_KEY (set)                                                            |
| Scope               | Encrypted backup + isolated-restore verification without touching the live DB          |
| Acceptance Criteria | Restore proven in isolation; runbook updated (docs/OPERATIONS.md)                      |
| Security Concerns   | Key custody; never restore over live data                                              |

| Field               | Value                                                                               |
| ------------------- | ----------------------------------------------------------------------------------- |
| Task ID             | TASK-005                                                                            |
| Name                | Release-please red: owner token-permission/log check                                |
| Priority            | Medium                                                                              |
| Status              | TODO (blocked on owner GitHub access)                                               |
| Complexity          | S                                                                                   |
| Depends On          | CI workflow fixes (done: checkout, config, fetch-depth, smoke)                      |
| Scope               | Paste failing step log OR check Settings → Actions → General → Workflow permissions |
| Acceptance Criteria | Release-please job green on a live run, or root cause identified                    |
| Security Concerns   | None (workflow permissions review is itself good hygiene)                           |

### Rules

### Template Format (use for every task added)

| Field               | Value                                           |
| ------------------- | ----------------------------------------------- |
| Task ID             | TASK-001                                        |
| Name                | [Task name]                                     |
| Priority            | High / Medium / Low                             |
| Status              | TODO / IN PROGRESS / DONE / BLOCKED             |
| Complexity          | S / M / L                                       |
| Depends On          | [Task IDs this task requires to be done first]  |
| Scope               | [Exact description of what must be built]       |
| Acceptance Criteria | [What "done" looks like, measurable]            |
| Security Concerns   | [Security considerations specific to this task] |

### Rules

- Keep tasks ordered by priority, then by dependency.
- One task `IN PROGRESS` at a time unless explicitly parallelized.
- Every completed task must link its acceptance-criteria evidence
  (test run, review, or demo note) before being marked `DONE`.
