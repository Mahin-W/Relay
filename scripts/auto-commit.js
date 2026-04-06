#!/usr/bin/env node
/**
 * auto-commit.js — watches for file changes and auto-commits + pushes
 * with Claude-generated commit messages.
 *
 * Usage: node scripts/auto-commit.js
 * Requires: ANTHROPIC_API_KEY in .env
 */

import chokidar from 'chokidar';
import { execSync } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Load .env manually (dotenv may not cover all cases at script startup)
try {
  const env = readFileSync(resolve(ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length && !key.startsWith('#')) {
      process.env[key.trim()] = rest.join('=').trim();
    }
  }
} catch {
  // .env not found — rely on process.env
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY not set. Add it to .env or environment.');
  process.exit(1);
}

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const DEBOUNCE_MS = 8000; // wait 8s of silence before committing
const IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/*.log',
  '.env',
  '**/package-lock.json',
];

let debounceTimer = null;
let pending = false;

function run(cmd, cwd = ROOT) {
  return execSync(cmd, { cwd, encoding: 'utf8' }).trim();
}

function hasChanges() {
  try {
    const status = run('git status --porcelain');
    return status.length > 0;
  } catch {
    return false;
  }
}

async function generateCommitMessage(diff, status) {
  const prompt = `You are generating a git commit message for the following changes to a Telegram shift-coverage bot called Relay.

Git status:
${status}

Git diff (may be truncated):
${diff.slice(0, 6000)}

Write a concise, meaningful commit message following conventional commits style (e.g. "feat: ...", "fix: ...", "refactor: ...", "chore: ...").
- First line: type + short summary (max 72 chars)
- Optionally a blank line + 1-2 bullet points of detail if the change is non-trivial
- No fluff, no "this commit", no trailing period on the title
- Return ONLY the commit message, nothing else`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text.trim();
}

async function commitAndPush() {
  if (pending) return;
  if (!hasChanges()) return;

  pending = true;
  try {
    const status = run('git status --short');
    const diff = run('git diff HEAD');

    console.log('\n📦 Changes detected:');
    console.log(status);
    console.log('\n🤖 Generating commit message...');

    const message = await generateCommitMessage(diff, status);
    console.log(`\n✅ Commit: ${message.split('\n')[0]}`);

    run('git add -A');
    run(`git commit -m ${JSON.stringify(message)}`);
    run('git push origin main');

    console.log('🚀 Pushed to origin/main\n');
  } catch (err) {
    console.error('❌ Commit/push failed:', err.message);
  } finally {
    pending = false;
  }
}

function scheduleCommit() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(commitAndPush, DEBOUNCE_MS);
}

// Start watcher
const watcher = chokidar.watch(ROOT, {
  ignored: IGNORE,
  ignoreInitial: true,
  persistent: true,
  awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
});

watcher
  .on('add', (p) => { console.log(`+ ${p.replace(ROOT + '/', '')}`); scheduleCommit(); })
  .on('change', (p) => { console.log(`~ ${p.replace(ROOT + '/', '')}`); scheduleCommit(); })
  .on('unlink', (p) => { console.log(`- ${p.replace(ROOT + '/', '')}`); scheduleCommit(); })
  .on('ready', () => {
    console.log('👀 Watching for changes in relay-bot/');
    console.log(`   Auto-commit fires ${DEBOUNCE_MS / 1000}s after last change\n`);
  });

process.on('SIGINT', () => {
  console.log('\nStopping watcher.');
  watcher.close();
  process.exit(0);
});
