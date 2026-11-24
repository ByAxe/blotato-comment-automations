# Capacity, scaling, and recovery

## Initial planning envelope

These are hypothetical sizing inputs. Replace them with account traffic, reply rates, adapter quotas, and measured service times before choosing production capacity. Assume 100 active tenants with one connected account each, averaging five unique comment events per minute per tenant. Assume that 20% of comments start a run, 40% of runs receive a qualifying email, total DM intake is 30% of comment intake, and redelivery adds 10% to inbound attempts. The peak column applies a 3× burst to all rates. The arithmetic assumes both initial sends succeed and each accepted email creates a link action.

| Work | Calculation | Steady per second | Peak per second |
| --- | --- | ---: | ---: |
| Unique comments | `100 × 5 / 60` | 8.33 | 25 |
| Unique messages | `comments × 0.30` | 2.50 | 7.5 |
| Ingress attempts | `(comments + messages) × 1.10` | 11.92 | 35.75 |
| Started runs | `comments × 0.20` | 1.67 | 5 |
| Accepted emails | `started × 0.40` | 0.67 | 2 |
| New outbound actions | `2 × started + accepted` | 4.00 | 12 |

At peak, the write path sees about 36 intake transactions and 24 claim/settlement transactions per second. Add one lease-expiry statement per delivery call in the prototype, idle polling, retries, wait expiry, and reconciliation. The active-wait upper bound at a sustained five starts per second and a 24-hour wait is about 432,000 waits, assuming every prompt reaches waiting and every participant stays until expiry. Pending sends and unresolved outcomes have separate backlog counts.

