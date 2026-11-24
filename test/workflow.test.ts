import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { SimulatedAdapter, type SocialAdapter } from '../src/adapter.js';
import { deliverOne } from '../src/delivery.js';
import { expireWaits, ingest, publish, setEnabled } from '../src/workflow.js';
import { afterPrompt, comment, db, input, message } from './fixtures.js';

after(() => db.end());

async function state(runId: string) {
  const result = await db.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId]);
  return result.rows[0]?.state;
}

async function start(config: ReturnType<typeof input>, id: string) {
  const result = await ingest(db, comment(config, id));
  assert.equal(result.outcome, 'started');
  assert.ok(result.runId);
  return result.runId;
}

async function openWait(adapter: SimulatedAdapter) {
  assert.equal(await deliverOne(db, adapter), 'sent');
  assert.equal(await deliverOne(db, adapter), 'sent');
}

test('only an enabled, exact keyword from a customer starts a conversation', async () => {
  const config = input('match');
  await publish(db, config);
  for (const text of ['show me pricing', 'prices', '']) {
    assert.equal((await ingest(db, { ...comment(config, `miss-${text}`), text })).outcome, 'ignored');
  }
  assert.equal((await ingest(db, { ...comment(config, 'self'), isSelf: true })).outcome, 'ignored');
  await setEnabled(db, config.tenantId, config.accountId, false);
  assert.equal((await ingest(db, comment(config, 'disabled'))).outcome, 'ignored');
  await setEnabled(db, config.tenantId, config.accountId, true);
  const matched = await ingest(db, { ...comment(config, 'match'), text: '   PrIcInG   ' });
  assert.equal(matched.outcome, 'started');
  await openWait(new SimulatedAdapter());
});

test('redelivery and two competing comments create a single conversation and one first reply', async () => {
  const config = input('race');
  await publish(db, config);
  const first = comment(config, 'event-a');
  const second = comment(config, 'event-b');
  const attempts = await Promise.all([
    ingest(db, first),
    ingest(db, first),
    ingest(db, second),
  ]);
  assert.deepEqual(attempts.map(result => result.outcome).sort(), ['busy', 'duplicate', 'started']);

  const winner = attempts.findIndex(result => result.outcome === 'started');
  const winningComment = winner === 2 ? second : first;
  const replay = { ...winningComment, eventId: 'renamed-delivery-envelope' };
  assert.equal((await ingest(db, replay)).outcome, 'duplicate');
  const adapter = new SimulatedAdapter();
  await openWait(adapter);
  assert.deepEqual(adapter.sent.map(action => action.kind), ['comment_reply', 'email_prompt']);
  assert.equal(await deliverOne(db, adapter), 'idle');
});

test('a reply received during the prompt send survives the acknowledgement race', async () => {
  const config = input('early');
  await publish(db, config);
  const runId = await start(config, 'trigger-comment');
  const sink = new SimulatedAdapter();
  assert.equal(await deliverOne(db, sink), 'sent');

  const bufferedAdapter: SocialAdapter = {
    async send(action, signal) {
      assert.equal(action.kind, 'email_prompt');
      const occurredAt = await afterPrompt(runId);
      const early = message(config, 'in-flight-email', 'Please use reader@example.org.', occurredAt);
      assert.equal((await ingest(db, early)).outcome, 'buffered');
      assert.equal(await state(runId), 'prompt_pending');
      return sink.send(action, signal);
    },
  };

  assert.equal(await deliverOne(db, bufferedAdapter), 'sent');
  assert.equal(await state(runId), 'link_pending');
  assert.equal(await deliverOne(db, sink), 'sent');
  assert.equal(await state(runId), 'completed');
  assert.deepEqual(sink.sent.map(action => action.kind), ['comment_reply', 'email_prompt', 'link_dm']);
});

