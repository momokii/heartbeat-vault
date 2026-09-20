## Task Queue

> Phase 0 gate active. No implementation before design approval.

| Field               | Value                                                                   |
| ------------------- | ----------------------------------------------------------------------- |
| Task ID             | TASK-001                                                                |
| Name                | Phase 0 design approval gate                                            |
| Priority            | High                                                                    |
| Status              | IN PROGRESS                                                             |
| Complexity          | M                                                                       |
| Depends On          | None (research done, `docs/DESIGN.md` proposed)                         |
| Scope               | User reviews `docs/DESIGN.md` §1–10; approve or request section changes |
| Acceptance Criteria | Explicit user approval (or change list); then Phase 1+ plan agent       |
| Security Concerns   | No code before approval; hardened deferred, ADRs only                   |

| Field               | Value                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------- |
| Task ID             | TASK-002                                                                                  |
| Name                | Hardened profile (OpenBao vs Vault) follow-up                                             |
| Priority            | Medium                                                                                    |
| Status              | TODO                                                                                      |
| Complexity          | L                                                                                         |
| Depends On          | TASK-001, v1 standard profile                                                             |
| Scope               | Next-development todo per user: ADRs now, implementation later; never a release-path SPOF |
| Acceptance Criteria | ADR pair written; tracked, not built in v1                                                |
| Security Concerns   | AppRole least-privilege, Shamir unseal handling, audit devices                            |

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
