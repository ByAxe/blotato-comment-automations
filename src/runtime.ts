import { once } from 'node:events';
import type { Server } from 'node:http';
import pg from 'pg';
import type { Pool } from 'pg';

export class ConfigurationError extends Error {}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConfigurationError(`Set ${name} before starting the process`);
  return value;
}

export function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const value = process.env[name] ?? String(fallback);
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new ConfigurationError(`${name} must be an integer in the range ${min} through ${max}`);
  }
  return number;
}

export function logEvent(event: string, fields: Record<string, string | number> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

export function logFailure(event: string, error?: unknown): void {
  // Driver and network errors can contain query values, addresses or credentials.
  const details = error instanceof ConfigurationError ? { message: error.message } : {};
  console.error(JSON.stringify({ event, ...details }));
}

export function openPool(): Pool {
  const pool = new pg.Pool({
    connectionString: requiredEnv('DATABASE_URL'),
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
  });
  pool.on('error', () => logFailure('database_idle_connection_error'));
  return pool;
}

export async function databaseReady(db: Pick<Pool, 'query'>): Promise<boolean> {
  const result = await db.query<{ ready: boolean }>(`
    WITH required_columns(relation_name, column_name) AS (
      VALUES ('outbox', 'send_before'), ('outbox', 'sent_at'),
             ('outbox', 'tenant_id'), ('outbox', 'account_id'),
             ('delivery_lanes', 'pending_count'), ('delivery_lanes', 'turn'),
             ('automation_versions', 'post_id'), ('inbox', 'post_id')
    )
    SELECT to_regclass('automations') IS NOT NULL
       AND to_regclass('runs') IS NOT NULL
       AND to_regclass('buffered_emails') IS NOT NULL
       AND to_regclass('leads') IS NOT NULL
       AND to_regclass('delivery_cooldowns') IS NOT NULL
       AND to_regclass('delivery_turn_seq') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM required_columns required
         WHERE NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_attribute column_info
           WHERE column_info.attrelid = to_regclass(required.relation_name)
             AND column_info.attname = required.column_name
             AND NOT column_info.attisdropped
         )
       ) AS ready
  `);
  return result.rows[0]?.ready === true;
}

export async function runServer(server: Server, host: string, port: number, event: string): Promise<void> {
  server.listen(port, host);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP listener address is unavailable');
  const stop = () => {
    server.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  logEvent(event, { port: address.port });
  try {
    await once(server, 'close');
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
