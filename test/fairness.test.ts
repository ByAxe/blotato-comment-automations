import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { SimulatedAdapter } from '../src/adapter.js';
import { deliverOne } from '../src/delivery.js';
import { ingest, publish } from '../src/workflow.js';
import { comment, db, input } from './fixtures.js';

after(() => db.end());

async function backlogs(label: string, depth: number) {
  const hot = input(label);
  const quiet = { ...hot, accountId: 'quiet-account' };
  await publish(db, hot);
  await publish(db, quiet);
  for (let i = 0; i < depth; i++) {
    await ingest(db, comment(hot, 'hot-' + i, 'reader-' + i));
  }
  await ingest(db, comment(quiet, 'quiet-1'));
  return { hot, quiet };
}

async function checkCounts(tenantId: string) {
  const mismatch = await db.query(`
    SELECT l.account_id FROM delivery_lanes l
    WHERE l.tenant_id=$1 AND l.pending_count <> (
      SELECT count(*) FROM outbox o
      WHERE o.tenant_id=l.tenant_id AND o.account_id=l.account_id AND o.status='pending'
    )
  `, [tenantId]);
  assert.equal(mismatch.rowCount, 0);
}

test('an eligible quiet account gets alternate claim turns through an older account backlog', async () => {
  const { hot, quiet } = await backlogs('fair-turns', 12);
  const adapter = new SimulatedAdapter();
  for (let i = 0; i < 4; i++) {
    assert.equal(await deliverOne(db, adapter), 'sent');
    await checkCounts(hot.tenantId);
  }
  assert.deepEqual(adapter.sent.map(a => [a.accountId, a.kind]), [
    [hot.accountId, 'comment_reply'], [quiet.accountId, 'comment_reply'],
    [hot.accountId, 'comment_reply'], [quiet.accountId, 'email_prompt'],
  ]);
  while (await deliverOne(db, adapter) !== 'idle') { /* drain remaining hot work */ }
  await checkCounts(hot.tenantId);
  const active = await db.query('SELECT 1 FROM delivery_lanes WHERE tenant_id=$1 AND pending_count>0', [hot.tenantId]);
  assert.equal(active.rowCount, 0);
});

test('retiring expired hot work still dispatches a valid quiet action in the same pass', async () => {
  const { hot, quiet } = await backlogs('fair-expiry', 4);
  await db.query("UPDATE outbox SET send_before=clock_timestamp()-interval '1 minute' WHERE tenant_id=$1 AND account_id=$2",
    [hot.tenantId, hot.accountId]);
  const adapter = new SimulatedAdapter();
  assert.equal(await deliverOne(db, adapter), 'sent');
  assert.deepEqual(adapter.sent.map(a => a.accountId), [quiet.accountId]);
  const backlog = await db.query('SELECT pending_count FROM delivery_lanes WHERE tenant_id=$1 AND account_id=$2',
    [hot.tenantId, hot.accountId]);
  assert.equal(Number(backlog.rows[0].pending_count), 3);
  await checkCounts(hot.tenantId);
  while (await deliverOne(db, adapter) !== 'idle') { /* drain pending expiry and prompt */ }
});

test('expired entries in the same account leave a live action eligible', async () => {
  const config = input('mixed-deadlines');
  await publish(db, config);
  for (let i = 0; i < 4; i++) await ingest(db, comment(config, 'expired-' + i, 'expired-' + i));
  await db.query("UPDATE outbox SET send_before=clock_timestamp()-interval '1 minute' WHERE tenant_id=$1", [config.tenantId]);
  await ingest(db, comment(config, 'current', 'current'));
  const adapter = new SimulatedAdapter();
  assert.equal(await deliverOne(db, adapter), 'sent');
  assert.deepEqual(adapter.sent.map(a => a.commentId), ['current']);
  while (await deliverOne(db, adapter) !== 'idle') { /* drain work before the next account */ }
});

test('a prompt blocked on its conversation lock cannot start sending after the lease expires', async () => {
  const config = input('arming-lock');
  await publish(db, config);
  await ingest(db, comment(config, 'comment', 'reader'));
  const adapter = new SimulatedAdapter();
  assert.equal(await deliverOne(db, adapter), 'sent');
  const owner = await db.connect();
  let pending: Promise<string> | undefined;
  let holding = false;
  try {
    await owner.query('BEGIN');
    holding = true;
    await owner.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      JSON.stringify([config.tenantId, config.accountId, 'reader']),
    ]);
    pending = deliverOne(db, adapter, { leaseMs: 1_000 });
    const timeout = Date.now() + 5_000;
    for (;;) {
      const expired = await db.query(
        "SELECT 1 FROM outbox WHERE tenant_id=$1 AND kind='email_prompt' AND status='leased' AND lease_until<=clock_timestamp()",
        [config.tenantId],
      );
      if (expired.rowCount) break;
      assert.ok(Date.now() < timeout, 'expected the blocked prompt lease to expire');
      await delay(10);
    }
    await owner.query('COMMIT');
    holding = false;
    assert.equal(await pending, 'retry');
    assert.deepEqual(adapter.sent.map(a => a.kind), ['comment_reply']);
    assert.equal(await deliverOne(db, adapter), 'sent');
  } finally {
    if (holding) await owner.query('ROLLBACK');
    owner.release();
    await pending;
  }
});


test('a locked head yields its lane turn to a different eligible account', async () => {
  const { hot, quiet } = await backlogs('locked-head', 2);
  const owner = await db.connect();
  const adapter = new SimulatedAdapter();
  let delivery: Promise<string> | undefined;
  try {
    await owner.query('BEGIN');
    const head = await owner.query(`
      SELECT id FROM outbox WHERE tenant_id=$1 AND account_id=$2 AND status='pending'
      ORDER BY available_at, id LIMIT 1 FOR UPDATE
    `, [hot.tenantId, hot.accountId]);
    assert.equal(head.rowCount, 1);
    delivery = deliverOne(db, adapter);
    const result = await Promise.race([
      delivery,
      delay(5_000, undefined, { ref: false }).then(() => { throw new Error('claim waited for the locked head'); }),
    ]);
    assert.equal(result, 'sent');
    assert.deepEqual(adapter.sent.map(a => a.accountId), [quiet.accountId]);
  } finally {
    await owner.query('ROLLBACK');
    owner.release();
    await delivery;
  }
  assert.equal(await deliverOne(db, adapter), 'sent');
  assert.equal(adapter.sent[1]?.commentId, 'hot-0');
});
