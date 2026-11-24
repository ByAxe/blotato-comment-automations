import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { after, test } from 'node:test';

import { SimulatedAdapter, type SendOutcome, type SocialAction } from '../src/adapter.js';
import { deliverOne, expireLeases, reconcile } from '../src/delivery.js';
import { ingest, publish } from '../src/workflow.js';
import { comment, db, input } from './fixtures.js';

after(() => db.end());

async function firstReply(suffix: string) {
  const config = input(`delivery-${suffix}`);
  await publish(db, config);
  const { runId, outcome } = await ingest(db, comment(config, 'event-1'));
  assert.equal(outcome, 'started');
  assert.ok(runId);
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM outbox WHERE run_id = $1 AND kind = 'comment_reply'",
    [runId],
  );
  assert.equal(rows.length, 1);
  return { config, tenantId: config.tenantId, runId, actionId: rows[0]!.id };
}

async function runState(runId: string) {
  const { rows } = await db.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId]);
  return rows[0]?.state;
}

test('a rate limit pauses the account, and another tenant can keep sending', async () => {
  const { config, runId, actionId } = await firstReply('rate-limit');
  const adapter = new SimulatedAdapter();
  adapter.plan({ kind: 'retry', code: 'rate_limited', retryAfterMs: 60_000 });
  assert.equal(await deliverOne(db, adapter), 'retry');
  const sibling = await ingest(db, comment(config, 'event-2', 'another-reader'));
  assert.equal(sibling.outcome, 'started');
  assert.ok(sibling.runId);
  assert.equal(await deliverOne(db, adapter), 'idle');
  const other = await firstReply('unaffected');
  assert.equal(await deliverOne(db, adapter), 'sent');
  assert.equal(await deliverOne(db, adapter), 'sent');
  assert.equal(await runState(other.runId), 'waiting');
  assert.equal(await runState(runId), 'reply_pending');
  const { rows } = await db.query<{ deferred: boolean }>(
    "SELECT available_at >= first_attempt_at + interval '60 seconds' AS deferred FROM outbox WHERE id = $1",
    [actionId],
  );
  assert.equal(rows[0]?.deferred, true);
  await db.query('UPDATE delivery_cooldowns SET until_at = clock_timestamp() WHERE tenant_id = $1 AND account_id = $2', [
    config.tenantId, config.accountId,
  ]);
  await db.query('UPDATE outbox SET available_at = clock_timestamp() WHERE id = $1', [actionId]);
  for (let step = 0; step < 4; step++) assert.equal(await deliverOne(db, adapter), 'sent');
  assert.equal(await runState(runId), 'waiting');
  assert.equal(await runState(sibling.runId), 'waiting');
  assert.deepEqual(adapter.sent.filter(action => action.runId === runId).map(action => action.kind), [
    'comment_reply', 'email_prompt',
  ]);
});

test('permanent rejection ends the run before the next message', async () => {
  const { runId } = await firstReply('rejected');
  const adapter = new SimulatedAdapter();
  adapter.plan({ kind: 'rejected', code: 'account_disconnected' });
  assert.equal(await deliverOne(db, adapter), 'failed');
  assert.equal(await runState(runId), 'failed');
  assert.equal(await deliverOne(db, adapter), 'idle');
});

test('known-unsent retries stop at the configured attempt limit', async () => {
  const { runId, actionId } = await firstReply('retry-cap');
  const adapter = new SimulatedAdapter();
  const busy = { kind: 'retry', code: 'provider_busy' } as const;
  adapter.plan(busy, busy);
  assert.equal(await deliverOne(db, adapter, { maxAttempts: 2 }), 'retry');
  await db.query('UPDATE outbox SET available_at = clock_timestamp() WHERE id = $1', [actionId]);
  assert.equal(await deliverOne(db, adapter, { maxAttempts: 2 }), 'failed');
  assert.equal(await runState(runId), 'failed');
  assert.equal(await deliverOne(db, adapter), 'idle');
});

