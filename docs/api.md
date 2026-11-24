# Example API

The example runs an HTTP API and a separate PostgreSQL-backed worker. The worker sends to a fake HTTP provider. The end-to-end test starts the API and worker, submits normalized events, and checks the recording provider across both process restarts.

## Run the pricing flow

From the repository root, start the disposable sandbox and wait for the API to respond.

```sh
make sandbox-up
```

Run the example to publish the rule, submit a comment, wait for the email prompt, and reply. It generates distinct event and object IDs, uses the same participant for both events, and takes each timestamp when the event is sent. The script runs in the API container so it can also inspect the private recording provider.

```sh
make sandbox-demo
```

The command prints the run ID, the completed state, and one provider receipt for each action. [Executable API example](../examples/try-pricing.mjs)

Remove the disposable sandbox when finished.

```sh
make sandbox-down
```

## Process configuration

| Process | Required | Optional |
| --- | --- | --- |
| `npm run api` | `DATABASE_URL`, `DEMO_TENANT_ID`, `DEMO_ACCOUNT_ID`, `DEMO_CONTROL_TOKEN`, `DEMO_ADAPTER_TOKEN` | `HOST` defaults to `127.0.0.1`. `PORT` defaults to `3000`. Use `PORT=0` to bind an ephemeral port. |
| `npm run worker` | `DATABASE_URL`, `PROVIDER_URL`, `PROVIDER_TOKEN` | `WORKER_POLL_MS` defaults to `1000` and accepts `10` through `60000`. |

Apply the migrations to a disposable PostgreSQL database before starting the processes. Startup requires the schema through `006_participant_context.sql`, including the new history table and collection settings. Existing rules and runs upgrade with collection off and an empty history. The server then prints a JSON event named `listening` with the bound port, and the worker prints `worker_ready`. On `SIGINT` or `SIGTERM`, the API stops taking requests and drains active requests. The worker lets its current bounded iteration settle and exits.

## Authentication and scope

Send `Authorization: Bearer <token>` for all tenant routes. Configure distinct control and adapter tokens. Both credentials are bound to one configured tenant and one authorized connected account for this example. Tenant and account IDs use 1–255 URL-safe characters from letters, digits, `._~-` and exclude `.` and `..`. A request cannot establish account ownership by supplying an ID. The production application supplies an authenticated signed-in customer and proves authorization on the connected account for the control routes. The existing social adapter authenticates provider webhooks and derives the trusted account and participant mapping before calling ingress.

Use `Content-Type: application/json` on requests with a body. A JSON body is limited to 128 KiB and accepts only the fields shown below. Errors use a JSON object with an `error` string. The API returns `400 invalid_request` for invalid input, `401 unauthorized` for missing or invalid credentials, `403 forbidden` for the wrong credential scope, tenant, or account, `404 not_found` for an unavailable route or resource, `413 body_too_large` for an oversized body, and `415 unsupported_media_type` for an unsupported request content type.

## Routes

`GET /healthz` returns `200 {"ready":true}` when PostgreSQL is reachable and the required workflow, delivery, and participant context schema is visible to the API connection. It returns `503 {"ready":false}` when the connection or schema check fails.

`POST /v1/tenants/{tenantId}/automations` accepts a control token and publishes a new configuration version.

```json
{
  "accountId": "studio-ig",
  "keyword": "pricing",
  "publicReply": "Sent you a DM!",
  "emailPrompt": "What email address should I use?",
  "linkUrl": "https://example.com/pricing"
}
```

The optional `postId` field limits the rule to one provider post. Omit it or send `null` to match comments on any supported post of the account. Use a nonblank string up to 255 characters for a specific post. IDs match exactly, including case and surrounding whitespace.

Set `collectParticipantContext` to `true` to retain interaction history for new runs started under this version. It defaults to `false`. Collection can be enabled with the regular `emailPrompt` alone. To customize the email request for a returning commenter, also supply `returningEmailPrompt` as a nonblank string up to 2,000 characters. The worker chooses that copy when it prepares the prompt and finds an unexpired email response previously accepted from the same commenter in the account, dated at or before the new comment. Omit the custom prompt or send `null` to use `emailPrompt` for everyone. Every run still waits for a qualifying email response before sending the link.

The response is `201` with `{"versionId":"<uuid>"}`. The first version enables the automation. Later versions apply to future runs and preserve the current enabled flag. Every successful POST creates a new revision.

`PUT /v1/tenants/{tenantId}/automations/{accountId}/enabled` accepts a control token and `{"enabled":false}` or `{"enabled":true}`. Returns `204` for an existing automation. Disabling stops new runs. Existing runs continue on their captured version.

`POST /v1/tenants/{tenantId}/adapter/events` accepts an adapter token and a normalized comment or inbound message. Supply the bound `accountId`, `platform: "instagram"`, and `text` (up to 16,000 UTF-16 code units). Use provider IDs for `eventId` and `objectId`, and serialize `occurredAt` in UTC as `YYYY-MM-DDTHH:mm:ss.sssZ`. The object ID identifies the source comment for `kind: "comment"` and the inbound message for `kind: "message"`. Use the same `participantId` for the commenter across those events. The optional `isSelf` field defaults to false. Use the adapter's verified self/echo classification in production.

For comments, supply the provider's source post ID as `postId` when available. Use the same format as the publish field. A missing, null, or different post ID yields `ignored` when the rule is scoped to a particular post. Omit `postId` on inbound messages.

The response is `200` with `{"outcome":"started","runId":"<uuid>"}` for a matching comment that starts a run. The `busy`, `buffered`, and `accepted` outcomes carry the affected run ID. The `ignored` and `duplicate` outcomes return `"runId":null`. Use the actual timestamp from the provider on each event. An inbound message dated before the prompt attempt or after the receipt cannot advance the flow.

