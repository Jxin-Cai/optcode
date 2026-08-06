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
const REPAIR_STATUSES = ['verified', 'partial', 'blocked', 'regressed', 'skipped'];

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

function main() {
  const [cmd, workDir, ...rest] = process.argv.slice(2);
  if (!cmd || !workDir) {
    process.stderr.write('用法: node effectiveness-tracker.js <record-repair|compare|summary> <work-dir> [...args]\n');
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
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { recordRepairProgress, compareRuns, getSummary, readTracker, initTracker };
