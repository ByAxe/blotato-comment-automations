import { randomUUID } from 'node:crypto';
import pg from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('Set DATABASE_URL to the migrated test database.');
}

export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export function input(scenario: string) {
  return {
    tenantId: `${scenario}-${randomUUID()}`,
    accountId: 'ig-business-account',
    keyword: 'pricing',
    publicReply: 'Sent you a DM!',
    emailPrompt: 'What email address should I use?',
    linkUrl: 'https://example.org/pricing',
  };
}

type Account = Pick<ReturnType<typeof input>, 'tenantId' | 'accountId'>;

export function comment(account: Account, eventId: string, participantId = 'reader') {
  return {
    tenantId: account.tenantId,
    accountId: account.accountId,
    participantId,
    eventId,
    objectId: eventId,
    kind: 'comment' as const,
    platform: 'instagram' as const,
    text: 'pricing',
    occurredAt: new Date(),
  };
}

export function message(account: Account, eventId: string, text: string, occurredAt: Date, participantId = 'reader') {
  return { ...comment(account, eventId, participantId), kind: 'message' as const, text, occurredAt };
}

// Use the database clock for the synthetic provider event. Both timestamps can
// share a millisecond when the worker and the fixture run on the same machine.
export async function afterPrompt(runId: string) {
  const result = await db.query<{ sent_at: Date }>(
    'SELECT clock_timestamp() AS sent_at FROM runs WHERE id = $1 AND prompt_started_at IS NOT NULL',
    [runId],
  );
  const timestamp = result.rows[0]?.sent_at;
  if (!timestamp) throw new Error('Expected a prompt attempt with a recorded timestamp.');
  return timestamp;
}
