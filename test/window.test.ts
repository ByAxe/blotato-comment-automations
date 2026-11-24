import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { SimulatedAdapter } from '../src/adapter.js';
import { deliverOne, reconcile } from '../src/delivery.js';
import { ingest, publish } from '../src/workflow.js';
import { afterPrompt, comment, db, input, message } from './fixtures.js';

after(() => db.end());
const hour = 60 * 60 * 1000;

test('a delayed comment cannot send a public reply past the original comment deadline', async () => {
  const config = input('stale-comment');
  await publish(db, config);
  const original = { ...comment(config, 'delayed'), occurredAt: new Date(Date.now() - 169 * hour) };
  const { runId } = await ingest(db, original);
  assert.ok(runId);
  const adapter = new SimulatedAdapter();
  assert.equal(await deliverOne(db, adapter), 'expired');
  assert.equal(adapter.sent.length, 0);
  const { rows } = await db.query(
    `SELECT r.state, r.comment_occurred_at, o.send_before, o.last_error
     FROM runs r JOIN outbox o ON o.run_id=r.id WHERE r.id=$1`, [runId],
  );
  assert.deepEqual(rows, [{
    state: 'expired', comment_occurred_at: original.occurredAt,
    send_before: new Date(original.occurredAt.getTime() + 168 * hour),
    last_error: 'window_expired',
  }]);
});

test('a queued link keeps the response deadline and expires under backlog without a send', async () => {
  const config = input('late-link');
  await publish(db, config);
  const original = { ...comment(config, 'comment'), occurredAt: new Date(Date.now() - 18 * hour) };
  const { runId } = await ingest(db, original);
  assert.ok(runId);
  const adapter = new SimulatedAdapter();
  assert.equal(await deliverOne(db, adapter), 'sent');
  assert.equal(await deliverOne(db, adapter), 'sent');
  const occurredAt = await afterPrompt(runId);
  const result = await ingest(db, message(config, 'response', 'reader@example.org', occurredAt));
  assert.equal(result.outcome, 'accepted');
  const actions = await db.query<{ kind: string; send_before: Date }>(
    'SELECT kind, send_before FROM outbox WHERE run_id=$1 ORDER BY kind', [runId],
  );
  const firstDeadline = new Date(original.occurredAt.getTime() + 168 * hour);
  assert.deepEqual(actions.rows, [
    { kind: 'comment_reply', send_before: firstDeadline },
    { kind: 'email_prompt', send_before: firstDeadline },
    { kind: 'link_dm', send_before: new Date(occurredAt.getTime() + 24 * hour) },
  ]);

  // Advance the fixture to the point where the queued link's deadline has passed.
  await db.query(
    "UPDATE outbox SET send_before=statement_timestamp() - interval '1 second' WHERE run_id=$1 AND kind='link_dm'",
    [runId],
  );
  assert.equal(await deliverOne(db, adapter), 'expired');
  assert.deepEqual(adapter.sent.map(action => action.kind), ['comment_reply', 'email_prompt']);
  const { rows } = await db.query(
    'SELECT state, response_object_id, response_occurred_at FROM runs WHERE id=$1', [runId],
  );
  assert.deepEqual(rows, [{ state: 'expired', response_object_id: 'response', response_occurred_at: occurredAt }]);
});

test('a send deadline cannot turn an uncertain attempt into a known non-send', async () => {
  const config = input('uncertain-deadline');
  await publish(db, config);
  const { runId } = await ingest(db, comment(config, 'trigger'));
  assert.ok(runId);
  const adapter = new SimulatedAdapter();
  adapter.plan({ kind: 'uncertain', code: 'receipt_lost', accepted: true });
  assert.equal(await deliverOne(db, adapter), 'uncertain');
  const { rows } = await db.query<{ id: string }>(
    `WITH old_comment AS (
       UPDATE runs SET comment_occurred_at=statement_timestamp()-interval '169 hours'
       WHERE id=$1 RETURNING id, comment_occurred_at
     )
     UPDATE outbox o SET send_before=c.comment_occurred_at + interval '168 hours'
     FROM old_comment c WHERE o.run_id=c.id AND o.kind='comment_reply' RETURNING o.id`, [runId],
  );
  assert.equal(await deliverOne(db, adapter), 'idle');
  const actionId = rows[0]!.id;
  const stored = await db.query('SELECT status FROM outbox WHERE id=$1', [actionId]);
  assert.deepEqual(stored.rows, [{ status: 'uncertain' }]);
  assert.equal(await reconcile(db, {
    tenantId: config.tenantId, actionId, expectedAttempt: 1, decision: 'confirmed_sent',
    operatorId: 'reviewer', evidence: 'case-window-44', providerReceipt: 'receipt-window-44',
  }), true);
  const afterEvidence = await db.query('SELECT status FROM outbox WHERE id=$1', [actionId]);
  assert.deepEqual(afterEvidence.rows, [{ status: 'sent' }]);
  assert.equal(await deliverOne(db, adapter), 'expired');
  assert.deepEqual(adapter.sent.map(action => action.kind), ['comment_reply']);
});
