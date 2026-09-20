# ADR 002: Postgres as the queue with SKIP LOCKED, transactional outbox, and LISTEN/NOTIFY

- Status: Accepted
- Date: 2026-09-20
- Deciders: Phase 0 design review
- Sources: `docs/BRIEF.md` §7 and §7.1, `docs/DESIGN.md` §§1-2, `docs/BRIEF.md` §§5.1, 5.3

## Context

Brief §§5.1 and 5.3 set a high bar for the trigger and delivery path. Scheduling must be durable, crash safe, idempotent, and safe with multiple instances. State lives in Postgres with advisory locks or leader election. A trigger must never be silently lost, it must be queued, retried, and surfaced to the operator. Delivery needs retries with backoff, idempotency, receipts, and a dead letter queue.

Design §1 answers with Postgres only. One TypeScript image runs two roles, api and scheduler-worker, with N replicas. Queueing is a transactional outbox enqueue, claim with `FOR UPDATE SKIP LOCKED`, wake with `LISTEN/NOTIFY`, and a 2 to 5 second poll fallback. Design §2 adds the fail safe default. When in doubt, do not fire. Missed heartbeat waits for `grace_until`, scheduler downtime extends grace, and DB outage holds the job and audits.

Brief §7.1 adds the hardening constraint. Any extra service must be optional and layered. The standard profile runs with only app plus Postgres plus reverse proxy. A new dep like Redis or RabbitMQ must not become a single point of failure on the release path. Design §1 already keeps the queue off that path by caching wrapped DEKs and using queue plus retry plus alert.

At v1 scale this is a single host product with a documented HA path but no HA code beyond multi instance safe primitives. Expected queue depth is small, far below a few thousand jobs per second. The decision is whether Postgres can carry the queue alone, or whether we need a dedicated broker from day one.

## Decision

Use Postgres as the only queue.

- Enqueue is a transactional outbox. The business write and the job row commit in one transaction, so a trigger cannot be created without its job and a job cannot appear without its trigger.
- Claim uses `FOR UPDATE SKIP LOCKED`. Workers select due rows ordered by `COALESCE(grace_until, next_checkin_at)`, lock a small batch, update lease fields, and commit. The claim transaction is tiny. It does not hold the lock while calling Email, Webhook, or Telegram.
- Leases make crashes safe. Each claimed job gets `locked_by`, `locked_at`, and `lease_expires` around 30 seconds. Workers heartbeat the lease about every 10 seconds. A sweeper elected by advisory lock reclaims stale leases and requeues them. The sweeper also promotes `vault_waits` after outage compensation.
- Wake is `LISTEN/NOTIFY` with polling fallback. A heartbeat or arm does `pg_notify` on a channel. Workers `LISTEN` for sub second wake, and still poll every 2 to 5 seconds because `NOTIFY` is best effort and can be dropped on restart.
- Delivery jobs carry `idempotency_key` with a DB unique guard, attempt count, backoff with jitter, receipts, and a move to `dead_letter_jobs` after max attempts. That satisfies the never silently lost rule from Brief §5.1.

No Redis, RabbitMQ, or Kafka in v1. The hardened profile may add Vault or OpenBao later, but the queue stays in Postgres. Envelope and queue design keeps the key service off the hot release path.

## Alternatives considered

### Redis with BullMQ or similar

Redis plus BullMQ is a common TypeScript queue. It offers fast in memory ops, delayed jobs, and a nice dashboard. The trade is durability and atomicity. Enqueue plus business data cannot be in one ACID transaction unless we also use Postgres, so we risk a trigger row without a job or a job without a trigger if either write fails. Redis needs persistence tuning and memory sizing, and a second service to back up, monitor, and scale. At our scale the speed win does not pay for the extra ops and the weaker exactly once story.

### RabbitMQ

RabbitMQ has strong routing, ack based delivery, and good HA options with quorum queues. It is also a separate Erlang service with its own clustering, disk, and monitoring. The app would still need Postgres for the source of truth, so we would be keeping two durable stores in sync. For a single host, single household product that adds work. The transactional outbox plus `SKIP LOCKED` gives us the same at most once and retry guarantees with one store.

