# Capacity, scaling, and recovery

The two workloads exercise competing PostgreSQL consumers and record accepted simulator effects with participant context collection off. The historical results below predate the participant context migration. An opted-in workload adds interaction writes, returning-prompt lookups, context reads, and expiry cleanup. [Production sizing model](storage-and-sizing.md) · [Participant context](data.md#participant-context)

## Reproduce the PostgreSQL workload

Run from the repository root after `npm ci`. The default command requires `initdb` and `pg_ctl` on `PATH`. It starts a private local PostgreSQL instance, migrates a disposable database, executes the load scenario, and removes its database afterward. `PG_TEST_ADMIN_URL` can point to a dedicated PostgreSQL test server whose role can create and drop a disposable database.

```sh
npm run load
npm run load -- --tenants 8 --participants 50 --ingress-workers 8 --delivery-workers 4
```

Both commands select the same default scenario. `--participants` is per tenant. The harness caps the scenario at 5,000 conversations, 50 tenants, 1,000 participants per tenant, and 32 workers of either kind. Tenant fixtures intentionally reuse account, participant, comment, and message IDs across tenant boundaries. Two identical envelopes plus a different envelope carrying the same object enter each phase concurrently. The workload uses the engine's public TypeScript APIs and real PostgreSQL transactions. The simulator accepts and records each outbound call without deduplicating it.

The program enqueues comments, drains their public replies and prompts with competing workers, verifies that all runs are waiting, and changes the configured link for each tenant. It then submits eligible synthetic replies, drains the link actions, and verifies persisted rows and simulator effects. The checks cover event deduplication, one completed run and one lead for every comment, no leftover buffered email, action order, ownership, original link content, and one recorded receipt per action. Output contains counts, timings, and runtime metadata.

Each phase reports wall time, completed operations per second, and nearest-rank p50, p95, and p99 call latency. Ingress counts include duplicate attempts. Drain counts include successful calls, and drain wall time includes repolling. A claim may return idle while another worker holds a lane lock. Each benchmark worker polls again after a 2 ms delay until the phase reaches its expected effect count or makes no progress for five seconds. Per-worker sends and idle polls describe worker contention. The skew workload observes fairness across accounts separately. Client call timing uses a monotonic clock and includes pool and database waits. PostgreSQL timestamps measure enqueue-to-first-attempt latency by action kind. The deliberate separation of ingest and drain makes that queue measurement a burst-backlog observation. Setup, version publication, verification, and relation-size queries are outside the phase timings.

### Historical 400-conversation baseline

On 24 November 2026, the default workload at core commit `275a6a4` ran on macOS arm64 with an Apple M3 Pro (11 logical CPUs), Node.js 22.22.0, and local Homebrew PostgreSQL 14.25. This baseline preceded account rotation and benchmark idle repolling. It used eight ingress workers, four delivery workers, and a pool limit of eight connections. Each ingress phase submitted 1,200 attempts and accepted 400 unique events with 800 duplicate outcomes.

| Phase | Operations | Wall time (ms) | Operations/s | p95 call (ms) |
| --- | ---: | ---: | ---: | ---: |
| Comment ingress | 1,200 | 149.22 | 8,041.80 | 2.12 |
| Public reply and prompt drain | 800 | 281.27 | 2,844.28 | 2.03 |
| Response ingress | 1,200 | 72.54 | 16,541.90 | 0.68 |
| Link drain | 400 | 114.67 | 3,488.40 | 1.54 |

The run verified 800 inbox rows, 400 completed runs, 400 leads, 1,200 sent outbox rows, 1,200 simulated provider effects, and zero buffered emails. The four workers sent 201, 198, 200, and 201 replies and prompts respectively, then 100, 100, 99, and 101 links. The p95 enqueue-to-first-attempt delay was 144.21 ms for public replies, 144.41 ms for prompts, and 113.53 ms for links.

### Observed 5,000-conversation fair queue run

On the same local setup at core commit `83ef847`, `npm run load -- --tenants 50 --participants 100` exercised the fair queue and kept all four delivery workers polling until each phase reached its expected action count. The run verified 5,000 completed runs, 10,000 inbox rows, 5,000 leads, and exactly 15,000 accepted simulator effects backed by 15,000 sent outbox rows. Each ingress phase received 5,000 unique events and 10,000 duplicates. [Recorded command output](measurements.json)

| Phase | Operations | Wall time (ms) | Operations/s | p95 call (ms) |
| --- | ---: | ---: | ---: | ---: |
| Comment ingress | 15,000 | 918.34 | 16,333.86 | 0.73 |
| Public reply and prompt drain | 10,000 | 3,202.86 | 3,122.21 | 1.71 |
| Response ingress | 15,000 | 859.62 | 17,449.63 | 0.59 |
| Link drain | 5,000 | 1,132.84 | 4,413.69 | 1.11 |

The four workers sent 2,498, 2,498, 2,501, and 2,503 replies and prompts respectively, then 1,249, 1,250, 1,250, and 1,251 links. There were three idle polls in each drain. The p95 enqueue-to-first-attempt delay was 1,913.95 ms for public replies, 1,774.39 ms for prompts, and 1,535.42 ms for links.

The relation sizes below were measured after the run on the disposable database. They include allocated relation pages and indexes at that point. WAL and backup sizes are separate. [PostgreSQL disk usage](https://www.postgresql.org/docs/current/disk-usage.html)

| Relation | Rows | Table bytes | Index bytes | Total bytes |
| --- | ---: | ---: | ---: | ---: |
| `inbox` | 10,000 | 1,400,832 | 2,539,520 | 3,940,352 |
| `runs` | 5,000 | 1,318,912 | 1,974,272 | 3,293,184 |
| `outbox` | 15,000 | 3,883,008 | 4,390,912 | 8,273,920 |
| `leads` | 5,000 | 458,752 | 212,992 | 671,744 |

The load scenario covers concurrent database work in one Node.js process with an immediate-success simulator. The HTTP and recovery tests provide separate evidence for the service boundary, process restarts, retry outcomes, and ambiguous sends. For deployment capacity, rerun against a retention-aged database with the expected database latency, concurrent ingress and drain, and an adapter fixture calibrated to observed network latency and rate limits. [HTTP end-to-end test](../test/e2e.test.ts) · [Delivery tests](../test/delivery.test.ts)

## Reproduce the skew and backpressure workload

```sh
npm run skew
npm run skew -- --hot-comments 1000 --workers 4 --adapter-ms 5
```

The default workload starts with 216 matching comments queued for one tenant account. A second tenant account submits one matching comment after delivery begins. Four workers compete for claims, and the harness checks that the quiet account's prompt arrives while hot-account work remains pending. The check budgets at most four hot-account acceptances per worker before that prompt. This finite-workload regression threshold allows for already claimed work and variable completion order across workers.

The adapter fixture delays each send by 5 ms and injects one known-unsent rate limit with a 3-second retry delay. These are workload inputs. During the actual persisted cooldown, another 24 comments arrive for the hot account, and a third tenant account settles its public reply and email prompt. The harness checks that the hot account receives no additional provider calls during this check. It waits for the database retry deadline and drains the delayed queue using the same worker API. Then synthetic email replies advance both quiet runs and every hot run. Stored receipts and recorded effects prove there is one ordered effect per step, with the right account, participant, and link. A successful default run has 242 completed runs, 726 accepted actions, and one additional proven-unsent attempt.

The report counts hot-account acceptances before the quiet reply and prompt. PostgreSQL timestamps give the age of each quiet action at its first claim, the interval from run start to prompt settlement, and evidence that the second quiet prompt settled before cooldown ended. The recovery rate counts accepted initial actions after the retry became due and divides by drain wall time. The separate response and link phase is outside that rate. The portable verification target also runs this scenario with 64 hot-account comments and a 1 ms adapter delay. [Scenario source](../scripts/skew.ts)

### Observed skew run

On the same local setup at core commit `83ef847`, the first quiet account's reply and prompt were accepted after one and four additional hot-account acceptances respectively. The quiet reply spent 1.27 ms queued and the prompt spent 1.40 ms queued. Its prompt settled 14.12 ms after run creation, with 216 hot actions still pending. This phase made two idle polls. [Recorded command output](measurements.json)

During the 3-second cooldown, 24 new hot comments entered the queue and 240 hot actions were pending at the check. The second quiet account settled both initial sends within the cooldown, with 12.36 ms from run creation to prompt settlement. The check made 16 idle polls and recorded zero additional provider calls for the hot account. After the retry deadline, workers delivered 473 accepted initial actions in 879.21 ms (537.98/s), with 164 idle polls. The scenario finished with 242 completed runs, 242 leads, 484 inbox rows, 726 sent outbox rows and simulator effects, and 727 outbound attempts. The extra attempt was the single confirmed-unsent rate limit.

## Scale by the limiting resource

Begin with a PostgreSQL primary and horizontally scalable stateless workers. The scheduler rotates among eligible tenant and account pairs through durable turn numbers. `FOR UPDATE SKIP LOCKED` lets workers claim different lanes during short transactions. The worker releases its connection before the adapter call. Multiple eligible accounts under one tenant each get a turn, and an account may have several sends in flight. Add provider-specific concurrency caps or hierarchical tenant budgets when account fan-out or adapter constraints make them necessary. Track ready queue age, depth, throughput, retries, and rate limiting by account and action kind, keeping tenant drilldowns out of high-cardinality labels. Reserve separate connection capacity for intake. [Fair delivery migration](../db/004_fair_delivery.sql) · [PostgreSQL SELECT](https://www.postgresql.org/docs/current/sql-select.html)

Use provisional internal objectives such as p95 durable intake below 250 ms and p95 ready-action age below 5 seconds during the modeled burst, excluding work scheduled for a future retry or rate-limited account. Observe the oldest ready action, deadline headroom, waiting and uncertain counts, settlement latency, pool wait, lock and disk waits, autovacuum progress, and replica lag. Compare queue growth and actual send rate with arrival rate before adding workers. Add provider concurrency when spare provider quota exists and database saturation metrics stay flat. The claim query inspects candidate lanes in turn order and seeks each lane's due work through an index. If many lanes have delayed or expired work, the poll can inspect many candidates. If idle lease sweeps or lane scans dominate, back off idle polling and evaluate a due-lane index or separate bounded maintenance for lease expiry. [Delivery and recovery](delivery-recovery.md)

Keep live deduplication, active conversations, and retryable work together. Move terminal history to time-partitioned tables when retention deletes, vacuum time, or index growth materially reduce headroom. Keep compact idempotency keys for at least the agreed replay horizon. In PostgreSQL, partitioned unique constraints must cover the partition key, so a date partition alone cannot enforce the live uniqueness keys across dates. Rehearse retention against late events before deleting deduplication records. [PostgreSQL partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)

Consider sharding only if a retention-aged load test reproduces persistent primary write or I/O saturation after query, connection, and maintenance tuning. Route by tenant so the inbox, conversation lock, run, lead, and outbox for each conversation stay on one shard. Co-locate the tenant's configuration with that write path. Use separate reporting projections for cross-shard reads. A hot account still needs independent admission and fair provider use. A shard move needs an ownership fence that stops old claims, a cutover watermark, and verification that in-flight effects and deduplication keys survived.

## Durability and recovery

Commit a webhook receipt and its state changes before acknowledging intake. Keep PostgreSQL durability enabled and use encrypted backups plus continuous WAL archiving for point-in-time recovery. Validate retention and backup access separately for lead data. Define the acceptable recovery point and recovery time with the operator, then test restore and failover against those targets. Assess synchronous standby acknowledgement if acknowledged commits must survive the loss of the primary. [PostgreSQL continuous archiving](https://www.postgresql.org/docs/current/continuous-archiving.html) · [PostgreSQL synchronous replication](https://www.postgresql.org/docs/current/warm-standby.html#SYNCHRONOUS-REPLICATION)

An expired lease after a worker failure becomes uncertain, with a lease token fencing out late settlements. Use a provider receipt or verified absence before resolving an unknown send. A database restore can bring back pending intent for a send the provider already accepted. Pause outbound workers during recovery, identify the affected commit window, reconcile restored work with provider evidence, and resume safe actions while leaving unresolved sends visible. Track time to resolve uncertain actions and alert when unresolved or ready work approaches a provider deadline. [Outbox delivery implementation](../src/delivery.ts) · [Provider integration](integration.md)