The steady rates yield roughly 936,000 inbox rows, 144,000 runs, 345,600 outbox rows, and 57,600 leads per day. As a sensitivity check, 0.5–1 KiB per row across heap and indexes gives about 0.7–1.4 GiB per day before WAL, dead tuples, backups, replicas, or analytics copies. Measure `pg_total_relation_size`, dead tuples, and WAL volume on a retention-aged test database. Budget each table against its own retention policy, including the provider replay horizon for deduplication and the approved lifetime of stored contact data. [PostgreSQL disk usage](https://www.postgresql.org/docs/current/disk-usage.html)

If the provider and database jointly allow a 24-action/s recovery rate, a 10-minute outage at 12 new actions/s leaves about 7,200 queued actions. With arrivals continuing at 12/s, draining them takes another 10 minutes at the net rate of 12/s. In general, `drain time = backlog / (effective send rate − new action rate)`. Provider account or app limits can make that denominator zero for an affected account. At a hypothetical mean 250 ms per delivery with a 70% worker utilization target, `ceil(24 × 0.25 / 0.70) = 9` gives a starting concurrency for a recovery experiment. Keep database connections bounded independently of network concurrency, then adjust using settlement latency, observed rate limiting, and queue age.

## Reproduce the PostgreSQL workload

Run from the repository root after `npm ci`. The default command requires `initdb` and `pg_ctl` on `PATH`. It starts a private local PostgreSQL instance, migrates a disposable database, executes the load scenario, and removes its database afterward. `PG_TEST_ADMIN_URL` can point to a dedicated PostgreSQL test server whose role can create and drop a disposable database.

```sh
npm run load
npm run load -- --tenants 8 --participants 50 --ingress-workers 8 --delivery-workers 4
```

Both commands select the same default scenario. `--participants` is per tenant. The harness caps the scenario at 5,000 conversations, 50 tenants, 1,000 participants per tenant, and 32 workers of either kind. Tenant fixtures intentionally reuse account, participant, comment, and message IDs across tenant boundaries. Two identical envelopes plus a different envelope carrying the same object enter each phase concurrently. The workload uses the engine's public TypeScript APIs and real PostgreSQL transactions. The simulator accepts and records each outbound call without deduplicating it.

The program enqueues comments, drains their public replies and prompts with competing workers, verifies that all runs are waiting, and changes the configured link for each tenant. It then submits eligible synthetic replies, drains the link actions, and verifies persisted rows and simulator effects. The checks cover event deduplication, one completed run and one lead for every comment, no leftover buffered email, action order, ownership, original link content, and one recorded receipt per action. Output contains counts, timings, and runtime metadata.

Each phase reports wall time, completed operations per second, and nearest-rank p50, p95, and p99 call latency. Ingress counts include duplicate attempts. Drain counts include successful calls, and drain wall time includes the final idle polls. Client call timing uses a monotonic clock and includes pool and database waits. PostgreSQL timestamps measure enqueue-to-first-attempt latency by action kind. The deliberate separation of ingest and drain makes that queue measurement a burst-backlog observation. Setup, version publication, and verification queries are outside the phase timings.

### Observed local run

On 24 November 2026, the default workload at core commit `275a6a4` ran on macOS arm64 with an Apple M3 Pro (11 logical CPUs), Node.js 22.22.0, and local Homebrew PostgreSQL 14.25. It used eight ingress workers, four delivery workers, and a pool limit of eight connections. Each ingress phase submitted 1,200 attempts and accepted 400 unique events with 800 duplicate outcomes.

| Phase | Operations | Wall time (ms) | Operations/s | p95 call (ms) |
| --- | ---: | ---: | ---: | ---: |
| Comment ingress | 1,200 | 149.22 | 8,041.80 | 2.12 |
| Public reply and prompt drain | 800 | 281.27 | 2,844.28 | 2.03 |
| Response ingress | 1,200 | 72.54 | 16,541.90 | 0.68 |
| Link drain | 400 | 114.67 | 3,488.40 | 1.54 |

The run verified 800 inbox rows, 400 completed runs, 400 leads, 1,200 sent outbox rows, 1,200 simulated provider effects, and zero buffered emails. The four workers sent 201, 198, 200, and 201 replies and prompts respectively, then 100, 100, 99, and 101 links. The p95 enqueue-to-first-attempt delay was 144.21 ms for public replies, 144.41 ms for prompts, and 113.53 ms for links.

The load scenario covers concurrent database work in one Node.js process with a zero-network-delay simulator. The HTTP and recovery tests provide separate evidence for the service boundary, process restarts, retry outcomes, and ambiguous sends. For a deployment capacity measurement, rerun with the database at its expected retention age, remote PostgreSQL latency, concurrent ingress and drain, a skewed tenant mix, and a recording adapter that reproduces measured latency and rate limits. [HTTP end-to-end test](../test/e2e.test.ts) · [Delivery tests](../test/delivery.test.ts)

## Scale by the limiting resource

Begin with a PostgreSQL primary and horizontally scalable stateless workers. `FOR UPDATE SKIP LOCKED` lets workers claim different rows during short transactions. The worker releases its connection before the adapter call. A global due-work order can still favor a tenant with an older or larger backlog. Track ready queue age and depth, throughput, retries, and rate limiting by account and action kind, using bounded dimensions and keeping tenant drilldowns out of high-cardinality metric labels. Add per-account concurrency caps and fair scheduling by tenant if healthy accounts see rising queue age while another account dominates the work. Reserve separate capacity for intake so provider delays cannot fill the database pool. [PostgreSQL SELECT](https://www.postgresql.org/docs/current/sql-select.html)

Use provisional internal objectives such as p95 durable intake below 250 ms and p95 ready-action age below 5 seconds during the modeled burst, excluding work scheduled for a future retry or rate-limited account. Observe the oldest ready action, deadline headroom, waiting and uncertain counts, settlement latency, pool wait, lock and disk waits, autovacuum progress, and replica lag. Compare queue growth and actual send rate with arrival rate before adding workers. Add provider concurrency when spare provider quota exists and database saturation metrics stay flat. If idle lease sweeps and queue scans dominate, reduce idle polling and separate bounded maintenance from the claim loop.

Keep live deduplication, active conversations, and retryable work together. Move terminal history to time-partitioned tables when retention deletes, vacuum time, or index growth materially reduce headroom. Keep compact idempotency keys for at least the agreed replay horizon. In PostgreSQL, partitioned unique constraints must cover the partition key, so a date partition alone cannot enforce the live uniqueness keys across dates. Rehearse retention against late events before deleting deduplication records. [PostgreSQL partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)

Consider sharding only if a retention-aged load test reproduces persistent primary write or I/O saturation after query, connection, and maintenance tuning. Route by tenant so the inbox, conversation lock, run, lead, and outbox for each conversation stay on one shard. Co-locate the tenant's configuration with that write path. Use separate reporting projections for cross-shard reads. A hot account still needs independent admission and fair provider use. A shard move needs an ownership fence that stops old claims, a cutover watermark, and verification that in-flight effects and deduplication keys survived.

## Durability and recovery

Commit a webhook receipt and its state changes before acknowledging intake. Keep PostgreSQL durability enabled and use encrypted backups plus continuous WAL archiving for point-in-time recovery. Validate retention and backup access separately for lead data. Define the acceptable recovery point and recovery time with the operator, then test restore and failover against those targets. Assess synchronous standby acknowledgement if acknowledged commits must survive the loss of the primary. [PostgreSQL continuous archiving](https://www.postgresql.org/docs/current/continuous-archiving.html) · [PostgreSQL synchronous replication](https://www.postgresql.org/docs/current/warm-standby.html#SYNCHRONOUS-REPLICATION)

An expired lease after a worker failure becomes uncertain, with a lease token fencing out late settlements. Use a provider receipt or verified absence before resolving an unknown send. A database restore can bring back pending intent for a send the provider already accepted. Pause outbound workers during recovery, identify the affected commit window, reconcile restored work with provider evidence, and resume safe actions while leaving unresolved sends visible. Track time to resolve uncertain actions and alert when unresolved or ready work approaches a provider deadline. [Outbox delivery implementation](../src/delivery.ts) · [Provider integration](integration.md)
