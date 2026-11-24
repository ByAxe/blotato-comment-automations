import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const api = 'http://127.0.0.1:3000/v1/tenants/studio';
const accountId = 'studio-ig';
const control = 'local-control';
const ingress = 'local-ingress';
const linkUrl = 'https://example.com/pricing';

async function request(url, token, method = 'GET', body) {
  const response = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(method + ' ' + url + ' returned ' + response.status);
  return response.status === 204 ? undefined : response.json();
}

const rule = await request(api + '/automations', control, 'POST', {
  accountId, keyword: 'pricing', publicReply: 'Sent you a DM!',
  emailPrompt: 'What email address should I use?', linkUrl,
});
await request(api + '/automations/' + accountId + '/enabled', control, 'PUT', { enabled: true });

const participantId = randomUUID();
function submit(kind, text) {
  return request(api + '/adapter/events', ingress, 'POST', {
    accountId, participantId, kind, text, platform: 'instagram',
    eventId: randomUUID(), objectId: randomUUID(), occurredAt: new Date().toISOString(),
  });
}

const comment = await submit('comment', 'pricing');
assert.equal(comment.outcome, 'started');
assert.ok(comment.runId);
const statusUrl = api + '/status?runId=' + comment.runId;

async function waitFor(state) {
  const deadline = Date.now() + 15_000;
  let run;
  do {
    run = await request(statusUrl, control);
    if (run.state === state) return run;
    if (run.state === 'failed' || run.state === 'expired') break;
    if (run.actions.some(({ status }) => status === 'failed' || status === 'uncertain')) break;
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error('Expected ' + state + ', observed ' + JSON.stringify(run));
}

await waitFor('waiting');
assert.equal((await submit('message', 'reviewer@example.com')).outcome, 'accepted');
const run = await waitFor('completed');
assert.deepEqual(run.actions.map(({ kind, status }) => [kind, status]), [
  ['comment_reply', 'sent'], ['email_prompt', 'sent'], ['link_dm', 'sent'],
]);

const { records } = await request('http://provider:3001/records', 'local-provider');
const sent = records.filter(({ action }) => action.runId === run.id);
assert.deepEqual(sent.map(({ action }) => action.kind), ['comment_reply', 'email_prompt', 'link_dm']);
assert.equal(sent[2].action.text, linkUrl);
assert.ok(sent.every(({ receipt }) => typeof receipt === 'string' && receipt.length > 0));
console.log(JSON.stringify({
  versionId: rule.versionId,
  runId: run.id,
  state: run.state,
  providerReceipts: sent.map(({ action, receipt }) => ({ kind: action.kind, receipt })),
}, null, 2));