### Kafka

Kafka is built for high throughput event logs and long retention. It is the right call for tens of thousands of events per second and stream replay. Our trigger volume is tiny. Kafka brings brokers, ZooKeeper or KRaft, topic sizing, and consumer group ops that far exceed the need. It also pushes exactly once handling to the consumer. Using Kafka here would trade simplicity for headroom we do not need in v1.

### Managed SQS or cloud queue

A managed queue would be simple, but Brief §7.1 requires on premise friendly with no mandatory cloud or SaaS dep. SQS would break that rule and tie the release path to the network path to AWS. That is a new failure mode for a dead man switch.

## Tradeoff table

| Criteria | Postgres SKIP LOCKED plus outbox | Redis plus BullMQ | RabbitMQ | Kafka |
| --- | --- | --- | --- | --- |
| Durability | ACID. Job and trigger commit together or not at all. Survives process and host restart. | In memory by default. Persistence needs AOF or RDB plus tuning. Job can be lost on crash if not persisted. | Durable when queues are mirrored or quorum. Needs disk and cluster care. | Durable log on disk. Needs broker cluster and retention tuning. |
| Transactionality | One transaction for business write plus enqueue. No sync bug. | Two systems. No cross store transaction. Needs outbox anyway. | Two systems. Same sync gap. | Two systems. Same sync gap. |
| Ops cost at single host scale | Zero new service. One Postgres to back up and tune. Partial index keeps dequeue fast. | Extra service, memory sizing, persistence config, second backup. | Extra service, Erlang runtime, queue mirroring, second backup. | Extra cluster, topic and partition ops, second backup. |
| Throughput headroom | Good to a few thousand jobs per second with `SKIP LOCKED`. Enough for v1 and beyond. Partial index on `status = pending` keeps it `O(kB)`. | Higher raw ops per second in memory. | High, many thousands per second with tuning. | Very high, tens of thousands per second. |
| Multi instance safety | `SKIP LOCKED` plus advisory lock for sweeper. Non blocking claim. | Redis atomic claim, but still needs Postgres sync. | Ack based, needs idempotency in app too. | Consumer group rebalance, needs idempotency in app. |
| Failure mode on queue down | Same as DB down. Fail safe hold plus audit per Design §2. One store to reason about. | Queue down is distinct from DB down. Release can stall if Redis is gone. | Same distinct failure domain. | Same distinct failure domain. |
| Idempotency and DLQ | Unique `idempotency_key`, receipts, `dead_letter_jobs` in one DB. Easy to replay. | Needs Redis plus Postgres DLQ, two places to check. | Needs Postgres DLQ, two places to check. | Needs Postgres DLQ, two places to check. |
| On premise fit | Fully self hosted. No cloud dep. Standard profile stays slim. | Self hostable, but adds a service to the standard profile. | Self hostable, but heavier standard profile. | Self hostable, but heaviest standard profile. |
| When it wins | Our case. Small volume, correctness and simplicity first. | Large job volume, many delayed jobs, and you accept two stores. | Complex routing and priority queues at scale. | High throughput event streaming with replay needs. |

## Rationale

We chose the store we already must run. Postgres is required by Brief §7, so it is not an extra dep. One store keeps the failure story simple, which matters for Brief §5.1. A trigger is never silently lost because enqueue is transactional and the sweeper reclaims orphaned leases. `LISTEN/NOTIFY` keeps wake quick, polling keeps it correct when notify drops.

The hard requirements push against a new broker. Brief §7.1 says the standard profile must work with only app plus Postgres plus proxy, and no extra service may become a single point of failure on the release path. Adding Redis, RabbitMQ, or Kafka in v1 would break both rules. Design §2 also favors fail safe. Holding a job in Postgres while the DB is gone is a clear, auditable wait. Splitting state across two stores makes that harder to prove.