test('a lost provider receipt pauses delivery until an operator in the owning tenant confirms it', async () => {
  const { runId, actionId, tenantId } = await firstReply('lost-receipt');
  const accepted: SocialAction[] = [];
  const receiptLost = {
    async send(action: SocialAction): Promise<SendOutcome> {
      accepted.push(action);
      throw new Error('Connection closed after the provider accepted the request');
    },
  };
  assert.equal(await deliverOne(db, receiptLost), 'uncertain');
  assert.equal(await deliverOne(db, receiptLost), 'idle');
  const resolution = {
    tenantId, actionId, expectedAttempt: 1, decision: 'confirmed_sent', evidence: 'provider-case-42',
    operatorId: 'operator-1', providerReceipt: 'receipt-42',
  } as const;
  assert.equal(await reconcile(db, { ...resolution, tenantId: 'other-tenant' }), false);
  assert.equal(await runState(runId), 'reply_pending');
  assert.equal(await reconcile(db, resolution), true);
  assert.equal(await reconcile(db, resolution), false);
  const receipt = await db.query<{ provider_id: string }>('SELECT provider_id FROM outbox WHERE id = $1', [actionId]);
  assert.equal(receipt.rows[0]?.provider_id, resolution.providerReceipt);
  const adapter = new SimulatedAdapter();
  assert.equal(await deliverOne(db, adapter), 'sent');
  assert.equal(await runState(runId), 'waiting');
  assert.deepEqual(accepted.map(action => action.kind), ['comment_reply']);
  assert.deepEqual(adapter.sent.map(action => action.kind), ['email_prompt']);
});

test('confirmed absence allows one retry and an older decision cannot authorize a later attempt', async () => {
  const { runId, actionId, tenantId } = await firstReply('confirmed-absent');
  const adapter = new SimulatedAdapter();
  const unknown = { kind: 'uncertain', code: 'socket_closed' } as const;
  adapter.plan(unknown, unknown);
  assert.equal(await deliverOne(db, adapter), 'uncertain');
  assert.equal(await deliverOne(db, adapter), 'idle');
  const resolution = {
    tenantId, actionId, expectedAttempt: 1, decision: 'confirmed_absent', operatorId: 'operator-2',
    evidence: 'provider-case-64', quiescenceEvidence: 'dispatcher-case-64',
  } as const;
  assert.equal(await reconcile(db, resolution), true);
  assert.equal(await deliverOne(db, adapter), 'uncertain');
  assert.equal(await reconcile(db, resolution), false);
  assert.equal(await deliverOne(db, adapter), 'idle');
  assert.equal(await reconcile(db, { ...resolution, expectedAttempt: 2, evidence: 'provider-case-65' }), true);
  assert.equal(await deliverOne(db, adapter), 'sent');
  assert.equal(await deliverOne(db, adapter), 'sent');
  assert.equal(await runState(runId), 'waiting');
});

test('an expired worker cannot overwrite a reconciled receipt or create another prompt', async () => {
  const { runId, actionId, tenantId } = await firstReply('stale');
  const provider = new EventEmitter();
  const started = once(provider, 'accepted');
  const release = once(provider, 'release-receipt');
  let calls = 0;
  const pending = deliverOne(db, {
    async send() {
      calls++;
      provider.emit('accepted');
      await release;
      return { kind: 'sent', receipt: 'receipt-77' };
    },
  });
  try {
    await Promise.race([
      started,
      pending.then(result => { throw new Error(`Worker exited before calling the adapter: ${result}`); }),
    ]);
    const adapter = new SimulatedAdapter();
    assert.equal(await deliverOne(db, adapter), 'idle');
    await db.query("UPDATE outbox SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1", [actionId]);
    assert.equal(await expireLeases(db), 1);
    assert.equal(await deliverOne(db, adapter), 'idle');
    assert.equal(await reconcile(db, {
      tenantId, actionId, expectedAttempt: 1, decision: 'confirmed_sent', operatorId: 'operator-3', providerReceipt: 'receipt-77',
      evidence: 'provider-case-77',
    }), true);
    provider.emit('release-receipt');
    assert.equal(await pending, 'stale');
    assert.equal(await deliverOne(db, adapter), 'sent');
    assert.equal(await deliverOne(db, adapter), 'idle');
    assert.equal(await runState(runId), 'waiting');
    assert.equal(calls, 1);
    assert.deepEqual(adapter.sent.map(action => action.kind), ['email_prompt']);
  } finally {
    provider.emit('release-receipt');
    await pending;
  }
});

test('confirmed absence after the deadline expires the run without another attempt', async () => {
  const { runId, tenantId, actionId } = await firstReply('late-absence');
  const adapter = new SimulatedAdapter();
  adapter.plan({ kind: 'uncertain', code: 'connection_closed' });
  assert.equal(await deliverOne(db, adapter), 'uncertain');
  await db.query("UPDATE outbox SET send_before = clock_timestamp() - interval '1 second' WHERE id = $1", [actionId]);
  assert.equal(await reconcile(db, {
    tenantId, actionId, expectedAttempt: 1, decision: 'confirmed_absent', operatorId: 'operator-1',
    evidence: 'provider-case-83', quiescenceEvidence: 'dispatcher-case-83',
  }), true);
  assert.equal(await runState(runId), 'expired');
  assert.equal(await deliverOne(db, adapter), 'idle');
  assert.equal(adapter.sent.length, 0);
});
