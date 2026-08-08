#!/usr/bin/env node
/**
 * optcode orchestration status — diagnostic tool.
 *
 * Reports the current state of an optcode workflow run.
 * Used for debugging and resumption detection — NOT for orchestration
 * (orchestration is handled by the Dynamic Workflow engine).
 *
 * Usage: node orchestration-status.js <work-dir>
 * Output: JSON status report
 */
const { readState, DIMENSIONS, readAuditLog } = require('./workflow-lib.js');
const { failure, success, writeJsonResult } = require('./cli-result.js');

function getStatus(workDir) {
  const state = readState(workDir);
  if (!state) {
    return { status: 'not_initialized', workDir };
  }

  const dims = state.dimensions || {};
  const completed = Object.values(dims).filter(d => d.status === 'pass' || d.status === 'skipped' || d.status === 'exceeded').length;
  const needsFix = Object.values(dims).filter(d => d.status === 'needs_fix').length;
  const running = Object.values(dims).filter(d => ['cr_running', 'fix_running'].includes(d.status)).length;
  const pending = Object.values(dims).filter(d => d.status === 'pending').length;
  const failed = Object.values(dims).filter(d => d.status === 'failed').length;
  const total = DIMENSIONS.length;

  // Determine current phase
  let phase = 'unknown';
  if (state.status === 'completed') phase = 'completed';
  else if (needsFix > 0) phase = 'fixing';
  else if (running > 0) phase = 'reviewing';
  else if (pending === total) phase = 'initialized';
  else phase = 'in_progress';

  // Recent audit entries
  const recentAudit = readAuditLog(workDir, 5);

  return {
    status: phase,
    workDir,
    mode: state.mode,
    progress: {
      total,
      completed,
      needs_fix: needsFix,
      running,
      pending,
      failed,
    },
    completion_pct: Math.round((completed / total) * 100),
    dimensions: Object.fromEntries(
      Object.entries(dims).map(([k, v]) => [k, { status: v.status, round: v.round, issues: v.issues_found }])
    ),
    recent_activity: recentAudit.map(e => ({ type: e.type, ts: e.ts })),
  };
}

function main() {
  const workDir = process.argv[2];
  if (!workDir) {
    const error = Object.assign(new Error('用法: node orchestration-status.js <work-dir>'), { code: 'E_USAGE' });
    process.exitCode = writeJsonResult(failure(error, 'E_USAGE'));
    return;
  }
  try {
    process.exitCode = writeJsonResult(success(getStatus(workDir)));
  } catch (error) {
    process.exitCode = writeJsonResult(failure(error));
  }
}

if (require.main === module) main();
module.exports = { getStatus, main };
