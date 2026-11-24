import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const local = args[0] === '--local';
const [image, revision] = args.slice(local ? 1 : 0);
assert.match(
  image ?? '',
  local ? /^[a-z0-9][a-z0-9./-]*:v[0-9]+\.[0-9]+\.[0-9]+$/ : /^[a-z0-9][a-z0-9./:-]*@sha256:[a-f0-9]{64}$/,
  local ? 'Pass the version tag loaded from the release archive.' : 'Pass a digest-pinned image.',
);
assert.match(revision ?? '', /^[a-f0-9]{40}$/, 'Pass the full Git revision.');

const suffix = randomBytes(5).toString('hex');
const project = `blotato-stage-${suffix}`;
const tenantId = `tenant-${suffix}`;
const accountId = `account-${suffix}`;
const participantId = 'synthetic-reader';
const commentId = 'synthetic-comment';
const controlToken = randomBytes(24).toString('hex');
const adapterToken = randomBytes(24).toString('hex');
const providerToken = randomBytes(24).toString('hex');
const cwd = fileURLToPath(new URL('./', import.meta.url));
const env = {
  ...process.env,
  STAGE_IMAGE: image,
  STAGE_DB_PASSWORD: randomBytes(24).toString('hex'),
  STAGE_TENANT_ID: tenantId,
  STAGE_ACCOUNT_ID: accountId,
  STAGE_CONTROL_TOKEN: controlToken,
  STAGE_ADAPTER_TOKEN: adapterToken,
  STAGE_PROVIDER_TOKEN: providerToken,
};

function docker(args, capture = false) {
  return execFileSync('docker', args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
  })?.trim();
}

const compose = (args, capture) => docker(['compose', '--env-file', '/dev/null', '-f', 'compose.stage.yaml', '-p', project, ...args], capture);
const inspect = (service, field) => docker(
  ['inspect', '--format', field, compose(['ps', '--all', '--quiet', service], true)],
  true,
);

function serviceUrl(service, port) {
  const address = compose(['port', service, String(port)], true);
  assert.match(address, /^127\.0\.0\.1:\d+$/, `${service} must use a loopback port.`);
  return `http://${address}`;
}

async function request(url, expected, token, body) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  if (body) headers['content-type'] = 'application/json';
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(3_000),
  });
  assert.equal(response.status, expected, `${new URL(url).pathname} returned HTTP ${response.status}`);
  return response.status === 204 ? undefined : response.json();
}

async function waitFor(description, condition) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await condition();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function exercise(provider) {
  let api = serviceUrl('api', 3000);
  const apiPath = () => `${api}/v1/tenants/${tenantId}`;
  const config = {
    accountId,
    keyword: 'pricing',
    publicReply: 'Sent you a DM!',
    emailPrompt: 'What email address should I use?',
    collectParticipantContext: true,
    linkUrl: 'https://example.org/pricing',
  };
  const event = (kind, objectId, text) => ({
    accountId, participantId, kind, objectId, text,
    platform: 'instagram', eventId: `event-${objectId}`, occurredAt: new Date().toISOString(),
  });
  const ingest = (body) => request(`${apiPath()}/adapter/events`, 200, adapterToken, body);

  await request(`${apiPath()}/automations`, 401, undefined, config);
  await request(`${apiPath()}/automations`, 403, adapterToken, config);
  await request(`${apiPath()}/automations`, 201, controlToken, config);

  const comment = event('comment', commentId, '  PRICING  ');
  const started = await ingest(comment);
  assert.equal(started.outcome, 'started');
  assert.match(started.runId, /^[a-f\d-]{36}$/);
  assert.equal((await ingest(comment)).outcome, 'duplicate');

  const status = () => request(`${apiPath()}/status?runId=${started.runId}`, 200, controlToken);
  const expectState = (state) => waitFor(`the run to reach ${state}`, async () => {
    const run = await status();
    assert.ok(!['failed', 'expired', 'uncertain'].includes(run.state), `Run stopped in ${run.state}`);
    return run.state === state ? run : undefined;
  });

  const waiting = await expectState('waiting');
  compose(['restart', 'api', 'worker']);
  api = serviceUrl('api', 3000);
  await waitFor('the restarted API', () =>
    fetch(`${api}/healthz`, { signal: AbortSignal.timeout(1_000) })
      .then((response) => response.ok, () => false));
  assert.deepEqual(await status(), waiting);
  assert.equal((await ingest(event('message', 'invalid-message', 'Can you send the price?'))).outcome, 'ignored');

  const reply = event('message', 'email-message', 'buyer@example.org');
  assert.equal((await ingest(reply)).outcome, 'accepted');
  assert.equal((await ingest(reply)).outcome, 'duplicate');
  const completed = await expectState('completed');
  const kinds = ['comment_reply', 'email_prompt', 'link_dm'];
  assert.deepEqual(
    completed.actions.map(({ kind, status, attempts }) => [kind, status, attempts]).sort(),
    kinds.map((kind) => [kind, 'sent', 1]).sort(),
  );
  assert.doesNotMatch(JSON.stringify(completed), /buyer@example\.org/);

  const historyUrl = `${apiPath()}/automations/${accountId}/participant-context`;
  const person = { participantId };
  await request(historyUrl, 403, adapterToken, person);
  const history = await request(historyUrl, 200, controlToken, person);
  assert.equal(history.interactions.length, 3);
  assert.deepEqual(history.runs.map((run) => run.runId), [started.runId]);
  assert.deepEqual(history.runs[0].actions.map((action) => action.kind), kinds);
  assert.ok(history.runs[0].actions.every((action) => action.status === 'sent' && action.acceptedAt));
  assert.doesNotMatch(JSON.stringify(history), /buyer@example\.org/);
  await request(`${historyUrl}/deletions`, 204, controlToken, person);
  assert.deepEqual(await request(historyUrl, 200, controlToken, person), { interactions: [], runs: [], truncated: false });

  const { total, records } = await request(`${provider}/records`, 200, providerToken);
  assert.equal(total, 3);
  assert.equal(records.length, 3);
  assert.equal(new Set(records.map(({ action }) => action.id)).size, 3);
  assert.deepEqual(records.map(({ action }) => action.text), [config.publicReply, config.emailPrompt, config.linkUrl]);
  for (const [index, { action, receipt }] of records.entries()) {
    assert.deepEqual(
      [action.kind, action.runId, action.tenantId, action.accountId, action.participantId, action.commentId],
      [kinds[index], started.runId, tenantId, accountId, participantId, commentId],
    );
    assert.equal(receipt, `fixture-${action.id}`);
  }
}

if (!local) docker(['pull', image]);
const imageId = docker(['image', 'inspect', '--format', '{{.Id}}', image], true);
const imageRevision = docker(['image', 'inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}', image], true);
assert.equal(imageRevision, revision, 'The runtime image must identify the tagged revision.');

let passed = false;
try {
  compose(['up', '--detach', '--no-build', '--wait', '--wait-timeout', '60']);
  for (const service of ['migrate', 'api', 'worker', 'provider']) {
    assert.equal(inspect(service, '{{.Image}}'), imageId, `${service} must run from the pulled image.`);
  }
  await exercise(serviceUrl('provider', 3001));
  assert.equal(inspect('worker', '{{.State.Running}}'), 'true');
  passed = true;
} finally {
  try {
    if (!passed) compose(['logs', '--no-color', '--tail', '40']);
  } finally {
    compose(['down', '--volumes', '--remove-orphans']);
  }
}

console.log(`Passed staged HTTP workflow and cleanup for ${image} (${process.arch}).`);