Scale is not the driver here. At a few thousand jobs per second Postgres with `SKIP LOCKED` and a partial index is plenty. We do not need Kafka grade throughput or RabbitMQ grade routing in v1. Three delivery providers, Email plus Webhook plus Telegram per Design §1, do not need topic streaming.

## Impacts

### Positive

- One durable store for vaults, trigger jobs, delivery jobs, vault waits, scheduler heartbeat, and audit log. One backup to test per Brief §6.
- Enqueue and business state stay atomic. No ghost triggers and no orphan jobs.
- N api and worker replicas can claim concurrently without blocking each other. Empty claim returns in milliseconds.
- Downtime compensation has a clear home. `scheduler_heartbeat` gap check extends `grace_until` and moves due timers to `vault_waits`. That matches Design §2 and Brief §5.1.

### Negative and mitigations

- Long running delivery holds no row lock, which is good, but a worker that dies mid delivery leaves a leased row until the sweeper fires. Mitigation is a 30 second lease with 10 second heartbeat and a 15 to 60 second sweeper. Idempotent delivery plus `idempotency_key` makes reclaim safe.
- `LISTEN/NOTIFY` payloads are best effort and limited in size. We notify with just an id and re read the row. Poll every 2 to 5 seconds covers dropped notifies.
- Throughput is lower than an in memory broker at extreme scale. Mitigation is the documented HA path. If volume ever outgrows Postgres, we can add a broker behind the same outbox without changing the job model.
- Partial and covering indexes matter. We index `WHERE status = pending` on `run_at` and `priority`, and keep scheduler indexes on `status` plus `next_checkin_at` and `grace_until`. Without them, dequeue can scan.

### Follow on work

- DDL will create `trigger_jobs`, `delivery_jobs` with `idempotency_key` unique, `vault_waits`, `scheduler_heartbeat`, and `dead_letter_jobs` with the `SKIP LOCKED` claim function. That lands in Phase 2.
- Advisory lock election for the sweeper and the fencing token for delivery need tests. Failure injection in Phase 8 will cover crash mid trigger, duplicate workers, DB restart, clock skew, and downtime recovery.
- This ADR does not pick Vault versus OpenBao. That choice stays in ADR 007 per Design §9, deferred per user decision.

## Security implications

- Transactional enqueue prevents the silent loss case that would hide a missed release from the audit log. That maps to Repudiation and Tampering controls in Design §2. Append only `audit_log` plus receipts gives a complete trail.
- Idempotency keys with DB unique guards prevent double delivery if a worker retries or a lease is reclaimed. That is needed for correctness under multi instance claim and for the at most once promise during outage compensation.
- Least privilege DB roles still apply. The app role that claims jobs does not get `UPDATE` or `DELETE` on `audit_log`. Secrets stay ciphertext only in Postgres. The queue rows hold refs, not plaintext.
- The sweeper uses `pg_try_advisory_lock`, so only one instance reclaims at a time. That avoids two workers both deciding to promote the same `vault_waits` row after a downtime window.
- No queue in Redis means one less service with its own auth and TLS to harden. That keeps the standard profile small and the verification script focused on Postgres exposure and role grants per Brief §10.

## References

- `docs/BRIEF.md` §5.1 durable, crash safe, idempotent, multi instance, fail safe vs fail deadly, no silent loss
- `docs/BRIEF.md` §5.3 retries, backoff, idempotency, receipts, dead letter, recipient pre approval
- `docs/BRIEF.md` §7 Postgres primary, monorepo, Docker, and default Postgres backed queue
- `docs/BRIEF.md` §7.1 standard vs hardened, optional and layered, no new single point of failure on release path
- `docs/DESIGN.md` §1 queue Postgres only, transactional outbox, `SKIP LOCKED`, `LISTEN/NOTIFY` plus poll, single image two roles, N replicas, lease and sweeper
- `docs/DESIGN.md` §2 fail safe default, downtime extend grace, clock uncertainty hold, DB unavailable hold plus audit
- `docs/research/2026-09-20-foundation-research.md` §4 trigger engine and Postgres scheduler patterns
