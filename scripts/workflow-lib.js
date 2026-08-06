#!/usr/bin/env node
/**
 * optcode workflow state library.
 * Manages dimension loop state, round tracking, and audit logging.
 */
const _fs = require('node:fs');
const _path = require('node:path');

const DEFAULT_DEPS = Object.freeze({
  existsSync: _fs.existsSync,
  mkdirSync: _fs.mkdirSync,
  readFileSync: _fs.readFileSync,
  readdirSync: _fs.readdirSync,
  writeFileSync: _fs.writeFileSync,
  appendFileSync: _fs.appendFileSync,
  renameSync: _fs.renameSync,
  statSync: _fs.statSync,
  openSync: _fs.openSync,
  closeSync: _fs.closeSync,
  unlinkSync: _fs.unlinkSync,
  join: _path.join,
  now: () => new Date().toISOString(),
  pid: () => process.pid,
});

function resolveDeps(deps) {
  if (!deps || Object.keys(deps).length === 0) return DEFAULT_DEPS;
  return { ...DEFAULT_DEPS, ...deps };
}

const { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, renameSync } = _fs;
const { join } = _path;

const DIMENSIONS = [
  'dead-code',
  'duplication',
  'concurrency',
  'design',
  'style',
  'maintainability',
  'legacy-safety',
  'ai-sdd-smells',
  'security'
];

const MODES = ['light', 'deep', 'auto'];

const DEFAULT_MODE = 'light';

const MAX_ROUNDS = 20;

const STAGNATION_THRESHOLD = 3;

const DIMENSION_RESULTS = ['pending', 'in_progress', 'cr_running', 'cr_ready', 'pass', 'needs_fix', 'fix_running', 'fix_ready', 'failed', 'exceeded', 'skipped'];

const FIX_STATUSES = ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED'];

// Dimension activation conditions — keywords that must appear in target code
const DIMENSION_ACTIVATION = {
  'dead-code': { always: true },
  'duplication': { always: true },
  'concurrency': {
    always: false,
    keywords: ['async', 'await', 'thread', 'mutex', 'lock', 'channel', 'goroutine', 'Promise.all', 'concurrent', 'parallel', 'Worker', 'Atomics', 'SharedArrayBuffer']
  },
  'design': { always: true },
  'style': { always: true },
  'maintainability': { always: true },
  'legacy-safety': {
    always: false,
    keywords: ['deprecated', 'legacy', 'compat', 'migration', 'v1', 'old_', 'DEPRECATED', '@deprecated', 'backward']
  },
  'ai-sdd-smells': { always: true },
  'security': {
    always: false,
    keywords: ['password', 'secret', 'token', 'auth', 'login', 'session', 'cookie', 'jwt', 'bcrypt', 'crypto', 'hash', 'encrypt', 'decrypt', 'sql', 'query', 'exec', 'spawn', 'eval', 'innerHTML', 'dangerouslySetInnerHTML', 'sanitize', 'escape', 'cors', 'csrf', 'xss', 'req.body', 'req.params', 'req.query']
  },
};

const ACTIVATION_CAPABILITIES = Object.freeze({
  ALWAYS: 'always',
  CONCURRENCY: 'concurrency',
  LEGACY: 'legacy',
  SECURITY: 'security',
});

