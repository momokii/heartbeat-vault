# New Feature Implementation Checklist

## Before Starting

- [ ] Task is defined in TASK_QUEUE.md with clear acceptance criteria
- [ ] All dependencies for this task are complete
- [ ] Relevant PRD and technical docs have been read
- [ ] Current test suite passes
- [ ] Active environment identified and confirmed as development

## Design

- [ ] Feature scope is clearly understood — list all files to be created or modified
- [ ] Edge cases identified and documented
- [ ] Security implications identified before implementation begins
- [ ] If this requires a new dependency or schema change: confirm with user first
- [ ] If this requires a new dependency: vulnerability check performed and logged

## Implementation

- [ ] Code written following CODING_STANDARDS.md
- [ ] Error handling implemented for all failure paths
- [ ] Logging added where appropriate — no sensitive data logged

## Security Review

- [ ] No secrets, tokens, or credentials hardcoded anywhere in new code
- [ ] All external input validated and sanitized at the boundary layer
- [ ] Auth and permission checks enforced — default deny posture confirmed
- [ ] Any new dependency checked for known vulnerabilities and logged in DECISIONS_LOG.md
- [ ] No sensitive data exposed in logs, error messages, or API responses
- [ ] `.env.example` updated if new environment variables were introduced
- [ ] Behavior verified correct in both development and production environment configs

## Testing

- [ ] Unit tests written for all new logic
- [ ] Integration test written if the feature touches external systems
- [ ] All tests pass (new + existing)

## Completion

- [ ] TASK_QUEUE.md updated — task marked DONE
- [ ] CURRENT_STATUS.md updated with session summary
- [ ] DECISIONS_LOG.md updated if any significant decision was made
- [ ] Relevant docs updated if behavior changed
- [ ] Committed with Conventional Commits format (per CODING_STANDARDS.md) — only if user requested a commit
