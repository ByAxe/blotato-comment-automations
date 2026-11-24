import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { after, test, type TestContext } from 'node:test';
import { SimulatedAdapter } from '../src/adapter.js';
import { deliverOne } from '../src/delivery.js';
import { createHttpServer } from '../src/http.js';
import { expireParticipantContext } from '../src/participant-context.js';
import { ingest } from '../src/workflow.js';
import { afterPrompt, comment, db, input, message } from './fixtures.js';

after(() => db.end());

const reader = 'reader';
const returningEmailPrompt = 'Welcome back! What email address should I use this time?';
const optIn = { collectParticipantContext: true, returningEmailPrompt };
const emptyContext = { interactions: [], runs: [], truncated: false };

type Configuration = ReturnType<typeof input>;
type Trigger = ReturnType<typeof comment> & { postId?: string };
type InboundMessage = ReturnType<typeof message> & { replyToActionId?: string | null };
type Context = {
  interactions: Array<{
    kind: 'comment' | 'message';
    eventId: string;
    objectId: string;
    postId: string | null;
    occurredAt: string;
    excerpt: string;
    runId: string;
    runState: string;
    emailAccepted: boolean;
  }>;
  runs: Array<{
    runId: string;
    state: string;
    actions: Array<{ kind: string; status: string; acceptedAt: string | null }>;
  }>;
  truncated: boolean;
};

