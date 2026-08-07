#!/usr/bin/env node
/**
 * Stop hook: auto-collects lightweight review findings at session end.
 *
 * Scans active optcode workflows for:
 *   1. Unresolved findings (confirmed but not fixed)
 *   2. Stagnant dimensions (fix attempts exhausted without resolution)
 *   3. Quality gate failures that were not addressed
 *
 * Appends a summary to .optcode/known-issues.json for cross-run learning.
 * Never blocks session exit — only emits informational output.
 */
const { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync } = require('node:fs');
const { join } = require('node:path');

function main() {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { return; }

  const cwd = input.cwd || process.cwd();
  const optcodeDir = join(cwd, '.optcode');
  if (!existsSync(optcodeDir)) return;

  const collectedFindings = [];

  try {
    const entries = readdirSync(optcodeDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && /^\d/.test(e.name));

    for (const entry of entries) {
      const runDir = join(optcodeDir, entry.name);
      const statePath = join(runDir, 'state.json');
      if (!existsSync(statePath)) continue;

      let state;
      try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { continue; }
      if (state.status === 'completed') continue;

      for (const [dim, dimState] of Object.entries(state.dimensions || {})) {
        if (dimState.status === 'exceeded' || dimState.status === 'failed') {
          collectedFindings.push({
            type: 'unresolved_dimension',
            dimension: dim,
            status: dimState.status,
            round: dimState.round || 0,
            issues_found: dimState.issues_found || 0,
            issues_fixed: dimState.issues_fixed || 0,
            run: entry.name,
            collected_at: new Date().toISOString(),
          });
        }

        if (dimState.status === 'needs_fix' && dimState.round >= 2) {
          const fixRate = dimState.issues_found > 0
            ? dimState.issues_fixed / dimState.issues_found
            : 0;
          if (fixRate < 0.5) {
            collectedFindings.push({
              type: 'stagnant_fix_loop',
              dimension: dim,
              round: dimState.round,
              fix_rate: Math.round(fixRate * 100),
              issues_remaining: dimState.issues_found - dimState.issues_fixed,
              run: entry.name,
              collected_at: new Date().toISOString(),
            });
          }
        }
      }
    }
  } catch { /* best-effort; never block exit */ }

  if (collectedFindings.length === 0) return;

  // Persist to known-issues
  try {
    const knownIssuesPath = join(optcodeDir, 'known-issues.json');
    let knownIssues = [];
    if (existsSync(knownIssuesPath)) {
      try { knownIssues = JSON.parse(readFileSync(knownIssuesPath, 'utf8')); } catch { knownIssues = []; }
    }

    for (const finding of collectedFindings) {
      const fingerprint = `${finding.type}:${finding.dimension}:${finding.run}`;
      const existing = knownIssues.find(i => i.fingerprint === fingerprint);
      if (existing) {
        existing.last_seen = finding.collected_at;
        existing.run_count = (existing.run_count || 1) + 1;
      } else {
        knownIssues.push({
          fingerprint,
          ...finding,
          first_seen: finding.collected_at,
          last_seen: finding.collected_at,
          run_count: 1,
          status: 'active',
        });
      }
    }

    mkdirSync(optcodeDir, { recursive: true });
    const tmp = `${knownIssuesPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(knownIssues, null, 2) + '\n');
    renameSync(tmp, knownIssuesPath);
  } catch { /* best-effort */ }

  const result = {
    hookSpecificOutput: {
      hookEventName: 'Stop',
      stopDecision: 'allow',
      findings: collectedFindings.map(f => `[${f.type}] ${f.dimension} (${f.run})`),
      message: `Collected ${collectedFindings.length} unresolved finding(s) for cross-run tracking.`,
    },
  };
  console.log(JSON.stringify(result));
}

main();
