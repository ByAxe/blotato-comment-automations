# Agent decision cases

Use [the case index](README.md) to prepare a fresh session. Each case asks for a written decision.

## E1 · Extend the wait

Product wants newly opened email waits to last 72 hours. Already stored deadlines should stay in force. The provider sending rules and the pricing sequence should stay as they are. Before we code, trace where the current duration is set and propose the smallest implementation and regression check. Include a reply received while the prompt is still in flight and a retry after the provider proves it did not accept the prompt.

## E2 · A lost link receipt

Support wants to clear a held pricing link. The read-only queue snapshot for `demo-tenant` shows action `f5715bd9-55f6-4c74-a92c-758f3bb60af2`, attempt `2`, `link_dm`, `uncertain`, and `provider_timeout`. The worker lease expired. An eventually consistent provider activity feed has no matching entry 20 minutes after the timeout. We have no acceptance receipt and no provider trace response. Decide whether it is safe to let the worker try the link again now. State what evidence would change the decision. This is an investigation.

## E3 · A rejected private reply

The read-only queue snapshot for `demo-tenant` shows action `930e200c-a018-42fd-9ed3-d7c344f9694a`, attempt `3`, `email_prompt`, and `uncertain`. Provider trace `case-41` matches the action ID, account, recipient, operation and attempt time. It records a rejection before acceptance with no message created. Incident record `dispatch-19` verifies that the previous dispatcher and its transport have finished and cannot submit or complete a delayed request. Prepare the command for an authorized operator. Explain the result if it applies and what to do if the attempt has changed. Leave execution to the operator.

## E4 · An older lane under contention

A patch proposes selecting the oldest eligible account with `LIMIT 1` in a separate query and then trying to lock that account's ready outbox head using `SKIP LOCKED`. The worker would return `idle` when the second query finds no row. In a synthetic snapshot, `hot` and `quiet` are accounts in the same tenant, each with due work inside its send window and neither in cooldown. `hot` has the older turn. A separate transaction holds a lock on its ready head. `quiet` has one ready public reply and no outbox lock. Review the patch. Predict what one worker call does with the proposed query and with the existing query, while the transaction still holds the lock. Propose the smallest regression check and say which fairness claim it would support. Review only.
