# Production sizing and storage decision

Use managed high-availability PostgreSQL as the transactional system of record for the pricing workflow. Scale intake and delivery workers independently and measure the writer against both a busy-hour envelope and a concentrated account burst. [Local PostgreSQL workload and its limits](capacity.md)

## Public anchors as of November 24, 2026

Blotato advertises **10,000+ operators**. The published count has no stated activity window or billing-status definition. In November 2026, founder Sabrina Ramonov cited a book profile describing her solo business as reaching millions in annual revenue. That gives commercial context. Current paid subscriptions, plan mix, automation adoption, inbound volume and peak concurrency remain unknown. [Blotato pricing](https://www.blotato.com/pricing) · [Founder’s November 16 post](https://www.blotato.com/blog/sabrina-ramonov-tony-robbins-ai-advantage)

Starter ($29/month), Creator ($97/month) and Agency ($499/month) include **1,000 / 6,000 / 15,000 active contacts per month** by default. Each person reached by DM or comment reply counts once per connected social account in the billing period, with a shared allowance across the subscription. A tenant in this model is a billing subscription, which can contain several connected accounts. The same person on two accounts can contribute two contact-months. Repeat sends on one account consume no additional contact allowance, and inbound events can arrive without a response. [Blotato pricing](https://www.blotato.com/pricing) · [Billing documentation](https://help.blotato.com/settings/billing-and-credits#active-contacts)

Blotato’s public REST routes document 30 requests/minute each for posting a comment, sending a message and mutating an automation, and 60/minute each for the listed comment, message, run, log and analytics reads. MCP calls use the underlying REST routes. These are client API quotas. The provider applies its own endpoint and account limits, and the workflow sizes inbound and outbound traffic separately. [Blotato rate limits](https://help.blotato.com/api-and-mcp-concepts/rate-limits) · [Meta rate limits](https://developers.facebook.com/docs/graph-api/overview/rate-limiting/#messenger-api-for-instagram)

## Workload envelope

Model **10,000 hypothetical billing tenants** with an 80% Starter, 18% Creator and 2% Agency mix. Published default allowances sum to **21.8M contact-months**, equivalent to about 727k/day or 8.4/s averaged over a 30-day month at full use. This is a normalization of a contact allowance. It supplies no ceiling on event or message throughput. The flow’s share in the model assigns a distinct portion of those account-scoped contact-months to this workflow.

| Model input | Planning | Stress |
| --- | ---: | ---: |
| Tenants using DM automation × their allowance utilization × share of contacts due to this flow | 30% × 40% × 60% | 60% × 65% × 75% |
| Run starts per reached contact, allowing for repeats and failed starts | 1.25 | 1.25 |
| Unique comments starting a run | 20% | 10% |
| Unique inbound DMs per unique comment, including eligible email replies | 0.30 | 0.30 |
| Inbound attempts per unique event / send attempts per action | 1.10 / 1.05 | 1.25 / 1.20 |
| Share of day in busiest two hours × short burst above that window’s average | 25% × 3 | 40% × 5 |

Each run enqueues a public reply. Assume 90% of starts advance to the private email prompt and 40% of those prompt actions result in an eligible email and link action. That yields `1 + 0.90 + (0.90 × 0.40) = 2.26` new actions and `0.36` leads per start. Compute unique comments as starts divided by the start fraction. Add DMs once, then apply the duplicate multiplier to derive ingress attempts. The burst factors are 9× and 24× above the full-day average. Multiplying outbound by that burst assumes responses and events align, so treat it as offered load for a test before account throttling.

| Result | Planning (average → burst) | Stress (average → burst) |
| --- | ---: | ---: |
| Contact-months attributed to this flow | 1.57M/month · 52,320/day · 0.61/s average | 6.38M/month · 212,550/day · 2.46/s average |
| Started runs/s | 0.76 → 6.8 | 3.08 → 73.8 |
| Unique inbound events/s | 4.9 → 44 | 40 → 959 |
| Inbound attempts/s, including redelivery | 5.4 → 49 | 50 → 1,199 |
| New outbound actions/s | 1.7 → 15 | 6.9 → 167 |
| Provider call attempts/s, including retries | 1.8 → 16 | 8.3 → 200 |
| Core DB transactions/s, including prompt arming | 9.7 → 87 | 70 → 1,679 |

The core estimate includes one transaction per intake attempt, two per send attempt for claim and settlement, and one for each attempt to arm the email prompt. Prompt attempts use the same retry multiplier as other actions. The reference worker also checks expired leases and pending sends each cycle. At the modeled burst that adds roughly **32 / 400** database units of work per second if one cycle makes one send attempt, plus cycles with no send. Include wait expiry, reconciliation, configuration changes, and report reads in a deployment test. [Delivery worker](../src/delivery.ts)

At an illustrative mean adapter call of 250 ms and target 70% worker utilization, `ceil(attempts/s × 0.25 / 0.70)` gives **6 / 72 concurrent call slots** at the two burst loads where provider quotas permit. Required concurrency scales with observed adapter latency. PostgreSQL connections serve short SQL transactions. Pending sends and 24-hour waits occupy rows. At the average run rates, sending every modeled prompt and holding it for the full 24 hours would give approximately 59k / 239k waiting runs before accounting for replies or burst backlog.

**One viral account.** Blotato’s published example uses 3,000 matching comments in an hour. Meta documents up to 750 private replies per hour to Instagram posts and reels per app per professional account. Assume all starts are eligible, the tenant has room in its monthly contact allowance and public replies keep pace. Private prompts consume four hours of allowance in total. If 750 send in the first hour, 2,250 remain queued, requiring another three hours at the ceiling with zero new arrivals. At 375 new prompts/hour, net drain falls to 375/hour and takes six hours. Persist the deferral across restarts, apply the account’s cooldown across workers, track deadline headroom, and let quiet accounts progress. At the provider ceiling, database capacity improves intake and queue durability. [Blotato burst example](https://www.blotato.com/blog/instagram-dm-limits#three-accounts-three-different-ceilings) · [Meta rate limits](https://developers.facebook.com/docs/graph-api/overview/rate-limiting/#messenger-api-for-instagram) · [Private reply deadlines](https://developers.facebook.com/documentation/instagram-platform/private-replies)

## Retention and physical storage

Daily inserts for planning/stress are **425k / 3.45M** inbox receipts, **65k / 266k** runs, **148k / 600k** outbox actions and **24k / 96k** leads. Retries reuse an action row. Model each table as daily inserts × retained days × allocated relation bytes divided by its live row count. At illustrative 30 days for inbox and leads and 90 days for runs and outbox, this gives about **32.6M / 184.4M retained rows** across those four tables. Those durations are sizing inputs. Actual receipt retention must cover accepted redelivery and replay, and personal data retention depends on purpose and deletion policy. [Schema and privacy boundaries](data.md)

The 5,000-conversation local run measured each relation after delivery drained. `pg_total_relation_size` includes indexes and allocated table space, including TOAST and auxiliary forks. Dividing by the measured live rows gives the following inputs. The extrapolation covers four primary relations with synthetic payloads. [Local workload and size measurements](capacity.md) · [PostgreSQL size functions](https://www.postgresql.org/docs/17/functions-admin.html)

| Relation | Measured allocated bytes per live row | Retention used | Planning GiB | Stress GiB |
| --- | ---: | ---: | ---: | ---: |
| Inbox | 394 | 30 days | 4.68 | 38.03 |
| Runs | 659 | 90 days | 3.61 | 14.67 |
| Outbox | 552 | 90 days | 6.83 | 27.76 |
| Leads | 134 | 30 days | 0.09 | 0.36 |
| **Estimated primary relation footprint** | | | **15.2** | **80.8** |

If allocated bytes per live row double, the sample footprint scales to **30.4 / 161.6 GiB**. Keeping inbox receipts for 90 days instead of 30 raises the original estimate to **24.6 / 156.9 GiB**. Budget other relations, replicas, WAL archives and backups separately. Before choosing storage and I/O, measure production-shaped payloads and a retention-aged mix of inserts, updates and deletes. Track indexes, dead tuples, peak WAL, replica lag and restore duration. Keep tenant-and-account-scoped deduplication across rotation boundaries. A PostgreSQL partitioned unique key must include the partition key, so moving historical rows into time partitions also requires preserving any still-live deduplication keys. [Partitioning constraints](https://www.postgresql.org/docs/17/ddl-partitioning.html)

## When a different architecture pays off

This service uses PostgreSQL as a transactional OLTP store, with authoritative current state and operational records. The inbox deduplicates deliveries, the outbox tracks intended actions and their outcomes, and pinned rule versions make runs interpretable. Event sourcing requires a complete, authoritative history of domain changes from which current state can be rebuilt. A managed deployment can provide a synchronous standby and point-in-time recovery while preserving the transactions that enforce tenant-scoped deduplication, the active-run invariant, atomic lead capture and outbound intent. Keep workers’ claim and settlement transactions short. Measure commit latency, failover and restore with explicit recovery targets. [PostgreSQL row locks](https://www.postgresql.org/docs/17/sql-select.html#SQL-FOR-UPDATE-SHARE) · [Amazon RDS Multi-AZ](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZSingleStandby.html) · [Point-in-time recovery](https://docs.aws.amazon.com/AmazonRDS/latest/gettingstartedguide/managing-backup-restore.html)

PostgreSQL could also host an append-only domain-event table if event sourcing became a business requirement. PostgreSQL's write-ahead log supports database recovery and change capture. Reconstructing a business aggregate requires an explicit domain event contract and a compatible replay implementation. [PostgreSQL WAL](https://www.postgresql.org/docs/17/wal-intro.html) · [KurrentDB event sourcing](https://docs.kurrent.io/dev-center/use-cases/outbox/introduction)

| Option | Use when | Work it introduces |
| --- | --- | --- |
| Immutable event sourcing, e.g. KurrentDB | Business requirements demand a complete, reconstructable history for a bounded aggregate. Versioned domain events become authoritative, appends check the expected stream revision, and projections rebuild current state. | Capture every decision needed for replay, version event schemas, keep projections consistent, and give cross-aggregate invariants an explicit owner. Put addresses and message bodies in erasable storage with restricted access. [KurrentDB](https://docs.kurrent.io/getting-started/introduction) · [Expected revision](https://docs.kurrent.io/clients/node/v1.3/appending-events) |
| Kafka with outbox CDC and separate projections | Independent consumers, analytical fan-out, or ingestion isolation justify a partitioned log. PostgreSQL still commits the business state and outbox together. Downstream consumers deduplicate by stable event ID and use an ordering key suited to their domain. | Operate connector lag and WAL retention, partition routing, consumer checkpoints, schema evolution and deletion propagation. Kafka orders within a partition, and compaction can remove older events. Exactly-once processing of Kafka records still needs destination cooperation for effects outside Kafka. [Kafka design](https://kafka.apache.org/42/design/design/) · [Debezium outbox router](https://debezium.io/documentation/reference/transformations/outbox-event-router.html) |
| Temporal plus PostgreSQL | Many long-running workflows need durable timers, signals, retries or compensation, and hand-maintained transitions become the limiting complexity. Temporal can own execution history while PostgreSQL owns tenant data and reporting. | Maintain deterministic workflow code and versioning, pass references for personal data, and design idempotent activities. If a send succeeded before the activity result was recorded, the retry needs the same provider-side protection or reconciliation. [Temporal replay and timers](https://docs.temporal.io/durable-execution) · [Activity idempotency](https://docs.temporal.io/activity-definition) |

Keep reporting replay and outbound effects independent. A database restore or log replay can surface old send intents whose provider effects already happened. Hold dispatch during recovery, reconcile against provider receipts or verified absence, and check current eligibility before resuming. Preserve the original timer and provider deadlines. Add CDC first if measured analytical fan-out interferes with the writer, Temporal if orchestration complexity warrants it, and tenant sharding if an aged, mixed workload still saturates a tuned primary. [Recovery procedure](delivery-recovery.md) · [Capacity verification](capacity.md)

## Introducing the workflow into a live product

An August 2026 founder retrospective names Supabase as the database used after Blotato’s initial rebuild. The current DM automation storage and its migration interfaces remain unpublished in that account. Verify the incumbent's contracts before importing any live state. [Founder’s August 15 retrospective](https://www.sabrina.dev/p/how-i-built-a-1m-solo-ai-business)

On a live PostgreSQL deployment, use an additive schema change, bounded outbox backfill, and compatible writers throughout the expansion. Build indexes concurrently outside the migration transaction, validate the backfill, and tighten constraints once old writers are drained. The repository’s migration can backfill and index in a single transaction for a fresh or controlled installation. [Fair delivery migration](../db/004_fair_delivery.sql) · [PostgreSQL concurrent index builds](https://www.postgresql.org/docs/17/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY)

Compare outcomes with the new workflow in a read-only shadow before transferring a cohort. Fence sender ownership by tenant, drain active leases or reconcile uncertain sends, then transfer or let the incumbent finish its in-progress waits under one owner. Transfer receipts, pinned versions, provider event identities and original deadlines with any transferred work. Rollback uses the same handoff in reverse with reconciliation from the cutover watermark before dispatch resumes. [Delivery recovery](delivery-recovery.md)
