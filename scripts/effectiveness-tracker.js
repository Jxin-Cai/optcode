#!/usr/bin/env node
/**
 * optcode effectiveness tracker — separates repair progress from loop effectiveness.
 *
 * Two distinct metrics:
 *   1. Repair Progress: same-window verification — "did the fix land correctly?"
 *      Updated by regression checks within a single run.
 *   2. Loop Effectiveness: cross-run comparison — "did the codebase actually improve?"
 *      Updated ONLY when a comparable later episode demonstrates improvement.
 *
 * Rules:
 *   - Same-window verification NEVER promotes loop effectiveness scores
 *   - Loop effectiveness requires a comparable later run on the same scope
 *   - A regression in a later run keeps stop/revert blocker status
 *   - Pending entries never erase completed results
 *
 * Usage:
 *   node effectiveness-tracker.js record-repair <work-dir> <dimension> --status <status>
 *   node effectiveness-tracker.js compare <work-dir> <previous-work-dir>
 *   node effectiveness-tracker.js summary <work-dir>
 */
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { readState, appendAudit, atomicReplace } = require('./workflow-lib.js');

const TRACKER_FILE = 'effectiveness.json';
const HISTORY_FILE = 'effectiveness-history.json';
const REPAIR_STATUSES = ['verified', 'partial', 'blocked', 'regressed', 'skipped'];

const GUARDRAIL_DEFINITIONS = Object.freeze({
  'dead-code': { primary: 'dead_code_removed', guardrail: 'no_test_failures', direction: 'lower-is-better' },
  'duplication': { primary: 'duplication_reduced', guardrail: 'no_new_complexity', direction: 'lower-is-better' },
  'concurrency': { primary: 'race_conditions_fixed', guardrail: 'no_deadlock_introduced', direction: 'lower-is-better' },
  'design': { primary: 'complexity_reduced', guardrail: 'api_surface_stable', direction: 'lower-is-better' },
  'style': { primary: 'style_violations_fixed', guardrail: 'no_formatting_regressions', direction: 'lower-is-better' },
  'maintainability': { primary: 'maintainability_improved', guardrail: 'no_coupling_increase', direction: 'lower-is-better' },
  'legacy-safety': { primary: 'legacy_risks_mitigated', guardrail: 'no_behavior_change', direction: 'lower-is-better' },
  'ai-sdd-smells': { primary: 'ai_smells_removed', guardrail: 'no_new_ai_patterns', direction: 'lower-is-better' },
  'security': { primary: 'vulnerabilities_fixed', guardrail: 'no_new_attack_surface', direction: 'lower-is-better' },
});

const VERDICT = Object.freeze({ PROCEED: 'proceed', STOP: 'stop', REVERT: 'revert' });

function trackerPath(workDir) {
  return join(workDir, TRACKER_FILE);
}

