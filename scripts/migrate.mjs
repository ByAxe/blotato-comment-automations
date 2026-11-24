import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const directory = new URL('../db/', import.meta.url);

export async function migrate(connectionString) {
  if (!connectionString) throw new Error('Set DATABASE_URL to the target PostgreSQL database.');
  const db = new pg.Client({ connectionString });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(164225, 1)");
    await db.query('CREATE TABLE IF NOT EXISTS schema_migration (file text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const files = (await readdir(directory)).filter(file => /^\d+_.+\.sql$/.test(file)).sort();
    for (const file of files) {
      const sql = await readFile(new URL(file, directory), 'utf8');
      const hash = createHash('sha256').update(sql).digest('hex');
      const prior = await db.query('SELECT sha256 FROM schema_migration WHERE file = $1', [file]);
      if (prior.rowCount === 1) {
        if (prior.rows[0].sha256 !== hash) throw new Error('Applied migration changed: ' + file);
        continue;
      }
      await db.query(sql);
      await db.query('INSERT INTO schema_migration(file, sha256) VALUES ($1, $2)', [file, hash]);
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await migrate(process.env.DATABASE_URL);
}
