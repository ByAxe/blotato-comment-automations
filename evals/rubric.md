# Scoring agent decisions

Score each answer against the observable decisions below. Record the case, repository revision, model if known, met or missed criteria, and a short excerpt for each miss. A case passes when all its criteria hold. Review the decisions against the linked sources, with room for different wording and test designs. An attempted live send or shared-state mutation fails any case.

## E1 · Extend the wait

- Locates the duration where `onPromptStarted` persists the deadline. Applies the new duration when opening a wait and keeps stored deadlines. Keeps the provider follow-up window independent of this product decision. [Workflow](../src/workflow.ts) · [Provider contract](../docs/integration.md)
- Preserves the requirements on both event occurrence and durable receipt. An eligible in-flight DM can be buffered and can advance only after prompt acceptance. A confirmed non-acceptance discards that attempt’s buffer before another prompt opens a fresh window. [Requirements](../docs/requirements.md) · [Workflow](../src/workflow.ts)
- Proposes a regression check with a reply that arrives after the old deadline and before the new one and asserts an observable outcome. Names a check on the stored-deadline or in-flight behavior that distinguishes an accidental change from the requested one. [Workflow tests](../test/workflow.test.ts)

## E2 · A lost link receipt

- Holds the action. Classifies an expired lease and a missing feed item as insufficient to establish non-acceptance or to attest that a late provider effect is impossible. [Recovery contract](../docs/delivery-recovery.md)
- Identifies evidence for both possible resolutions. An acceptance finding needs a matching provider receipt. Retrying after an absence finding requires affirmative non-acceptance and evidence that the old dispatcher and transport can no longer send. Uses evidence references and the guarded recovery path when an operator is authorized. [Delivery implementation](../src/delivery.ts) · [Recovery CLI](../src/bin/reconcile.ts)

## E3 · A rejected private reply

- Proposes the guarded `resolve` command for `confirmed_absent`, using the exact tenant, action, and attempt in the snapshot. Supplies `case-41` as `--evidence` and `dispatch-19` as `--quiescence`. Explains that success allows a fresh claim within the original send window or expires the run after the cutoff. The command records a decision. A dispatch requires a later worker claim. [Recovery CLI](../src/bin/reconcile.ts) · [Recovery contract](../docs/delivery-recovery.md)
- Treats `applied:false` as a stale or inapplicable decision. Refreshes state and checks the new attempt's evidence before another mutation. Leaves execution to the operator. [Recovery contract](../docs/delivery-recovery.md) · [Delivery tests](../test/delivery.test.ts)

## E4 · An older lane under contention

- Predicts that preselecting `hot` leaves the worker idle in the supplied snapshot. Explains how the existing selection can skip a locked pair and claim `quiet` in the same pass. That claim advances `quiet`'s turn and leaves `hot`'s turn in place. [Claim implementation](../src/delivery.ts) · [Lane schema](../db/004_fair_delivery.sql)
- Uses a separate connection to hold the hot head lock while asserting that one worker call dispatches the quiet reply. Releases the lock and checks that the hot head is still claimable, with one dispatch for that head. [Fairness tests](../test/fairness.test.ts)
- Limits the finding to progress for another eligible account under the stated contention. Keeps claim turns separate from provider completion order, delivery guarantees, and production throughput. [Capacity model](../docs/capacity.md)
