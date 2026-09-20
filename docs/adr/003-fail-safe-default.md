# ADR-003: Fail-safe release default with per-switch typed opt-out

Date: 2026-09-20
Status: Accepted (implemented — see `apps/api/src/routes/switches.ts`, `apps/api/src/lib/downtime.ts`, `apps/api/src/lib/escalation.ts`)

## Context

A dead man's switch must decide what happens under uncertainty: the owner
missed a check-in, the server was down, the clock looks wrong. Two postures
exist. Fail-safe (fail-closed) withholds release until uncertainty resolves;
fail-deadly releases on silence. Brief §5.1 requires this choice to be made
deliberately and documented. For a secrets vault, an early release of secrets
to recipients is cryptographically irreversible (delivered secrets cannot be
un-sent), while a late release is fully recoverable: the owner checks in
during the grace/cancellation window and the switch resets.

## Decision

1. **Fail-safe is the hard default** (`switches.release_policy = 'fail_safe'`).
   A missed heartbeat never fires immediately: the escalation ladder
   (`lib/escalation.ts`) schedules reminder → warning → pending → fire_due →
   release, and the release only queues after the full ladder has elapsed.
2. **Scheduler downtime never causes a fire.** On recovery
   (`lib/downtime.ts recoverFromOutage`), switches whose deadline fell inside
   the outage gap and are still inside their grace window get a `vault_wait`
   at `deadline + grace_window` instead of a job — the owner keeps the whole
   grace to check in and cancel. Only when grace has fully expired during the
   outage does a backfill job fire, exactly once (idempotency key
   `switch:<id>:<deadlineEpoch>` shared with the materializer).
3. **A check-in cancels the post-recovery wait** (`recordHeartbeat` deletes
   the switch's `vault_waits` row), so a single check-in after recovery fully
   resets the switch.
4. **Fail-deadly is a per-switch opt-in** requiring the exact switch id as a
   typed confirmation string at arm time (`failDeadlyConfirmation`; mismatch
   → 409 `arm_blocked/confirmation_required`). Enforced by a CHECK constraint
   (`fail_safe | fail_deadly`) at the schema level.

## Alternatives rejected

- **Fail-deadly default** — turns any outage, jamming, or coercion of the
  host into a release mechanism; the attacker who wants the secrets wants
  fail-deadly.
- **User-configurable default at install time** — defaults must be safe
  without configuration; install-time choices are invisible to future
  operators.
- **No cancellation window after fire** — rejected: the 48 h window between
  fire-queued and release (delivered via `delivery_jobs.available_at`) is the
  owner's last-resort recovery for a lost phone or missed reminder.

## Security implications

- Denial-of-service against the host extends grace instead of opening the
  vault — false-trigger prevention per Brief §5.1.
- The fail_deadly opt-out is auditable (`switch_armed` audit rows) and
  requires a deliberate, switch-specific string, not a checkbox.
- Trade-off accepted and documented: a fail_safe vault stays locked if the
  host is permanently seized; ciphertext remains present (see
  `docs/DESIGN.md` §2 honest non-goals).

## Impacts

- `trigger_jobs` may be backfilled after outages, but never more than once
  per deadline bucket; `vault_waits` rows block premature materialization.
- The escalation ladder and cancellation window constants
  (`CANCEL_WINDOW_MS`, `FIRE_LAG_MS`) live in one place (`lib/escalation.ts`)
  and are covered by boundary tests.

## References

- `docs/DESIGN.md` §2 (threat model), §5 (escalation defaults)
- Research: dead-man's-switch escalation precedents (Posthumous 7/8/12/14d,
  Deadhand 30/60/90d, LastSignal trusted-contact delay)
