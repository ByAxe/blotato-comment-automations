# Participant history

A customer can keep a short history of a pricing conversation for their connected Instagram account. For example, a reader might reply “Does the team plan include five seats?” and later send an address. The account operator can see the question, the source message, whether the workflow accepted an address, and whether the provider accepted the pricing link. A future comment can receive a returning-customer email prompt. The reader still supplies an address in that new conversation before the link can be sent.

## Publish and read

Publish a rule version with `collectParticipantContext: true` to collect history for runs started under that version. Optionally set `returningEmailPrompt`, for example “Welcome back! Which email address should we use this time?” Omission or `false` for the collection flag keeps history off. A later publication governs new runs. Existing rules migrate with history off and historical contacts are never imported. See the [control API](api.md) for authenticated lookup and deletion requests.

Lookup takes an exact participant ID under the caller's authorized tenant and connected account. The result contains up to 50 **interactions**, newest first by provider occurrence time, with the event ID as a stable tie-breaker. Each entry points to its inbound event, provider object and run. Triggering comments also carry the available source post ID. The excerpt preserves the reader’s words up to 500 Unicode code points and replaces every whitespace-delimited token containing `@` with `[redacted]` before truncation. Other volunteered personal information can remain in the excerpt. Treat it as private, untrusted social content.

The **runs** list groups outgoing actions for the returned conversations in workflow order. Each action shows its current status and the UTC time the database recorded provider acceptance when available. Run state, captured-response facts and outbound statuses come from the same database snapshot. An accepted send proves provider acceptance. It takes additional evidence to establish that the recipient read the DM or visited the link. The response omits delivery receipts, destination URLs, stored addresses and outbound message bodies. `truncated: true` indicates that more than 50 visible interactions remain inside the retention period.

## Which interactions count

| Event | History |
| --- | --- |
| Matching external comment that starts an opted-in run | Store its excerpt with the source ID, occurrence time and pinned run. |
| Plain DM from that participant, or a DM explicitly replying to the active prompt, received during the accepted prompt’s wait | Store its excerpt, including questions and other nonqualifying replies. Only the DM that supplies the run’s qualifying address gets `emailAccepted: true`. |
| First qualifying DM while the matching prompt send is in flight | Stage a redacted excerpt in the same transaction as the workflow buffer. It becomes visible on prompt acceptance. A proven non-send discards it. |
| Self-authored event, duplicate, comment with a busy outcome, explicit reply to another or unverified target, or DM without an eligible scoped wait | No history entry. A DM after the conversation has completed falls outside the wait. |

An `emailAccepted` fact means the workflow received one syntactically valid address. The application has no evidence of address ownership or marketing consent. The returning prompt uses this fact only if the retained response came from the same scoped person in a different run and occurred by the new comment’s provider timestamp. At prompt arming, the worker checks the pinned rule and the evidence still available. An erased or expired interaction cannot select the returning copy. A retry after a proven non-send opens a new attempt and evaluates the evidence again. A send with an unknown outcome stays held for reconciliation.

## Retention and erasure

Each interaction expires 720 hours after its provider occurrence time. Reads and personalization exclude expired rows immediately. While running, the worker also removes expired rows in batches of up to 500, including hidden staged excerpts. Cleanup resumes after a worker restart. PostgreSQL transactions commit history with the corresponding workflow transition, and the inbox deduplicates both provider event and object identities. Delayed events use their own occurrence time for ordering and expiry.

Clearing one participant’s history deletes their stored interactions and stops collection for their current run. A conversation lock serializes the clear with ingest, prompt arming and send reconciliation. A prompt armed before the clear may already be in flight. Duplicate deliveries and a later acknowledgement of a previously buffered DM cannot rebuild erased history. A future matched comment can start a new opted-in run and new history. Clearing history leaves the operational contact address, workflow, identity receipts and delivery decisions under their own retention policies. A full subject-deletion or permanent opt-out request needs the deployment owner’s controls for those records, any downstream systems and restored backups. [Operational data and erasure](data.md#retention-and-access-in-production)
