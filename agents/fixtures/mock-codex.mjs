#!/usr/bin/env node
// Offline transport fixture. Its handoffs are markers, never model output.
import { appendFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('mock-codex transport fixture');
} else {
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  const id = prompt.match(/^Role: ([\w-]+)$/m)[1];
  const input = JSON.parse(prompt.split('\n\n').at(-1));
  const log = (action) => appendFile(process.env.MOCK_LOG, JSON.stringify({ id, action, args, input, cwd: process.cwd() }) + '\n');
  await log('start');
  const delay = id === process.env.MOCK_SLOW ? 20000 : 90;
  await new Promise((resolve) => setTimeout(resolve, delay));
  if (id === process.env.MOCK_FAIL) {
    console.error('Synthetic role failure');
    process.exitCode = 3;
  } else {
    const digest = createHash('sha256').update(prompt).digest('hex');
    const path = args[args.indexOf('-o') + 1];
    await writeFile(path, '# Synthetic ' + id + '\n\nFixture digest ' + digest + '\n');
  }
  await log('end');
}
