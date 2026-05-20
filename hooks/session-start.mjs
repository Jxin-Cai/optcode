#!/usr/bin/env node
/**
 * SessionStart hook: injects active optcode workflow state into context.
 * Reminds the orchestrator of the current dimension, round, and iron rules.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function readState(workDir) {
  const file = join(workDir, 'state.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch { return null; }
}

function main() {
  const cwd = process.cwd();
  const optcodeDir = join(cwd, '.optcode');

  console.log('optcode plugin is available.');
  console.log('Use /optcode <target-paths> for multi-dimension code review and auto-fix.');

  if (!existsSync(optcodeDir)) {
    console.log('Runtime artifacts are stored under .optcode/{timestamp}/ in the target project.');
    return;
  }

  let entries;
  try {
    entries = readdirSync(optcodeDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch { return; }

  const activeWorkflows = [];
  for (const entry of entries) {
    const workDir = join(optcodeDir, entry.name);
    const state = readState(workDir);
    if (!state) continue;
    // Check if all dimensions are done
    const allDone = Object.values(state.dimensions).every(d => ['pass', 'failed', 'exceeded'].includes(d.status));
    if (allDone && existsSync(join(workDir, 'summary.md'))) continue;
    activeWorkflows.push({ timestamp: entry.name, state });
  }

  if (activeWorkflows.length > 0) {
    console.log('');
    console.log('Active optcode workflows:');
    for (const w of activeWorkflows) {
      const dims = Object.entries(w.state.dimensions);
      const done = dims.filter(([, d]) => ['pass', 'failed', 'exceeded'].includes(d.status)).length;
      const current = w.state.current_dimension || 'none';
      const round = w.state.current_round || 0;
      console.log(`  - ${w.timestamp}: ${done}/${dims.length} dimensions done | current=${current} round=${round}`);
    }
    console.log('');
    console.log('OPTCODE RULES:');
    console.log('  - orchestration-status.mjs = 唯一恢复点，每轮必调，不凭记忆跳步');
    console.log('  - CR agent 不改代码，gate-check 必须通过才能继续');
    console.log('  - 产物落盘，不依赖上下文记忆');
  }
}

main();
