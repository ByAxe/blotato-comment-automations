import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SimulatedAdapter } from '../src/adapter.js';
import { deliverOne } from '../src/delivery.js';
import { ingest, publish } from '../src/workflow.js';

const accountId = 'demo-instagram-account';
const participantId = 'synthetic-reader';
const commentId = 'synthetic-comment';
const publicReply = 'Sent you a DM!';
const emailPrompt = 'What email address should I use?';
const linkUrl = 'https://example.org/pricing';

async function runPhase(phase: string, tenantId: string) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new SimulatedAdapter();
  const original = {
    platform: 'instagram' as const, kind: 'comment' as const, tenantId, accountId, participantId,
    eventId: 'comment-created', objectId: commentId, text: 'Pricing', occurredAt: new Date(),
  };

  try {
    if (phase === 'start') {
      await publish(pool, { tenantId, accountId, keyword: 'pricing', publicReply, emailPrompt, linkUrl });
      assert.equal((await ingest(pool, original)).outcome, 'started');
      assert.equal((await ingest(pool, original)).outcome, 'duplicate');
      assert.equal(await deliverOne(pool, adapter), 'sent');
      assert.equal(await deliverOne(pool, adapter), 'sent');
      assert.deepEqual(adapter.sent.map(action => action.text), [publicReply, emailPrompt]);
      assert.equal(await deliverOne(pool, adapter), 'idle');
      console.log('1. An Instagram comment matched “pricing”. A repeated delivery created no second run.');
      console.log(`2. Public reply: “${publicReply}”`);
      console.log(`3. Private message: “${emailPrompt}”`);
      console.log('4. The worker has no runnable actions. This process now exits with the conversation still open.');
      return;
    }

    const runResult = await pool.query<{ id: string; state: string }>(
      'SELECT id, state FROM runs WHERE tenant_id = $1 AND account_id = $2 AND comment_id = $3',
      [tenantId, accountId, commentId],
    );
    const run = runResult.rows[0];
    assert.ok(run);
    assert.equal(run.state, 'waiting');
    console.log('5. A new process found the waiting run in PostgreSQL.');
    const dm = {
      ...original, kind: 'message' as const, eventId: 'first-message', objectId: 'dm-one',
      text: 'I will get back to you.',
    };
    await ingest(pool, dm);
    assert.equal(await deliverOne(pool, adapter), 'idle');
    console.log('6. A message with no address left the conversation open.');

    const withEmail = { ...dm, eventId: 'second-message', objectId: 'dm-two', text: 'Use reader@example.org.', occurredAt: new Date() };
    assert.equal((await ingest(pool, withEmail)).outcome, 'accepted');
    assert.equal((await ingest(pool, withEmail)).outcome, 'duplicate');
    assert.equal(await deliverOne(pool, adapter), 'sent');
    assert.equal(await deliverOne(pool, adapter), 'idle');
    assert.deepEqual(adapter.sent.map(action => action.kind), ['link_dm']);
    assert.ok(adapter.sent[0]?.text.includes(linkUrl));
    const completion = await pool.query('SELECT state FROM runs WHERE id = $1', [run.id]);
    assert.equal(completion.rows[0]?.state, 'completed');
    console.log(`7. An email arrived twice. The worker sent one private link to ${linkUrl} and completed the run.`);

    const funnel = await pool.query(
      `SELECT cohort_day::text, started_runs, emails_captured, links_sent, uncertain_runs
         FROM automation_daily_funnel WHERE tenant_id = $1 AND account_id = $2`,
      [tenantId, accountId],
    );
    assert.equal(funnel.rows.length, 1);
    const row = funnel.rows[0];
    assert.deepEqual([row.started_runs, row.emails_captured, row.links_sent, row.uncertain_runs].map(Number), [1, 1, 1, 0]);
    console.log(`UTC cohort ${row.cohort_day}: ${row.started_runs} started, ${row.emails_captured} email captured, ${row.links_sent} link sent, ${row.uncertain_runs} uncertain.`);
  } finally {
    await pool.end();
  }
}

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to a fresh, migrated demo database.');

const [phase, tenantId] = process.argv.slice(2);
if (phase && tenantId && ['start', 'resume'].includes(phase)) {
  await runPhase(phase, tenantId);
} else if (process.argv.length === 2) {
  console.log('Instagram pricing workflow · real PostgreSQL, simulated social delivery');
  const tenant = `demo-${randomUUID()}`;
  for (const step of ['start', 'resume']) {
    const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), step, tenant], { stdio: 'inherit' });
    if (child.error) throw child.error;
    if (child.status !== 0) process.exit(child.status ?? 1);
  }
} else {
  throw new Error('Run the demo without arguments.');
}
