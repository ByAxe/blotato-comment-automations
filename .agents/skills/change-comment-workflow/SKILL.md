---
name: change-comment-workflow
description: Implement or review a behavior change to the comment-triggered workflow, including matching, reply correlation, wait deadlines, run transitions and outbound progression.
---

# Change the comment workflow

Locate the behavior and its acceptance scenario in [requirements and acceptance](../../../docs/requirements.md). Trace the affected input through `src/workflow.ts`, the constraints in `db/001_core.sql`, and the worker in `src/delivery.ts` if it crosses a send boundary. Check the contract with `src/http.ts` when the event shape or customer-visible state changes.

The run pins the configuration version and reserves the tenant, account and participant conversation. Each inbound event has a durable identity. Each next action commits with the transition that creates it. Preserve the public reply → private email prompt → qualifying response → link order unless the behavior change explicitly revises it. Provider acceptance advances the relevant send step.

For a response timing change, distinguish provider occurrence time from durable receipt time. An eligible reply can arrive while the prompt is in flight. Its capture depends on acceptance of that attempt. A retry after proven non-acceptance opens a new wait and clears the earlier buffer.

Choose a scenario that can distinguish the proposed behavior from the current behavior. Reuse the closest workflow or delivery fixture. Assert observable outcomes such as the run state, action sequence and recipient. Include replay, expiry or restart only when the changed path can behave differently under that condition. Record the result of the focused check and the external behavior it leaves for provider verification.
