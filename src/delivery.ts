import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ActionKind, SendOutcome, SocialAction, SocialAdapter } from "./adapter.js";
import {
  onDeliveryExpired, onDeliveryFailed, onDeliverySent, onPromptStarted, onPromptUnsent, transaction,
} from "./workflow.js";

export interface WorkerOptions {
  leaseMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
}

export type DeliveryResult = "idle" | "sent" | "retry" | "uncertain" | "failed" | "stale" | "expired";

interface Claim {
  action: SocialAction;
  token: string;
  attempt: number;
  leaseUntil: Date;
}

export async function expireLeases(pool: Pool): Promise<number> {
  const result = await pool.query(`
    WITH expired AS (
      SELECT id FROM outbox WHERE status = 'leased' AND lease_until <= statement_timestamp()
      ORDER BY lease_until, id LIMIT 128 FOR UPDATE SKIP LOCKED
    )
    UPDATE outbox SET status = 'uncertain', lease_until = NULL, lease_token = NULL,
                      last_error = 'lease_expired'
    FROM expired WHERE outbox.id = expired.id
  `);
  return result.rowCount ?? 0;
}

async function expirePending(pool: Pool): Promise<boolean> {
  return transaction(pool, async (client) => {
    // An account cooldown or a delayed retry can outlive the original send window.
    const expired = await client.query<ActionRef>(`
      SELECT id, run_id AS "runId", kind FROM outbox
      WHERE status = 'pending' AND send_before <= statement_timestamp()
      ORDER BY send_before, id LIMIT 1 FOR UPDATE SKIP LOCKED
    `);
    if (!expired.rows[0]) return false;
    await settleExpired(client, expired.rows[0]);
    return true;
  });
}

async function claim(pool: Pool, leaseMs: number): Promise<Claim | undefined> {
  return transaction(pool, async (client) => {
    const result = await client.query<Omit<SocialAction, "sendBefore"> & { cutoff: Date }>(`
      WITH candidate AS MATERIALIZED (
        SELECT o.id, o.run_id, o.kind, o.send_before
        FROM delivery_lanes l
        CROSS JOIN LATERAL (
          SELECT q.id FROM outbox q
          WHERE q.tenant_id=l.tenant_id AND q.account_id=l.account_id AND q.status='pending'
            AND q.available_at <= statement_timestamp() AND q.send_before > statement_timestamp()
          ORDER BY q.available_at, q.id LIMIT 1
        ) head
        JOIN outbox o ON o.id=head.id AND o.status='pending'
        WHERE l.pending_count > 0 AND NOT EXISTS (
          SELECT 1 FROM delivery_cooldowns c WHERE c.tenant_id=l.tenant_id AND c.account_id=l.account_id
            AND c.until_at > statement_timestamp()
        )
        ORDER BY l.turn LIMIT 1 FOR UPDATE OF l, o SKIP LOCKED
      )
      SELECT o.id, o.run_id AS "runId", r.tenant_id AS "tenantId",
             r.account_id AS "accountId", r.participant_id AS "participantId",
             r.comment_id AS "commentId", o.kind, o.send_before AS cutoff,
             CASE o.kind WHEN 'comment_reply' THEN v.public_reply
                         WHEN 'email_prompt' THEN v.email_prompt ELSE v.link_url END AS text
      FROM candidate o JOIN runs r ON r.id=o.run_id
      JOIN automation_versions v ON v.id=r.version_id
    `);
    const row = result.rows[0];
    if (!row) return;
    const { cutoff, ...fields } = row;
    const action: SocialAction = { ...fields, sendBefore: cutoff.toISOString() };
    const token = randomUUID();
    const updated = await client.query<{ attempts: number; lease_until: Date }>(`
      UPDATE outbox SET status = 'leased', attempts = attempts + 1, lease_token = $2,
             lease_until = clock_timestamp() + $3 * interval '1 millisecond',
             first_attempt_at = COALESCE(first_attempt_at, clock_timestamp())
      WHERE id = $1 RETURNING attempts, lease_until
    `, [action.id, token, leaseMs]);
    await client.query(`
      UPDATE delivery_lanes SET turn=nextval('delivery_turn_seq') WHERE tenant_id=$1 AND account_id=$2
    `, [action.tenantId, action.accountId]);
    return { action, token, attempt: updated.rows[0]!.attempts, leaseUntil: updated.rows[0]!.lease_until };
  });
}

function validReceipt(receipt: string | undefined): receipt is string {
  return typeof receipt === "string" && receipt.length > 0 && receipt.length <= 256
    && !/[\s\p{C}]/u.test(receipt);
}

function errorCode(code: string): string {
  return /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "adapter_error";
}

