# Bug Fix Checklist

## Reproduce First

- [ ] Bug is reproducible — repro steps documented before touching any code
- [ ] Expected behavior clearly stated
- [ ] Actual broken behavior clearly stated
- [ ] Active environment confirmed — reproduction performed in development only

## Root Cause Analysis

- [ ] Root cause identified and documented before any fix is applied
- [ ] Checked whether the same bug exists in related areas of the codebase
- [ ] Assessed whether the bug has security implications (data exposure, auth bypass,
      injection risk) — if yes, escalate to user immediately before proceeding

## Fix

- [ ] Minimal, targeted fix applied — no opportunistic refactoring in the same change
- [ ] Fix resolves only the stated bug — no scope creep
- [ ] Fix does not introduce new behavior beyond resolving the specific bug

## Verification

- [ ] Bug is no longer reproducible with the fix applied
- [ ] Regression test written and passing
- [ ] Full test suite passes

## Completion

- [ ] DECISIONS_LOG.md updated if root cause revealed an important insight
- [ ] CURRENT_STATUS.md updated
- [ ] Committed with Conventional Commits format (`fix(<scope>): <subject>`) — only if user requested a commit