`GET /v1/tenants/{tenantId}/status?runId={uuid}` accepts a control token and returns the run for the bound tenant and account.

```json
{
  "id": "<uuid>",
  "accountId": "studio-ig",
  "state": "waiting",
  "actions": [
    { "kind": "comment_reply", "status": "sent", "attempts": 1 },
    { "kind": "email_prompt", "status": "sent", "attempts": 1 }
  ]
}
```

The output includes the run state and outbox statuses. This response omits stored addresses, inbound text, participant identifiers, and provider response content.

### Participant context

`POST /v1/tenants/{tenantId}/automations/{accountId}/participant-context` retrieves history for a single commenter. Send a control token and `{"participantId":"instagram-reader"}` in the JSON body. Use the exact participant ID supplied by the adapter on ingress. The API resolves it within the credential's authorized tenant and account. Both context routes send `Cache-Control: no-store`.

```json
{
  "interactions": [
    {
      "kind": "comment",
      "eventId": "webhook-comment-1",
      "objectId": "comment-1",
      "postId": "post-1",
      "occurredAt": "2026-01-15T12:00:00.000Z",
      "excerpt": "pricing",
      "runId": "<uuid>",
      "runState": "waiting",
      "emailAccepted": false
    }
  ],
  "runs": [
    {
      "runId": "<uuid>",
      "state": "waiting",
      "actions": [
        { "kind": "comment_reply", "status": "sent", "acceptedAt": "2026-01-15T12:00:01.000Z" },
        { "kind": "email_prompt", "status": "sent", "acceptedAt": "2026-01-15T12:00:02.000Z" }
      ]
    }
  ],
  "truncated": false
}
```

History includes comments that started opted-in runs and in-window replies received while those runs are waiting for an email. The first qualifying response received during a prompt attempt becomes visible after the provider accepts the prompt. A confirmed non-send discards its staged response. Each record expires 30 days after its provider timestamp. The worker deletes expired records in batches.

The response is `200` with up to 50 unexpired interactions, sorted by provider timestamp and then event ID, both descending. `truncated` is true when more interactions are available. Comments can have a null `postId`. Inbound messages always have a null `postId`. Each excerpt contains up to 500 Unicode code points, with tokens containing `@` replaced by `[redacted]`. Treat the lookup response as private customer data. `runState` reflects the current run state. `emailAccepted` is true for the DM that supplied the captured address.

`runs` includes a summary for each distinct run represented in the returned interactions. Each summary contains the current run state and up to three outbound actions in workflow order. `acceptedAt` records when the worker or operator stored confirmed provider acceptance, and is null while acceptance is unknown or the action is unsent. Outbound text and provider receipts stay private. A commenter with no retained interactions returns `{"interactions":[],"runs":[],"truncated":false}`.

`POST /v1/tenants/{tenantId}/automations/{accountId}/participant-context/deletions` accepts the same control credential and JSON body. It erases retained context for the commenter in the authorized account and returns `204` even if there was no matching history. An active run stops collecting context and uses the regular prompt if the worker has yet to prepare a send. A previously prepared send may still reach the provider. This route erases the history only. Operational runs, temporary response buffers, and captured leads keep their existing lifecycles. A later opted-in run can build new context from a new interaction.

## Fake provider

The worker sends `POST` to the configured fixture URL with a separate bearer credential. The request header `Idempotency-Key` equals the logical action UUID. The JSON contains `id`, `runId`, `tenantId`, `accountId`, `participantId`, `commentId`, `kind`, `text`, and `sendBefore`. The three kinds are `comment_reply`, `email_prompt`, and `link_dm`. The `sendBefore` field is an absolute UTC deadline serialized in the same format as `occurredAt`. A production adapter must enforce it at the send boundary. The email supplied to ingress is never included in the outbound action.

| Fixture response | Worker interpretation |
| --- | --- |
| `200` with `Content-Type: application/json` and an opaque `{"receipt":"fake-receipt-1"}` | Accepted. |
| `410` | Known non-acceptance. The send window expired. |
| `429` with an optional `Retry-After` in integer seconds | Known non-acceptance. Retry according to backoff and the supplied delay. |
| `400`, `403`, or `422` | Known non-acceptance. Terminal rejection. |
| Timeout, redirect, connection failure, invalid receipt, or any other status | Acceptance uncertain. The outbox keeps the action for operator reconciliation. |

A fixture receipt uses at most 256 characters from letters, digits and `._:-`. The response body is limited to 1 KiB. Fixture statuses certify delivery outcomes only under this contract. A production adapter needs provider-specific evidence before classifying any response as a known non-acceptance.

After a confirmed non-send, a retry uses the same logical action ID and can use the regular prompt if the earlier context has expired or been deleted. A production adapter must support this for known non-sends. Unresolved attempts wait for reconciliation.

For a manual run, start `node dist/examples/recording-provider.js` with `PROVIDER_TOKEN`. It binds to `127.0.0.1:3001` by default. Override the binding with `PROVIDER_HOST` and `PROVIDER_PORT`. A port of `0` selects an ephemeral port reported by the `recording_provider_listening` event. Point the worker at the recorder's `/send` route. The recorder returns the same receipt for the same action and key and rejects a conflicting payload with `409`. Inspect its health with `GET /healthz` and its latest recordings with authenticated `GET /records?limit=100`. The response includes `total` and a `records` array of `{action, receipt}`. The recorder retains at most 1,000 synthetic sends in memory across worker restarts. Restarting the recorder clears them.
