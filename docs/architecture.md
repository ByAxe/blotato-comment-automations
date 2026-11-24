# Workflow architecture

A customer publishes a keyword, a public reply, an email prompt and a destination URL for a connected Instagram account. The rule can cover the whole account or one post. A matching comment starts one conversation. The service can stop for hours between the prompt and the reply. PostgreSQL holds the exact definition version, the step the conversation reached and the evidence needed to decide what may happen next.

[Runtime and state diagrams](diagrams.md) · [Product requirements](requirements.md) · [Tables and reporting grains](data.md) · [Production sizing and storage choice](storage-and-sizing.md) · [Modularity review](modularity.md)

## Where a transaction ends

| Operation | How the database commits it | What a caller can safely do afterward |
| --- | --- | --- |
| Publish | Lock the account's rule, append a version, update its current pointer. | New runs see the new text and URL. A run already in progress uses its pinned version. |
| Receive a comment | Lock the conversation, deduplicate the delivery and social object, match the enabled definition, insert a run and its public-reply intent. | The ingress API acknowledges the event. Redelivery finds the same identity even if the original HTTP response was lost. |
| Send an action | Lock the next eligible account queue, claim one due action, rotate the account's turn and commit. A prompt opens its response window in a second, fenced transaction. Call the adapter outside the transaction. In a new transaction, verify the token and settle the result together with the next state and intent. | Other workers can claim independent work during the HTTP call. Only the current lease can advance the run. |
| Receive an email | Lock the conversation, validate and consume at most one qualifying response, save the lead, set the next state and enqueue the link together. | A second response cannot create another link intent. |
| Resolve an unknown send | Lock the action in the owning tenant, check its attempt number, record the operator and evidence, then apply the decision. | A stale resolution cannot authorize a later attempt. |

These operations use PostgreSQL's default read-committed isolation. Advisory transaction locks serialize all state transitions concerning one person on one account. Row locks protect the version pointer and the delivery claim. Composite foreign keys, a partial unique index for the active conversation and a unique key for each run and action kind enforce the same invariants when several connections race. The queue uses `SKIP LOCKED` only to choose work. Its incomplete view of locked rows is appropriate there. [PostgreSQL transactions](https://www.postgresql.org/docs/17/tutorial-transactions.html) · [PostgreSQL locking reads](https://www.postgresql.org/docs/17/sql-select.html#SQL-FOR-UPDATE-SHARE)

## Early replies and uncertain sends

**Someone replies before the prompt acknowledgement arrives.** The worker records the prompt attempt boundary before it sends. An inbound DM carrying one eligible address can then be held against this run while the request is in flight. When the provider confirms the prompt, the same transaction consumes the buffered address and queues the link. A definitive non-send discards the buffer before a retry. An ambiguous result holds the run for reconciliation. A plain, unthreaded DM has no proof of causality. One active flow per person, account and tenant limits ambiguity, at the cost of skipping a second trigger from the same person.

**The provider accepted a send and the worker disappeared.** The database can guarantee one *intent*. It cannot undo a public reply, nor establish from a timeout whether anyone saw it. An expired lease therefore enters the same uncertain state as a lost provider acknowledgement. An operator with a provider receipt can settle the original action. Requeueing requires evidence of absence and evidence that the original request can no longer take effect. If neither is available the action can stay held or be abandoned with an audit record. [Recovery procedure](delivery-recovery.md)

The configured public message says `Sent you a DM!` before the private send. Preserving that sequence means a commenter can see the acknowledgement even when the prompt subsequently fails. The status endpoint shows both outcomes. A customer who wants different wording can publish a new version. Provider acceptance is the strongest delivery signal represented here. [Integration and provider windows](integration.md)

## Why PostgreSQL, and when to adopt Temporal

The first version has three outbound actions, one timer and a single kind of inbound response. The state fits in a short table, and a single transaction can update the lead, the run and its outbox. A waiting run needs no live process. PostgreSQL stores its state and deadline. API and worker processes scale separately, and a new worker can resume without reconstructing the state from logs. This choice puts the cost of maintaining the state machine, lease recovery, operator tooling and version rules on the application.

Temporal offers durable event history, replay, durable timers, Signals and independently retried Activities, with a TypeScript SDK. It becomes an attractive choice when customers need multiple waits, parallel branches, long-lived workflow-code migrations or compensation across services. For a migration, let new runs use a workflow ID derived from the subscribing tenant, rule and comment, send normalized inbound messages as Signals, and carry the same stable action IDs into Activities. Give the old engine ownership of its in-flight runs until they finish. Switching both engines onto the same account without a persisted ownership fence can send the same public reply twice. [Temporal workflow execution](https://docs.temporal.io/workflow-execution) · [Temporal message passing](https://docs.temporal.io/develop/typescript/message-passing) · [Temporal Activities and idempotency](https://docs.temporal.io/activity-definition)

Workflow replay would recover the orchestration state. An Activity can still call an external provider successfully and lose its completion acknowledgement. The adapter's idempotency and reconciliation contract matters with either engine. Likewise, redelivering a command through a broker would still require a durable transition and a way to handle that crash window.

## The next extension

Adding another platform starts at the adapter boundary. It needs stable event and object identities, a way to correlate a comment with a private sender, and an explicit send outcome. A platform that cannot initiate a private reply cannot enable this template. Multiple independent rules per connected account require a rule ID in trigger deduplication and an explicit conflict policy for an unthreaded reply. That product decision comes before exposing a rule builder.

The size and shape of the backlog determine when to split the single database. The capacity note gives the measured workload, how to recognize a hot tenant, and how a shard handoff would preserve the conversation lock and idempotency keys. [Capacity and recovery](capacity.md)
