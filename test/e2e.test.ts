import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const waitMs = 5_000;

async function waitFor<T>(description: string, observe: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + waitMs;
  do {
    const result = await observe();
    if (result !== undefined) return result;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}.`);
}

function startProcess(entry: 'server' | 'worker', env: NodeJS.ProcessEnv) {
  const script = fileURLToPath(new URL(`../scripts/${entry}.js`, import.meta.url));
  const child = spawn(process.execPath, [script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines: string[] = [];
  const events = new Map<string, Record<string, unknown>>();
  let exit: string | undefined;

  function log(line: string) {
    lines.push(line);
    if (lines.length > 30) lines.shift();
  }

  createInterface({ input: child.stdout }).on('line', (line: string) => {
    log(line);
    try {
      const value = JSON.parse(line) as Record<string, unknown> | null;
      if (value && typeof value.event === 'string') events.set(value.event, value);
    } catch {
      // The captured output is still useful if the process wrote plain text.
    }
  });
  createInterface({ input: child.stderr }).on('line', log);
  child.once('error', (error) => { exit = error.message; });
  const closed = new Promise<true>((resolve) => {
    child.once('close', (code, signal) => {
      exit ??= `code=${code}, signal=${signal}`;
      resolve(true);
    });
  });

  function assertRunning() {
    assert.equal(exit, undefined, `${entry} exited unexpectedly (${exit})`);
  }

  return {
    details: () => ({ entry, exit, lines }),
    assertRunning,
    ready(event: string) {
      return waitFor(`${entry} readiness event ${event}`, () => {
        assertRunning();
        return events.get(event);
      });
    },
    async stop() {
      if (exit === undefined) child.kill('SIGTERM');
      const graceful = await Promise.race([closed, delay(3_000, false, { ref: false })]);
      if (!graceful) {
        child.kill('SIGKILL');
        await closed;
        throw new Error(`${entry} did not stop after SIGTERM.`);
      }
    },
  };
}

type ActionKind = 'comment_reply' | 'email_prompt' | 'link_dm';
type Action = {
  id: string;
  runId: string;
  tenantId: string;
  accountId: string;
  participantId: string;
  commentId: string;
  kind: ActionKind;
  text: string;
  sendBefore: string;
};

function hoursAfter(timestamp: string, hours: number) {
  return new Date(Date.parse(timestamp) + hours * 3_600_000).toISOString();
}

async function recordingProvider(token: string) {
  const requests: Action[] = [];
  const acceptedIds: string[] = [];
  const errors: string[] = [];
  const replyAcceptance = Promise.withResolvers<void>();
  const linkAcceptance = Promise.withResolvers<void>();

  async function handle(request: IncomingMessage, response: ServerResponse) {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/actions');
    assert.ok(request.headers.authorization === `Bearer ${token}`, 'Expected the provider fixture credential.');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const action = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Action;
    assert.match(action.id, /^[\da-f-]{36}$/i);
    assert.equal(request.headers['idempotency-key'], action.id);
    const cutoff = Date.parse(action.sendBefore);
    assert.ok(Number.isFinite(cutoff) && new Date(cutoff).toISOString() === action.sendBefore);
    requests.push(action);
    if (action.kind === 'comment_reply') await replyAcceptance.promise;
    if (action.kind === 'link_dm') await linkAcceptance.promise;
    if (Date.now() >= cutoff) {
      response.writeHead(410, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'window_expired' }));
      return;
    }
    acceptedIds.push(action.id);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ receipt: `fake-${action.id}` }));
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      errors.push(String(error));
      response.writeHead(500).end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    requests,
    acceptedIds,
    errors,
    acceptReply: replyAcceptance.resolve,
    acceptLink: linkAcceptance.resolve,
    url: `http://127.0.0.1:${address.port}/actions`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

type EventResult = { outcome: string; runId: string | null };
type Status = { id: string; accountId: string; state: string; actions: { kind: ActionKind; status: string; attempts: number }[] };

test('the HTTP service resumes the Instagram pricing flow after both processes restart', { timeout: 45_000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, 'Set DATABASE_URL to a fresh database with the migrations applied.');
  const tenantId = `e2e-${randomUUID()}`;
  const controlToken = randomUUID();
  const adapterToken = randomUUID();
  const providerToken = randomUUID();
  const config = {
    accountId: 'instagram-business',
    keyword: 'pricing',
    publicReply: 'Sent you a DM!',
    emailPrompt: 'What email address should I use?',
    linkUrl: 'https://example.org/pricing',
  };
  const participantId = 'instagram-reader';
  const commentId = 'comment-on-new-post';
  const provider = await recordingProvider(providerToken);
  const processes: ReturnType<typeof startProcess>[] = [];
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: '0',
    DEMO_TENANT_ID: tenantId,
    DEMO_ACCOUNT_ID: config.accountId,
    DEMO_CONTROL_TOKEN: controlToken,
    DEMO_ADAPTER_TOKEN: adapterToken,
    PROVIDER_URL: provider.url,
    PROVIDER_TOKEN: providerToken,
    WORKER_POLL_MS: '25',
  };

  t.after(async () => {
    provider.acceptReply();
    provider.acceptLink();
    try {
      await Promise.all(processes.map((process) => process.stop()));
    } finally {
      await provider.close();
    }
  });

  async function launch() {
    const server = startProcess('server', env);
    const worker = startProcess('worker', env);
    processes.push(server, worker);
    const [binding] = await Promise.all([server.ready('listening'), worker.ready('worker_ready')]);
    assert.ok(typeof binding.port === 'number' && Number.isInteger(binding.port) && binding.port > 0);
    return { server, worker, url: `http://127.0.0.1:${binding.port}` };
  }

  const tenantPath = `/v1/tenants/${tenantId}`;
  let runtime: Awaited<ReturnType<typeof launch>>;
  let lastStatus: Status | undefined;

  async function request<T>(path: string, token: string, expectedStatus: number, body?: object): Promise<T> {
    runtime.server.assertRunning();
    const response = await fetch(`${runtime.url}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, ...(body && { 'content-type': 'application/json' }) },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(2_000),
    });
    const responseBody = await response.text();
    assert.equal(response.status, expectedStatus, `${path}: ${responseBody}`);
    return JSON.parse(responseBody) as T;
  }

  const publishPath = `${tenantPath}/automations`;
  const ingestPath = `${tenantPath}/adapter/events`;
  const publish = (configuration: typeof config & { postId?: string | null }, token: string, status: number) =>
    request<{ versionId: string }>(publishPath, token, status, configuration);
  const ingest = (event: object) => request<EventResult>(ingestPath, adapterToken, 200, event);
  const status = (runId: string) => request<Status>(`${tenantPath}/status?runId=${runId}`, controlToken, 200);

  function expectState(runId: string, state: string) {
    return waitFor(`run ${runId} to become ${state}`, async () => {
      runtime.worker.assertRunning();
      assert.deepEqual(provider.errors, []);
      lastStatus = await status(runId);
      assert.ok(!['failed', 'expired'].includes(lastStatus.state));
      return lastStatus.state === state ? lastStatus : undefined;
    });
  }

  function expectRequest(kind: ActionKind) {
    return waitFor(`worker to send ${kind}`, () => {
      runtime.worker.assertRunning();
      assert.deepEqual(provider.errors, []);
      return provider.requests.find((action) => action.kind === kind);
    });
  }

  function message(objectId: string, text: string, sender = participantId) {
    return {
      accountId: config.accountId,
      participantId: sender,
      eventId: `webhook-${objectId}`,
      objectId,
      kind: 'message',
      platform: 'instagram',
      text,
      occurredAt: new Date().toISOString(),
    };
  }

  try {
    runtime = await launch();
    await publish(config, adapterToken, 403);
    await publish({ ...config, accountId: 'another-account' }, controlToken, 403);
    assert.ok((await publish(config, controlToken, 201)).versionId);

    const comment = {
      ...message(commentId, '  PRICING  '),
      kind: 'comment',
    };
    const { runId, outcome } = await ingest(comment);
    assert.equal(outcome, 'started');
    assert.ok(runId);
    const target = { runId, tenantId, accountId: config.accountId, participantId, commentId };
    const initialSendBefore = hoursAfter(comment.occurredAt, 168);
    const expectedActions = [
      { ...target, kind: 'comment_reply', text: config.publicReply, sendBefore: initialSendBefore },
      { ...target, kind: 'email_prompt', text: config.emailPrompt, sendBefore: initialSendBefore },
    ];
    const observedActions = () => provider.requests.map(({ id: _id, ...action }) => action);

    await expectRequest('comment_reply');
    const replying = await status(runId);
    assert.equal(replying.state, 'reply_pending');
    assert.deepEqual(replying.actions, [{ kind: 'comment_reply', status: 'leased', attempts: 1 }]);
    assert.deepEqual(observedActions(), expectedActions.slice(0, 1));
    provider.acceptReply();

    const waiting = await expectState(runId, 'waiting');
    assert.equal(waiting.id, runId);
    assert.deepEqual(observedActions(), expectedActions);
    assert.equal((await ingest(comment)).outcome, 'duplicate');

    const earlyReply = message('first-email', 'buyer@example.org');
    await Promise.all([runtime.server.stop(), runtime.worker.stop()]);
    runtime = await launch();
    assert.deepEqual(await status(runId), waiting);
    assert.equal((await ingest({ ...comment, eventId: 'redelivered-comment' })).outcome, 'duplicate');
    assert.equal((await ingest(message('invalid-dm', 'I would like the price'))).outcome, 'ignored');
    assert.equal((await ingest(message('wrong-reader-dm', 'someone@example.org', 'another-reader'))).outcome, 'ignored');
    assert.deepEqual(await status(runId), waiting);
    assert.deepEqual(observedActions(), expectedActions);

    const replies = [earlyReply, message('second-email', 'buyer2@example.org')];
    const results = await Promise.all(replies.map(ingest));
    assert.deepEqual(results.map((result) => result.outcome).sort(), ['accepted', 'ignored']);
    const acceptedIndex = results.findIndex((result) => result.outcome === 'accepted');
    assert.equal(results[acceptedIndex]?.runId, runId);
    const acceptedReply = replies[acceptedIndex]!;
    assert.equal((await ingest(acceptedReply)).outcome, 'duplicate');
    assert.equal((await ingest({ ...acceptedReply, eventId: 'redelivered-email' })).outcome, 'duplicate');

    const linkAction = { ...target, kind: 'link_dm', text: config.linkUrl, sendBefore: hoursAfter(acceptedReply.occurredAt, 24) };
    await expectRequest('link_dm');
    assert.equal((await status(runId)).state, 'link_pending');
    assert.deepEqual(observedActions(), [...expectedActions, linkAction]);
    provider.acceptLink();

    const completed = await expectState(runId, 'completed');
    assert.equal(completed.id, runId);
    assert.equal(completed.accountId, config.accountId);
    assert.deepEqual(Object.fromEntries(completed.actions.map(({ kind, status, attempts }) => [kind, { status, attempts }])), {
      comment_reply: { status: 'sent', attempts: 1 },
      email_prompt: { status: 'sent', attempts: 1 },
      link_dm: { status: 'sent', attempts: 1 },
    });
    assert.doesNotMatch(JSON.stringify(completed), /buyer2?@example\.org/);
    assert.equal((await ingest(acceptedReply)).outcome, 'duplicate');
    assert.deepEqual(await status(runId), completed);
    await request(`/v1/tenants/${tenantId}-other/status?runId=${runId}`, controlToken, 403);
    await request(`${tenantPath}/status?runId=${runId}`, adapterToken, 403);
    assert.deepEqual(provider.errors, []);
    assert.deepEqual(observedActions(), [...expectedActions, linkAction]);
    const requestedIds = provider.requests.map(({ id }) => id);
    assert.equal(new Set(requestedIds).size, 3);
    assert.deepEqual(provider.acceptedIds, requestedIds);

    const postId = 'Target-Instagram-Post';
    const scopedComment = (objectId: string, sourcePostId?: string | null) => ({
      ...message(objectId, 'pricing'), kind: 'comment', postId: sourcePostId,
    });
    assert.deepEqual(await request(publishPath, controlToken, 400, { ...config, postId: 123 }), {
      error: 'invalid_request',
    });
    assert.ok((await publish({ ...config, postId }, controlToken, 201)).versionId);
    for (const comment of [
      scopedComment('missing-post'),
      scopedComment('unknown-post', null),
      scopedComment('other-post', postId.toLowerCase()),
    ]) {
      assert.deepEqual(await ingest(comment), { outcome: 'ignored', runId: null });
    }
    assert.deepEqual(await request(ingestPath, adapterToken, 400, {
      ...message('dm-with-post-id', 'buyer@example.org'), postId: null,
    }), { error: 'invalid_request' });

    const scoped = await ingest(scopedComment('matching-post', postId));
    assert.equal(scoped.outcome, 'started');
    assert.ok(scoped.runId);
    await expectState(scoped.runId, 'waiting');
    assert.deepEqual(
      provider.requests.slice(requestedIds.length).map(({ runId, commentId, kind }) => [runId, commentId, kind]),
      [
        [scoped.runId, 'matching-post', 'comment_reply'],
        [scoped.runId, 'matching-post', 'email_prompt'],
      ],
    );
  } catch (error) {
    const providerRequests = provider.requests.map(({ id, kind, sendBefore }) => ({ id, kind, sendBefore }));
    const statusDetails = lastStatus && { state: lastStatus.state, actions: lastStatus.actions };
    t.diagnostic(JSON.stringify({ statusDetails, providerRequests, processes: processes.map((process) => process.details()) }));
    throw error;
  }
});
