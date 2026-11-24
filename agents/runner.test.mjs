import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

function context(entry, config, args, input) {
  const result = run(process.execPath, [entry, ...args], { env: { XDG_CONFIG_HOME: config } });
  result.child.stdin.end(input);
  return result;
}

test('the plan prints the dependency graph offline', async () => {
  const { stdout } = await run(process.execPath, [join(here, 'run.mjs'), 'plan'], { env: { PATH: '' } });
  assert.match(stdout, /requirements <- problem \[gpt-6\.2-sol\]/);
  assert.match(stdout, /design <- draft, technical-review, english-review \[gpt-6\.2-astra\]/);
  const override = await run(process.execPath, [join(here, 'run.mjs'), 'plan', '--model', 'project-model']);
  assert.equal(override.stdout.split('[project-model]').length - 1, 8);
});

test('local developer handoffs persist per user and reject unsafe updates', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'comment-profile-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = join(home, 'one');
  const other = join(home, 'two');
  const cli = (dir, args, input) => context(join(here, 'context.mjs'), dir, args, input);
  const save = (dir, handoff, ...args) => cli(dir, ['set', '--handoff-stdin', ...args], JSON.stringify(handoff, null, 2));
  const show = async (dir, ...args) => (await cli(dir, ['show', ...args])).stdout;
  await assert.rejects(save(here, { objective: 'misplaced' }), /outside the checkout/);
  assert.match(await show(config), /No local developer profile/);
  await assert.rejects(stat(config), { code: 'ENOENT' });
  const saved = await save(config, { objective: 'Finish an example', nextStep: 'Inspect the sample output' });
  assert.equal(saved.stdout, 'Developer profile saved locally.\n');
  assert.equal(saved.stderr, '');
  await cli(config, ['set', '--detail', 'concise']);
  const expected = { version: 1, objective: 'Finish an example', nextStep: 'Inspect the sample output', detail: 'concise', reviewFocus: 'default' };
  assert.deepEqual(JSON.parse(await show(config)), expected);
  assert.match(await show(config, '--profile', 'another'), /No local developer profile/);
  assert.match(await show(other), /No local developer profile/);
  await save(other, { objective: 'A different example', nextStep: 'Check a fixture' }, '--review-focus', 'data');
  await save(other, { nextStep: '' });
  assert.deepEqual(JSON.parse(await show(other)), { ...expected, objective: 'A different example', nextStep: '', detail: 'default', reviewFocus: 'data' });

  const dir = join(config, 'blotato-comment-automations');
  const file = join(dir, 'default.json');
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(save(config, { objective: 'lose original' }, '--detail', 'unrecognized'), /detail must be/);
  await assert.rejects(save(config, { objective: 'invalid path' }, '--profile', '../outside'), /profile name/);
  for (const flag of ['--objective', '--next-step', '--unexpected']) {
    await assert.rejects(cli(config, ['set', flag + '=ARGV_EXAMPLE']), ({ stderr, stdout }) => {
      assert.match(stderr, /--handoff-stdin/);
      assert.doesNotMatch(stderr + stdout, /ARGV_EXAMPLE/);
      return true;
    });
  }
  await assert.rejects(cli(config, ['set', '--handoff-stdin'], '{"objective":"STDIN_EXAMPLE",'), ({ stderr, stdout }) => {
    assert.match(stderr, /valid UTF-8 JSON/);
    assert.doesNotMatch(stderr + stdout, /STDIN_EXAMPLE/);
    return true;
  });
  await assert.rejects(save(config, { detail: 'expanded' }), /must contain objective, nextStep, or both/);
  await assert.rejects(save(config, { objective: 'x'.repeat(2001) }), /at most 2000 characters/);
  await assert.rejects(cli(config, ['set', '--handoff-stdin'], ' '.repeat(32 * 1024 + 1)), /exceeds 32 KiB/);
  assert.deepEqual(JSON.parse(await show(config)), expected);
  await mkdir(file + '.lock', { mode: 0o700 });
  await assert.rejects(save(config, { objective: 'lost update' }), /Another profile update/);
  assert.deepEqual(JSON.parse(await show(config)), expected);
  await rm(file + '.lock', { recursive: true });
  await writeFile(file, '{"version":2}');
  await assert.rejects(save(config, { nextStep: 'replace newer version' }), /Unsupported developer profile schema/);
  assert.equal(await readFile(file, 'utf8'), '{"version":2}');
  await writeFile(file, 'malformed example');
  await assert.rejects(save(config, { nextStep: 'overwrite' }), /Invalid JSON/);
  assert.equal(await readFile(file, 'utf8'), 'malformed example');
});

