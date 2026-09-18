## Task Queue

> This backlog is empty pending the first user instruction.
> The agent must populate this file once the project goals and PRD are established.

### Template Format (use for every task added)

| Field               | Value                                              |
|---------------------|----------------------------------------------------|
| Task ID             | TASK-001                                           |
| Name                | [Task name]                                        |
| Priority            | High / Medium / Low                                |
| Status              | TODO / IN PROGRESS / DONE / BLOCKED                |
| Complexity          | S / M / L                                          |
| Depends On          | [Task IDs this task requires to be done first]     |
| Scope               | [Exact description of what must be built]          |
| Acceptance Criteria | [What "done" looks like, measurable]               |
| Security Concerns   | [Security considerations specific to this task]    |

### Rules

- Keep tasks ordered by priority, then by dependency.
- One task `IN PROGRESS` at a time unless explicitly parallelized.
- Every completed task must link its acceptance-criteria evidence
  (test run, review, or demo note) before being marked `DONE`.
