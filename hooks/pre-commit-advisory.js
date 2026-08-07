#!/usr/bin/env node
/**
 * PreToolUse hook: advises running /optcode check before git commit/push.
 * Reads JSON from stdin (tool_input.command), outputs advisory JSON if needed.
 */
const { existsSync, readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch { return; }

  const command = input?.tool_input?.command;
  if (!command) return;

  if (!/\bgit\s+(commit|push)\b/.test(command)) return;

  const cwd = input.cwd || process.cwd();
  const optcodeDir = join(cwd, '.optcode');
  if (!existsSync(optcodeDir)) return;

  let entries;
  try {
    entries = readdirSync(optcodeDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && /^\d{8}-\d{6}$/.test(e.name))
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch { return; }

  if (entries.length === 0) {
    output('建议先运行 /optcode check security,design 再提交。');
    return;
  }

  const latest = entries[0];
  const ts = parseTimestamp(latest.name);
  const thirtyMinAgo = Date.now() - 30 * 60 * 1000;

  if (ts && ts > thirtyMinAgo) {
    const statePath = join(optcodeDir, latest.name, 'state.json');
    if (existsSync(statePath)) {
      try {
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        const allPass = Object.values(state.dimensions).every(d => d.status === 'pass' || d.status === 'skipped');
        if (allPass) return;
      } catch {}
    }
  }

  output('建议先运行 /optcode check security,design 再提交，以捕获注入、鉴权和设计问题。');
}

function parseTimestamp(name) {
  const m = name.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`).getTime();
}

function output(message) {
  const result = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: message,
    },
  };
  process.stdout.write(JSON.stringify(result));
}

main();
