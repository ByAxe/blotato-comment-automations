import { availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { SimulatedAdapter, type SocialAction, type SocialAdapter } from '../src/adapter.js';
import { deliverOne } from '../src/delivery.js';
import { ingest, publish } from '../src/workflow.js';

const accountId = 'synthetic-account';
const publicReply = 'Sent you a DM!';
const emailPrompt = 'What email address should I use?';
const hotTenant = 'skew-hot';
const quietTenant = 'skew-quiet';
const cooldownTenant = 'skew-cooldown';
const rateLimitMs = 3_000;
const kinds = ['comment_reply', 'email_prompt', 'link_dm'] as const;
const link = (tenantId: string) => `https://example.org/pricing/${tenantId}`;
const rounded = (value: number) => Math.round(value * 100) / 100;

class ScenarioFailure extends Error {}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ScenarioFailure(message);
}

function options() {
  const { values } = parseArgs({ options: {
    'hot-comments': { type: 'string', default: '240' },
    'adapter-ms': { type: 'string', default: '5' },
    workers: { type: 'string', default: '4' },
  } });
  function read(name: keyof typeof values, min: number, max: number) {
    const number = Number(values[name]);
    check(Number.isInteger(number) && number >= min && number <= max, `--${name} must be an integer from ${min} to ${max}.`);
    return number;
  }
  return { hotComments: read('hot-comments', 64, 1_000), adapterMs: read('adapter-ms', 0, 50), workers: read('workers', 2, 8) };
}

