import { createHttpServer } from '../src/http.js';
import { databaseReady, integerEnv, logFailure, openPool, requiredEnv, runServer } from '../src/runtime.js';

async function main(): Promise<void> {
  const access = {
    tenantId: requiredEnv('DEMO_TENANT_ID'),
    accountId: requiredEnv('DEMO_ACCOUNT_ID'),
    controlToken: requiredEnv('DEMO_CONTROL_TOKEN'),
    adapterToken: requiredEnv('DEMO_ADAPTER_TOKEN'),
  };
  const host = process.env.HOST ?? '127.0.0.1';
  const port = integerEnv('PORT', 3_000, 0, 65_535);
  const pool = openPool();
  try {
    const server = createHttpServer(pool, access);
    if (!await databaseReady(pool)) {
      logFailure('database_schema_missing');
      throw new Error('Database schema is unavailable');
    }

    await runServer(server, host, port, 'listening');
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  logFailure('server_startup_or_runtime_error', error);
  process.exitCode = 1;
});