test('version edits affect later comments, while an existing wait uses its original link', async () => {
  const config = input('version');
  const old = await publish(db, config);
  const runId = await start(config, 'first');
  const adapter = new SimulatedAdapter();
  await openWait(adapter);

  const nextConfig = { ...config, keyword: 'details', linkUrl: 'https://example.org/new-price' };
  const latest = await publish(db, nextConfig);
  assert.notEqual(old, latest);
  const afterStart = await afterPrompt(runId);
  const foreign = { ...config, tenantId: input('foreign').tenantId };
  await ingest(db, message(foreign, 'other-tenant', 'foreign@example.org', afterStart));
  await ingest(db, message({ ...config, accountId: 'another-account' }, 'other-account', 'else@example.org', afterStart));
  await ingest(db, message(config, 'other-reader', 'else@example.org', afterStart, 'someone-else'));
  await ingest(db, message(config, 'old-dm', 'old@example.org', new Date('2000-01-01T00:00:00Z')));
  await ingest(db, message(config, 'no-email', 'Maybe later.', afterStart));
  await ingest(db, message(config, 'two-addresses', 'one@example.org or two@example.org', afterStart));
  assert.equal(await state(runId), 'waiting');

  const reply = message(config, 'valid-email', 'reader@example.org', afterStart);
  const results = await Promise.all([ingest(db, reply), ingest(db, reply)]);
  assert.deepEqual(results.map(result => result.outcome).sort(), ['accepted', 'duplicate']);
  assert.equal(await deliverOne(db, adapter), 'sent');
  assert.equal(await state(runId), 'completed');
  assert.ok(adapter.sent.at(-1)?.text.includes(config.linkUrl));
  const leads = await db.query<{ email: string }>('SELECT email FROM leads WHERE run_id = $1', [runId]);
  assert.deepEqual(leads.rows, [{ email: 'reader@example.org' }]);

  assert.equal((await ingest(db, comment(config, 'old-keyword'))).outcome, 'ignored');
  const next = await ingest(db, { ...comment(config, 'new-keyword'), text: 'details' });
  assert.equal(next.outcome, 'started');
  await openWait(adapter);
  const versions = await db.query<{ id: string; version_id: string }>(
    'SELECT id, version_id FROM runs WHERE tenant_id = $1', [config.tenantId],
  );
  assert.equal(versions.rows.find(row => row.id === runId)?.version_id, old);
  assert.equal(versions.rows.find(row => row.id === next.runId)?.version_id, latest);
});

test('an expired wait ignores late email and releases the conversation for a new comment', async () => {
  const config = input('expiry');
  await publish(db, config);
  const id = await start(config, 'first');
  const adapter = new SimulatedAdapter();
  await openWait(adapter);
  await db.query(
    `UPDATE runs SET prompt_started_at = now() - interval '25 hours',
                     expires_at = now() - interval '1 hour' WHERE id = $1`, [id],
  );
  await expireWaits(db);
  assert.equal(await state(id), 'expired');
  await ingest(db, message(config, 'late', 'late@example.org', new Date()));
  assert.equal(await deliverOne(db, adapter), 'idle');
  const leads = await db.query('SELECT 1 FROM leads WHERE run_id = $1', [id]);
  assert.equal(leads.rowCount, 0);
  await start(config, 'second');
  await openWait(adapter);
});

test('a definitively unsent prompt discards addresses buffered during that attempt', async () => {
  const config = input('prompt-retry');
  await publish(db, config);
  const runId = await start(config, 'trigger');
  const adapter = new SimulatedAdapter();
  assert.equal(await deliverOne(db, adapter), 'sent');

  let inboundOutcome: string | undefined;
  const providerBusy: SocialAdapter = {
    async send() {
      const early = message(config, 'unrelated-dm', 'unrelated@example.org', await afterPrompt(runId));
      inboundOutcome = (await ingest(db, early)).outcome;
      return { kind: 'retry', code: 'busy_before_send' };
    },
  };
  assert.equal(await deliverOne(db, providerBusy, { baseDelayMs: 0 }), 'retry');
  assert.equal(inboundOutcome, 'buffered');
  assert.equal(await deliverOne(db, adapter), 'sent');
  assert.equal(await state(runId), 'waiting');
  assert.equal(await deliverOne(db, adapter), 'idle');
  const stored = await db.query('SELECT 1 FROM leads WHERE run_id = $1', [runId]);
  assert.equal(stored.rowCount, 0);
});
