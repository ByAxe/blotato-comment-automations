# Requirements and acceptance

Customers use comment-triggered automations to respond to people who comment on their social posts. An integration supplies authenticated events and performs social actions.

## Functional requirements

| ID | Requirement | Acceptance evidence |
| --- | --- | --- |
| FR-01 | Publish or update an automation for a connected account with a keyword, messages, and destination URL. Disabling the rule stops new runs. Edits apply to later runs. | E1, W1, W4 |
| FR-02 | Start a run when a new external comment on any supported post of the account matches the enabled keyword. Ignore self-authored events and nonmatches. | E1, W1 |
| FR-03 | For the pricing automation, reply publicly to the triggering comment with exactly `Sent you a DM!`. After acceptance, DM the commenter to request an email, then wait. | E1, W2 |
| FR-04 | Accept a qualifying email from the same commenter on the same account. Send the configured URL to that commenter. An invalid, unrelated, or late DM cannot send the URL. | E1, W4, W5 |
| FR-05 | Expose the run and per-action status. Mark it complete only after the provider accepts the final DM. Keep unsuccessful or unresolved actions visible. | E1, D2, D4 |
| FR-06 | Count starts, accepted sends, and email captures in the run's original UTC start cohort. Removing the captured address alone preserves the count. | A1 |
| FR-07 | Prevent known-unsent actions from dispatching after their send deadline. Keep an unknown send unresolved when its deadline elapses. | P1–P3 |

## Nonfunctional requirements

| ID | Requirement | Acceptance evidence |
| --- | --- | --- |
| NFR-01 | Preserve event identities, configuration, pending actions, and waiting runs across service and worker restarts. | E1, W4, D6 |
| NFR-02 | Deduplicate repeated comments and messages. Concurrent events for one conversation can start one active run and produce one logical action per step. | E1, W2, W3, W6 |
| NFR-03 | Retry confirmed transient non-sends within the attempt and time limits. Preserve unknown outcomes for reconciliation and fence off stale workers. | D1–D6, R1 |
| NFR-04 | Bind HTTP configuration, intake, and status to the configured tenant and account. Give control and adapter callers distinct credentials and enforce their route permissions. | E1 |
| NFR-05 | Keep raw email and credentials out of status responses and diagnostic output. Restrict production access to stored leads. | E1 checks that run status omits the address. Production access and retention require deployment controls. |
| NFR-06 | Run verification with the HTTP service, worker, PostgreSQL, and a recording provider. The portable verification configuration uses the same Compose command locally and in CI. | E1, `compose.yaml`, `.github/workflows/verify.yml` |
| NFR-07 | Trust the recovery CLI's database login and record it with each decision. Apply a decision only when the supplied tenant, action, attempt and unresolved state match. Operator role grants and per-tenant or per-account access controls are deployment responsibilities. | D4, D5, R1 |

## MVP behavior

- One current automation per tenant and connected account. Each publish creates an immutable version. Active runs keep their version and destination. The destination must be an absolute HTTPS URL without embedded credentials.
- Match the entire comment after trimming whitespace and lowercasing. ` PRICING ` matches `pricing`. `PRICING?` and `repricing` do not.
- Allow one active run per tenant, account, and commenter. A second matching comment returns a busy outcome. The inbox keeps its identity so a redelivery cannot start another run.
- Wait up to 24 hours from the prompt send attempt. The DM must occur and be durably received during that interval. Buffer an eligible early response pending prompt acceptance. A confirmed non-send discards that buffer and lets the next attempt open a fresh window.
- For standard Instagram feed posts, dispatch the public acknowledgement and private prompt before 168 hours have elapsed from comment creation. Dispatch the final DM before 24 hours have elapsed from the accepted response's provider timestamp. The adapter enforces any narrower provider limit.
- Accept one address-like token containing an `@` if it parses as a conventional ASCII email. Capture the accepted address as a lead. Invalid or ambiguous text leaves the wait open without another prompt.
- The prototype uses role-specific credentials for one configured tenant and account. Production requires the integration to authorize each actual connection and enforce the provider's messaging rules. The reference flow leaves lead access, retention, consent, and any support for multiple concurrent prompts to the product rollout.

## Executable acceptance

Each title below identifies an executable test. The HTTP test records outbound requests, holds acknowledgements to verify ordering, restarts the service and worker while the run is waiting, and checks that two concurrent valid replies produce one final DM.

| ID | File | Test name |
| --- | --- | --- |
| E1 | `test/e2e.test.ts` | the HTTP service resumes the Instagram pricing flow after both processes restart |
| W1 | `test/workflow.test.ts` | only an enabled, exact keyword from a customer starts a conversation |
| W2 | `test/workflow.test.ts` | redelivery and two competing comments create a single conversation and one first reply |
| W3 | `test/workflow.test.ts` | a reply received during the prompt send survives the acknowledgement race |
| W4 | `test/workflow.test.ts` | version edits affect later comments, while an existing wait uses its original link |
| W5 | `test/workflow.test.ts` | an expired wait ignores late email and releases the conversation for a new comment |
| W6 | `test/workflow.test.ts` | a definitively unsent prompt discards addresses buffered during that attempt |
| D1 | `test/delivery.test.ts` | a rate limit pauses the account, and another tenant can keep sending |
| D2 | `test/delivery.test.ts` | permanent rejection ends the run before the next message |
| D3 | `test/delivery.test.ts` | known-unsent retries stop at the configured attempt limit |
| D4 | `test/delivery.test.ts` | a lost provider receipt pauses delivery until an operator in the owning tenant confirms it |
| D5 | `test/delivery.test.ts` | confirmed absence allows one retry and an older decision cannot authorize a later attempt |
| D6 | `test/delivery.test.ts` | an expired worker cannot overwrite a reconciled receipt or create another prompt |
| A1 | `test/analytics.test.ts` | a late receipt updates the UTC start cohort and preserves counts after contact erasure |
| R1 | `test/recovery-cli.test.ts` | operator CLI records the login and both proofs before requeueing a held send |
| P1 | `test/window.test.ts` | a delayed comment cannot send a public reply past the original comment deadline |
| P2 | `test/window.test.ts` | a queued link keeps the response deadline and expires under backlog without a send |
| P3 | `test/window.test.ts` | a send deadline cannot turn an uncertain attempt into a known non-send |

Run `npm test` for the full suite or `npm run e2e` for E1. The recording provider verifies the local integration boundary. Live Instagram capability and delivery require separate verification.
