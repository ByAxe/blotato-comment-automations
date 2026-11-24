# PostgreSQL workload results · November 24, 2026

These runs used macOS arm64 on an Apple M3 Pro (11 logical CPUs), Node.js 22.22.0, local Homebrew PostgreSQL 14.25, and a simulated provider. They predate participant context. The load runs separate ingress and delivery into phases. Use these results for the recorded scenarios and revisions. [Run the current workloads](../docs/capacity.md) · [Recorded JSON for the fair queue and skew runs](2026-11-24-postgres-workloads.json)

## 400-conversation baseline

The default workload ran at [`275a6a4`](https://github.com/ByAxe/blotato-comment-automations/tree/275a6a49244de58a02dacb3427aa922b6d225093). This baseline preceded account rotation and benchmark idle repolling. It used eight ingress workers, four delivery workers, and a pool limit of eight connections. Each ingress phase submitted 1,200 attempts and accepted 400 unique events with 800 duplicate outcomes.

| Phase | Operations | Wall time (ms) | Operations/s | p95 call (ms) |
| --- | ---: | ---: | ---: | ---: |
| Comment ingress | 1,200 | 149.22 | 8,041.80 | 2.12 |
| Public reply and prompt drain | 800 | 281.27 | 2,844.28 | 2.03 |
| Response ingress | 1,200 | 72.54 | 16,541.90 | 0.68 |
| Link drain | 400 | 114.67 | 3,488.40 | 1.54 |

The run verified 800 inbox rows, 400 completed runs, 400 leads, 1,200 sent outbox rows, 1,200 simulated provider effects, and zero buffered emails. The four workers sent 201, 198, 200, and 201 replies and prompts respectively, then 100, 100, 99, and 101 links. The p95 enqueue-to-first-attempt delay was 144.21 ms for public replies, 144.41 ms for prompts, and 113.53 ms for links.

## 5,000-conversation fair queue

At [`83ef847`](https://github.com/ByAxe/blotato-comment-automations/tree/83ef8478f74351ff388f5122375e1324d1197b2b), `npm run load -- --tenants 50 --participants 100` exercised the fair queue and kept all four delivery workers polling until each phase reached its expected action count. The run verified 5,000 completed runs, 10,000 inbox rows, 5,000 leads, and exactly 15,000 accepted simulator effects backed by 15,000 sent outbox rows. Each ingress phase received 5,000 unique events and 10,000 duplicates.

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

## Skew and backpressure

At `83ef847`, `npm run skew` exercised the same fair queue. The first quiet account’s reply and prompt were accepted after one and four additional hot-account acceptances respectively. The quiet reply spent 1.27 ms queued and the prompt spent 1.40 ms queued. Its prompt settled 14.12 ms after run creation, with 216 hot actions still pending. This phase made two idle polls.

During the 3-second cooldown, 24 new hot comments entered the queue and 240 hot actions were pending at the check. The second quiet account settled both initial sends within the cooldown, with 12.36 ms from run creation to prompt settlement. The check made 16 idle polls and recorded zero additional provider calls for the hot account. After the retry deadline, workers delivered 473 accepted initial actions in 879.21 ms (537.98/s), with 164 idle polls. The scenario finished with 242 completed runs, 242 leads, 484 inbox rows, 726 sent outbox rows and simulator effects, and 727 outbound attempts. The extra attempt was the single confirmed-unsent rate limit.