async function connectedAccount(t: TestContext, config: Configuration) {
  const { tenantId, ...definition } = config;
  const { accountId } = definition;
  const controlToken = randomUUID();
  const adapterToken = randomUUID();
  const server = createHttpServer(db, { tenantId, accountId, controlToken, adapterToken });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const tenantPath = `/v1/tenants/${tenantId}`;
  const publishPath = `${tenantPath}/automations`;
  const contextPath = `${publishPath}/${accountId}/participant-context`;
  const ingestPath = `${tenantPath}/adapter/events`;

  async function request<T = unknown>(path: string, token: string, expected: number, body?: object): Promise<T> {
    const response = await fetch(url + path, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, ...(body && { 'content-type': 'application/json' }) },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    assert.equal(response.status, expected, `${path}: ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async function ingest({ tenantId: _tenantId, ...event }: Trigger | InboundMessage) {
    return request<{ runId: string | null; outcome: string }>(ingestPath, adapterToken, 200, event);
  }

  async function start(event: Trigger) {
    const result = await ingest(event);
    assert.equal(result.outcome, 'started');
    assert.ok(result.runId);
    return result.runId;
  }

  return {
    request, ingest, start, controlToken, adapterToken, contextPath, publishPath, ingestPath,
    publish: (settings: Partial<typeof definition> & { collectParticipantContext?: boolean; returningEmailPrompt?: string } = {}) =>
      request<{ versionId: string }>(publishPath, controlToken, 201, { ...definition, ...settings }),
    context: (participantId = reader) => request<Context>(contextPath, controlToken, 200, { participantId }),
    forget: (participantId = reader) => request(`${contextPath}/deletions`, controlToken, 204, { participantId }),
    status: (runId: string) => request<{ state: string }>(`${tenantPath}/status?runId=${runId}`, controlToken, 200),
  };
}

async function openWait(adapter: SimulatedAdapter, runId: string, publicReply: string, emailPrompt: string) {
  assert.equal(await deliverOne(db, adapter), 'sent');
  assert.equal(await deliverOne(db, adapter), 'sent');
  assert.deepEqual(adapter.sent.filter(action => action.runId === runId).map(({ kind, text }) => ({ kind, text })), [
    { kind: 'comment_reply', text: publicReply },
    { kind: 'email_prompt', text: emailPrompt },
  ]);
}

async function sendLink(adapter: SimulatedAdapter, runId: string, participantId: string, linkUrl: string) {
  assert.equal(await deliverOne(db, adapter), 'sent');
  const action = adapter.sent.at(-1);
  assert.deepEqual([action?.runId, action?.participantId, action?.kind, action?.text],
    [runId, participantId, 'link_dm', linkUrl]);
}

test('retained conversations inform a later prompt while each run requires a fresh email', async (t) => {
  const config = input('context-return');
  const account = await connectedAccount(t, config);
  const adapter = new SimulatedAdapter();
  await account.publish(optIn);

  const trigger = { ...comment(config, 'initial-comment'), objectId: 'comment-on-a', postId: 'Post-A' };
  const original = await account.start(trigger);
  await openWait(adapter, original, config.publicReply, config.emailPrompt);
  const question = message(config, 'team-question', 'I’m comparing team options.', await afterPrompt(original));
  assert.equal((await account.ingest(question)).outcome, 'ignored');
  assert.equal(await deliverOne(db, adapter), 'idle');

  const response = {
    ...message(config, 'email-envelope', 'Please use first@example.org for the quote.', await afterPrompt(original)),
    objectId: 'email-message',
  };
  const envelopes = [response, response, { ...response, eventId: 'redelivered-envelope' }];
  const results = await Promise.all(envelopes.map(event => account.ingest(event)));
  assert.deepEqual(results.map(result => result.outcome).sort(), ['accepted', 'duplicate', 'duplicate']);
  const accepted = envelopes[results.findIndex(result => result.outcome === 'accepted')]!;
  await sendLink(adapter, original, reader, config.linkUrl);
  assert.equal((await account.ingest({ ...trigger, eventId: 'comment-retry' })).outcome, 'duplicate');

  const history = await account.context();
  assert.equal(history.truncated, false);
  assert.equal(history.runs.length, 1);
  const [recordedRun] = history.runs;
  assert.equal(recordedRun.runId, original);
  assert.equal(recordedRun.state, 'completed');
  assert.deepEqual(recordedRun.actions.map(({ kind, status }) => ({ kind, status })), [
    { kind: 'comment_reply', status: 'sent' },
    { kind: 'email_prompt', status: 'sent' },
    { kind: 'link_dm', status: 'sent' },
  ]);
  let preceding = trigger.occurredAt.getTime();
  for (const action of recordedRun.actions) {
    assert.ok(action.acceptedAt);
    const acceptedAt = Date.parse(action.acceptedAt);
    assert.ok(acceptedAt >= preceding);
    assert.equal(action.acceptedAt, new Date(acceptedAt).toISOString());
    preceding = acceptedAt;
  }
  const completed = { runId: original, runState: 'completed' };
  const interactions = new Map(history.interactions.map(entry => [entry.objectId, entry]));
  assert.equal(history.interactions.length, 3);
  assert.deepEqual(interactions.get(trigger.objectId), {
    ...completed, kind: 'comment', eventId: trigger.eventId, objectId: trigger.objectId, postId: 'Post-A',
    occurredAt: trigger.occurredAt.toISOString(), excerpt: 'pricing', emailAccepted: false,
  });
  assert.deepEqual(interactions.get(question.objectId), {
    ...completed, kind: 'message', eventId: question.eventId, objectId: question.objectId, postId: null,
    occurredAt: question.occurredAt.toISOString(), excerpt: question.text, emailAccepted: false,
  });
  assert.deepEqual(interactions.get(response.objectId), {
    ...completed, kind: 'message', eventId: accepted.eventId, objectId: response.objectId, postId: null,
    occurredAt: response.occurredAt.toISOString(), excerpt: 'Please use [redacted] for the quote.', emailAccepted: true,
  });
  assert.doesNotMatch(JSON.stringify(await account.status(original)), /first@example\.org|team options|excerpt/);

  const revised = {
    ...optIn,
    publicReply: 'Check your DMs!',
    returningEmailPrompt: 'Good to hear from you again. Where should I send this quote?',
    linkUrl: 'https://example.org/pricing/new',
  };
  await account.publish(revised);
  const next = await account.start({ ...comment(config, 'return-comment'), postId: 'Post-B' });
  await account.publish({ linkUrl: 'https://example.org/pricing/later' });
  await openWait(adapter, next, revised.publicReply, revised.returningEmailPrompt);
  assert.equal((await account.ingest({ ...response, eventId: 'return-replay' })).outcome, 'duplicate');
  assert.equal((await account.ingest({ ...response, eventId: 'delayed-dm', objectId: 'delayed-dm' })).outcome, 'ignored');
  assert.equal((await account.status(next)).state, 'waiting');
  assert.equal(await deliverOne(db, adapter), 'idle');

  const fresh = message(config, 'fresh-email', 'Please use next@example.org.', await afterPrompt(next));
  assert.deepEqual(await account.ingest(fresh), { runId: next, outcome: 'accepted' });
  await sendLink(adapter, next, reader, revised.linkUrl);
  const updated = await account.context();
  assert.equal(updated.interactions.length, 5);
  assert.deepEqual(new Set(updated.interactions.map(entry => entry.runId)), new Set([original, next]));
  assert.deepEqual(updated.runs.map(entry => entry.runId).sort(), [original, next].sort());
  assert.deepEqual(updated.interactions.filter(entry => entry.emailAccepted).map(entry => entry.objectId).sort(),
    [fresh.objectId, response.objectId].sort());
});

test('context lookup and collection are scoped and opt-in', async (t) => {
  const config = input('context-scope');
  const neighborConfig = { ...config, accountId: 'neighbor-account' };
  const foreignConfig = { ...config, tenantId: input('context-foreign').tenantId };
  const account = await connectedAccount(t, config);
  const neighbor = await connectedAccount(t, neighborConfig);
  const foreign = await connectedAccount(t, foreignConfig);
  const adapter = new SimulatedAdapter();

  const { tenantId: _tenantId, ...definition } = config;
  await account.request(account.publishPath, account.controlToken, 400, { ...definition, returningEmailPrompt });
  await account.publish(optIn);
  await neighbor.publish();
  await foreign.publish(optIn);

  const run = await account.start(comment(config, 'shared-object-id'));
  await openWait(adapter, run, config.publicReply, config.emailPrompt);
  assert.equal((await account.ingest(message(config, 'shared-dm-id', 'first@example.org', await afterPrompt(run)))).outcome, 'accepted');
  await sendLink(adapter, run, reader, config.linkUrl);

  const original = await account.context();
  assert.equal(original.interactions.length, 2);
  const subject = { participantId: reader };
  await account.request(account.contextPath, account.adapterToken, 403, subject);
  await account.request(`${account.contextPath}/deletions`, account.adapterToken, 403, subject);
  await account.request(neighbor.contextPath, account.controlToken, 403, subject);
  await account.request(`${foreign.contextPath}/deletions`, account.controlToken, 403, subject);
  const { tenantId: _foreignTenant, ...event } = comment(config, 'control-event');
  await account.request(account.ingestPath, account.controlToken, 403, event);
  assert.deepEqual(await account.context(), original);
  assert.deepEqual(await account.context('other-reader'), emptyContext);
  assert.deepEqual(await neighbor.context(), emptyContext);
  assert.deepEqual(await foreign.context(), emptyContext);

  const sameTenantRun = await neighbor.start(comment(neighborConfig, 'shared-object-id'));
  await openWait(adapter, sameTenantRun, config.publicReply, config.emailPrompt);
  assert.equal((await neighbor.ingest(message(neighborConfig, 'shared-dm-id', 'other@example.org', await afterPrompt(sameTenantRun)))).outcome, 'accepted');
  await sendLink(adapter, sameTenantRun, reader, config.linkUrl);
  assert.deepEqual(await neighbor.context(), emptyContext);
  const stored = await db.query('SELECT 1 FROM participant_interactions WHERE tenant_id=$1 AND account_id=$2',
    [config.tenantId, neighborConfig.accountId]);
  assert.equal(stored.rowCount, 0);
  await neighbor.publish(optIn);
  const neighborRun = await neighbor.start(comment(neighborConfig, 'neighbor-now-opted-in'));
  await openWait(adapter, neighborRun, config.publicReply, config.emailPrompt);
  const neighborHistory = await neighbor.context();
  assert.deepEqual(neighborHistory.runs.map(entry => entry.runId), [neighborRun]);

  const foreignRun = await foreign.start(comment(foreignConfig, 'shared-object-id'));
  await openWait(adapter, foreignRun, config.publicReply, config.emailPrompt);
  const foreignHistory = await foreign.context();
  assert.deepEqual(foreignHistory.interactions.map(entry => entry.runId), [foreignRun]);
  assert.deepEqual(foreignHistory.runs.map(entry => entry.runId), [foreignRun]);
  const otherReader = await account.start(comment(config, 'different-person-comment', 'other-reader'));
  await openWait(adapter, otherReader, config.publicReply, config.emailPrompt);
  const otherHistory = await account.context('other-reader');
  assert.deepEqual(otherHistory.interactions.map(entry => entry.runId), [otherReader]);
  assert.deepEqual(otherHistory.runs.map(entry => entry.runId), [otherReader]);
  assert.deepEqual(await account.context(), original);
  await account.forget();
  assert.deepEqual(await account.context(), emptyContext);
  assert.deepEqual(await account.context('other-reader'), otherHistory);
  assert.deepEqual(await neighbor.context(), neighborHistory);
  assert.deepEqual(await foreign.context(), foreignHistory);
});

test('expired and forgotten context is unavailable and replay cannot recreate it', async (t) => {
  const config = input('context-expire');
  const account = await connectedAccount(t, config);
  const adapter = new SimulatedAdapter();
  await account.publish(optIn);

  const trigger = comment(config, 'original-comment');
  const previous = await account.start(trigger);
  await openWait(adapter, previous, config.publicReply, config.emailPrompt);
  const response = message(config, 'original-email', 'first@example.org', await afterPrompt(previous));
  assert.equal((await account.ingest(response)).outcome, 'accepted');
  await sendLink(adapter, previous, reader, config.linkUrl);
  assert.equal((await account.context()).interactions.length, 2);

  // Age this completed conversation without changing the database clock for delivery.
  const aged = await db.query(`UPDATE participant_interactions SET occurred_at=occurred_at - interval '31 days'
    WHERE tenant_id=$1 AND account_id=$2 AND participant_id=$3`, [config.tenantId, config.accountId, reader]);
  assert.equal(aged.rowCount, 2);
  assert.deepEqual(await account.context(), emptyContext);

  const afterExpiry = await account.start(comment(config, 'comment-after-expiry'));
  await openWait(adapter, afterExpiry, config.publicReply, config.emailPrompt);
  assert.deepEqual((await account.context()).runs.map(entry => entry.runId), [afterExpiry]);
  assert.equal(await expireParticipantContext(db), 2);
  const retained = message(config, 'email-before-erasure', 'recent@example.org', await afterPrompt(afterExpiry));
  assert.deepEqual(await account.ingest(retained), { runId: afterExpiry, outcome: 'accepted' });
  await sendLink(adapter, afterExpiry, reader, config.linkUrl);

  const activeTrigger = comment(config, 'comment-before-erasure');
  const active = await account.start(activeTrigger);
  await openWait(adapter, active, config.publicReply, returningEmailPrompt);
  await account.forget();
  await account.forget();
  assert.deepEqual(await account.context(), emptyContext);
  for (const event of [trigger, response, retained, activeTrigger]) {
    assert.equal((await account.ingest({ ...event, eventId: `replay-${event.eventId}` })).outcome, 'duplicate');
  }
  const fresh = message(config, 'email-after-erasure', 'new@example.org', await afterPrompt(active));
  assert.deepEqual(await account.ingest(fresh), { runId: active, outcome: 'accepted' });
  await sendLink(adapter, active, reader, config.linkUrl);
  assert.deepEqual(await account.context(), emptyContext);

  const newTrigger = comment(config, 'comment-after-erasure');
  const next = await account.start(newTrigger);
  await openWait(adapter, next, config.publicReply, config.emailPrompt);
  const currentHistory = await account.context();
  assert.deepEqual(currentHistory.interactions.map(entry => entry.objectId), [newTrigger.objectId]);
  assert.deepEqual(currentHistory.runs.map(entry => entry.runId), [next]);
});

test('a buffered message enters context only when its prompt attempt is accepted', async (t) => {
  const config = input('context-buffer');
  const account = await connectedAccount(t, config);
  const adapter = new SimulatedAdapter();
  await account.publish(optIn);
  const trigger = comment(config, 'buffer-trigger');
  const run = await account.start(trigger);
  assert.equal(await deliverOne(db, adapter), 'sent');

  async function buffer(objectId: string, text: string) {
    const reply = message(config, objectId, text, await afterPrompt(run));
    assert.deepEqual(await account.ingest(reply), { runId: run, outcome: 'buffered' });
    assert.deepEqual((await account.context()).interactions.map(entry => entry.objectId), [trigger.objectId]);
  }

  assert.equal(await deliverOne(db, {
    async send(action) {
      assert.equal(action.kind, 'email_prompt');
      await buffer('before-non-send', 'Do not retain rejected@example.org.');
      return { kind: 'retry', code: 'busy_before_send' };
    },
  }, { baseDelayMs: 0 }), 'retry');
  assert.deepEqual((await account.context()).interactions.map(entry => entry.objectId), [trigger.objectId]);

  const responseId = 'before-acceptance';
  assert.equal(await deliverOne(db, {
    async send(action, signal) {
      assert.equal(action.kind, 'email_prompt');
      await buffer(responseId, 'My quote address is accepted@example.org');
      return adapter.send(action, signal);
    },
  }), 'sent');
  assert.equal((await account.status(run)).state, 'link_pending');
  const context = await account.context();
  assert.equal(context.interactions.length, 2);
  assert.deepEqual(context.interactions.filter(entry => entry.kind === 'message').map(entry => ({
    objectId: entry.objectId, excerpt: entry.excerpt, emailAccepted: entry.emailAccepted,
  })), [{ objectId: responseId, excerpt: 'My quote address is [redacted]', emailAccepted: true }]);
  await sendLink(adapter, run, reader, config.linkUrl);
});

test('explicit DM replies must address the active email prompt to enter the workflow', async (t) => {
  const config = input('context-reply-target');
  const account = await connectedAccount(t, config);
  const adapter = new SimulatedAdapter();
  await account.publish(optIn);

  const { tenantId: _tenantId, ...invalidComment } = comment(config, 'bad-comment');
  await account.request(account.ingestPath, account.adapterToken, 400, { ...invalidComment, replyToActionId: null });
  const invalidMessage = { ...invalidComment, kind: 'message' };
  for (const replyToActionId of [false, 123, {}, 'provider-message-id']) {
    await account.request(account.ingestPath, account.adapterToken, 400, { ...invalidMessage, replyToActionId });
  }
  await assert.rejects(ingest(db, {
    ...message(config, 'undefined-target', 'reader@example.org', new Date()),
    replyToActionId: undefined,
  }), TypeError);

  let previousPromptId: string | undefined;
  for (const stage of ['prompt_pending', 'waiting'] as const) {
    const runId = await account.start(comment(config, `trigger-${stage}`));
    assert.equal(await deliverOne(db, adapter), 'sent');
    const commentReplyId = adapter.sent.at(-1)!.id;

    async function receiveReplies(promptId: string) {
      assert.equal((await account.status(runId)).state, stage);
      const occurredAt = await afterPrompt(runId);
      for (const [label, replyToActionId] of [['wrong', previousPromptId ?? commentReplyId], ['unmapped', null]] as const) {
        const event = message(config, `${label}-${stage}`, 'Ignore wrong@example.org.', occurredAt);
        assert.deepEqual(await account.ingest({ ...event, replyToActionId }), { outcome: 'ignored', runId: null });
      }
      const valid = message(config, `valid-${stage}`, 'Send it to reader@example.org.', occurredAt);
      const outcome = stage === 'prompt_pending' ? 'buffered' : 'accepted';
      assert.deepEqual(await account.ingest({ ...valid, replyToActionId: promptId }), { outcome, runId });
    }

    assert.equal(await deliverOne(db, {
      async send(action, signal) {
        assert.equal(action.kind, 'email_prompt');
        if (stage === 'prompt_pending') await receiveReplies(action.id);
        return adapter.send(action, signal);
      },
    }), 'sent');
    const promptId = adapter.sent.at(-1)!.id;
    if (stage === 'waiting') await receiveReplies(promptId);
    previousPromptId = promptId;

    assert.equal((await account.status(runId)).state, 'link_pending');
    const replies = (await account.context()).interactions.filter(entry => entry.runId === runId && entry.kind === 'message');
    assert.deepEqual(replies.map(({ objectId, emailAccepted }) => ({ objectId, emailAccepted })),
      [{ objectId: `valid-${stage}`, emailAccepted: true }]);
    await sendLink(adapter, runId, reader, config.linkUrl);
  }
});
