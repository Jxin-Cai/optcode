#!/usr/bin/env node
/**
 * optcode workflow state library.
 * Manages dimension loop state, round tracking, and audit logging.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const DIMENSIONS = [
  'dead-code',
  'duplication',
  'concurrency',
  'design',
  'style',
  'maintainability',
  'legacy-safety'
];

export const MAX_ROUNDS = 20;

export const STAGNATION_THRESHOLD = 3;

export const DIMENSION_RESULTS = ['pending', 'in_progress', 'pass', 'needs_fix', 'failed', 'exceeded'];

export const FIX_STATUSES = ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED'];

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

export function stateFile(workDir) {
  return join(workDir, 'state.json');
}

export function auditLogFile(workDir) {
  return join(workDir, 'audit-log.jsonl');
}

export function readState(workDir) {
  const file = stateFile(workDir);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeState(workDir, state) {
  ensureDir(workDir);
  state.updated_at = new Date().toISOString();
  const file = stateFile(workDir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, file);
}

export function appendAudit(workDir, entry) {
  ensureDir(workDir);
  const record = { ts: new Date().toISOString(), ...entry };
  appendFileSync(auditLogFile(workDir), JSON.stringify(record) + '\n');
}

export function initState(workDir, targetPaths, baseCommit) {
  const state = {
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    target_paths: targetPaths,
    base_commit: baseCommit,
    current_dimension: null,
    current_round: 0,
    dimensions: {}
  };
  for (const dim of DIMENSIONS) {
    state.dimensions[dim] = {
      status: 'pending',
      round: 0,
      issues_found: 0,
      issues_fixed: 0,
      issue_history: []
    };
  }
  ensureDir(join(workDir, 'cr'));
  ensureDir(join(workDir, 'fix'));
  writeState(workDir, state);
  appendAudit(workDir, { type: 'init', target_paths: targetPaths, base_commit: baseCommit });
  return state;
}

export function startDimension(workDir, dimension) {
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

export function recordCrResult(workDir, dimension, round, result, issuesCount = 0) {
  const state = readState(workDir);
  if (!state) throw new Error('state not initialized');
  const dim = state.dimensions[dimension];
  if (!dim) throw new Error(`unknown dimension: ${dimension}`);
  dim.round = round;
  if (result === 'pass') {
    dim.status = 'pass';
    state.current_dimension = null;
  } else if (result === 'failed') {
    dim.status = 'failed';
    state.current_dimension = null;
  } else if (result === 'needs_fix') {
    dim.status = 'needs_fix';
    dim.issues_found += issuesCount;
    dim.issue_history.push({ round, issues_count: issuesCount });
  }
  writeState(workDir, state);
  appendAudit(workDir, { type: 'cr_result', dimension, round, result, issues_count: issuesCount });
  return state;
}

export function recordFixResult(workDir, dimension, round, result, fixedCount = 0, status = 'DONE') {
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

export function exceedDimension(workDir, dimension) {
  const state = readState(workDir);
  if (!state) throw new Error('state not initialized');
  state.dimensions[dimension].status = 'exceeded';
  state.current_dimension = null;
  writeState(workDir, state);
  appendAudit(workDir, { type: 'dimension_exceeded', dimension, max_rounds: MAX_ROUNDS });
  return state;
}

export function detectStagnation(workDir, dimension) {
  const state = readState(workDir);
  if (!state) return { stagnant: false };
  const dim = state.dimensions[dimension];
  if (!dim || !dim.issue_history) return { stagnant: false };

  const history = dim.issue_history;
  if (history.length < STAGNATION_THRESHOLD) return { stagnant: false };

  const recent = history.slice(-STAGNATION_THRESHOLD);
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

export function getResumePoint(workDir) {
  const state = readState(workDir);
  if (!state) return { action: 'init', reason: 'state not initialized' };

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

  return { action: 'summary', reason: 'all dimensions complete' };
}

export function readFrontmatter(text) {
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

export function readAuditLog(workDir, tail = 0) {
  const file = auditLogFile(workDir);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const entries = lines.map(line => JSON.parse(line));
  return tail > 0 ? entries.slice(-tail) : entries;
}
