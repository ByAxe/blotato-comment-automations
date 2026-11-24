# Example API

The example runs an HTTP API and a separate PostgreSQL-backed worker. The worker sends to a fake HTTP provider. The end-to-end test starts the API and worker, submits normalized events, and checks the recording provider across both process restarts.

## Run the pricing flow

From the repository root, start the disposable sandbox and wait for the API to respond.

```sh
docker compose -p comment-demo --profile sandbox up --build -d api worker
curl -fsS --retry 10 --retry-all-errors --retry-delay 1 http://127.0.0.1:3030/healthz
```

Run the example to publish the rule, submit a comment, wait for the email prompt, and reply. It generates distinct event and object IDs, uses the same participant for both events, and takes each timestamp when the event is sent. The script runs in the API container so it can also inspect the private recording provider.

```sh
docker compose -p comment-demo --profile sandbox exec -T api node scripts/try-pricing.mjs
```

The command prints the run ID, the completed state, and one provider receipt for each action. [Executable API example](../scripts/try-pricing.mjs)

The output includes the completed run, three sent actions, and the recorder's receipt for the link DM. Remove the disposable sandbox when finished.

```sh
docker compose -p comment-demo --profile sandbox down --volumes
```

## Process configuration

| Process | Required | Optional |
| --- | --- | --- |
| `npm run api` | `DATABASE_URL`, `DEMO_TENANT_ID`, `DEMO_ACCOUNT_ID`, `DEMO_CONTROL_TOKEN`, `DEMO_ADAPTER_TOKEN` | `HOST` defaults to `127.0.0.1`. `PORT` defaults to `3000`. Use `PORT=0` to bind an ephemeral port. |
| `npm run worker` | `DATABASE_URL`, `PROVIDER_URL`, `PROVIDER_TOKEN` | `WORKER_POLL_MS` defaults to `1000` and accepts `10` through `60000`. |

Apply the migrations to a disposable PostgreSQL database before starting the processes. Startup requires the workflow and delivery schema, including the fair delivery lanes from `004_fair_delivery.sql` and the post scope columns from `005_post_scope.sql`. The server then prints a JSON event named `listening` with the bound port, and the worker prints `worker_ready`. On `SIGINT` or `SIGTERM`, the API stops taking requests and drains active requests. The worker lets its current bounded iteration settle and exits.

## Authentication and scope

Send `Authorization: Bearer <token>` for all tenant routes. Configure distinct control and adapter tokens. Both credentials are bound to one configured tenant and one authorized connected account for this example. Tenant and account IDs use 1–255 URL-safe characters from letters, digits, `._~-` and exclude `.` and `..`. A request cannot establish account ownership by supplying an ID. The production application supplies an authenticated signed-in customer and proves authorization on the connected account for the control routes. The existing social adapter authenticates provider webhooks and derives the trusted account and participant mapping before calling ingress.

Use `Content-Type: application/json` on requests with a body. A JSON body is limited to 128 KiB and accepts only the fields shown below. Errors use a JSON object with an `error` string. The API returns `400 invalid_request` for invalid input, `401 unauthorized` for missing or invalid credentials, `403 forbidden` for the wrong credential scope, tenant, or account, `404 not_found` for an unavailable route or resource, `413 body_too_large` for an oversized body, and `415 unsupported_media_type` for an unsupported request content type.

## Routes

`GET /healthz` returns `200 {"ready":true}` when PostgreSQL is reachable and the required workflow, delivery, and post scope schema is visible to the API connection. It returns `503 {"ready":false}` when the connection or schema check fails.

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

The response is `201` with `{"versionId":"<uuid>"}`. The first version enables the automation. Later versions apply to future runs and preserve the current enabled flag. Every successful POST creates a new revision.

`PUT /v1/tenants/{tenantId}/automations/{accountId}/enabled` accepts a control token and `{"enabled":false}` or `{"enabled":true}`. Returns `204` for an existing automation. Disabling stops new runs. Existing runs continue on their captured version.

`POST /v1/tenants/{tenantId}/adapter/events` accepts an adapter token and a normalized comment or inbound message. Supply the provider's event and object IDs and UTC timestamp serialized as `YYYY-MM-DDTHH:mm:ss.sssZ`. The object ID identifies the source comment for `kind: "comment"` and the inbound message for `kind: "message"`. The participant ID identifies the same commenter across those events. The optional `isSelf` field defaults to false. Use the adapter's verified self/echo classification in production.

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

The output includes the run state and outbox statuses. Stored addresses, inbound text, participant identifiers, and provider response content are private.

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

For a manual run, start `node dist/scripts/recording-provider.js` with `PROVIDER_TOKEN`. It binds to `127.0.0.1:3001` by default. Override the binding with `PROVIDER_HOST` and `PROVIDER_PORT`. A port of `0` selects an ephemeral port reported by the `recording_provider_listening` event. Point the worker at the recorder's `/send` route. The recorder returns the same receipt for the same action and key and rejects a conflicting payload with `409`. Inspect its health with `GET /healthz` and its latest recordings with authenticated `GET /records?limit=100`. The response includes `total` and a `records` array of `{action, receipt}`. The recorder retains at most 1,000 synthetic sends in memory across worker restarts. Restarting the recorder clears them.
