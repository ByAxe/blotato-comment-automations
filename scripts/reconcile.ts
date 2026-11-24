import { parseArgs } from 'node:util';
import { reconcile, type Reconciliation } from '../src/delivery.js';
import { openPool } from '../src/runtime.js';

const help = `Usage:
  node dist/scripts/reconcile.js list --tenant ID [--after ACTION_UUID]
  node dist/scripts/reconcile.js resolve --tenant ID --action ACTION_UUID --attempt N
    --decision confirmed_sent --evidence CASE_REF --receipt PROVIDER_RECEIPT
  node dist/scripts/reconcile.js resolve --tenant ID --action ACTION_UUID --attempt N
    --decision confirmed_absent --evidence CASE_REF --quiescence DISPATCHER_CASE_REF
  node dist/scripts/reconcile.js resolve --tenant ID --action ACTION_UUID --attempt N
    --decision abandon --evidence CASE_REF

Set DATABASE_URL to the database connection for the operator. Each decision records session_user.`;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  const [verb, ...args] = process.argv.slice(2);
  if (verb === '--help') { console.log(help); return; }
  const { values } = parseArgs({
    args,
    options: {
      tenant: { type: 'string' }, after: { type: 'string' }, action: { type: 'string' },
      attempt: { type: 'string' }, decision: { type: 'string' }, evidence: { type: 'string' },
      receipt: { type: 'string' }, quiescence: { type: 'string' },
    },
  });
  const { tenant, after, action, attempt, decision, evidence, receipt, quiescence } = values;
  if (!tenant?.trim() || tenant.length > 255) throw new Error('usage');
  const pool = openPool();
  try {
    if (verb === 'list') {
      if ((after && !uuid.test(after)) || Object.keys(values).some(k => k !== 'tenant' && k !== 'after')) {
        throw new Error('usage');
      }
      const held = await pool.query<{ id: string }>(`
        SELECT o.id, o.kind, o.attempts AS attempt, o.run_id, o.last_error, o.first_attempt_at
        FROM outbox o JOIN runs r ON r.id = o.run_id
        WHERE r.tenant_id = $1 AND o.status = 'uncertain' AND ($2::uuid IS NULL OR o.id > $2)
        ORDER BY o.id LIMIT 51
      `, [tenant, after ?? null]);
      const actions = held.rows.slice(0, 50);
      console.log(JSON.stringify({ actions, next: held.rows.length > 50 ? actions[49]!.id : null }, null, 2));
      return;
    }
    if (verb !== 'resolve' || !action || !uuid.test(action) || !attempt || !/^[1-9]\d*$/.test(attempt)
      || !evidence?.trim() || after
      || (decision !== 'confirmed_sent' && decision !== 'confirmed_absent' && decision !== 'abandon')
      || ((decision === 'confirmed_sent') !== Boolean(receipt))
      || ((decision === 'confirmed_absent') !== Boolean(quiescence))) throw new Error('usage');

    const identity = await pool.query<{ operator: string }>('SELECT session_user AS operator');
    const input: Reconciliation = {
      tenantId: tenant, actionId: action, expectedAttempt: Number(attempt), decision,
      operatorId: identity.rows[0]!.operator, evidence, providerReceipt: receipt, quiescenceEvidence: quiescence,
    };
    const applied = await reconcile(pool, input);
    console.log(JSON.stringify({ applied }));
    if (!applied) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  if (error instanceof Error && (error.message === 'usage' || error instanceof TypeError)) console.error(help);
  else console.error('Recovery command failed. Check database access and the supplied arguments.');
  process.exitCode = 1;
});
