---
name: reconcile-social-send
description: Investigate or resolve a held outbound reply or DM when a timeout, expired lease or missing provider acknowledgement leaves acceptance uncertain.
---

# Reconcile an uncertain social send

Read [Recovering an uncertain send](../../../docs/delivery-recovery.md) for exact CLI arguments and evidence fields. Identify the environment, tenant, action ID and current attempt from authorized read access or a supplied snapshot. Use the stable action ID to check the provider account, recipient, operation and time. Keep references opaque.

- Record `confirmed_sent` only with provider evidence that matches this action and an acceptance receipt.
- Record `confirmed_absent` only with affirmative evidence of non-acceptance and evidence that the old dispatcher and transport can no longer submit or complete the send. A lost acknowledgement, expired lease or missing item in an eventually consistent feed leaves it held.
- Use `abandon` when an authorized operator decides to end the run and the team has recorded the reason.

An investigation request authorizes a recommendation. Resolve an attempt only with explicit authorization to change that environment using the chosen decision. Use the guarded CLI, linked to an attributable operator login, instead of updating queue rows. If the guard cannot apply the decision, refresh the state and investigate the mismatch before any further change. If evidence is incomplete, describe what would resolve it and leave the attempt held.