function readTracker(workDir) {
  const file = trackerPath(workDir);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeTracker(workDir, tracker) {
  atomicReplace(trackerPath(workDir), JSON.stringify(tracker, null, 2) + '\n');
}

function initTracker(workDir) {
  const tracker = {
    version: 1,
    created_at: new Date().toISOString(),
    repair_progress: {},
    loop_effectiveness: {
      status: 'pending',
      comparable_run: null,
      score_delta: null,
      dimensions: {},
    },
  };
  writeTracker(workDir, tracker);
  return tracker;
}

function recordRepairProgress(workDir, dimension, status, details = {}) {
  if (!REPAIR_STATUSES.includes(status)) {
    throw Object.assign(
      new Error(`invalid repair status: ${status}`),
      { code: 'E_INVALID_STATUS' },
    );
  }

  let tracker = readTracker(workDir);
  if (!tracker) tracker = initTracker(workDir);

  const existing = tracker.repair_progress[dimension];
  // Rule: pending entries never erase completed results
  if (existing && existing.status === 'verified' && status === 'pending') {
    return tracker;
  }
  // Rule: regression keeps stop/revert blocker
  if (existing && existing.status === 'regressed' && status !== 'verified') {
    details.blocker_retained = true;
  }

  tracker.repair_progress[dimension] = {
    status,
    updated_at: new Date().toISOString(),
    ...details,
  };

  writeTracker(workDir, tracker);
  appendAudit(workDir, {
    type: 'repair_progress_recorded',
    dimension,
    status,
  });
  return tracker;
}

function compareRuns(currentWorkDir, previousWorkDir) {
  const currentState = readState(currentWorkDir);
  const previousState = readState(previousWorkDir);
  if (!currentState || !previousState) {
    return { comparable: false, reason: 'one or both states missing' };
  }

  // Check comparability: same target paths and same active dimensions
  const currentTargets = new Set(currentState.target_paths || []);
  const previousTargets = new Set(previousState.target_paths || []);
  const sameScope = currentTargets.size === previousTargets.size &&
    [...currentTargets].every(t => previousTargets.has(t));

  if (!sameScope) {
    return { comparable: false, reason: 'target paths differ between runs' };
  }

  const dimensionDeltas = {};
  let totalImproved = 0;
  let totalRegressed = 0;

  for (const dim of Object.keys(currentState.dimensions)) {
    const curr = currentState.dimensions[dim];
    const prev = previousState.dimensions[dim];
    if (!prev || curr.status === 'skipped' || prev.status === 'skipped') continue;

    const currIssues = curr.issues_found || 0;
    const prevIssues = prev.issues_found || 0;
    const delta = prevIssues - currIssues;

    dimensionDeltas[dim] = {
      previous_issues: prevIssues,
      current_issues: currIssues,
      delta,
      improved: delta > 0,
      regressed: delta < 0,
    };

    if (delta > 0) totalImproved++;
    if (delta < 0) totalRegressed++;
  }

  const overallDelta = Object.values(dimensionDeltas).reduce((sum, d) => sum + d.delta, 0);

  // Update loop effectiveness only when comparable
  let tracker = readTracker(currentWorkDir);
  if (!tracker) tracker = initTracker(currentWorkDir);

  tracker.loop_effectiveness = {
    status: totalRegressed > 0 ? 'regressed' : (totalImproved > 0 ? 'improved' : 'stable'),
    comparable_run: previousWorkDir,
    score_delta: overallDelta,
    dimensions: dimensionDeltas,
    compared_at: new Date().toISOString(),
  };

  writeTracker(currentWorkDir, tracker);
  appendAudit(currentWorkDir, {
    type: 'loop_effectiveness_compared',
    status: tracker.loop_effectiveness.status,
    score_delta: overallDelta,
    improved: totalImproved,
    regressed: totalRegressed,
  });

  return {
    comparable: true,
    status: tracker.loop_effectiveness.status,
    score_delta: overallDelta,
    improved_dimensions: totalImproved,
    regressed_dimensions: totalRegressed,
    dimensions: dimensionDeltas,
  };
}

function getSummary(workDir) {
  const tracker = readTracker(workDir);
  if (!tracker) return { initialized: false };

  const repairEntries = Object.entries(tracker.repair_progress);
  const repairByStatus = {};
  for (const [, entry] of repairEntries) {
    repairByStatus[entry.status] = (repairByStatus[entry.status] || 0) + 1;
  }

  return {
    initialized: true,
    repair_progress: {
      total: repairEntries.length,
      by_status: repairByStatus,
    },
    loop_effectiveness: tracker.loop_effectiveness,
  };
}

function judgeFixOutcome(currentWorkDir, previousWorkDir) {
  const comparison = compareRuns(currentWorkDir, previousWorkDir);
  if (!comparison.comparable) {
    return { verdict: VERDICT.STOP, reasons: [`not comparable: ${comparison.reason}`] };
  }

  const reasons = [];
  let guardrailRegressed = false;
  let primaryImproved = false;

  for (const [dim, delta] of Object.entries(comparison.dimensions || {})) {
    const guard = GUARDRAIL_DEFINITIONS[dim];
    if (!guard) continue;

    if (delta.regressed) {
      guardrailRegressed = true;
      reasons.push(`guardrail breach: ${dim} regressed (${delta.previous_issues} → ${delta.current_issues})`);
    }
    if (delta.improved) {
      primaryImproved = true;
    }
  }

  if (guardrailRegressed) {
    return { verdict: VERDICT.REVERT, reasons };
  }
  if (!primaryImproved && comparison.score_delta === 0) {
    reasons.push('no improvement detected — plateau');
    return { verdict: VERDICT.STOP, reasons };
  }

  reasons.push(`improvement: score_delta=${comparison.score_delta}, ${comparison.improved_dimensions} dimensions improved`);
  return { verdict: VERDICT.PROCEED, reasons };
}

function detectPlateau(workDir, windowSize = 3) {
  const tracker = readTracker(workDir);
  if (!tracker) return { plateaued: false, rounds_unchanged: 0, recommendation: 'no tracker data' };

  const entries = Object.values(tracker.repair_progress);
  const recent = entries.slice(-windowSize);

  if (recent.length < windowSize) {
    return { plateaued: false, rounds_unchanged: 0, recommendation: 'insufficient data' };
  }

  const unchangedCount = recent.filter(e => e.status === 'partial' || e.status === 'blocked').length;
  const plateaued = unchangedCount === recent.length;

  return {
    plateaued,
    rounds_unchanged: unchangedCount,
    total_recent: recent.length,
    recommendation: plateaued
      ? 'Fix loop has plateaued — consider escalating to human review or changing strategy'
      : 'Progress still being made — continue fix loop',
  };
}

function appendEffectivenessHistory(projectRoot, runResult) {
  const historyPath = join(projectRoot, '.optcode', HISTORY_FILE);
  let history = [];
  if (existsSync(historyPath)) {
    try { history = JSON.parse(readFileSync(historyPath, 'utf8')); } catch { history = []; }
  }

  const entry = {
    run_id: runResult.run_id || `run-${Date.now()}`,
    timestamp: new Date().toISOString(),
    primary_delta: runResult.score_delta || 0,
    guardrail_status: runResult.guardrail_regressed ? 'regressed' : 'stable',
    verdict: runResult.verdict || 'unknown',
    improved_dimensions: runResult.improved_dimensions || 0,
    regressed_dimensions: runResult.regressed_dimensions || 0,
  };

  history.push(entry);

  const dir = join(projectRoot, '.optcode');
  if (!existsSync(dir)) {
    const { mkdirSync } = require('node:fs');
    mkdirSync(dir, { recursive: true });
  }
  atomicReplace(historyPath, JSON.stringify(history, null, 2) + '\n');
  return entry;
}

function getEffectivenessHistory(projectRoot, last = 20) {
  const historyPath = join(projectRoot, '.optcode', HISTORY_FILE);
  if (!existsSync(historyPath)) return [];
  try {
    const history = JSON.parse(readFileSync(historyPath, 'utf8'));
    return history.slice(-last);
  } catch { return []; }
}

function main() {
  const [cmd, workDir, ...rest] = process.argv.slice(2);
  if (!cmd || !workDir) {
    process.stderr.write('用法: node effectiveness-tracker.js <record-repair|compare|summary|judge|plateau|history> <work-dir> [...args]\n');
    process.exit(1);
  }

  switch (cmd) {
    case 'record-repair': {
      const dimension = rest[0];
      const statusIdx = rest.indexOf('--status');
      const status = statusIdx >= 0 ? rest[statusIdx + 1] : 'pending';
      recordRepairProgress(workDir, dimension, status);
      console.log(JSON.stringify({ recorded: true, dimension, status }));
      break;
    }
    case 'compare': {
      const previousWorkDir = rest[0];
      if (!previousWorkDir) {
        process.stderr.write('missing previous work-dir argument\n');
        process.exit(1);
      }
      const result = compareRuns(workDir, previousWorkDir);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'summary': {
      const summary = getSummary(workDir);
      console.log(JSON.stringify(summary, null, 2));
      break;
    }
    case 'judge': {
      const previousWorkDir = rest[0];
      if (!previousWorkDir) {
        process.stderr.write('missing previous work-dir argument\n');
        process.exit(1);
      }
      const result = judgeFixOutcome(workDir, previousWorkDir);
      console.log(JSON.stringify(result, null, 2));
      if (result.verdict === 'revert') process.exit(2);
      if (result.verdict === 'stop') process.exit(1);
      break;
    }
    case 'plateau': {
      const windowIdx = rest.indexOf('--window');
      const window = windowIdx >= 0 ? Number(rest[windowIdx + 1]) : 3;
      const result = detectPlateau(workDir, window);
      console.log(JSON.stringify(result, null, 2));
      if (result.plateaued) process.exit(1);
      break;
    }
    case 'history': {
      const lastIdx = rest.indexOf('--last');
      const last = lastIdx >= 0 ? Number(rest[lastIdx + 1]) : 20;
      const history = getEffectivenessHistory(workDir, last);
      console.log(JSON.stringify(history, null, 2));
      break;
    }
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      process.exit(1);
  }
}

if (require.main === module) main();
module.exports = {
  recordRepairProgress, compareRuns, getSummary, readTracker, initTracker,
  judgeFixOutcome, detectPlateau, appendEffectivenessHistory, getEffectivenessHistory,
  GUARDRAIL_DEFINITIONS, VERDICT,
};
