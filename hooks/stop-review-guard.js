#!/usr/bin/env node
/**
 * Stop hook: blocks session stop if recent write marker exists
 * and an optcode workflow is active. TTL: 15 minutes.
 */
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const TTL_MS = 15 * 60 * 1000;

function main() {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { return; }

  const cwd = input.cwd || process.cwd();
  const markerPath = join(cwd, '.optcode', 'state', 'last-write.json');
  if (!existsSync(markerPath)) return;

  let marker;
  try { marker = JSON.parse(readFileSync(markerPath, 'utf8')); } catch { return; }

  const age = Date.now() - new Date(marker.updatedAt).getTime();
  if (age > TTL_MS) return;

  const optcodeDir = join(cwd, '.optcode');
  let hasActive = false;
  try {
    const entries = readdirSync(optcodeDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && /^\d/.test(e.name));
    for (const entry of entries) {
      const statePath = join(optcodeDir, entry.name, 'state.json');
      if (existsSync(statePath)) {
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        if (state.status !== 'completed') { hasActive = true; break; }
      }
    }
  } catch {}

  if (!hasActive) return;

  const result = {
    hookSpecificOutput: {
      hookEventName: 'Stop',
      stopDecision: 'block',
      reason: `optcode write detected ${Math.round(age / 1000)}s ago (TTL: ${TTL_MS / 60000}min). Run gate-check or finish the active workflow before stopping.`,
    },
  };
  console.log(JSON.stringify(result));
}

main();
