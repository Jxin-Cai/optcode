#!/usr/bin/env node
/**
 * optcode workflow state library.
 * Manages dimension loop state, round tracking, and audit logging.
 */
const { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, renameSync } = require('node:fs');
const { join } = require('node:path');

const DIMENSIONS = [
  'dead-code',
  'duplication',
  'concurrency',
  'design',
  'style',
  'maintainability',
  'legacy-safety'
];

const MODES = ['light', 'deep', 'auto'];

const DEFAULT_MODE = 'light';

const MAX_ROUNDS = 20;

const STAGNATION_THRESHOLD = 3;

const DIMENSION_RESULTS = ['pending', 'in_progress', 'pass', 'needs_fix', 'failed', 'exceeded', 'skipped'];

const FIX_STATUSES = ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED'];

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function stateFile(workDir) {
  return join(workDir, 'state.json');
}

function auditLogFile(workDir) {
  return join(workDir, 'audit-log.jsonl');
}

function readState(workDir) {
  const file = stateFile(workDir);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeState(workDir, state) {
  ensureDir(workDir);
  state.updated_at = new Date().toISOString();
  const file = stateFile(workDir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, file);
}

function appendAudit(workDir, entry) {
  ensureDir(workDir);
  const record = { ts: new Date().toISOString(), ...entry };
  appendFileSync(auditLogFile(workDir), JSON.stringify(record) + '\n');
}

function normalizeMode(mode = DEFAULT_MODE) {
  if (!MODES.includes(mode)) throw new Error(`unknown mode: ${mode}`);
  return mode;
}

function buildPreflight(mode) {
  if (mode !== 'auto') return null;
  return {
    status: 'pending',
    recommended_mode: null,
    reason: null,
    signals: {},
    completed_at: null
  };
}

function buildDeepPlan(workDir, mode) {
  if (mode !== 'deep') return null;
  return {
    status: 'pending',
    path: join(workDir, 'deep-plan.md'),
    completed_at: null
  };
}

function getEffectiveMode(state) {
  if (!state) return DEFAULT_MODE;
  const mode = state.mode || DEFAULT_MODE;
  if (mode === 'auto') return state.resolved_mode || 'auto';
  return state.resolved_mode || mode;
}

function initState(workDir, targetPaths, baseCommit, skipDimensions = [], options = {}) {
  const mode = normalizeMode(options.mode || DEFAULT_MODE);
  const state = {
    schema_version: 2,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    target_paths: targetPaths,
    base_commit: baseCommit,
    mode,
    requested_mode: options.requested_mode || mode,
    resolved_mode: mode === 'auto' ? null : mode,
    init_options: {
      diff: Boolean(options.diff),
      diff_base_ref: options.diff_base_ref || null,
      skip_dimensions: skipDimensions
    },
    preflight: buildPreflight(mode),
    deep_plan: buildDeepPlan(workDir, mode),
    current_dimension: null,
    current_round: 0,
    dimensions: {}
  };
  const skipSet = new Set(skipDimensions);
  for (const dim of DIMENSIONS) {
    state.dimensions[dim] = {
      status: skipSet.has(dim) ? 'skipped' : 'pending',
      round: 0,
      issues_found: 0,
      issues_fixed: 0,
      issue_history: []
    };
  }
  ensureDir(join(workDir, 'cr'));
  ensureDir(join(workDir, 'fix'));
  writeState(workDir, state);
  appendAudit(workDir, {
    type: 'init',
    target_paths: targetPaths,
    base_commit: baseCommit,
    mode,
    resolved_mode: state.resolved_mode,
    init_options: state.init_options,
    skipped_dimensions: skipDimensions
  });
  return state;
}

function startDimension(workDir, dimension) {
  const state = readState(workDir);
  if (!state) throw new Error('state not initialized');
  if (!DIMENSIONS.includes(dimension)) throw new Error(`unknown dimension: ${dimension}`);
  state.current_dimension = dimension;
  state.current_round = 1;
  state.dimensions[dimension].status = 'in_progress';
  state.dimensions[dimension].round = 1;
  writeState(workDir, state);
  appendAudit(workDir, { type: 'dimension_start', dimension });
  return state;
}

function extractIssueIds(workDir, dimension, round) {
  const candidates = [
    join(workDir, 'cr', `${dimension}-round-${round}.md`),
    join(workDir, 'cr', `${dimension}-pass.md`),
    join(workDir, 'cr', `${dimension}-failed.md`)
  ];
  for (const file of candidates) {
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8');
      const ids = [...text.matchAll(/###\s+(ISSUE-\d+)/g)].map(m => m[1]);
      return [...new Set(ids)];
    }
  }
  return [];
}

function recordCrResult(workDir, dimension, round, result, issuesCount = 0) {
  const state = readState(workDir);
  if (!state) throw new Error('state not initialized');
  const dim = state.dimensions[dimension];
  if (!dim) throw new Error(`unknown dimension: ${dimension}`);
  dim.round = round;
  const issueIds = extractIssueIds(workDir, dimension, round);
  if (result === 'pass') {
    dim.status = 'pass';
    state.current_dimension = null;
  } else if (result === 'failed') {
    dim.status = 'failed';
    state.current_dimension = null;
  } else if (result === 'needs_fix') {
    dim.status = 'needs_fix';
    dim.issues_found += issuesCount;
    dim.issue_history.push({ round, issues_count: issuesCount, issue_ids: issueIds });
  }
  writeState(workDir, state);
  appendAudit(workDir, { type: 'cr_result', dimension, round, result, issues_count: issuesCount, issue_ids: issueIds });
  return state;
}

function recordFixResult(workDir, dimension, round, result, fixedCount = 0, status = 'DONE') {
  const state = readState(workDir);
  if (!state) throw new Error('state not initialized');
  const dim = state.dimensions[dimension];
  if (!dim) throw new Error(`unknown dimension: ${dimension}`);

  if (result === 'failed' || status === 'BLOCKED') {
    dim.status = 'failed';
    state.current_dimension = null;
  } else if (status === 'NEEDS_CONTEXT') {
    dim.status = 'failed';
    state.current_dimension = null;
    appendAudit(workDir, { type: 'fix_needs_context', dimension, round });
  } else {
    dim.issues_fixed += fixedCount;
    state.current_round = round + 1;
    dim.round = round + 1;
    dim.status = 'in_progress';
  }
  writeState(workDir, state);
  appendAudit(workDir, { type: 'fix_result', dimension, round, result, fixed_count: fixedCount, status });
  return state;
}

function exceedDimension(workDir, dimension) {
  const state = readState(workDir);
  if (!state) throw new Error('state not initialized');
  state.dimensions[dimension].status = 'exceeded';
  state.current_dimension = null;
  writeState(workDir, state);
  appendAudit(workDir, { type: 'dimension_exceeded', dimension, max_rounds: MAX_ROUNDS });
  return state;
}

function completeWorkflow(workDir) {
  const state = readState(workDir);
  if (!state) throw new Error('state not initialized');
  state.status = 'completed';
  state.completed_at = new Date().toISOString();
  writeState(workDir, state);
  appendAudit(workDir, { type: 'workflow_completed' });
  return state;
}

function recordPreflightResult(workDir, recommendedMode, reason = '', signals = {}) {
  const state = readState(workDir);
  if (!state) throw new Error('state not initialized');
  if (!['light', 'deep'].includes(recommendedMode)) throw new Error(`invalid recommended mode: ${recommendedMode}`);
  state.mode = state.mode || 'auto';
  state.preflight = {
    status: 'completed',
    recommended_mode: recommendedMode,
    reason,
    signals,
    completed_at: new Date().toISOString()
  };
  state.resolved_mode = recommendedMode;
  if (recommendedMode === 'deep' && !state.deep_plan) {
    state.deep_plan = buildDeepPlan(workDir, 'deep');
  }
  writeState(workDir, state);
  appendAudit(workDir, { type: 'preflight_result', recommended_mode: recommendedMode, reason, signals });
  return state;
}

function recordDeepPlanDone(workDir) {
  const state = readState(workDir);
  if (!state) throw new Error('state not initialized');
  state.deep_plan = state.deep_plan || buildDeepPlan(workDir, 'deep');
  state.deep_plan.status = 'completed';
  state.deep_plan.path = state.deep_plan.path || join(workDir, 'deep-plan.md');
  state.deep_plan.completed_at = new Date().toISOString();
  state.status = 'completed';
  state.completed_at = state.deep_plan.completed_at;
  writeState(workDir, state);
  appendAudit(workDir, { type: 'deep_plan_completed', path: state.deep_plan.path });
  return state;
}

function detectStagnation(workDir, dimension) {
  const state = readState(workDir);
  if (!state) return { stagnant: false };
  const dim = state.dimensions[dimension];
  if (!dim || !dim.issue_history) return { stagnant: false };

  const history = dim.issue_history;
  if (history.length < STAGNATION_THRESHOLD) return { stagnant: false };

  const recent = history.slice(-STAGNATION_THRESHOLD);

  const hasIssueIds = recent.every(h => h.issue_ids && h.issue_ids.length > 0);
  if (hasIssueIds) {
    const sets = recent.map(h => new Set(h.issue_ids));
    let allStagnant = true;
    for (let i = 1; i < sets.length; i++) {
      const prev = sets[i - 1];
      const curr = sets[i];
      const overlap = [...curr].filter(id => prev.has(id)).length;
      const overlapRate = overlap / Math.max(prev.size, curr.size);
      if (overlapRate < 0.5) { allStagnant = false; break; }
    }
    if (allStagnant) {
      return {
        stagnant: true,
        rounds_stagnant: STAGNATION_THRESHOLD,
        recent_issues: recent,
        reason: `same issues recurring over the last ${STAGNATION_THRESHOLD} rounds (IDs overlap ≥50%: ${recent.map(h => h.issue_ids.join(',')).join(' → ')})`
      };
    }
    return { stagnant: false };
  }

  const firstCount = recent[0].issues_count;
  const noImprovement = recent.every(h => h.issues_count >= firstCount);
  if (noImprovement) {
    return {
      stagnant: true,
      rounds_stagnant: STAGNATION_THRESHOLD,
      recent_issues: recent,
      reason: `issues_count has not decreased over the last ${STAGNATION_THRESHOLD} rounds (${recent.map(h => h.issues_count).join(' → ')})`
    };
  }

  return { stagnant: false };
}

function getResumePoint(workDir) {
  const state = readState(workDir);
  if (!state) return { action: 'init', reason: 'state not initialized' };

  if (state.status === 'completed') {
    return { action: 'done', reason: 'workflow already completed', completed_at: state.completed_at };
  }

  const mode = state.mode || DEFAULT_MODE;
  if (mode === 'auto' && (!state.preflight || state.preflight.status !== 'completed')) {
    return { action: 'preflight', reason: 'auto mode requires preflight before selecting workflow' };
  }

  const effectiveMode = getEffectiveMode(state);
  if (effectiveMode === 'deep') {
    if (!state.deep_plan || state.deep_plan.status !== 'completed') {
      return { action: 'deep_plan', reason: 'deep mode runs plan-only structural diagnosis' };
    }
    return { action: 'done', reason: 'deep plan already completed', completed_at: state.deep_plan.completed_at };
  }

  if (state.current_dimension) {
    const dim = state.dimensions[state.current_dimension];
    if (dim.round > MAX_ROUNDS) {
      return { action: 'exceed', dimension: state.current_dimension, reason: `round ${dim.round} exceeds max ${MAX_ROUNDS}` };
    }
    if (dim.status === 'needs_fix') {
      const stagnation = detectStagnation(workDir, state.current_dimension);
      if (stagnation.stagnant) {
        return {
          action: 'escalate',
          dimension: state.current_dimension,
          round: dim.round,
          stagnation,
          reason: `fix stagnation detected: ${stagnation.reason}`
        };
      }
      return { action: 'fix', dimension: state.current_dimension, round: dim.round, reason: 'CR found issues, awaiting fix' };
    }
    return { action: 'cr', dimension: state.current_dimension, round: dim.round, reason: 'dimension in progress' };
  }

  for (const dim of DIMENSIONS) {
    if (state.dimensions[dim].status === 'pending') {
      return { action: 'start_dimension', dimension: dim, reason: `next pending dimension: ${dim}` };
    }
  }

  const summaryFile = join(workDir, 'summary.md');
  if (existsSync(summaryFile)) {
    return { action: 'done', reason: 'summary already exists, workflow finished' };
  }

  return { action: 'summary', reason: 'all dimensions complete' };
}

function readFrontmatter(text) {
  const lines = String(text || '').split('\n');
  if (lines[0] !== '---') return {};
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end === -1) return {};
  const result = {};
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, raw] = match;
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) result[key] = Number(trimmed);
    else result[key] = trimmed;
  }
  return result;
}

function readAuditLog(workDir, tail = 0) {
  const file = auditLogFile(workDir);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const entries = lines.map(line => JSON.parse(line));
  return tail > 0 ? entries.slice(-tail) : entries;
}

module.exports = {
  DIMENSIONS,
  MODES,
  DEFAULT_MODE,
  MAX_ROUNDS,
  STAGNATION_THRESHOLD,
  DIMENSION_RESULTS,
  FIX_STATUSES,
  ensureDir,
  stateFile,
  auditLogFile,
  readState,
  writeState,
  appendAudit,
  normalizeMode,
  initState,
  startDimension,
  extractIssueIds,
  recordCrResult,
  recordFixResult,
  exceedDimension,
  completeWorkflow,
  recordPreflightResult,
  recordDeepPlanDone,
  detectStagnation,
  getResumePoint,
  readFrontmatter,
  readAuditLog
};
