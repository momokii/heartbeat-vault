# New Test Scenario Checklist

## Before Starting

- [ ] Test objective clearly defined — what specific behavior is being verified
- [ ] Test type identified: unit / integration / end-to-end / load
- [ ] Test environment is functional
- [ ] Active environment confirmed — load and destructive tests must never run
      against production

## Implementation

- [ ] Test file follows this project's naming and folder conventions
- [ ] Test is isolated — no dependency on external shared state unless intentional
- [ ] No real secrets or credentials used in test fixtures — use test doubles
- [ ] Setup and teardown handled cleanly
- [ ] Assertions are specific and meaningful (not just "no error thrown")

## Completion

- [ ] Test passes reliably — run it at least 3 times to confirm no flakiness
- [ ] Test is included in the standard test suite run
- [ ] CURRENT_STATUS.md updated