const DIMENSION_DESCRIPTORS = Object.freeze([
  { id: 'dead-code', displayName: 'Dead Code', capabilities: ['always'], keywords: [] },
  { id: 'duplication', displayName: 'Duplication', capabilities: ['always'], keywords: [] },
  { id: 'concurrency', displayName: 'Concurrency', capabilities: ['concurrency'], keywords: ['async', 'await', 'thread', 'mutex', 'lock', 'channel', 'goroutine', 'Promise.all', 'concurrent', 'parallel', 'Worker', 'Atomics', 'SharedArrayBuffer'] },
  { id: 'design', displayName: 'Design', capabilities: ['always'], keywords: [] },
  { id: 'style', displayName: 'Style', capabilities: ['always'], keywords: [] },
  { id: 'maintainability', displayName: 'Maintainability', capabilities: ['always'], keywords: [] },
  { id: 'legacy-safety', displayName: 'Legacy Safety', capabilities: ['legacy'], keywords: ['deprecated', 'legacy', 'compat', 'migration', 'v1', 'old_', 'DEPRECATED', '@deprecated', 'backward'] },
  { id: 'ai-sdd-smells', displayName: 'AI/SDD Smells', capabilities: ['always'], keywords: [] },
  { id: 'security', displayName: 'Security', capabilities: ['security'], keywords: ['password', 'secret', 'token', 'auth', 'login', 'session', 'cookie', 'jwt', 'bcrypt', 'crypto', 'hash', 'encrypt', 'decrypt', 'sql', 'query', 'exec', 'spawn', 'eval', 'innerHTML', 'dangerouslySetInnerHTML', 'sanitize', 'escape', 'cors', 'csrf', 'xss', 'req.body', 'req.params', 'req.query'] },
]);

function dimensionsFor(capability) {
  return DIMENSION_DESCRIPTORS.filter(d => d.capabilities.includes(capability));
}

function shouldActivate(dimensionId, contentText) {
  const descriptor = DIMENSION_DESCRIPTORS.find(d => d.id === dimensionId);
  if (!descriptor) return { activated: true, reason: 'unknown dimension (default active)' };
  if (descriptor.capabilities.includes(ACTIVATION_CAPABILITIES.ALWAYS)) {
    return { activated: true, reason: 'always active' };
  }
  if (descriptor.keywords.length > 0) {
    const found = descriptor.keywords.filter(kw => contentText.includes(kw));
    if (found.length > 0) return { activated: true, reason: `keywords found: ${found.slice(0, 5).join(', ')}` };
    return { activated: false, reason: 'no activation keywords found' };
  }
  return { activated: true, reason: 'no conditions to check' };
}

function ensureDir(dir, deps = {}) {
  const d = resolveDeps(deps);
  d.mkdirSync(dir, { recursive: true });
}

function stateFile(workDir, deps = {}) {
  const d = resolveDeps(deps);
  return d.join(workDir, 'state.json');
}

function auditLogFile(workDir, deps = {}) {
  const d = resolveDeps(deps);
  return d.join(workDir, 'audit-log.jsonl');
}

function readState(workDir, deps = {}) {
  const d = resolveDeps(deps);
  const file = stateFile(workDir, deps);
  if (!d.existsSync(file)) return null;
  try {
    return JSON.parse(d.readFileSync(file, 'utf8'));
  } catch (parseErr) {
    const backup = `${file}.backup`;
    if (d.existsSync(backup)) {
      try {
        const recovered = JSON.parse(d.readFileSync(backup, 'utf8'));
        d.writeFileSync(file, JSON.stringify(recovered, null, 2) + '\n');
        d.appendFileSync(
          auditLogFile(workDir, deps),
          JSON.stringify({ ts: d.now(), type: 'state_recovered_from_backup', error: parseErr.message }) + '\n'
        );
        return recovered;
      } catch { /* backup also corrupt — fall through */ }
    }
    throw new Error(`state.json corrupt and no valid backup: ${parseErr.message}`);
  }
}

function writeState(workDir, state, expectedSeq, deps = {}) {
  const d = resolveDeps(deps);
  ensureDir(workDir, deps);
  const file = stateFile(workDir, deps);
  if (expectedSeq !== undefined) {
    const current = d.existsSync(file) ? JSON.parse(d.readFileSync(file, 'utf8')) : null;
    const currentSeq = current ? (current._seq || 0) : 0;
    if (currentSeq !== expectedSeq) {
      throw new Error(`OCC conflict: expected _seq=${expectedSeq}, got ${currentSeq}`);
    }
  }
  if (d.existsSync(file)) {
    const backup = `${file}.backup`;
    const tmp_bak = `${backup}.${d.pid()}.tmp`;
    d.writeFileSync(tmp_bak, d.readFileSync(file));
    d.renameSync(tmp_bak, backup);
  }
  state._seq = (state._seq || 0) + 1;
  state.updated_at = d.now();
  const tmp = `${file}.${d.pid()}.tmp`;
  d.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  d.renameSync(tmp, file);
}

