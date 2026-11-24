import type { Pool, PoolClient } from 'pg';
import type { ActionKind } from './adapter.js';
import { recordInteraction, returningPrompt } from './participant-context.js';

const REPLY_ACTION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export interface DefinitionInput {
  tenantId: string;
  accountId: string;
  keyword: string;
  postId?: string | null;
  publicReply: string;
  emailPrompt: string;
  collectParticipantContext?: boolean;
  returningEmailPrompt?: string | null;
  linkUrl: string;
}

export interface SocialEvent {
  tenantId: string;
  accountId: string;
  participantId: string;
  platform: 'instagram';
  eventId: string;
  objectId: string;
  postId?: string | null;
  /** Omit for a plain DM. Use null for an explicit reply with no verified action mapping. */
  replyToActionId?: string | null;
  kind: 'comment' | 'message';
  text: string;
  occurredAt: Date;
  isSelf?: boolean;
}

type Outcome = 'started' | 'busy' | 'ignored' | 'duplicate' | 'buffered' | 'accepted';
interface IngestResult { outcome: Outcome; runId: string | null }
interface Run {
  id: string;
  tenant_id: string;
  account_id: string;
  participant_id: string;
  state: string;
  prompt_started_at: Date | null;
  expires_at: Date | null;
  collect_participant_context: boolean;
}

export async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    throw error;
  } finally {
    client.release(broken);
  }
}

function requiredString(value: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) {
    throw new TypeError('Expected a nonempty string within the field limit.');
  }
  return value;
}

function optionalPostId(value: string | null | undefined): string | null {
  return value == null ? null : requiredString(value, 255);
}

function normalized(text: string): string {
  return text.trim().toLowerCase();
}

function emailFrom(text: string): string | null {
  const tokens = text.split(/[\s<>()\[\],;:"]+/u).filter(token => token.includes('@'));
  if (tokens.length !== 1) return null;
  const address = tokens[0]!.replace(/[.!?]$/, '');
  const parts = address.split('@');
  if (parts.length !== 2 || address.length > 254) return null;
  const local = parts[0]!;
  const domain = parts[1]!;
  if (local.length > 64 || !/^[a-z\d%_+'-]+(\.[a-z\d%_+'-]+)*$/i.test(local)) return null;
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some(label => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) {
    return null;
  }
  return local + '@' + domain.toLowerCase();
}

export async function publish(pool: Pool, input: DefinitionInput): Promise<string> {
  const { tenantId, accountId } = input;
  requiredString(tenantId, 255);
  requiredString(accountId, 255);
  const keyword = normalized(requiredString(input.keyword, 128));
  const postId = optionalPostId(input.postId);
  const reply = requiredString(input.publicReply, 2000).trim();
  const prompt = requiredString(input.emailPrompt, 2000).trim();
  const collect = input.collectParticipantContext === undefined ? false : input.collectParticipantContext;
  if (typeof collect !== 'boolean') throw new TypeError('Expected a participant context flag.');
  const returning = input.returningEmailPrompt == null ? null : requiredString(input.returningEmailPrompt, 2000).trim();
  if (returning && !collect) throw new TypeError('A returning prompt requires participant context.');
  const link = requiredString(input.linkUrl, 2048).trim();
  const url = new URL(link);
  if (!/^https:\/\//i.test(link) || /[\s\\\p{C}]/u.test(link) || url.protocol !== 'https:'
      || url.username || url.password) {
    throw new TypeError('The link must be an absolute HTTPS URL without credentials.');
  }

  return transaction(pool, async client => {
    await client.query(
      'INSERT INTO automations (tenant_id, account_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [tenantId, accountId],
    );
    await client.query(
      'SELECT 1 FROM automations WHERE tenant_id=$1 AND account_id=$2 FOR UPDATE', [tenantId, accountId],
    );
    const created = await client.query<{ id: string }>(
      `INSERT INTO automation_versions (tenant_id, account_id, revision, keyword, public_reply, email_prompt,
                                        link_url, post_id, collect_participant_context, returning_email_prompt)
       SELECT $1, $2, COALESCE(max(revision),0)+1, $3, $4, $5, $6, $7, $8, $9
       FROM automation_versions WHERE tenant_id=$1 AND account_id=$2 RETURNING id`,
      [tenantId, accountId, keyword, reply, prompt, link, postId, collect, returning],
    );
    const versionId = created.rows[0]!.id;
    await client.query(
      'UPDATE automations SET current_version_id=$3 WHERE tenant_id=$1 AND account_id=$2',
      [tenantId, accountId, versionId],
    );
    return versionId;
  });
}

export async function setEnabled(pool: Pool, tenantId: string, accountId: string, enabled: boolean): Promise<boolean> {
  requiredString(tenantId, 255);
  requiredString(accountId, 255);
  if (typeof enabled !== 'boolean') throw new TypeError('Expected an enabled flag.');
  const result = await pool.query(
    'UPDATE automations SET enabled=$3 WHERE tenant_id=$1 AND account_id=$2', [tenantId, accountId, enabled],
  );
  return result.rowCount === 1;
}

async function lockConversation(client: PoolClient, tenantId: string, accountId: string, participantId: string) {
  // A hash collision only serializes two unrelated conversations. Every data query uses the full scope.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    JSON.stringify([tenantId, accountId, participantId]),
  ]);
}

