import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { databaseReady } from '../src/runtime.js';
import { ingest, publish, setEnabled } from '../src/workflow.js';
import { comment, db, input } from './fixtures.js';

after(() => db.end());

test('one post-scoped revision matches an exact known post and leaves prior runs pinned', async () => {
  const config = input('post-scope');
  const original = await publish(db, config);
  const wildcardEvent = comment(config, 'old-comment', 'first-reader');
  assert.equal((await ingest(db, wildcardEvent)).outcome, 'started');

  const scoped = await publish(db, { ...config, postId: 'Post-A' });
  for (const [id, postId] of [[1, null], [2, undefined], [3, 'post-a'], [4, 'Post-A '], [5, 'Post-B']] as const) {
    const candidate = { ...comment(config, 'unmatched-' + id, 'first-reader'), postId };
    assert.equal((await ingest(db, candidate)).outcome, 'ignored');
  }
  const match = { ...comment(config, 'scoped-comment', 'second-reader'), postId: 'Post-A' };
  assert.equal((await ingest(db, { ...match, eventId: 'wrong-word', objectId: 'wrong-word', text: 'pricing today' })).outcome, 'ignored');
  assert.equal((await ingest(db, match)).outcome, 'started');
  assert.equal((await ingest(db, { ...match, eventId: 'envelope-retry' })).outcome, 'duplicate');
  const { rows } = await db.query(
    'SELECT comment_id, version_id FROM runs WHERE tenant_id=$1 ORDER BY comment_id', [config.tenantId],
  );
  assert.deepEqual(rows, [
    { comment_id: 'old-comment', version_id: original },
    { comment_id: 'scoped-comment', version_id: scoped },
  ]);

  await setEnabled(db, config.tenantId, config.accountId, false);
  await publish(db, { ...config, postId: null });
  const next = comment(config, 'disabled', 'third-reader');
  assert.equal((await ingest(db, next)).outcome, 'ignored');
  await setEnabled(db, config.tenantId, config.accountId, true);
  assert.equal((await ingest(db, { ...next, eventId: 're-enabled', objectId: 're-enabled' })).outcome, 'started');
});

test('upgrading existing definitions and queued replies preserves account-wide targeting', async () => {
  const client = await db.connect();
  const apply = async (name: string) => client.query(await readFile('db/' + name, 'utf8'));
  try {
    await client.query('BEGIN');
    await client.query('CREATE SCHEMA upgrade_fixture');
    await client.query('SET LOCAL search_path TO upgrade_fixture');
    assert.equal(await databaseReady(client), false);
    for (const name of ['001_core.sql', '002_delivery.sql', '003_analytics.sql']) await apply(name);
    assert.equal(await databaseReady(client), false);
    await client.query(`
      INSERT INTO automations (tenant_id, account_id) VALUES ('before','account');
      INSERT INTO automation_versions (tenant_id, account_id, revision, keyword, public_reply, email_prompt, link_url)
        VALUES ('before','account',1,'pricing','Sent you a DM!','Your email?','https://example.org/pricing');
      UPDATE automations SET current_version_id=(SELECT id FROM automation_versions);
      INSERT INTO inbox (tenant_id,account_id,event_id,kind,object_id,occurred_at)
        VALUES ('before','account','event','comment','comment-id',statement_timestamp());
      INSERT INTO runs (tenant_id,account_id,participant_id,comment_id,version_id,comment_occurred_at,state)
        SELECT tenant_id,account_id,'reader','comment-id',id,statement_timestamp(),'reply_pending' FROM automation_versions;
      INSERT INTO outbox (run_id,kind,send_before)
        SELECT id,'comment_reply',comment_occurred_at + interval '168 hours' FROM runs;
    `);
    await apply('004_fair_delivery.sql');
    assert.equal(await databaseReady(client), false);
    await apply('005_post_scope.sql');
    assert.equal(await databaseReady(client), true);
    const { rows } = await client.query(`
      SELECT v.post_id AS target, i.post_id AS source, o.kind, l.pending_count::integer AS pending
      FROM automations a JOIN automation_versions v ON v.id=a.current_version_id
      JOIN runs r ON r.version_id=v.id JOIN outbox o ON o.run_id=r.id
      JOIN delivery_lanes l ON l.tenant_id=o.tenant_id AND l.account_id=o.account_id
      JOIN inbox i ON i.tenant_id=r.tenant_id AND i.account_id=r.account_id AND i.object_id=r.comment_id
      WHERE r.tenant_id='before'
    `);
    assert.deepEqual(rows, [{ target: null, source: null, kind: 'comment_reply', pending: 1 }]);
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
});