test('failed work resumes from validated handoffs with bounded, isolated roles', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'comment-design-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(here, join(root, 'agents'), { recursive: true });
  await mkdir(join(root, 'bin'));
  const evidence = [
    { path: 'benchmarks/load.ts', body: '// Synthetic load exercise\n' },
    { path: 'db/migrate.mjs', body: '// Synthetic migration tool\n' },
    { path: 'docs/diagrams/engine.puml', body: '@startuml\ncomponent Engine\n@enduml\n' },
    { path: 'docs/requirements.md', body: '# Synthetic requirements\n' },
    { path: 'examples/demo.ts', body: '// Synthetic workflow example\n' },
    { path: 'ops/staging-smoke.mjs', body: '// Synthetic staging check\n' },
    { path: 'src/sample.ts', body: 'export const example = "committed";\n' },
    { path: 'test/disposable-db.mjs', body: '// Synthetic database fixture\n' }
  ];
  for (const { path, body } of [...evidence,
    { path: 'contributing/guide.md', body: '# Synthetic contributor guide\n' },
    { path: 'docs/old-report.md', body: '# Synthetic historical report\n' },
    { path: 'evidence/results.md', body: '# Synthetic result report\n' },
    { path: 'private-note.md', body: 'Private fixture\n' }
  ]) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
  }
  const fake = join(root, 'bin', 'codex');
  await cp(join(here, 'fixtures', 'mock-codex.mjs'), fake);
  await chmod(fake, 0o755);
  const problem = '# Public committed fixture brief\n\nDescribe a synthetic comment workflow.\n';
  await writeFile(join(root, 'agents/problem.md'), problem);
  const git = (...args) => run('git', args, { cwd: root });
  await git('init', '-q');
  await git('add', 'agents', 'benchmarks', 'contributing', 'db', 'docs', 'evidence', 'examples', 'ops', 'src', 'test', 'private-note.md');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  await writeFile(join(root, 'src', 'sample.ts'), 'Uncommitted fixture\n');
  await writeFile(join(root, 'agents/problem.md'), '# Alternate public working-tree fixture brief\n');

  const config = await mkdtemp(join(tmpdir(), 'comment-design-profile-'));
  t.after(() => rm(config, { recursive: true, force: true }));
  const profile = 'private-profile-name';
  const save = (args, handoff) => context(join(root, 'agents/context.mjs'), config, ['set', '--profile', profile, ...args], handoff);
  await save(['--detail', 'concise', '--review-focus', 'data', '--handoff-stdin'], JSON.stringify({ objective: 'PRIVATE_OBJECTIVE', nextStep: 'PRIVATE_NEXT_STEP' }));
  const launch = (args, log, fail = '', slow = '') => run(process.execPath, [join(root, 'agents/run.mjs'), ...args], {
    cwd: root, env: { ...process.env, XDG_CONFIG_HOME: config, PATH: join(root, 'bin') + ':' + process.env.PATH, MOCK_LOG: join(root, log), MOCK_FAIL: fail, MOCK_SLOW: slow }
  });
  const read = (name) => readFile(join(root, name), 'utf8');
  const history = async (name) => (await read(name)).trim().split('\n').map((line) => JSON.parse(line));
  await assert.rejects(launch(['run', 'first'], 'first.log', 'data'), /Synthetic role failure/);
  assert.ok((await history('first.log')).filter((entry) => entry.action === 'start').every((entry) => entry.input.problem === problem));
  assert.equal(JSON.parse(await read('first/architecture.json')).status, 'generated');
  await assert.rejects(read('first/design.md'), { code: 'ENOENT' });

  await launch(['resume', 'first', 'next', '--jobs', '2'], 'next.log');
  assert.equal(JSON.parse(await read('next/architecture.json')).status, 'reused');
  assert.equal(JSON.parse(await read('next/requirements.json')).status, 'reused');
  assert.match(await read('next/design.md'), /^# Synthetic design/);
  const trace = await history('next.log');
  const started = trace.filter((entry) => entry.action === 'start');
  assert.ok(started.every((entry) => entry.input.problem === problem));
  const review = started.find((entry) => entry.id === 'technical-review');
  assert.deepEqual(Object.keys(review.input.handoffs), ['draft']);
  assert.equal(review.args[review.args.indexOf('--model') + 1], 'gpt-6.2-astra');
  const copyEditor = started.find((entry) => entry.id === 'english-review');
  assert.equal(copyEditor.args[copyEditor.args.indexOf('--model') + 1], 'gpt-6.2-sol');
  assert.equal(JSON.parse(await read('next/english-review.json')).model, 'gpt-6.2-sol');
  assert.deepEqual(review.input.files, evidence);
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

  assert.equal(JSON.parse(await read('first/run.json')).preferencesSha256, undefined);
  assert.doesNotMatch((await history('first.log'))[0].prompt, /Use compact explanations|PRIVATE_OBJECTIVE/);
  await launch(['run', 'personalized', '--profile', profile], 'personalized.log');
  const personalized = (await history('personalized.log')).filter((row) => row.action === 'start');
  assert.ok(personalized.every((role) => role.prompt.includes('Use compact explanations')));
  assert.deepEqual(personalized.filter((role) => role.prompt.includes('Prioritize data lineage')).map((role) => role.id), ['technical-review']);
  const privateMarker = /private-profile-name|PRIVATE_OBJECTIVE|PRIVATE_NEXT_STEP/;
  assert.doesNotMatch(await read('personalized.log'), privateMarker);
  for (const artifact of await readdir(join(root, 'personalized'))) {
    assert.doesNotMatch(await read(join('personalized', artifact)), privateMarker);
  }
  assert.match(JSON.parse(await read('personalized/run.json')).preferencesSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(await read('personalized/design.md'), await read('next/design.md'));
  await save(['--handoff-stdin'], JSON.stringify({ objective: 'PRIVATE_OBJECTIVE_UPDATED' }));
  await launch(['resume', 'personalized', 'same', '--profile', profile], 'same.log');
  assert.equal(JSON.parse(await read('same/design.json')).status, 'reused');
  await assert.rejects(read('same.log'), { code: 'ENOENT' });
  await assert.rejects(launch(['resume', 'same', 'unselected'], 'unselected.log'), /preferences differ/);
  await save(['--detail', 'expanded']);
  await assert.rejects(launch(['resume', 'same', 'changed', '--profile', profile], 'changed.log'), /preferences differ/);
  await assert.rejects(stat(join(root, 'changed')), { code: 'ENOENT' });
  await assert.rejects(read('changed.log'), { code: 'ENOENT' });
  await assert.rejects(launch(['run', 'missing-profile', '--profile', 'unknown'], 'missing.log'), /does not exist/);

  await assert.rejects(launch(['run', 'timed', '--timeout-seconds', '1'], 'timed.log', '', 'requirements'), /Role timed out after 1s/);
  await assert.rejects(read('timed/requirements.json'), { code: 'ENOENT' });
  assert.deepEqual((await history('timed.log')).map((row) => row.action), ['start']);
});