function writeStateWithRetry(workDir, mutator, maxRetries = 3, deps = {}) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const state = readState(workDir, deps);
    if (!state) throw new Error('state not initialized');
    const expectedSeq = state._seq || 0;
    mutator(state);
    try {
      writeState(workDir, state, expectedSeq, deps);
      return state;
    } catch (e) {
      if (e.message.startsWith('OCC conflict') && attempt < maxRetries - 1) continue;
      throw e;
    }
  }
}

function appendAudit(workDir, entry, deps = {}) {
  const d = resolveDeps(deps);
  ensureDir(workDir, deps);
  const record = { ts: d.now(), ...entry };
  const file = auditLogFile(workDir, deps);
  const line = JSON.stringify(record) + '\n';
  const existing = d.existsSync(file) ? d.readFileSync(file, 'utf8') : '';
  const tmp = `${file}.${d.pid()}.tmp`;
  d.writeFileSync(tmp, existing + line);
  d.renameSync(tmp, file);
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

function initState(workDir, targetPaths, baseCommit, skipDimensions = [], options = {}, deps = {}) {
  const d = resolveDeps(deps);
  const mode = normalizeMode(options.mode || DEFAULT_MODE);
  const state = {
    schema_version: 2,
    created_at: d.now(),
    updated_at: d.now(),
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
  ensureDir(d.join(workDir, 'cr'), deps);
  ensureDir(d.join(workDir, 'fix'), deps);
  ensureDir(d.join(workDir, 'verification'), deps);
  ensureDir(d.join(workDir, 'rca'), deps);
  ensureDir(d.join(workDir, 'regression'), deps);
  writeState(workDir, state, undefined, deps);
  appendAudit(workDir, {
    type: 'init',
    target_paths: targetPaths,
    base_commit: baseCommit,
    mode,
    resolved_mode: state.resolved_mode,
    init_options: state.init_options,
    skipped_dimensions: skipDimensions
  }, deps);
  return state;
}

function startDimension(workDir, dimension, deps = {}) {
  if (!DIMENSIONS.includes(dimension)) throw new Error(`unknown dimension: ${dimension}`);
  const state = writeStateWithRetry(workDir, (s) => {
    s.current_dimension = dimension;
    s.current_round = 1;
    s.dimensions[dimension].status = 'in_progress';
    s.dimensions[dimension].round = 1;
  }, 3, deps);
  appendAudit(workDir, { type: 'dimension_start', dimension }, deps);
  return state;
}

function findCrReport(workDir, dimension, round, deps = {}) {
  const d = resolveDeps(deps);
  const candidates = [
    { path: d.join(workDir, 'cr', `${dimension}-round-${round}.md`), kind: 'round' },
    { path: d.join(workDir, 'cr', `${dimension}-pass.md`), kind: 'pass' },
    { path: d.join(workDir, 'cr', `${dimension}-failed.md`), kind: 'failed' }
  ];
  return candidates.find(candidate => d.existsSync(candidate.path)) || null;
}

function findFixReport(workDir, dimension, round, deps = {}) {
  const d = resolveDeps(deps);
  const path = d.join(workDir, 'fix', `${dimension}-round-${round}-fix.md`);
  return d.existsSync(path) ? path : null;
}

function findRcaReport(workDir, dimension, round, deps = {}) {
  const d = resolveDeps(deps);
  const path = d.join(workDir, 'rca', `${dimension}-round-${round}.md`);
  return d.existsSync(path) ? path : null;
}

function markCrRunning(workDir, dimension, round, deps = {}) {
  const state = writeStateWithRetry(workDir, (s) => {
    const dim = s.dimensions[dimension];
    if (!dim) throw new Error(`unknown dimension: ${dimension}`);
    dim.status = 'cr_running';
    dim.round = round;
    s.current_dimension = dimension;
    s.current_round = round;
  }, 3, deps);
  appendAudit(workDir, { type: 'cr_started', dimension, round }, deps);
  return state;
}

function markCrReady(workDir, dimension, round, deps = {}) {
  const report = findCrReport(workDir, dimension, round, deps);
  if (!report) throw new Error(`CR report missing for ${dimension} round ${round}`);
  const state = writeStateWithRetry(workDir, (s) => {
    const dim = s.dimensions[dimension];
    if (!dim) throw new Error(`unknown dimension: ${dimension}`);
    dim.status = 'cr_ready';
    dim.round = round;
  }, 3, deps);
  appendAudit(workDir, { type: 'cr_ready', dimension, round, report_path: report.path }, deps);
  return state;
}

function markFixRunning(workDir, dimension, round, deps = {}) {
  const state = writeStateWithRetry(workDir, (s) => {
    const dim = s.dimensions[dimension];
    if (!dim) throw new Error(`unknown dimension: ${dimension}`);
    dim.status = 'fix_running';
    dim.round = round;
    s.current_dimension = dimension;
    s.current_round = round;
  }, 3, deps);
  appendAudit(workDir, { type: 'fix_started', dimension, round }, deps);
  return state;
}

function markFixReady(workDir, dimension, round, deps = {}) {
  const reportPath = findFixReport(workDir, dimension, round, deps);
  if (!reportPath) throw new Error(`Fix report missing for ${dimension} round ${round}`);
  const state = writeStateWithRetry(workDir, (s) => {
    const dim = s.dimensions[dimension];
    if (!dim) throw new Error(`unknown dimension: ${dimension}`);
    dim.status = 'fix_ready';
    dim.round = round;
  }, 3, deps);
  appendAudit(workDir, { type: 'fix_ready', dimension, round, report_path: reportPath }, deps);
  return state;
}

function extractIssueIds(workDir, dimension, round, deps = {}) {
  const d = resolveDeps(deps);
  const report = findCrReport(workDir, dimension, round, deps);
  if (report) {
    const text = d.readFileSync(report.path, 'utf8');
    const ids = [...text.matchAll(/###\s+(?:[A-Za-z][\w-]*:)?(ISSUE-\d+)/g)].map(m => m[1]);
    return [...new Set(ids)];
  }
  return [];
}

function recordCrResult(workDir, dimension, round, result, issuesCount = 0, deps = {}) {
  const issueIds = extractIssueIds(workDir, dimension, round, deps);
  const state = writeStateWithRetry(workDir, (s) => {
    const dim = s.dimensions[dimension];
    if (!dim) throw new Error(`unknown dimension: ${dimension}`);
    dim.round = round;
    if (result === 'pass') {
      dim.status = 'pass';
      s.current_dimension = null;
    } else if (result === 'failed') {
      dim.status = 'failed';
      s.current_dimension = null;
    } else if (result === 'needs_fix') {
      dim.status = 'needs_fix';
      dim.issues_found += issuesCount;
      dim.issue_history.push({ round, issues_count: issuesCount, issue_ids: issueIds });
    }
  }, 3, deps);
  appendAudit(workDir, { type: 'cr_result', dimension, round, result, issues_count: issuesCount, issue_ids: issueIds }, deps);
  return state;
}

function recordFixResult(workDir, dimension, round, result, fixedCount = 0, status = 'DONE', deps = {}) {
  let needsContextAudit = false;
  const state = writeStateWithRetry(workDir, (s) => {
    const dim = s.dimensions[dimension];
    if (!dim) throw new Error(`unknown dimension: ${dimension}`);
    if (result === 'failed' || status === 'BLOCKED') {
      dim.status = 'failed';
      dim.issues_fixed += fixedCount;
      s.current_dimension = null;
    } else if (status === 'NEEDS_CONTEXT') {
      dim.status = 'failed';
      dim.issues_fixed += fixedCount;
      s.current_dimension = null;
      needsContextAudit = true;
    } else {
      dim.issues_fixed += fixedCount;
      s.current_round = round + 1;
      dim.round = round + 1;
      dim.status = 'in_progress';
    }
  }, 3, deps);
  if (needsContextAudit) appendAudit(workDir, { type: 'fix_needs_context', dimension, round }, deps);
  appendAudit(workDir, { type: 'fix_result', dimension, round, result, fixed_count: fixedCount, status }, deps);
  return state;
}

function exceedDimension(workDir, dimension, deps = {}) {
  const state = writeStateWithRetry(workDir, (s) => {
    s.dimensions[dimension].status = 'exceeded';
    s.current_dimension = null;
  }, 3, deps);
  appendAudit(workDir, { type: 'dimension_exceeded', dimension, max_rounds: MAX_ROUNDS }, deps);
  return state;
}

function completeWorkflow(workDir, deps = {}) {
  const d = resolveDeps(deps);
  const state = writeStateWithRetry(workDir, (s) => {
    s.status = 'completed';
    s.completed_at = d.now();
  }, 3, deps);
  appendAudit(workDir, { type: 'workflow_completed' }, deps);
  return state;
}

function recordPreflightResult(workDir, recommendedMode, reason = '', signals = {}, deps = {}) {
  const d = resolveDeps(deps);
  if (!['light', 'deep'].includes(recommendedMode)) throw new Error(`invalid recommended mode: ${recommendedMode}`);
  const state = writeStateWithRetry(workDir, (s) => {
    s.mode = s.mode || 'auto';
    s.preflight = {
      status: 'completed',
      recommended_mode: recommendedMode,
      reason,
      signals,
      completed_at: d.now()
    };
    s.resolved_mode = recommendedMode;
    if (recommendedMode === 'deep' && !s.deep_plan) {
      s.deep_plan = buildDeepPlan(workDir, 'deep');
    }
  }, 3, deps);
  appendAudit(workDir, { type: 'preflight_result', recommended_mode: recommendedMode, reason, signals }, deps);
  return state;
}

function recordDeepPlanDone(workDir, deps = {}) {
  const d = resolveDeps(deps);
  const state = writeStateWithRetry(workDir, (s) => {
    s.deep_plan = s.deep_plan || buildDeepPlan(workDir, 'deep');
    s.deep_plan.status = 'completed';
    s.deep_plan.path = s.deep_plan.path || d.join(workDir, 'deep-plan.md');
    s.deep_plan.completed_at = d.now();
    if (s.status === 'completed') s.status = 'reviewing';
  }, 3, deps);
  appendAudit(workDir, { type: 'deep_plan_completed', path: state.deep_plan.path }, deps);
  return state;
}

function detectStagnation(workDir, dimension, deps = {}) {
  const state = readState(workDir, deps);
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

function getResumePoint(workDir, deps = {}) {
  const state = readState(workDir, deps);
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
    // Deep plan is an intermediate checkpoint. Resume the normal CR/fix/
    // verification flow below instead of treating the plan as terminal.
  }

  if (state.current_dimension) {
    const dim = state.dimensions[state.current_dimension];
    if (dim.round > MAX_ROUNDS) {
      if (dim.status === 'cr_ready') {
        return { action: 'cr_gate', dimension: state.current_dimension, round: dim.round, reason: 'CR report ready for gate check (round exceeds max, process before exceeding)' };
      }
      if (dim.status === 'fix_ready') {
        return { action: 'fix_gate', dimension: state.current_dimension, round: dim.round, reason: 'Fix report ready for gate check (round exceeds max, process before exceeding)' };
      }
      return { action: 'exceed', dimension: state.current_dimension, reason: `round ${dim.round} exceeds max ${MAX_ROUNDS}` };
    }
    if (dim.status === 'cr_running') {
      if (findCrReport(workDir, state.current_dimension, dim.round, deps)) {
        return { action: 'cr_gate', dimension: state.current_dimension, round: dim.round, reason: 'CR report exists, ready for gate check' };
      }
      return { action: 'cr_wait', dimension: state.current_dimension, round: dim.round, reason: 'CR agent is running or report has not been written yet' };
    }
    if (dim.status === 'cr_ready') {
      return { action: 'cr_gate', dimension: state.current_dimension, round: dim.round, reason: 'CR report ready for gate check' };
    }
    if (dim.status === 'needs_fix') {
      const stagnation = detectStagnation(workDir, state.current_dimension, deps);
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
    if (dim.status === 'fix_running') {
      if (findFixReport(workDir, state.current_dimension, dim.round, deps)) {
        return { action: 'fix_gate', dimension: state.current_dimension, round: dim.round, reason: 'Fix report exists, ready for gate check' };
      }
      return { action: 'fix_wait', dimension: state.current_dimension, round: dim.round, reason: 'Fix agent is running or report has not been written yet' };
    }
    if (dim.status === 'fix_ready') {
      return { action: 'fix_gate', dimension: state.current_dimension, round: dim.round, reason: 'Fix report ready for gate check' };
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

function readAuditLog(workDir, tail = 0, deps = {}) {
  const d = resolveDeps(deps);
  const file = auditLogFile(workDir, deps);
  if (!d.existsSync(file)) return [];
  const lines = d.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const entries = lines.map(line => JSON.parse(line));
  return tail > 0 ? entries.slice(-tail) : entries;
}

function acquireLockSync(lockPath, options = {}, deps = {}) {
  const { timeoutMs = 5000, staleMs = 600000, pollMs = 50 } = options;
  const d = resolveDeps(deps);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const fd = d.openSync(lockPath, 'wx');
      d.writeFileSync(lockPath, JSON.stringify({ pid: d.pid(), createdAt: d.now() }));
      return { handle: fd, lockPath };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const stat = d.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          d.unlinkSync(lockPath);
          continue;
        }
      } catch { continue; }
      if (Date.now() >= deadline) {
        throw new Error(`acquireLock timeout: could not acquire ${lockPath} within ${timeoutMs}ms`);
      }
      const end = Date.now() + Math.min(pollMs, deadline - Date.now());
      while (Date.now() < end) { /* spin */ }
    }
  }
}

function releaseLock(lockPath, handle, deps = {}) {
  const d = resolveDeps(deps);
  try { d.closeSync(handle); } catch {}
  try { d.unlinkSync(lockPath); } catch {}
}

function atomicReplace(targetPath, content, deps = {}) {
  const d = resolveDeps(deps);
  const tmp = `${targetPath}.${d.pid()}.tmp`;
  d.writeFileSync(tmp, content);
  d.renameSync(tmp, targetPath);
}

function availableLane(data, status = 'available') {
  return { status, data };
}

function unavailableLane(owner, error) {
  return {
    status: 'unavailable',
    owner,
    error: error instanceof Error ? error.message : String(error),
  };
}

function laneIsAvailable(lane) {
  return lane && (lane.status === 'available' || lane.status === 'partial');
}

function compositeStatus(lanes, mode = 'light') {
  if (!lanes || lanes.length === 0) return 'failed';
  const statuses = lanes.map(l => l.status);
  if (statuses.every(s => s === 'available')) return 'complete';
  if (mode === 'deep' && statuses.some(s => s === 'unavailable')) return 'failed';
  return 'partial';
}

module.exports = {
  DIMENSIONS,
  MODES,
  DEFAULT_MODE,
  MAX_ROUNDS,
  STAGNATION_THRESHOLD,
  DIMENSION_RESULTS,
  FIX_STATUSES,
  DIMENSION_ACTIVATION,
  ACTIVATION_CAPABILITIES,
  DIMENSION_DESCRIPTORS,
  DEFAULT_DEPS,
  resolveDeps,
  ensureDir,
  stateFile,
  auditLogFile,
  readState,
  writeState,
  writeStateWithRetry,
  appendAudit,
  normalizeMode,
  initState,
  startDimension,
  findCrReport,
  findFixReport,
  findRcaReport,
  markCrRunning,
  markCrReady,
  markFixRunning,
  markFixReady,
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
  readAuditLog,
  dimensionsFor,
  shouldActivate,
  acquireLockSync,
  releaseLock,
  atomicReplace,
  availableLane,
  unavailableLane,
  laneIsAvailable,
  compositeStatus,
};
