import type { Pool, PoolClient } from 'pg';
import type { ActionKind } from './adapter.js';
import type { SocialEvent } from './workflow.js';

// Redact before truncation so a long address cannot leave a local-part prefix in storage.
function excerpt(text: string): string {
  const redacted = text.replace(/\S+/gu, token => token.includes('@') ? '[redacted]' : token);
  return Array.from(redacted).slice(0, 500).join('');
}

export async function recordInteraction(
  client: PoolClient, runId: string, event: SocialEvent, pendingPrompt = false,
): Promise<void> {
  await client.query(
    `INSERT INTO participant_interactions
       (tenant_id, account_id, participant_id, run_id, event_id, occurred_at, excerpt, pending_prompt)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8 WHERE $6::timestamptz > statement_timestamp() - interval '720 hours'`,
    [event.tenantId, event.accountId, event.participantId, runId, event.eventId, event.occurredAt,
      excerpt(event.text), pendingPrompt],
  );
}

export async function returningPrompt(client: PoolClient, runId: string): Promise<string | null> {
  const { rows } = await client.query<{ prompt: string }>(
    `SELECT v.returning_email_prompt AS prompt FROM runs r JOIN automation_versions v ON v.id=r.version_id
     WHERE r.id=$1 AND v.returning_email_prompt IS NOT NULL AND EXISTS (
       SELECT 1 FROM participant_interactions p
       JOIN inbox i USING (tenant_id, account_id, event_id)
       JOIN runs prior ON prior.id=p.run_id
       WHERE p.tenant_id=r.tenant_id AND p.account_id=r.account_id AND p.participant_id=r.participant_id
         AND p.run_id<>r.id AND NOT p.pending_prompt AND i.kind='message'
         AND prior.response_object_id=i.object_id AND p.occurred_at<=r.comment_occurred_at
         AND p.occurred_at > statement_timestamp() - interval '720 hours'
     )`, [runId],
  );
  return rows[0]?.prompt ?? null;
}

interface Interaction {
  kind: 'comment' | 'message';
  eventId: string;
  objectId: string;
  postId: string | null;
  occurredAt: Date;
  excerpt: string;
  runId: string;
  runState: string;
  emailAccepted: boolean;
}

export async function readParticipantContext(pool: Pool, tenantId: string, accountId: string, participantId: string) {
  type Action = { kind: ActionKind; status: string; acceptedAt: string | null };
  const { rows } = await pool.query<Interaction & { actions: Action[] }>(
    `WITH latest AS MATERIALIZED (
       SELECT i.kind, p.event_id AS "eventId", i.object_id AS "objectId", i.post_id AS "postId",
              p.occurred_at AS "occurredAt", p.excerpt, r.id AS "runId", r.state AS "runState",
              (i.kind='message' AND i.object_id IS NOT DISTINCT FROM r.response_object_id) AS "emailAccepted"
       FROM participant_interactions p JOIN inbox i USING (tenant_id, account_id, event_id)
       JOIN runs r ON r.id=p.run_id
       WHERE p.tenant_id=$1 AND p.account_id=$2 AND p.participant_id=$3 AND NOT p.pending_prompt
         AND p.occurred_at > statement_timestamp() - interval '720 hours'
       ORDER BY p.occurred_at DESC, p.event_id COLLATE "C" DESC LIMIT 51
     ), actions AS (
       SELECT o.run_id, json_agg(json_build_object(
         'kind', o.kind, 'status', o.status,
         'acceptedAt', to_char(o.sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       ) ORDER BY CASE o.kind WHEN 'comment_reply' THEN 1 WHEN 'email_prompt' THEN 2 ELSE 3 END) AS items
       FROM (SELECT DISTINCT "runId" FROM latest) ids JOIN outbox o ON o.run_id=ids."runId"
       GROUP BY o.run_id
     )
     SELECT l.*, COALESCE(a.items, '[]'::json) AS actions FROM latest l LEFT JOIN actions a ON a.run_id=l."runId"
     ORDER BY l."occurredAt" DESC, l."eventId" COLLATE "C" DESC`,
    [tenantId, accountId, participantId],
  );
  const runs = new Map<string, { runId: string; state: string; actions: Action[] }>();
  const interactions = rows.slice(0, 50).map(({ actions, ...entry }) => {
    if (!runs.has(entry.runId)) runs.set(entry.runId, { runId: entry.runId, state: entry.runState, actions });
    return entry;
  });
  return { interactions, runs: Array.from(runs.values()), truncated: rows.length > 50 };
}

export async function expireParticipantContext(pool: Pool): Promise<number> {
  const result = await pool.query(
    `WITH expired AS (
       SELECT tenant_id, account_id, event_id FROM participant_interactions
       WHERE occurred_at <= statement_timestamp() - interval '720 hours'
       ORDER BY occurred_at LIMIT 500 FOR UPDATE SKIP LOCKED
     )
     DELETE FROM participant_interactions p USING expired e
     WHERE (p.tenant_id,p.account_id,p.event_id) = (e.tenant_id,e.account_id,e.event_id)`,
  );
  return result.rowCount ?? 0;
}