async function send(adapter: SocialAdapter, action: SocialAction, timeoutMs: number): Promise<SendOutcome> {
  const remainingMs = Date.parse(action.sendBefore) - Date.now();
  if (remainingMs <= 0) return { kind: "rejected", code: "window_expired" };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<SendOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "uncertain", code: "send_timeout" });
    }, Math.min(timeoutMs, remainingMs));
  });
  try {
    return await Promise.race([adapter.send(action, controller.signal), deadline]);
  } catch {
    return { kind: "uncertain", code: "transport_exception" };
  } finally {
    clearTimeout(timer);
  }
}

interface ActionRef { id: string; runId: string; kind: ActionKind }

async function settleSent(client: PoolClient, action: ActionRef, receipt: string): Promise<void> {
  await client.query(`
    UPDATE outbox SET status = 'sent', provider_id = $2, sent_at = clock_timestamp(),
           lease_until = NULL, lease_token = NULL, last_error = NULL WHERE id = $1
  `, [action.id, receipt]);
  await onDeliverySent(client, action.runId, action.kind);
}

async function settleFailed(client: PoolClient, action: ActionRef, code: string): Promise<void> {
  await client.query(`
    UPDATE outbox SET status = 'failed', last_error = $2, lease_until = NULL,
           lease_token = NULL WHERE id = $1
  `, [action.id, code]);
  await onDeliveryFailed(client, action.runId);
}

async function settleExpired(client: PoolClient, action: ActionRef): Promise<void> {
  // Acquire the conversation before the outbox update takes its lane counter lock.
  await onDeliveryExpired(client, action.runId);
  await client.query(`
    UPDATE outbox SET status = 'failed', last_error = 'window_expired', lease_until = NULL,
           lease_token = NULL WHERE id = $1
  `, [action.id]);
}

async function requeue(client: PoolClient, action: ActionRef, code: string, delayMs: number): Promise<"expired" | "retry"> {
  if (action.kind === "email_prompt") await onPromptUnsent(client, action.runId);
  const result = await client.query(`
    WITH due AS (SELECT clock_timestamp() + $3 * interval '1 millisecond' AS at)
    UPDATE outbox SET status = 'pending', last_error = $2, lease_until = NULL, lease_token = NULL,
           available_at = due.at FROM due WHERE id = $1 AND due.at < send_before
  `, [action.id, code, delayMs]);
  if (result.rowCount) return "retry";
  await settleExpired(client, action);
  return "expired";
}

function retryDelay(baseDelayMs: number, attempt: number, retryAfterMs = 0): number {
  const cap = Math.min(60_000, baseDelayMs * 2 ** Math.min(attempt - 1, 16));
  return Math.max(retryAfterMs, Math.ceil(cap * (0.5 + Math.random() * 0.5)));
}

