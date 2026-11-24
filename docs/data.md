# From a comment to a counted run

A comment can have several webhook deliveries. A run can have several outbound attempts. The conversion report counts each **run** once. Counting webhook deliveries, send attempts or unique Instagram users would answer different questions.

## Operational records

[![UML class diagram of the workflow tables. Each run pins one version, can reference up to three actions, and can have one buffered email and one lead. Each opted-in run can retain multiple interactions, each tied to one inbox receipt. Each action can have multiple reconciliation decisions, one per attempt. An account can have one delivery lane and one cooldown.](diagrams/data-model.svg)](diagrams/data-model.svg)

The UML class diagram shows selected columns and the multiplicities allowed by the schema. A version holds the customer’s published settings. Its revision number is local to the account. An optional source post ID narrows the rule to that post. Each run pins that version and the original comment. The inbox records inbound identities and any supplied comment post ID before the handler decides whether an event should start or advance a run. The deduplication keys include the tenant and connected account because two accounts can use the same external identifier.

A single transaction records the run and its first outbox action. Each later action has one row per run and action kind. Retries update this row. While the prompt outcome is pending, a qualified early response can occupy a temporary slot for that run. Acceptance of a qualified address creates the lead and the link action together. The report uses that action as evidence of capture, so removing the contact address alone preserves the count. [Operational schema](../db/001_core.sql)

| Table | Key or constraint |
| --- | --- |
| `automations`, `automation_versions` | One automation per `(tenant_id, account_id)`. Revisions are unique within that pair. The current version and any run's pinned version must belong to the same tenant and account. |
| `inbox` | Unique on `(tenant_id, account_id, event_id)` and separately on `(tenant_id, account_id, kind, object_id)`. |
| `runs` | One run per `(tenant_id, account_id, comment_id)`. A partial unique index allows one active run per `(tenant_id, account_id, participant_id)`. |
| `buffered_emails`, `leads` | `run_id` is both the primary key and a foreign key to the owning run. |
| `participant_interactions` | One excerpt per tenant, account and inbound event ID. References the inbox receipt and a run with the same tenant, account and participant. |
| `outbox` | Unique on `(run_id, kind)`. A trigger derives the tenant and account from the run for the lane head lookup. The three allowed kinds bound the number of actions. A leased row requires a token and deadline. A sent row requires a receipt and timestamp. |
| `delivery_lanes` | One lane per `(tenant_id, account_id)`. Outbox triggers update `pending_count` in the same transaction as membership changes. A claim advances `turn` to rotate among eligible lanes. |
| `delivery_cooldowns`, `delivery_reconciliations` | One cooldown per `(tenant_id, account_id)` and one decision per `(action_id, attempt)`. |

[Editable PlantUML source](diagrams/data-model.puml) · [Delivery schema](../db/002_delivery.sql) · [Scheduling lanes](../db/004_fair_delivery.sql) · [Post scope](../db/005_post_scope.sql)

## Participant context

