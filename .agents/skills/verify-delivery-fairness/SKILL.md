---
name: verify-delivery-fairness
description: Review or verify changes to PostgreSQL delivery claims, account fairness, and queue progress under lock contention, retries, or cooldowns.
---

# Verify delivery fairness

Read the claim and requeue paths in [delivery.ts](../../../src/delivery.ts) together with the [lane migration](../../../db/004_fair_delivery.sql). A lane represents one `(tenant_id, account_id)` pair. Its `pending_count` includes delayed retries and expired work awaiting cleanup. A claim needs a due action inside its send window and an account outside cooldown.

Trace the order of candidate selection, row locking, and turn advancement. The current claim skips a locked lane and head pair while selecting a candidate. Choosing one lane before trying to lock its head can leave an eligible quiet account waiting. In the claim transaction, advance the turn only for the leased action's lane. The lane trigger maintains the pending count and sends a newly active lane to the back of the rotation. Preserve the lease fence and keep provider calls outside the claim transaction.

Use a hot account and a quiet account under the same tenant. For contention, hold the hot head lock in a separate PostgreSQL connection and verify a worker call dispatches the quiet action before the lock is released. After release, verify the hot action can still be dispatched once. Start with [fairness tests](../../../test/fairness.test.ts) for lock and expiry cases and [delivery tests](../../../test/delivery.test.ts) for cooldown or requeue. Use the [skew workload](../../../docs/capacity.md#reproduce-the-skew-and-backpressure-workload) when you need queue age or progress measurements under load.

Report claim order separately from provider completion order. Multiple workers and different provider latencies can reorder completions. A test with a simulated adapter establishes local queue behavior for its scenario.
