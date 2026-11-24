import { setTimeout as wait } from 'node:timers/promises';
import { deliverOne } from '../delivery.js';
import { FakeHttpSocialAdapter } from '../http-provider.js';
import { databaseReady, integerEnv, logEvent, logFailure, openPool, requiredEnv } from '../runtime.js';
import { expireWaits } from '../workflow.js';
import { expireParticipantContext } from '../participant-context.js';

async function main(): Promise<void> {
  const pollMs = integerEnv('WORKER_POLL_MS', 1_000, 10, 60_000);
  const adapter = new FakeHttpSocialAdapter(requiredEnv('PROVIDER_URL'), requiredEnv('PROVIDER_TOKEN'));
  const pool = openPool();
  const stop = new AbortController();
  const shutdown = () => stop.abort();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  try {
    if (!await databaseReady(pool)) {
      logFailure('database_schema_missing');
      throw new Error('Database schema is unavailable');
    }

    if (!stop.signal.aborted) logEvent('worker_ready');
    let nextContextSweep = 0;
    while (!stop.signal.aborted) {
      try {
        if (Date.now() >= nextContextSweep) {
          const removed = await expireParticipantContext(pool);
          if (removed === 0) nextContextSweep = Date.now() + 60_000;
        }
        await expireWaits(pool);
        if (stop.signal.aborted) break;
        const outcome = await deliverOne(pool, adapter);
        if (outcome !== 'idle') continue;
      } catch {
        logFailure('worker_iteration_error');
      }

      try {
        await wait(pollMs, undefined, { signal: stop.signal });
      } catch (error) {
        if (!stop.signal.aborted) throw error;
      }
    }
  } finally {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  logFailure('worker_startup_or_runtime_error', error);
  process.exitCode = 1;
});