async function batches<T>(items: T[], run: (item: T) => Promise<void>) {
  for (let offset = 0; offset < items.length; offset += 8) {
    const results = await Promise.allSettled(items.slice(offset, offset + 8).map(run));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
}

type Comment = Parameters<typeof ingest>[1];
let stage = 'configuration';

async function main() {
  const scenario = options();
  const connectionString = process.env.DATABASE_URL;
  check(connectionString, 'Set DATABASE_URL to a dedicated, empty, migrated PostgreSQL database.');
  const db = new pg.Pool({ connectionString, max: 8, connectionTimeoutMillis: 5_000, statement_timeout: 15_000 });
  const sink = new SimulatedAdapter();
  const attempted: SocialAction[] = [];
  const prompted = new Set<string>();
  const comments = new Map<string, Comment>();
  const totalRuns = scenario.hotComments + 2;
  const arrivalsDuringCooldown = Math.ceil(scenario.hotComments / 10);
  let injectRateLimit = false;
  let limitedActionId: string | undefined;
  const adapter: SocialAdapter = {
    async send(action, signal) {
      attempted.push(action);
      if (scenario.adapterMs > 0) await delay(scenario.adapterMs, undefined, { signal });
      if (injectRateLimit && action.tenantId === hotTenant) {
        injectRateLimit = false;
        limitedActionId = action.id;
        return { kind: 'retry', code: 'rate_limited', retryAfterMs: rateLimitMs };
      }
      const outcome = await sink.send(action, signal);
      if (outcome.kind === 'sent' && action.kind === 'email_prompt') prompted.add(action.runId);
      return outcome;
    },
  };

  async function start(tenantId: string, index: number) {
    const comment: Comment = {
      tenantId, accountId, participantId: `reader-${index}`, eventId: `comment-event-${index}`,
      objectId: `comment-${index}`, kind: 'comment', text: 'pricing', occurredAt: new Date(), platform: 'instagram',
    };
    const result = await ingest(db, comment);
    check(result.outcome === 'started' && result.runId, 'Every matching comment should start one run.');
    comments.set(result.runId, comment);
    return result.runId;
  }

  async function addHot(from: number, to: number) {
    await batches(Array.from({ length: to - from }, (_, index) => from + index), async index => {
      await start(hotTenant, index);
    });
  }

  async function drain(until: () => boolean) {
    let lastSendAt = performance.now();
    let idlePolls = 0;
    const results = await Promise.allSettled(Array.from({ length: scenario.workers }, async () => {
      while (!until()) {
        const result = await deliverOne(db, adapter);
        if (result === 'idle') {
          // A peer may hold the lane lock. Poll again until the phase reaches its goal.
          idlePolls++;
          check(performance.now() - lastSendAt < 5_000, 'The drain made no progress for five seconds.');
          if (!until()) await delay(2);
          continue;
        }
        check(result === 'sent' && attempted.length <= 3 * totalRuns + 1, 'Unexpected delivery during a drain.');
        lastSendAt = performance.now();
      }
    }));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    return idlePolls;
  }

  async function quietTiming(runId: string) {
    const timings = await db.query<{ kind: string; queue_ms: number; from_run_ms: number }>(`
      SELECT o.kind, extract(epoch FROM o.first_attempt_at - o.created_at)::double precision * 1000 AS queue_ms,
             extract(epoch FROM o.sent_at - r.started_at)::double precision * 1000 AS from_run_ms
      FROM outbox o JOIN runs r ON r.id = o.run_id
      WHERE r.id = $1 AND r.state = 'waiting' AND o.status = 'sent'
    `, [runId]);
    const reply = timings.rows.find(row => row.kind === 'comment_reply');
    const prompt = timings.rows.find(row => row.kind === 'email_prompt');
    check(reply && prompt && reply.queue_ms >= 0 && prompt.queue_ms >= 0 && prompt.from_run_ms >= reply.from_run_ms,
      'Expected the quiet run to settle both ordered actions and wait.');
    return { replyQueueMs: rounded(reply.queue_ms), promptQueueMs: rounded(prompt.queue_ms), runToPromptSettledMs: rounded(prompt.from_run_ms) };
  }

  async function pendingHot() {
    const result = await db.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM outbox o JOIN runs r ON r.id = o.run_id
      WHERE r.tenant_id = $1 AND r.account_id = $2 AND o.status = 'pending'
    `, [hotTenant, accountId]);
    return result.rows[0]!.count;
  }

  try {
    stage = 'database preflight';
    const preflight = await db.query<{ empty: boolean; version: string }>(`
      SELECT NOT (EXISTS (SELECT 1 FROM automations) OR EXISTS (SELECT 1 FROM inbox)
                 OR EXISTS (SELECT 1 FROM runs) OR EXISTS (SELECT 1 FROM outbox)) AS empty,
             current_setting('server_version') AS version
    `);
    const database = preflight.rows[0];
    check(database?.empty, 'Use an empty database because workers claim from the shared outbox.');
    for (const tenantId of [hotTenant, quietTenant, cooldownTenant]) {
      await publish(db, { tenantId, accountId, keyword: 'pricing', publicReply, emailPrompt, linkUrl: link(tenantId) });
    }

    stage = 'quiet-account fairness';
    await addHot(0, scenario.hotComments - arrivalsDuringCooldown);
    check(await deliverOne(db, adapter) === 'sent', 'The hot account should establish a claim history.');
    const acceptedBeforeQuiet = sink.sent.length;
    const quietRun = await start(quietTenant, 0);
    const fairnessIdlePolls = await drain(() => prompted.has(quietRun));
    const hotSendsBefore = (kind: SocialAction['kind']) => {
      const quietEffect = sink.sent.findIndex(effect => effect.runId === quietRun && effect.kind === kind);
      check(quietEffect >= acceptedBeforeQuiet, 'The quiet account should receive its effect during the fairness phase.');
      return sink.sent.slice(acceptedBeforeQuiet, quietEffect).filter(effect => effect.tenantId === hotTenant).length;
    };
    const maxAllowedHotSendsBeforePrompt = 4 * scenario.workers;
    const fairness = {
      hotSendsBeforeReply: hotSendsBefore('comment_reply'),
      hotSendsBeforePrompt: hotSendsBefore('email_prompt'), maxAllowedHotSendsBeforePrompt,
      hotPendingAfterPrompt: await pendingHot(), idlePolls: fairnessIdlePolls, ...await quietTiming(quietRun),
    };
    check(fairness.hotSendsBeforePrompt <= maxAllowedHotSendsBeforePrompt && fairness.hotPendingAfterPrompt > 0,
      'The quiet account must receive its prompt promptly while a hot-account backlog remains.');

    stage = 'provider cooldown and isolation';
    injectRateLimit = true;
    check(await deliverOne(db, adapter) === 'retry' && limitedActionId, 'Expected a known-unsent account rate limit.');
    const attemptsBeforeCooldown = attempted.length;
    await addHot(scenario.hotComments - arrivalsDuringCooldown, scenario.hotComments);
    const cooldownRun = await start(cooldownTenant, 0);
    const isolationIdlePolls = await drain(() => prompted.has(cooldownRun));
    const cooldownProgress = await db.query<{ inside: number; wait_ms: number }>(`
      SELECT (SELECT count(*)::int FROM outbox q WHERE q.run_id = $3 AND q.status = 'sent' AND q.sent_at < c.until_at) AS inside,
        greatest(0, ceil(extract(epoch FROM greatest(c.until_at, o.available_at) - clock_timestamp()) * 1000))::double precision AS wait_ms
      FROM delivery_cooldowns c CROSS JOIN outbox o
      WHERE c.tenant_id = $1 AND c.account_id = $2 AND o.id = $4 AND o.status = 'pending' AND o.attempts = 1
    `, [hotTenant, accountId, cooldownRun, limitedActionId]);
    const pause = cooldownProgress.rows[0];
    const isolation = {
      hotArrivalsDuringCooldown: arrivalsDuringCooldown, hotPendingAtCooldownCheck: await pendingHot(),
      hotAttemptsDuringCheck: attempted.slice(attemptsBeforeCooldown).filter(effect => effect.tenantId === hotTenant).length,
      quietActionsSettledBeforeCooldownEnded: pause?.inside ?? 0, idlePolls: isolationIdlePolls, ...await quietTiming(cooldownRun),
    };
    check(pause && isolation.quietActionsSettledBeforeCooldownEnded === 2 && isolation.hotAttemptsDuringCheck === 0 &&
      isolation.hotPendingAtCooldownCheck >= arrivalsDuringCooldown, 'The rate-limited account should retain queued work while another account advances.');

    stage = 'post-cooldown drain';
    // Let the worker observe the persisted provider retry deadline. No timestamps are rewritten.
    await delay(pause.wait_ms + 1);
    const acceptedBeforeRecovery = sink.sent.length;
    const recoveryStart = performance.now();
    const recoveryIdlePolls = await drain(() => sink.sent.length >= 2 * totalRuns);
    const recovered = sink.sent.length - acceptedBeforeRecovery;
    const recoveryElapsed = performance.now() - recoveryStart;
    check(recovered > 0 && prompted.size === totalRuns && sink.sent.length === 2 * totalRuns,
      'Every initial action should settle after the account cooldown.');

    stage = 'responses and completion';
    // Provider timestamps share the test database clock and follow all prompt commits.
    const timestamp = await db.query<{ at: Date }>('SELECT clock_timestamp() AS at');
    await batches([...comments], async ([runId, comment]) => {
      const result = await ingest(db, {
        ...comment, kind: 'message', eventId: `reply-${comment.eventId}`, objectId: `reply-${comment.objectId}`,
        text: 'reader@example.org', occurredAt: timestamp.rows[0]!.at,
      });
      check(result.outcome === 'accepted' && result.runId === runId, 'The response should advance its own waiting run.');
    });
    await drain(() => sink.sent.length >= 3 * totalRuns);
    const records = await db.query<{
      completed: number; leads: number; inbox: number; outbox: number; attempts: number; effects_ok: boolean;
    }>(`
      SELECT (SELECT count(*)::int FROM runs WHERE state = 'completed') AS completed,
             (SELECT count(*)::int FROM leads) AS leads, (SELECT count(*)::int FROM inbox) AS inbox,
             count(*)::int AS outbox, sum(attempts)::int AS attempts,
             bool_and(status = 'sent' AND provider_id = ('sim-' || id::text)
               AND attempts = (CASE WHEN id = $1 THEN 2 ELSE 1 END)
               AND (id <> $1 OR sent_at >= (SELECT until_at FROM delivery_cooldowns WHERE tenant_id = $2 AND account_id = $3))) AS effects_ok
      FROM outbox
    `, [limitedActionId, hotTenant, accountId]);
    const counts = records.rows[0];
    check(counts?.completed === totalRuns && counts.leads === totalRuns && counts.inbox === 2 * totalRuns &&
      counts.outbox === 3 * totalRuns && counts.attempts === 3 * totalRuns + 1 && counts.effects_ok &&
      sink.sent.length === counts.outbox && attempted.length === counts.attempts,
    'Persistent runs, provider effects and the one safe retry should agree.');
    const seen = new Map<string, number>();
    const seenIds = new Set<string>();
    for (const effect of sink.sent) {
      const comment = comments.get(effect.runId);
      const index = seen.get(effect.runId) ?? 0;
      check(comment && !seenIds.has(effect.id) && effect.kind === kinds[index] && effect.tenantId === comment.tenantId &&
        effect.commentId === comment.objectId && effect.participantId === comment.participantId && effect.accountId === comment.accountId &&
        effect.text === [publicReply, emailPrompt, link(comment.tenantId)][index], 'Expected one exact ordered effect per run step.');
      seen.set(effect.runId, index + 1);
      seenIds.add(effect.id);
    }
    check(seen.size === totalRuns && [...seen.values()].every(count => count === 3), 'Every completed run should have three recorded effects.');

    console.log(JSON.stringify({
      environment: { node: process.version, postgres: database.version, platform: process.platform, arch: process.arch, logicalCpus: availableParallelism() },
      scenario: { ...scenario, tenants: 3, poolMax: 8, rateLimitMs }, fairness, isolation,
      recovery: { sends: recovered, elapsedMs: rounded(recoveryElapsed), sendsPerSecond: rounded(recovered * 1000 / recoveryElapsed), idlePolls: recoveryIdlePolls },
      counts: { ...counts, simulatedSends: sink.sent.length, knownUnsentRetries: 1 },
    }, null, 2));
  } finally {
    await db.end();
  }
}

try {
  await main();
} catch (error) {
  const reason = error instanceof ScenarioFailure ? ` ${error.message}` : '';
  console.error(`Skew scenario failed during ${stage}.${reason}`);
  process.exitCode = 1;
}
