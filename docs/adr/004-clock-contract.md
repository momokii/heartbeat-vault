# ADR-004: Clock contract — DB-authoritative time, monotonic durations, skew hold

Date: 2026-09-20
Status: Accepted (implemented — see `apps/api/src/lib/downtime.ts checkClockSkew`, scheduler SQL in `lib/trigger-engine.ts`; worker-loop wiring lands with the worker runtime)

## Context

Brief §5.1: "Do not trust wall-clock time naively. Handle clock drift and
time-zone edge cases." Multi-instance scheduling with leases, backoff, and
escalation deadlines is attack surface if any clock can be skewed: stale
leases could double-fire releases, skewed hosts could fire early or hold
forever, DST transitions can make wall-clock schedules ambiguous.

## Decision

1. **PostgreSQL `clock_timestamp()` is the single authority for every
   persisted timestamp.** Schema defaults (`DEFAULT clock_timestamp()`), all
   deadline arithmetic (`next_deadline`, `fire_at`, `run_at`,
   `lease_expires`, `available_at`), and the scheduler heartbeat are written
   by the database, never by the application host (`new Date()` is never
   persisted for deadlines).
2. **Monotonic host time only for in-process durations** — retry jitter and
   rate-limit windows use `Date.now()` deltas within one process lifetime;
   they are never compared across hosts or persisted.
3. **Skew monitor with hold semantics** — `checkClockSkew(pool, budgetMs)`
   compares host time against the DB clock on every check. When
   `|skew| > budget`, the caller is in `CLOCK_UNCERTAIN` and must hold
   dispatch (queue, don't drop, don't guess). Existing in-flight work
   continues under its DB-computed lease, which stays correct even under
   host-clock skew because expiry is evaluated by the DB.
4. **UTC epoch arithmetic everywhere; time zones are presentation-only.**
   All columns are `timestamptz`; intervals are PG `interval` values added by
   the database; no DST-sensitive local-time scheduling exists in v1.

## Alternatives rejected

- **App-host wall clock for deadlines** (used by naive cron + in-memory
  timers): a skewed or stepped host clock silently corrupts leases and can
  fire releases early or never.
- **Monotonic clocks for persisted deadlines**: monotonic values are
  per-process and meaningless after restart or across replicas.
- **Local-time schedules with TZ conversion**: DST makes 01:30 fire twice or
  never; UTC anchors remove the class of bugs.
- **NTP-trust-and-forget** (assume skew never happens): cheap VPS hosts
  regularly exhibit multi-second drift; the skew budget plus explicit
  CLOCK_UNCERTAIN hold turns drift into a safe hold instead of a hazard.

## Security implications

- Lease expiry evaluated by the DB (`lease_expires < clock_timestamp()`) is
  not forgeable by compromising one worker's clock; a stale worker's claims
  are reaped and the job re-run at-least-once (never lost, never
  double-applied thanks to state transitions guarded per owner).
- The skew hold errs on the safe side of ADR-003: uncertainty delays a
  release, it never accelerates one.
- Residual risk, documented: if the operator runs no NTP at all and skew
  exceeds the budget permanently, the scheduler holds (releases pause) until
  an operator intervenes — availability trade-off in exchange for
  correctness, matching the brief's correctness-over-speed rule.

## Impacts

- All future deadline features (quorum, fixed-date triggers, delivery
  backoff) must compute time in SQL, not JS.
- `checkClockSkew` must be called by the worker loop before dispatch once the
  worker runtime entrypoint lands; the function and its budget semantics are
  already tested.

## References

- `docs/adr/002-postgres-as-queue.md` (lease/claim mechanics)
- `docs/DESIGN.md` §5 (escalation defaults), §2 (threat model)
- pg-boss clock-skew mitigation precedent (DB-vs-host offset monitoring)
