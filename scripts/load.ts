import { availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { SimulatedAdapter, type ActionKind } from '../src/adapter.js';
import { deliverOne } from '../src/delivery.js';
import { ingest, publish } from '../src/workflow.js';

const accountId = 'synthetic-instagram-account';
const publicReply = 'Sent you a DM!';
const emailPrompt = 'What email address should I use?';
const actionKinds = ['comment_reply', 'email_prompt', 'link_dm'] as const;
const optionLimits = {
  tenants: { default: 8, max: 50 },
  participants: { default: 50, max: 1_000 },
  'ingress-workers': { default: 8, max: 32 },
  'delivery-workers': { default: 4, max: 32 },
};

class LoadFailure extends Error {}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new LoadFailure(message);
}

function options() {
  const { values } = parseArgs({
    options: {
      tenants: { type: 'string' }, participants: { type: 'string' },
      'ingress-workers': { type: 'string' }, 'delivery-workers': { type: 'string' },
    },
  });
  function read(name: keyof typeof optionLimits) {
    const raw = values[name];
    const { default: defaultValue, max } = optionLimits[name];
    if (raw === undefined) return defaultValue;
    const size = Number(raw);
    requireCondition(/^\d+$/.test(raw) && size >= 1 && size <= max, `--${name} must be an integer from 1 to ${max}.`);
    return size;
  }
  const tenants = read('tenants');
  const participantsPerTenant = read('participants');
  requireCondition(tenants * participantsPerTenant <= 5_000, 'A load run supports up to 5,000 conversations.');
  return { tenants, participantsPerTenant, ingressWorkers: read('ingress-workers'), deliveryWorkers: read('delivery-workers') };
}

async function runParallel<T>(items: readonly T[], concurrency: number, work: (item: T) => Promise<void>) {
  let cursor = 0;
  const results = await Promise.allSettled(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    for (;;) {
      const item = items[cursor++];
      if (item === undefined) return;
      await work(item);
    }
  }));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function latencyMs(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  function percentile(fraction: number) {
    const value = sorted[Math.ceil(sorted.length * fraction) - 1];
    return value === undefined ? null : round(value);
  }
  return { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) };
}

function measurement(startedAt: number, samples: number[]) {
  const elapsedMs = performance.now() - startedAt;
  return { count: samples.length, elapsedMs: round(elapsedMs), perSecond: round(samples.length * 1_000 / elapsedMs), callMs: latencyMs(samples) };
}

type Event = Parameters<typeof ingest>[1];

async function ingestCopies(db: pg.Pool, events: Event[], concurrency: number, expectedOutcome: 'started' | 'accepted') {
  const copies = events.flatMap(event => [event, event, { ...event, eventId: `${event.eventId}-redelivery` }]);
  const samples: number[] = [];
  let unique = 0;
  let duplicate = 0;
  const startedAt = performance.now();
  await runParallel(copies, concurrency, async event => {
    const before = performance.now();
    const result = await ingest(db, event);
    samples.push(performance.now() - before);
    if (result.outcome === expectedOutcome) unique++;
    else if (result.outcome === 'duplicate') duplicate++;
    else throw new LoadFailure('An ingress attempt had an unexpected outcome.');
  });
  requireCondition(unique === events.length && duplicate === events.length * 2, 'Unexpected ingress deduplication counts.');
  return { ...measurement(startedAt, samples), unique, duplicate };
}

async function drain(db: pg.Pool, adapter: SimulatedAdapter, concurrency: number, expectedSends: number) {
  const samples: number[] = [];
  const workerSends = Array.from({ length: concurrency }, () => 0);
  const startedAt = performance.now();
  await runParallel(workerSends.map((_, worker) => worker), concurrency, async worker => {
    for (;;) {
      const before = performance.now();
      const result = await deliverOne(db, adapter);
      if (result === 'idle') return;
      requireCondition(result === 'sent', 'A simulated delivery did not finish with a receipt.');
      samples.push(performance.now() - before);
      workerSends[worker] = (workerSends[worker] ?? 0) + 1;
      requireCondition(samples.length <= expectedSends, 'Workers exceeded the expected number of actions.');
    }
  });
  requireCondition(samples.length === expectedSends, 'Workers did not send every expected action.');
  return { ...measurement(startedAt, samples), workerSends };
}

