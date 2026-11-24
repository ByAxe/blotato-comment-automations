# Recovering an uncertain send

A worker can lose the provider’s response after a message goes out. Resending a public reply or a pricing link at that point could send it twice. The worker marks the action `uncertain` and holds the run. Later actions in the conversation stay blocked until the operator resolves that attempt.

Use the recovery CLI from an operator shell after `npm run build`. Set `DATABASE_URL` to the affected environment using an individually authenticated database login. The CLI records the PostgreSQL session user. A shared database login identifies the service account, so individual attribution requires a separate login or an identity-aware operator gateway. Database access is the privilege boundary for this prototype. The customer API has no recovery route.

## Inspect a held action

```sh
node dist/src/bin/reconcile.js list --tenant demo-tenant
```

The result lists the action UUID, attempt number, run ID, operation, failure code and first claim time. For more than 50 results, pass the returned `next` UUID as `--after`. The list shows current state. A concurrent sweep can add actions while the operator reads the next page. Check again from the first page after a recovery batch.

Use the provider’s trace or support channel to look up the exact action. The adapter sends the stable action UUID to integrations that accept a correlation key. Check the provider account, recipient, operation and time when linking a receipt. Record a case reference. Keep raw DM text, email addresses and credentials out of evidence fields.

## Record a decision

Replace the shell variables with the tenant, action UUID and attempt number shown by the list command.

* **Confirmed sent.** The provider confirmed acceptance and supplied a receipt for this action. Recording the receipt advances the workflow in the same transaction.
* **Confirmed absent.** The provider established that the request had no effect. The operator also verified that the old dispatcher and its transport have finished and can no longer submit or complete a delayed send. Record both evidence references. This decision makes the action eligible for a fresh attempt while its original send window remains open. A confirmed absence after the deadline expires the run.
* **Abandon.** The team has decided to stop the run. The audit preserves this decision even if the actual recipient experience remains unknown. A missing receipt, a timeout or a message absent from an eventually consistent feed leaves acceptance unresolved.

```sh
node dist/src/bin/reconcile.js resolve --tenant "$TENANT" --action "$ACTION" --attempt "$ATTEMPT" \
  --decision confirmed_sent --evidence case-104 --receipt provider-message-42

node dist/src/bin/reconcile.js resolve --tenant "$TENANT" --action "$ACTION" --attempt "$ATTEMPT" \
  --decision confirmed_absent --evidence case-108 --quiescence dispatcher-case-91

node dist/src/bin/reconcile.js resolve --tenant "$TENANT" --action "$ACTION" --attempt "$ATTEMPT" \
  --decision abandon --evidence case-122
```

Choose one decision per attempt. A successful resolution prints `{"applied":true}`. Exit code 2 with `{"applied":false}` means the tenant, attempt or current state failed the guard. Refresh the list before taking further action. The audit row and workflow update commit together.

## Worker behavior

Each action carries an exclusive send deadline. For a feed post, the proposed product stops sending the public reply and the first private reply seven days after the comment. The link must go out within 24 hours of the qualifying DM. A queued action that misses its deadline expires even when the account is rate-limited. The connector receives the deadline and checks it immediately before its external call.

The default lease lasts 30 seconds. The worker allows up to 24 seconds for the provider call, shortened to the time left in the send window. The lease leaves time to record the result. An exception, timeout or invalid receipt holds the action. An expired lease also goes on hold, including a crash just before the send. A late worker cannot record success after losing its lease. Lease fencing protects local state. The provider and transport evidence above covers the separate risk of a late external effect.

A definitive rejection stops the run. A provably unsent transient failure schedules another attempt. The default budget allows five claims, including the first. Exponential backoff starts at one second, uses jitter and caps its own delay at one minute. The worker also honors a longer valid provider delay. A rate limit pauses new claims for the affected tenant and connected account. Requests that another worker already claimed may still reach the provider. Reconciliation of a confirmed absence can authorize another claim after the automatic budget is spent.

## How the worker shares dispatch time

Each tenant and connected account pair has a delivery lane. Its first pending action puts it at the back of the queue of active lanes. A worker takes the oldest eligible lane’s turn, claims its earliest due action, and moves that lane to the back. If three accounts stay eligible and a single worker is available, each gets one claim in every three turns. A busy account can still have several provider calls in flight. A tenant with several connected accounts has several turns.

PostgreSQL maintains the pending count in the same transaction as each action that enters or leaves the queue. Empty lanes drop out of the partial turn index. The worker can seek to the first due action for a lane using the tenant, account, due time and action ID. If a lane is cooling down, its head is locked, or it has no eligible work, workers can try other lanes. When all lanes are delayed, eligibility can require one indexed lookup per active lane. Within a lane, the due-time index may also read an expired prefix to reach its first live action. The separate expiry sweep gradually removes that work. A single hot account also serializes short updates to its pending count. Those are the two places to inspect in a query plan if claim latency rises.

The worker holds the lane row lock only while claiming an action and assigning its next turn. Another worker can claim a different lane during that transaction. The email prompt opens its reply window in a separate transaction that checks the lease token. All database locks have been released when the adapter sends. On each pass the worker also retires at most one expired pending action, so cleanup can progress alongside current traffic.
