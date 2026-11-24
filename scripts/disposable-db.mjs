import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from './migrate.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [mode, ...args] = process.argv.slice(2);
if (!['test', 'e2e', 'demo', 'load', 'skew', 'verify'].includes(mode)) throw new Error('Choose test, e2e, demo, load, skew, or verify.');

function run(program, argv, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, argv, { cwd: root, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(program + ' exited with ' + (signal ?? code))));
  });
}

// A unique database keeps globally competing queue consumers from seeing another scenario.
async function isolated(admin, adminUrl, argv) {
  const name = 'automation_test_' + randomBytes(12).toString('hex');
  const url = new URL(adminUrl);
  url.pathname = '/' + name;
  await admin.query('CREATE DATABASE ' + name);
  try {
    await migrate(url.href);
    await run(process.execPath, argv, { ...process.env, DATABASE_URL: url.href });
  } finally {
    await admin.query('DROP DATABASE ' + name + ' WITH (FORCE)');
  }
}

async function suite(adminUrl) {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    if (mode === 'test' || mode === 'verify') {
      if (mode === 'verify') await run(process.execPath, ['--test', 'agents/runner.test.mjs']);
      const files = (await readdir(join(root, 'dist/test'))).filter(f => f.endsWith('.test.js')).sort();
      if (!files.includes('e2e.test.js')) throw new Error('Build the full test suite first.');
      for (const file of files) await isolated(admin, adminUrl, ['--test', 'dist/test/' + file]);
    }
    if (mode === 'e2e') await isolated(admin, adminUrl, ['--test', 'dist/test/e2e.test.js']);
    if (mode === 'demo' || mode === 'verify') await isolated(admin, adminUrl, ['dist/scripts/demo.js']);
    if (mode === 'load' || mode === 'verify') {
      const size = mode === 'verify' ? ['--tenants', '3', '--participants', '12'] : args;
      await isolated(admin, adminUrl, ['dist/scripts/load.js', ...size]);
    }
    if (mode === 'skew' || mode === 'verify') {
      const size = mode === 'verify' ? ['--hot-comments', '64', '--adapter-ms', '1'] : args;
      await isolated(admin, adminUrl, ['dist/scripts/skew.js', ...size]);
    }
  } finally {
    await admin.end();
  }
}

if (process.env.PG_TEST_ADMIN_URL) {
  await suite(process.env.PG_TEST_ADMIN_URL);
} else {
  // Unix-domain socket lives in a private directory. No TCP port or system cluster is used.
  const dir = await mkdtemp(join(tmpdir(), 'blotato-'));
  const data = join(dir, 'data');
  const log = join(dir, 'server.log');
  let started = false;
  try {
    await run('initdb', ['-D', data, '-U', 'runner', '-A', 'trust', '--no-locale', '-E', 'UTF8']);
    await run('pg_ctl', ['-D', data, '-l', log, '-o', "-c listen_addresses='' -k '" + dir.replaceAll("'", "'\\''") + "'", '-w', 'start']);
    started = true;
    const url = new URL('postgresql://runner@localhost/postgres');
    url.searchParams.set('host', dir);
    await suite(url.href);
  } catch (error) {
    if (!started) {
      const details = await readFile(log, 'utf8').catch(() => '');
      if (details) console.error(details);
    }
    throw error;
  } finally {
    if (started) await run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    await rm(dir, { recursive: true, force: true });
  }
}
