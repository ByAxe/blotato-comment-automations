import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const checkout = dirname(dirname(fileURLToPath(import.meta.url)));
const empty = { version: 1, objective: '', nextStep: '', detail: 'default', reviewFocus: 'default' };
const details = ['default', 'concise', 'expanded'];
const focuses = ['default', 'reliability', 'data', 'operations'];
const usage = 'node agents/context.mjs show | set [--profile NAME] [--objective TEXT] [--next-step TEXT] [--detail default|concise|expanded] [--review-focus default|reliability|data|operations]';

function validate(profile) {
  if (profile?.version !== 1 || Object.keys(profile).some((k) => !Object.hasOwn(empty, k))) {
    throw new Error('Unsupported developer profile schema');
  }
  for (const key of ['objective', 'nextStep']) {
    if (typeof profile[key] !== 'string' || profile[key].length > 2000) throw new Error(key + ' must be text of at most 2000 characters');
  }
  if (!details.includes(profile.detail)) throw new Error('detail must be one of ' + details.join(', '));
  if (!focuses.includes(profile.reviewFocus)) throw new Error('reviewFocus must be one of ' + focuses.join(', '));
  return profile;
}

// Resolve existing ancestors even on the first use of a new config directory.
async function physicalPath(path) {
  try { return await realpath(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(await physicalPath(dirname(path)), basename(path));
  }
}

async function location(name) {
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(name)) throw new Error('Use a lowercase profile name of 1 to 48 letters, digits, underscores or hyphens');
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  if (!isAbsolute(config)) throw new Error('XDG_CONFIG_HOME must be an absolute path');
  const dir = join(await physicalPath(config), 'blotato-comment-automations');
  const physical = await physicalPath(dir);
  if (physical !== dir || physical === checkout || physical.startsWith(checkout + sep)) throw new Error('Use a private profile directory outside the checkout');
  return join(dir, name + '.json');
}

function checkPrivate(stat) {
  if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('Profile directory and file must be private to their owner (0700 and 0600)');
  }
}

async function readProfile(file) {
  let handle;
  try {
    const dir = await lstat(dirname(file));
    if (!dir.isDirectory()) throw new Error('Invalid profile directory');
    checkPrivate(dir);
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    checkPrivate(stat);
    if (!stat.isFile() || stat.size > 65536) throw new Error('Invalid profile file');
    const body = await handle.readFile('utf8');
    let profile;
    try { profile = JSON.parse(body); } catch { throw new Error('Invalid JSON in developer profile'); }
    return validate(profile);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally { await handle?.close(); }
}

// The runner receives this projection only. The profile name and handoff stay local.
export async function runnerPreferences(name) {
  if (name === undefined) return {};
  const profile = await readProfile(await location(name));
  if (!profile) throw new Error('Selected developer profile does not exist');
  const preferences = {};
  if (profile.detail !== 'default') preferences.detail = profile.detail;
  if (profile.reviewFocus !== 'default') preferences.reviewFocus = profile.reviewFocus;
  return preferences;
}

async function update(file, changes) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  checkPrivate(await lstat(dirname(file)));
  const lock = file + '.lock';
  try { await mkdir(lock, { mode: 0o700 }); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another profile update holds ' + lock + '. Retry when it finishes.');
    throw error;
  }
  const temp = join(lock, 'next.json');
  try {
    const profile = validate({ ...(await readProfile(file) ?? empty), ...changes });
    await writeFile(temp, JSON.stringify(profile, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } finally { await rm(lock, { recursive: true, force: true }); }
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    profile: { type: 'string', default: 'default' }, objective: { type: 'string' }, 'next-step': { type: 'string' },
    detail: { type: 'string' }, 'review-focus': { type: 'string' }
  } });
  if (positionals.length !== 1) throw new Error(usage);
  const file = await location(values.profile);
  const changes = {};
  for (const [flag, field] of Object.entries({ objective: 'objective', 'next-step': 'nextStep', detail: 'detail', 'review-focus': 'reviewFocus' })) {
    if (values[flag] !== undefined) changes[field] = values[flag];
  }
  const hasChanges = Object.keys(changes).length > 0;
  if (positionals[0] === 'show' && !hasChanges) {
    const profile = await readProfile(file);
    console.log(profile ? JSON.stringify(profile, null, 2) : 'No local developer profile saved.');
  } else if (positionals[0] === 'set' && hasChanges) {
    await update(file, changes);
    console.log('Developer profile saved locally.');
  } else throw new Error(usage);
}

const entry = process.argv[1] && await realpath(process.argv[1]).catch(() => undefined);
if (entry === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