A version can opt in with `collectParticipantContext`. Collection applies to new runs from that version. Versions and runs created before the context migration default to off. A run can retain its triggering comment and DMs that pass [reply correlation](integration.md#reply-correlation-and-delivery) within its active email wait after prompt acceptance, including questions that leave the wait open. The first qualifying DM received during a prompt attempt can stage an excerpt. That excerpt becomes visible when the prompt is accepted and the email is captured. A proven non-send discards the staged excerpt. The service replaces whitespace-delimited tokens containing `@` with `[redacted]` before limiting the excerpt to 500 Unicode code points. Other details a commenter volunteers can remain.

The scoped lookup returns up to 50 unexpired interactions ordered by provider occurrence time, newest first, with descending bytewise event ID as a tie-breaker. `truncated` is true when more matching rows are visible. Each item gives the event kind, event and object IDs, optional post ID, provider timestamp, excerpt, run ID, current run state and whether that event supplied the email captured by the run. The lookup returns one `runs` entry for each run represented by the returned interactions, ordered by first appearance. Each entry has the run’s current state and actions in workflow order. An action reports its kind, status and the time the database recorded provider acceptance, if any. The account-scoped control bearer governs access. The projection omits captured email addresses, outbound copy and provider receipts. [Context API](api.md#participant-context)

An interaction expires 30 days (720 hours) after its provider occurrence time. Lookups and prompt selection exclude expired rows, and the worker removes them. The control API can erase the retained excerpts for one participant within the connected account and stop further collection in their active run. Any outbound attempt that already selected its text can still complete. Erasure leaves the workflow, lead and buffered address intact. Existing inbox receipts prevent redelivery from rebuilding that history. [Context schema](../db/006_participant_context.sql) · [Context store](../src/participant-context.ts)

## The conversion report

`automation_daily_funnel` returns one row per tenant, connected account, configuration version and UTC day on which a run **started**. A run that starts Monday and completes Tuesday contributes its link to Monday. A provider event that occurred Monday but first starts a run on Tuesday belongs to Tuesday. This is a run-start cohort. Provider occurrence time serves reply correlation, while database timestamps describe processing.

| Measure | What counts |
| --- | --- |
| `started_runs` | Every run in the cohort, including one still waiting or already expired. |
| `public_replies_sent`, `email_prompts_sent`, `links_sent` | Runs with a confirmed provider acceptance for that action. Reading a DM or clicking its link requires separate evidence. |
| `emails_captured` | Runs with a link action. Two runs may supply the same address and both count. |
| `uncertain_runs` | Runs with a currently unresolved send. Reconciliation can reduce this count. |
| `failed_runs`, `expired_runs` | Runs currently in the corresponding terminal state. A failed link can still count as an email captured. |

The demo includes the funnel for its synthetic account. An analyst can run the following query in `psql` with variables `tenant`, `account` and `start_day` supplied by the caller. Summing both counts before dividing gives the capture rate across configuration revisions. A day with zero starts has no row.

```sql
SELECT cohort_day,
       sum(started_runs) AS started,
       sum(emails_captured) AS captured,
       round(100.0 * sum(emails_captured) / sum(started_runs), 1) AS capture_pct
FROM automation_daily_funnel
WHERE tenant_id = :'tenant'
  AND account_id = :'account'
  AND cohort_day >= :'start_day'::date
GROUP BY cohort_day
ORDER BY cohort_day;
```

One unique outbox key per run and kind bounds each of the three joins to one match. The cohort index supports a date range within one account. A query reads a consistent PostgreSQL snapshot, including reconciliations committed when that snapshot begins. A retried action can change its status many times without adding a second run. The view reads current facts, so replaying a report never adds to its previous totals. [Reporting SQL](../db/003_analytics.sql)

## Retention and access in production

The reference database contains synthetic inputs. The following controls are deployment decisions for real customer accounts.

- Keep participant excerpts and message bodies out of the analytics path. Restrict lead access to the owning tenant. Use a separate reporting credential with access only to authorized rows and aggregate columns. The view includes the tenant key for grouping. A caller-supplied filter alone cannot authorize a tenant.
- Agree on a lead retention period and purpose with the customer. Delete a buffered address as soon as the run consumes it or closes. A complete subject deletion should resolve the subject within the tenant and stop pending work before removing contacts, buffers and other subject-linked records. In-flight provider sends need reconciliation. Keep an erasure ledger restricted to the deletion service so it can reapply deletions after a backup restore.
- Keep deduplication receipts through the longest provider redelivery and operator replay windows. Reject events older than the supported replay horizon before dropping their receipts. Otherwise an old comment could start a new run. Scope any retained suppression key and expiry to the customer’s deletion policy. Removing a run also revises the report for its original day.
- Monitor age of the oldest ready action, time spent uncertain, expired waits and provider retry counts. Keep email, participant IDs and message content out of metric labels. Restricted run IDs can connect an operator’s investigation to one outbox row.

The [storage estimates](storage-and-sizing.md) cover the base workflow. Budget participant context separately based on opted-in traffic, excerpt sizes and retained rows.

An external warehouse can wait until report scans affect worker latency or customers need historical snapshots. At that point, export committed run and action changes, including deletions, from PostgreSQL in commit order. Deduplicate downstream by source key and commit position, advance the consumer checkpoint after its writes commit, and recompute the run’s original cohort. A nightly cross-check of starts, captures and accepted links against this view will expose missed updates. Exclude addresses and DM bodies from the export schema.
