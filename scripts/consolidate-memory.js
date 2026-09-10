#!/usr/bin/env node
// Nightly memory consolidation — a backstop that doesn't depend on the live agent remembering to
// update memory/ mid-conversation. Reads conversations updated since the last run, asks a CLI to
// fold anything durable into memory/*.md (and prune/dedupe), independent of which provider
// actually handled those conversations.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const APP_DIR = path.join(__dirname, '..');
const SESSIONS_FILE = path.join(APP_DIR, 'data', 'sessions.json');
const MEMORY_DIR = path.join(APP_DIR, 'memory');
const MARKER_FILE = path.join(MEMORY_DIR, '.last-consolidation');

function loadConvos() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { return {}; }
}

function lastRunTime() {
  try { return parseInt(fs.readFileSync(MARKER_FILE, 'utf8').trim(), 10) || 0; } catch { return 0; }
}

function main() {
  const since = lastRunTime();
  const now = Date.now();
  const convos = loadConvos();

  const recent = Object.entries(convos)
    .filter(([, c]) => (c.updatedAt || 0) > since)
    .sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0));

  if (!recent.length) {
    console.log('[consolidate-memory] nothing new since last run, skipping.');
    return;
  }

  let digest = '';
  for (const [id, c] of recent) {
    digest += `\n\n--- Conversation "${c.title || id}" (mode: ${c.mode || 'workspace'}) ---\n`;
    for (const m of c.messages || []) {
      const text = String(m.text || '').slice(0, 1500);
      digest += `${m.role === 'user' ? 'User' : 'Assistant'}: ${text}\n`;
    }
  }
  digest = digest.slice(0, 60000); // keep the digest bounded regardless of how much changed

  const prompt = `You are doing scheduled memory maintenance, not answering a user in real time.

Below are recent conversation transcripts (since the last consolidation run). Review them and
update ${MEMORY_DIR}/ accordingly:
- Add or update notes for anything durable that isn't already captured: stated preferences,
  corrections/feedback, project facts, useful reference pointers.
- Update ${MEMORY_DIR}/MEMORY.md's index to match (one line per note, under ~150 characters).
- Prune or fix any entry that's now stale or contradicted by what you read below.
- Don't touch docs/ — that's app-architecture knowledge, not conversation-derived.
- Make targeted edits only. If nothing here is worth remembering, do nothing and say so.

${digest}`;

  const result = spawnSync('claude', [
    '-p', prompt,
    '--permission-mode', 'bypassPermissions',
  ], {
    cwd: APP_DIR,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
  });

  if (result.error) {
    console.error('[consolidate-memory] failed to run:', result.error.message);
    process.exit(1);
  }
  console.log('[consolidate-memory] done.');
  console.log(result.stdout || '');
  if (result.stderr) console.error(result.stderr);

  fs.writeFileSync(MARKER_FILE, String(now));
}

main();