type RunRow = {
  id: string;
  tenant_id: string;
  account_id: string;
  participant_id: string;
  comment_id: string;
  version_id: string;
  state: string;
  reply_at: Date;
};

type OutboxRow = {
  id: string;
  run_id: string;
  kind: ActionKind;
  status: string;
  attempts: number;
  provider_id: string | null;
  queue_ms: number | null;
};

let stage = 'configuration';

async function main() {
  const scenario = options();
  const connectionString = process.env.DATABASE_URL;
  requireCondition(connectionString, 'Set DATABASE_URL to a dedicated, empty, migrated load database.');
  const max = Math.max(scenario.ingressWorkers, scenario.deliveryWorkers);
  const db = new pg.Pool({ connectionString, max, connectionTimeoutMillis: 5_000, statement_timeout: 15_000 });
  const adapter = new SimulatedAdapter();
  const n = scenario.tenants * scenario.participantsPerTenant;

  try {
    stage = 'database preflight';
    const preflight = await db.query<{ empty: boolean; version: string }>(`
      SELECT NOT (EXISTS (SELECT 1 FROM automations) OR EXISTS (SELECT 1 FROM inbox)
               OR EXISTS (SELECT 1 FROM runs) OR EXISTS (SELECT 1 FROM outbox)) AS empty,
             current_setting('server_version') AS version
    `);
    const database = preflight.rows[0];
    requireCondition(database?.empty, 'Use a dedicated empty database. Workers claim from the shared outbox.');

    stage = 'publication';
    const configs = Array.from({ length: scenario.tenants }, (_, tenant) => ({
      tenantId: `load-tenant-${tenant + 1}`, accountId, keyword: 'pricing', publicReply, emailPrompt,
      linkUrl: `https://example.org/pricing/${tenant + 1}`,
    }));
    const versions = new Map<string, { id: string; link: string }>();
    await runParallel(configs, scenario.ingressWorkers, async config => {
      versions.set(config.tenantId, { id: await publish(db, config), link: config.linkUrl });
    });
    const comments: Event[] = configs.flatMap(config => Array.from({ length: scenario.participantsPerTenant }, (_, reader) => ({
      tenantId: config.tenantId, accountId, participantId: `reader-${reader + 1}`, eventId: `comment-event-${reader + 1}`,
      objectId: `comment-${reader + 1}`, kind: 'comment', text: 'PRICING', occurredAt: new Date(), platform: 'instagram',
    })));

    stage = 'comment ingress';
    const commentsResult = await ingestCopies(db, comments, scenario.ingressWorkers, 'started');
    stage = 'reply and prompt drain';
    const initialSends = await drain(db, adapter, scenario.deliveryWorkers, n * 2);

    stage = 'waiting and version checks';
    const waiting = await db.query<RunRow>(`
      SELECT id, tenant_id, account_id, participant_id, comment_id, version_id, state,
             clock_timestamp() AS reply_at
      FROM runs
    `);
    const expectedConversations = new Set(comments.map(comment =>
      JSON.stringify([comment.tenantId, comment.accountId, comment.participantId, comment.objectId])));
    for (const run of waiting.rows) {
      const subject = JSON.stringify([run.tenant_id, run.account_id, run.participant_id, run.comment_id]);
      requireCondition(run.state === 'waiting' && expectedConversations.delete(subject),
        'A run was outside its expected conversation or was not waiting after two sends.');
    }
    requireCondition(expectedConversations.size === 0, 'Every matching comment should have one waiting run.');
    await runParallel(configs, scenario.ingressWorkers, async config => {
      await publish(db, { ...config, linkUrl: `${config.linkUrl}/new-version` });
    });
    const responses: Event[] = waiting.rows.map(run => ({
      tenantId: run.tenant_id, accountId: run.account_id, participantId: run.participant_id,
      eventId: `message-event-${run.participant_id}`, objectId: `message-${run.participant_id}`, kind: 'message',
      text: `${run.participant_id}@example.org`, occurredAt: run.reply_at, platform: 'instagram',
    }));

    stage = 'response ingress';
    const responsesResult = await ingestCopies(db, responses, scenario.ingressWorkers, 'accepted');
    stage = 'link drain';
    const links = await drain(db, adapter, scenario.deliveryWorkers, n);

    stage = 'durable and simulated effect checks';
    const [totals, outbox] = await Promise.all([
      db.query<{ completed: number; inbox: number; leads: number; buffered: number }>(`
        SELECT (SELECT count(*)::int FROM runs WHERE state = 'completed') AS completed,
               (SELECT count(*)::int FROM inbox) AS inbox,
               (SELECT count(*)::int FROM leads) AS leads,
               (SELECT count(*)::int FROM buffered_emails) AS buffered
      `),
      db.query<OutboxRow>(`
        SELECT id, run_id, kind, status, attempts, provider_id,
               extract(epoch FROM first_attempt_at - created_at)::double precision * 1000 AS queue_ms
        FROM outbox
      `),
    ]);
    const counts = totals.rows[0];
    requireCondition(counts?.completed === n && counts.inbox === n * 2 && counts.leads === n && counts.buffered === 0,
      'Persistent run, inbox, or lead counts did not match the workload.');
    requireCondition(outbox.rows.length === n * 3 && adapter.sent.length === n * 3,
      'Expected three stored and simulated effects per run.');
    const actions = new Map(outbox.rows.map(row => [row.id, row]));
    const runs = new Map(waiting.rows.map(row => [row.id, row]));
    const nextAction = new Map<string, number>();
    const queueSamples: Record<ActionKind, number[]> = { comment_reply: [], email_prompt: [], link_dm: [] };
    for (const effect of adapter.sent) {
      const run = runs.get(effect.runId);
      const row = actions.get(effect.id);
      const index = nextAction.get(effect.runId) ?? 0;
      requireCondition(run && row && row.run_id === run.id && row.kind === effect.kind && actionKinds[index] === effect.kind,
        'Simulated action order, ownership, or identity did not match its stored run.');
      requireCondition(row.status === 'sent' && row.attempts === 1 && row.provider_id === `sim-${effect.id}` && row.queue_ms !== null && row.queue_ms >= 0,
        'A durable action did not have its expected receipt, attempt count, or queue timing.');
      requireCondition(effect.tenantId === run.tenant_id && effect.accountId === run.account_id &&
        effect.participantId === run.participant_id && effect.commentId === run.comment_id,
      'An action targeted an unexpected tenant, account, participant, or comment.');
      const version = versions.get(effect.tenantId);
      const expected = { comment_reply: publicReply, email_prompt: emailPrompt, link_dm: version?.link };
      requireCondition(version?.id === run.version_id && effect.text === expected[effect.kind],
        'An action did not use the exact message from its original rule version.');
      actions.delete(effect.id);
      nextAction.set(effect.runId, index + 1);
      queueSamples[effect.kind].push(row.queue_ms);
    }
    requireCondition(actions.size === 0 && nextAction.size === n && [...nextAction.values()].every(count => count === 3),
      'The simulator did not observe every effect exactly once.');

    console.log(JSON.stringify({
      environment: { node: process.version, postgres: database.version, platform: process.platform, arch: process.arch, logicalCpus: availableParallelism() },
      scenario: { ...scenario, poolMax: max, conversations: n, deliveryAttemptsPerEvent: 3 },
      counts: { ...counts, outbox: outbox.rows.length, simulatedSends: adapter.sent.length },
      commentIngress: commentsResult, repliesAndPrompts: initialSends, responseIngress: responsesResult, links,
      enqueueToFirstAttemptMs: Object.fromEntries(actionKinds.map(kind => [kind, latencyMs(queueSamples[kind])])),
    }, null, 2));
  } finally {
    await db.end();
  }
}

try {
  await main();
} catch (error) {
  // Database errors may contain connection details or row values. Print only known diagnostics.
  const reason = error instanceof LoadFailure ? ` ${error.message}` : '';
  console.error(`Load scenario failed during ${stage}.${reason}`);
  process.exitCode = 1;
}
