import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { SimulatedAdapter } from '../src/adapter.js';
import { deliverOne, reconcile } from '../src/delivery.js';
import { ingest, publish } from '../src/workflow.js';
import { afterPrompt, comment, db, input, message } from './fixtures.js';

after(() => db.end());

async function cohorts(tenantId: string) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL TIME ZONE 'America/Los_Angeles'");
    const result = await client.query(
      'SELECT to_jsonb(f) AS report FROM automation_daily_funnel AS f WHERE tenant_id = $1',
      [tenantId],
    );
    return result.rows.map(row => row.report);
  } finally {
    try {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }
}

test('a late receipt updates the UTC start cohort and preserves counts after contact erasure', async () => {
  const primary = input('analytics-primary');
  const other = input('analytics-other');
  const primaryVersion = await publish(db, primary);
  const otherVersion = await publish(db, other);
  const event = comment(primary, 'shared-comment-id');
  const { runId } = await ingest(db, event);
  assert.ok(runId);
  await ingest(db, { ...event, eventId: 'redelivery' });

  const adapter = new SimulatedAdapter();
  assert.equal(await deliverOne(db, adapter), 'sent');
  assert.equal(await deliverOne(db, adapter), 'sent');
  const emailReply = message(primary, 'email-reply', 'reader@example.org', await afterPrompt(runId));
  await ingest(db, emailReply);
  await ingest(db, emailReply);
  adapter.plan({ kind: 'uncertain', code: 'ack_lost', accepted: true });
  assert.equal(await deliverOne(db, adapter), 'uncertain');

  // Both customers received the same platform IDs. Only the first reader qualified for a link.
  const second = await ingest(db, comment(other, 'shared-comment-id'));
  assert.ok(second.runId);
  adapter.plan({ kind: 'rejected', code: 'account_disconnected' });
  assert.equal(await deliverOne(db, adapter), 'failed');

  // Backdate both starts to a time that falls on the previous day in Los Angeles.
  await db.query(
    "UPDATE runs SET started_at = '2025-02-03 00:15:00+00' WHERE id IN ($1, $2)",
    [runId, second.runId],
  );
  const erased = await db.query('DELETE FROM leads WHERE run_id = $1', [runId]);
  assert.equal(erased.rowCount, 1);

  const pendingReceipt = {
    tenant_id: primary.tenantId, account_id: primary.accountId, version_id: primaryVersion,
    cohort_day: '2025-02-03', started_runs: 1, public_replies_sent: 1, email_prompts_sent: 1,
    emails_captured: 1, links_sent: 0, uncertain_runs: 1, failed_runs: 0, expired_runs: 0,
  };
  assert.deepEqual(await cohorts(primary.tenantId), [pendingReceipt]);
  const failed = {
    ...pendingReceipt, tenant_id: other.tenantId, account_id: other.accountId, version_id: otherVersion,
    public_replies_sent: 0, email_prompts_sent: 0, emails_captured: 0, uncertain_runs: 0, failed_runs: 1,
  };
  assert.deepEqual(await cohorts(other.tenantId), [failed]);

  const action = await db.query<{ id: string }>(
    "SELECT id FROM outbox WHERE run_id = $1 AND kind = 'link_dm'", [runId],
  );
  const confirmation = {
    tenantId: primary.tenantId, actionId: action.rows[0]!.id, expectedAttempt: 1,
    decision: 'confirmed_sent', operatorId: 'operator-7', evidence: 'support-case-3',
    providerReceipt: 'remote-link-42',
  } as const;
  assert.equal(await reconcile(db, confirmation), true);
  assert.deepEqual(await cohorts(primary.tenantId), [{ ...pendingReceipt, links_sent: 1, uncertain_runs: 0 }]);
  assert.deepEqual(await cohorts(other.tenantId), [failed]);
});
