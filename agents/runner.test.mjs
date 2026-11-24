import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

test('the plan prints the dependency graph offline', async () => {
  const { stdout } = await run(process.execPath, [join(here, 'run.mjs'), 'plan'], { env: { PATH: '' } });
  assert.match(stdout, /requirements <- problem \[gpt-6\.2-sol\]/);
  assert.match(stdout, /design <- draft, technical-review, english-review \[gpt-6\.2-astra\]/);
  const override = await run(process.execPath, [join(here, 'run.mjs'), 'plan', '--model', 'project-model']);
  assert.equal(override.stdout.split('[project-model]').length - 1, 8);
});

test('failed work resumes from validated handoffs with bounded, isolated roles', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'comment-design-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(here, join(root, 'agents'), { recursive: true });
  await mkdir(join(root, 'bin'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'docs/diagrams'), { recursive: true });
  const uml = '@startuml\ncomponent Engine\n@enduml\n';
  await writeFile(join(root, 'docs/diagrams/engine.puml'), uml);
  const fake = join(root, 'bin', 'codex');
  await cp(join(here, 'fixtures', 'mock-codex.mjs'), fake);
  await chmod(fake, 0o755);
  await writeFile(join(root, 'src', 'sample.ts'), 'export const example = "committed";\n');
  await writeFile(join(root, 'private-note.md'), 'Private fixture\n');
  const git = (...args) => run('git', args, { cwd: root });
  await git('init', '-q');
  await git('add', 'agents', 'src', 'docs', 'private-note.md');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  await writeFile(join(root, 'src', 'sample.ts'), 'Uncommitted fixture\n');

  const launch = (args, log, fail = '', slow = '') => run(process.execPath, [join(root, 'agents/run.mjs'), ...args], {
    cwd: root, env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH, MOCK_LOG: join(root, log), MOCK_FAIL: fail, MOCK_SLOW: slow }
  });
  const read = (name) => readFile(join(root, name), 'utf8');
  const history = async (name) => (await read(name)).trim().split('\n').map((line) => JSON.parse(line));
  await assert.rejects(launch(['run', 'first'], 'first.log', 'data'), /Synthetic role failure/);
  assert.equal(JSON.parse(await read('first/architecture.json')).status, 'generated');
  await assert.rejects(read('first/design.md'), { code: 'ENOENT' });

  await launch(['resume', 'first', 'next', '--jobs', '2'], 'next.log');
  assert.equal(JSON.parse(await read('next/architecture.json')).status, 'reused');
  assert.equal(JSON.parse(await read('next/requirements.json')).status, 'reused');
  assert.match(await read('next/design.md'), /^# Synthetic design/);
  const trace = await history('next.log');
  const started = trace.filter((entry) => entry.action === 'start');
  const review = started.find((entry) => entry.id === 'technical-review');
  assert.deepEqual(Object.keys(review.input.handoffs), ['draft']);
  assert.equal(review.args[review.args.indexOf('--model') + 1], 'gpt-6.2-astra');
  const copyEditor = started.find((entry) => entry.id === 'english-review');
  assert.equal(copyEditor.args[copyEditor.args.indexOf('--model') + 1], 'gpt-6.2-sol');
  assert.equal(JSON.parse(await read('next/english-review.json')).model, 'gpt-6.2-sol');
  assert.deepEqual(review.input.files, [
    { path: 'docs/diagrams/engine.puml', body: uml },
    { path: 'src/sample.ts', body: 'export const example = "committed";\n' }
  ]);
  assert.equal(started.find((entry) => entry.id === 'english-review').input.files, undefined);
  assert.equal(new Set(started.map((entry) => entry.cwd)).size, started.length);
  for (const { args } of started) {
    assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
    assert.ok(args.includes('--ignore-user-config') && args.includes('shell_tool') && args.includes('apps'));
  }
  let active = 0;
  for (const { action } of trace) {
    active += action === 'start' ? 1 : -1;
    assert.ok(active >= 0 && active <= 2);
  }

  await writeFile(join(root, 'next/data.md'), 'Corrupted handoff\n');
  await launch(['resume', 'next', 'repaired'], 'repaired.log');
  assert.deepEqual((await history('repaired.log')).filter((row) => row.action === 'start').map((row) => row.id), ['data']);
  assert.equal(await read('repaired/design.md'), await read('next/design.md'));

  await launch(['resume', 'repaired', 'rerouted', '--fast-model', 'fixture-fast'], 'rerouted.log');
  const rerun = (await history('rerouted.log')).filter((row) => row.action === 'start');
  assert.deepEqual(rerun.map((row) => row.id), ['requirements', 'english-review']);
  assert.equal(JSON.parse(await read('rerouted/english-review.json')).model, 'fixture-fast');
  assert.equal(JSON.parse(await read('rerouted/technical-review.json')).status, 'reused');

  await assert.rejects(launch(['run', 'timed', '--timeout-seconds', '1'], 'timed.log', '', 'requirements'), /Role timed out after 1s/);
  await assert.rejects(read('timed/requirements.json'), { code: 'ENOENT' });
  assert.deepEqual((await history('timed.log')).map((row) => row.action), ['start']);
});
