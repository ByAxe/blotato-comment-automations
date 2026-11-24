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

export async function databaseReady(pool: Pool): Promise<boolean> {
  const result = await pool.query<{ ready: boolean }>(`
    SELECT to_regclass('automations') IS NOT NULL
       AND to_regclass('outbox') IS NOT NULL
       AND to_regclass('delivery_cooldowns') IS NOT NULL AS ready
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
