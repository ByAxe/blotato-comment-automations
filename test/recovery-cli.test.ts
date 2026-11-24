import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SimulatedAdapter } from '../src/adapter.js';
import { deliverOne } from '../src/delivery.js';
import { ingest, publish } from '../src/workflow.js';
import { comment, db, input } from './fixtures.js';

after(() => db.end());

const entry = fileURLToPath(new URL('../scripts/reconcile.js', import.meta.url));

function cli(expectedExit: number, ...args: string[]) {
  const result = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, expectedExit, result.stderr);
  return result.stdout;
}

test('operator CLI records the login and both proofs before requeueing a held send', async () => {
  const config = input('cli');
  await publish(db, config);
  await ingest(db, comment(config, 'event-1'));
  const adapter = new SimulatedAdapter();
  adapter.plan({ kind: 'uncertain', code: 'ack_lost' });
  assert.equal(await deliverOne(db, adapter), 'uncertain');

  const listing = JSON.parse(cli(0, 'list', '--tenant', config.tenantId));
  assert.equal(listing.actions.length, 1);
  assert.deepEqual(JSON.parse(cli(0, 'list', '--tenant', 'another-tenant')).actions, []);
  const action = listing.actions[0];
  assert.equal(action.kind, 'comment_reply');
  assert.equal(action.attempt, 1);
  const args = ['resolve', '--tenant', config.tenantId, '--action', action.id, '--attempt', '1',
    '--decision', 'confirmed_absent', '--evidence', 'case-108'];
  cli(1, ...args);
  args.push('--quiescence', 'dispatcher-case-91');
  assert.deepEqual(JSON.parse(cli(0, ...args)), { applied: true });
  assert.deepEqual(JSON.parse(cli(2, ...args)), { applied: false });
  const audit = await db.query(
    'SELECT operator_id = session_user AS attributed, evidence, quiescence_evidence FROM delivery_reconciliations WHERE action_id = $1',
    [action.id],
  );
  assert.deepEqual(audit.rows, [{ attributed: true, evidence: 'case-108', quiescence_evidence: 'dispatcher-case-91' }]);
  assert.equal(await deliverOne(db, adapter), 'sent');
});