export async function forgetParticipantContext(pool: Pool, tenantId: string, accountId: string, participantId: string) {
  for (const id of [tenantId, accountId, participantId]) requiredString(id, 255);
  const scope = [tenantId, accountId, participantId];
  await transaction(pool, async client => {
    await lockConversation(client, tenantId, accountId, participantId);
    await client.query(
      `UPDATE runs SET collect_participant_context=false WHERE tenant_id=$1 AND account_id=$2 AND participant_id=$3
       AND collect_participant_context AND state IN ('reply_pending','prompt_pending','waiting','link_pending')`, scope,
    );
    await client.query(
      'DELETE FROM participant_interactions WHERE tenant_id=$1 AND account_id=$2 AND participant_id=$3', scope,
    );
  });
}

async function lockRun(client: PoolClient, id: string): Promise<Run> {
  const scope = (await client.query<Run>('SELECT * FROM runs WHERE id=$1', [id])).rows[0];
  if (!scope) throw new Error('Run does not exist.');
  await lockConversation(client, scope.tenant_id, scope.account_id, scope.participant_id);
  const run = (await client.query<Run>('SELECT * FROM runs WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!run) throw new Error('Run disappeared during processing.');
  return run;
}

async function enqueue(client: PoolClient, runId: string, kind: ActionKind) {
  await client.query(
    `INSERT INTO outbox (run_id, kind, send_before)
     SELECT id, $2, CASE WHEN $2='link_dm' THEN response_occurred_at + interval '24 hours'
                         ELSE comment_occurred_at + interval '168 hours' END
     FROM runs WHERE id=$1`, [runId, kind],
  );
}

interface EmailResponse { email: string; objectId: string; occurredAt: Date }

async function capture(client: PoolClient, runId: string, response: EmailResponse) {
  await client.query('INSERT INTO leads (run_id, email) VALUES ($1,$2)', [runId, response.email]);
  await client.query(
    "UPDATE runs SET state='link_pending', response_object_id=$2, response_occurred_at=$3 WHERE id=$1",
    [runId, response.objectId, response.occurredAt],
  );
  await enqueue(client, runId, 'link_dm');
}

async function expireIfDue(client: PoolClient, runId: string): Promise<boolean> {
  const expired = await client.query(
    `UPDATE runs SET state='expired', finished_at=clock_timestamp()
     WHERE id=$1 AND state='waiting' AND expires_at<=clock_timestamp()`, [runId],
  );
  return expired.rowCount === 1;
}

async function handleComment(
  client: PoolClient, event: SocialEvent, active: Run | undefined, postId: string | null,
): Promise<IngestResult> {
  const version = (await client.query<{ id: string; collect_participant_context: boolean }>(
    `SELECT v.id, v.collect_participant_context FROM automations a JOIN automation_versions v ON v.id=a.current_version_id
     WHERE a.tenant_id=$1 AND a.account_id=$2 AND a.enabled AND v.keyword=$3
       AND (v.post_id IS NULL OR v.post_id=$4)`,
    [event.tenantId, event.accountId, normalized(event.text), postId],
  )).rows[0];
  if (!version) return { outcome: 'ignored', runId: null };
  if (active) return { outcome: 'busy', runId: active.id };
  const run = (await client.query<{ id: string }>(
    `INSERT INTO runs (tenant_id, account_id, participant_id, comment_id, version_id, comment_occurred_at,
                       collect_participant_context, state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'reply_pending')
     ON CONFLICT (tenant_id, account_id, comment_id) DO NOTHING RETURNING id`,
    [event.tenantId, event.accountId, event.participantId, event.objectId, version.id, event.occurredAt,
      version.collect_participant_context],
  )).rows[0];
  if (!run) return { outcome: 'duplicate', runId: null };
  if (version.collect_participant_context) await recordInteraction(client, run.id, event);
  await enqueue(client, run.id, 'comment_reply');
  return { outcome: 'started', runId: run.id };
}

async function handleMessage(
  client: PoolClient, event: SocialEvent, active: Run | undefined, receivedAt: Date,
): Promise<IngestResult> {
  const ignored: IngestResult = { outcome: 'ignored', runId: null };
  if (!active || !['prompt_pending', 'waiting'].includes(active.state)
      || !active.prompt_started_at || !active.expires_at) return ignored;
  const start = active.prompt_started_at;
  const deadline = active.expires_at;
  if (event.occurredAt < start || receivedAt < start || receivedAt >= deadline) {
    return ignored;
  }
  if (event.replyToActionId === null) return ignored;
  if (event.replyToActionId !== undefined) {
    const target = await client.query(
      "SELECT 1 FROM outbox WHERE run_id=$1 AND kind='email_prompt' AND id=$2",
      [active.id, event.replyToActionId],
    );
    if (!target.rowCount) return ignored;
  }
  const email = emailFrom(event.text);
  if (active.state === 'prompt_pending') {
    if (!email) return ignored;
    const inserted = await client.query(
      `INSERT INTO buffered_emails (run_id,email,occurred_at,received_at,object_id) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (run_id) DO NOTHING`, [active.id, email, event.occurredAt, receivedAt, event.objectId],
    );
    if (!inserted.rowCount) return ignored;
    if (active.collect_participant_context) await recordInteraction(client, active.id, event, true);
    return { outcome: 'buffered', runId: active.id };
  }
  if (active.collect_participant_context) await recordInteraction(client, active.id, event);
  if (!email) return ignored;
  await capture(client, active.id, { email, objectId: event.objectId, occurredAt: event.occurredAt });
  return { outcome: 'accepted', runId: active.id };
}

export async function ingest(pool: Pool, event: SocialEvent): Promise<IngestResult> {
  for (const id of [event.tenantId, event.accountId, event.participantId, event.eventId, event.objectId]) {
    requiredString(id, 255);
  }
  if (event.kind === 'message' && Object.hasOwn(event, 'postId')) {
    throw new TypeError('Only a comment can have a post ID.');
  }
  if ('replyToActionId' in event) {
    if (event.kind !== 'message') throw new TypeError('Only a message can have a reply target.');
    const { replyToActionId } = event;
    if (replyToActionId !== null && (typeof replyToActionId !== 'string' || !REPLY_ACTION_ID.test(replyToActionId))) {
      throw new TypeError('A reply target must be an action UUID or null.');
    }
  }
  const postId = optionalPostId(event.postId);
  if (event.platform !== 'instagram' || event.isSelf) return { outcome: 'ignored', runId: null };
  if (!['message','comment'].includes(event.kind) || !(event.occurredAt instanceof Date)
      || !Number.isFinite(event.occurredAt.getTime()) || typeof event.text !== 'string'
      || event.text.includes('\0') || event.text.length > 16000) {
    throw new TypeError('Invalid normalized social event.');
  }
  return transaction(pool, async client => {
    await lockConversation(client, event.tenantId, event.accountId, event.participantId);
    const receipt = (await client.query<{ received_at: Date }>(
      `INSERT INTO inbox (tenant_id,account_id,event_id,kind,object_id,occurred_at,post_id) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT DO NOTHING RETURNING received_at`,
      [event.tenantId, event.accountId, event.eventId, event.kind, event.objectId, event.occurredAt, postId],
    )).rows[0];
    if (!receipt) return { outcome: 'duplicate', runId: null };
    if (event.occurredAt > receipt.received_at) return { outcome: 'ignored', runId: null };
    let active: Run | undefined = (await client.query<Run>(
      `SELECT * FROM runs WHERE tenant_id=$1 AND account_id=$2 AND participant_id=$3
       AND state IN ('reply_pending','prompt_pending','waiting','link_pending') FOR UPDATE`,
      [event.tenantId, event.accountId, event.participantId],
    )).rows[0];
    if (active?.state === 'waiting' && active.expires_at && receipt.received_at >= active.expires_at) {
      await expireIfDue(client, active.id);
      active = undefined;
    }
    if (event.kind === 'comment') return handleComment(client, event, active, postId);
    return handleMessage(client, event, active, receipt.received_at);
  });
}

// Called inside the delivery worker's transaction before its network call.
export async function onPromptStarted(client: PoolClient, runId: string): Promise<string | null> {
  const run = await lockRun(client, runId);
  if (run.state !== 'prompt_pending') throw new Error('Unexpected prompt claim.');
  await client.query(
    `WITH instant AS (SELECT date_trunc('milliseconds', clock_timestamp()) AS t)
     UPDATE runs SET prompt_started_at=t, expires_at=t + interval '24 hours'
     FROM instant WHERE id=$1 AND prompt_started_at IS NULL`, [runId],
  );
  return run.collect_participant_context ? returningPrompt(client, runId) : null;
}

// A retry after a proven non-send must open a fresh correlation window.
export async function onPromptUnsent(client: PoolClient, runId: string): Promise<void> {
  const run = await lockRun(client, runId);
  if (run.state !== 'prompt_pending') throw new Error('Unexpected prompt rejection.');
  await client.query('DELETE FROM buffered_emails WHERE run_id=$1', [runId]);
  if (run.collect_participant_context) {
    await client.query('DELETE FROM participant_interactions WHERE run_id=$1 AND pending_prompt', [runId]);
  }
  await client.query('UPDATE runs SET prompt_started_at=NULL, expires_at=NULL WHERE id=$1', [runId]);
}

export async function onDeliverySent(client: PoolClient, runId: string, kind: ActionKind): Promise<void> {
  const run = await lockRun(client, runId);
  const expected = { comment_reply: 'reply_pending', email_prompt: 'prompt_pending', link_dm: 'link_pending' };
  if (run.state !== expected[kind]) throw new Error('Delivery does not match the current workflow step.');
  if (kind === 'comment_reply') {
    await client.query("UPDATE runs SET state='prompt_pending' WHERE id=$1", [runId]);
    await enqueue(client, runId, 'email_prompt');
  } else if (kind === 'email_prompt') {
    if (!run.prompt_started_at) throw new Error('Prompt has no send-attempt boundary.');
    const candidate = (await client.query<EmailResponse>(
      'DELETE FROM buffered_emails WHERE run_id=$1 RETURNING email, object_id AS "objectId", occurred_at AS "occurredAt"', [runId],
    )).rows[0];
    if (candidate) {
      if (run.collect_participant_context) {
        await client.query('UPDATE participant_interactions SET pending_prompt=false WHERE run_id=$1 AND pending_prompt', [runId]);
      }
      await capture(client, runId, candidate);
    } else {
      await client.query("UPDATE runs SET state='waiting' WHERE id=$1", [runId]);
      await expireIfDue(client, runId);
    }
  } else {
    await client.query("UPDATE runs SET state='completed', finished_at=clock_timestamp() WHERE id=$1", [runId]);
  }
}

async function finishUnsent(client: PoolClient, runId: string, state: 'expired' | 'failed'): Promise<void> {
  const run = await lockRun(client, runId);
  await client.query('DELETE FROM buffered_emails WHERE run_id=$1', [runId]);
  if (run.collect_participant_context) {
    await client.query('DELETE FROM participant_interactions WHERE run_id=$1 AND pending_prompt', [runId]);
  }
  await client.query('UPDATE runs SET state=$2, finished_at=clock_timestamp() WHERE id=$1', [runId, state]);
}

export function onDeliveryExpired(client: PoolClient, runId: string): Promise<void> {
  return finishUnsent(client, runId, 'expired');
}

export function onDeliveryFailed(client: PoolClient, runId: string): Promise<void> {
  return finishUnsent(client, runId, 'failed');
}

export async function expireWaits(pool: Pool, limit = 100): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Invalid expiry batch size.');
  const candidates = await pool.query<{ id: string }>(
    `SELECT id FROM runs WHERE state='waiting' AND expires_at<=statement_timestamp()
     ORDER BY expires_at,id LIMIT $1`, [limit],
  );
  let count = 0;
  for (const { id } of candidates.rows) {
    const expired = await transaction(pool, async client => {
      await lockRun(client, id);
      return expireIfDue(client, id);
    });
    if (expired) count++;
  }
  return count;
}