export async function deliverOne(pool: Pool, adapter: SocialAdapter, options: WorkerOptions = {}): Promise<DeliveryResult> {
  const { leaseMs = 30_000, maxAttempts = 5, baseDelayMs = 1_000 } = options;
  for (const [value, min, max] of [[leaseMs, 1, 3_600_000], [maxAttempts, 1, 1_000], [baseDelayMs, 0, 60_000]] as const) {
    if (!Number.isInteger(value) || value < min || value > max) throw new RangeError("Invalid worker options");
  }
  await expireLeases(pool);
  const expired = await expirePending(pool);
  const job = await claim(pool, leaseMs);
  if (!job) return expired ? "expired" : "idle";

  const { action, token, attempt } = job;
  if (action.kind === "email_prompt") {
    // Ingestion can hold a conversation lock while enqueueing into its lane. Release the
    // scheduler's lane lock before opening the response window under the conversation lock.
    const armed = await transaction<DeliveryResult | "armed">(pool, async client => {
      const owned = await client.query(`
        SELECT id FROM outbox WHERE id=$1 AND status='leased' AND lease_token=$2
          AND lease_until > clock_timestamp() FOR UPDATE
      `, [action.id, token]);
      if (!owned.rowCount) return "stale";
      const personalPrompt = await onPromptStarted(client, action.runId);
      if (personalPrompt !== null) action.text = personalPrompt;
      const stillOwned = await client.query(
        'SELECT 1 FROM outbox WHERE id=$1 AND lease_until > clock_timestamp()', [action.id],
      );
      if (stillOwned.rowCount) return "armed";
      // We held this intent throughout arming and have not called the adapter.
      if (attempt < maxAttempts) return requeue(client, action, "lease_elapsed_before_send", 0);
      await settleFailed(client, action, "lease_elapsed_before_send");
      return "failed";
    });
    if (armed !== "armed") return armed;
  }
  const leaseRemaining = job.leaseUntil.getTime() - Date.now();
  if (leaseRemaining <= 0) return "stale";
  const timeoutMs = Math.min(leaseRemaining, Math.max(1, Math.floor(leaseMs * 0.8)));
  const outcome = await send(adapter, action, timeoutMs);
  return transaction(pool, async (client) => {
    const fence = await client.query(`
      SELECT id FROM outbox WHERE id = $1 AND lease_token = $2 AND status = 'leased'
        AND lease_until > clock_timestamp() FOR UPDATE
    `, [action.id, token]);
    if (!fence.rowCount) return "stale";

    if (outcome.kind === "sent" && validReceipt(outcome.receipt)) {
      await settleSent(client, action, outcome.receipt);
      return "sent";
    }
    if (outcome.kind === "retry" || outcome.kind === "rejected") {
      const code = errorCode(outcome.code);
      if (outcome.kind === "rejected") {
        if (code === "window_expired") {
          await settleExpired(client, action);
          return "expired";
        }
        await settleFailed(client, action, code);
        return "failed";
      }
      const wait = outcome.retryAfterMs ?? 0;
      // A rate limit beyond this range needs a policy change or operator intervention.
      if (!Number.isSafeInteger(wait) || wait < 0 || wait > 31_536_000_000) {
        await settleFailed(client, action, "invalid_retry_delay");
        return "failed";
      }
      const delayMs = retryDelay(baseDelayMs, attempt, wait);
      if (code === "rate_limited") {
        await client.query(`
          INSERT INTO delivery_cooldowns (tenant_id, account_id, until_at)
          VALUES ($1,$2, clock_timestamp() + $3 * interval '1 millisecond')
          ON CONFLICT (tenant_id, account_id) DO UPDATE
          SET until_at = GREATEST(delivery_cooldowns.until_at, EXCLUDED.until_at)
        `, [action.tenantId, action.accountId, delayMs]);
      }
      if (attempt >= maxAttempts) {
        await settleFailed(client, action, code);
        return "failed";
      }
      return requeue(client, action, code, delayMs);
    }
    const code = outcome.kind === "uncertain" ? errorCode(outcome.code) : "invalid_receipt";
    await client.query(`
      UPDATE outbox SET status = 'uncertain', last_error = $2, lease_token = NULL,
             lease_until = NULL WHERE id = $1
    `, [action.id, code]);
    return "uncertain";
  });
}

export interface Reconciliation {
  tenantId: string;
  actionId: string;
  expectedAttempt: number;
  decision: "confirmed_sent" | "confirmed_absent" | "abandon";
  operatorId: string;
  /** A case reference. Keep message contents and user identifiers out of the audit trail. */
  evidence: string;
  providerReceipt?: string;
  /** Evidence that the old dispatcher cannot submit a late request. Required to resend. */
  quiescenceEvidence?: string;
}

/**
 * Trusted operator entry point. A confirmed absence requires both a definitive provider
 * result and proof that the previous sender can no longer issue an outstanding request.
 * A missing message in a delayed activity feed cannot establish either condition.
 */
export async function reconcile(pool: Pool, input: Reconciliation): Promise<boolean> {
  if (!input.operatorId.trim() || input.operatorId.length > 128 || !input.evidence.trim() || input.evidence.length > 512
      || !Number.isSafeInteger(input.expectedAttempt) || input.expectedAttempt < 1) {
    throw new TypeError("Supply the attempt number, operator identity and evidence reference");
  }
  if (input.decision === "confirmed_sent" && !validReceipt(input.providerReceipt)) {
    throw new TypeError("Confirmed delivery requires an opaque provider receipt");
  }
  if (input.decision === "confirmed_absent" && (!input.quiescenceEvidence?.trim() || input.quiescenceEvidence.length > 512)) {
    throw new TypeError("Confirmed absence requires evidence that the previous dispatcher is quiescent");
  }
  return transaction(pool, async (client) => {
    const locked = await client.query<ActionRef>(`
      SELECT o.id, o.run_id AS "runId", o.kind FROM outbox o JOIN runs r ON r.id = o.run_id
      WHERE r.tenant_id = $1 AND o.id = $2 AND o.attempts = $3 AND o.status = 'uncertain'
      FOR UPDATE OF o
    `, [input.tenantId, input.actionId, input.expectedAttempt]);
    const action = locked.rows[0];
    if (!action) return false;
    await client.query(`
      INSERT INTO delivery_reconciliations (action_id, attempt, operator_id, evidence, decision, quiescence_evidence)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [action.id, input.expectedAttempt, input.operatorId, input.evidence, input.decision,
      input.decision === "confirmed_absent" ? input.quiescenceEvidence : null]);
    switch (input.decision) {
      case "confirmed_sent":
        await settleSent(client, action, input.providerReceipt!);
        break;
      case "confirmed_absent":
        await requeue(client, action, "confirmed_absent", 0);
        break;
      case "abandon":
        await settleFailed(client, action, "operator_abandoned");
        break;
    }
    return true;
  });
}
