#!/usr/bin/env node
/**
 * optcode quality gate — computes a quality score from dimension results.
 *
 * Usage: node quality-gate.js <work-dir> [--no-history]
 * Output: JSON with verdict (PASS/WARN/FAIL), score, and per-dimension breakdown.
 */
const { readState, DIMENSIONS, readFrontmatter } = require('./workflow-lib.js');
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { failure, success } = require('./cli-result.js');
const { CLI_EXIT_CODES } = require('./error-codes.js');

const args = process.argv.slice(2);
const workDir = args.find(arg => !arg.startsWith('--'));
const noHistory = args.includes('--no-history');

if (!workDir) {
  process.stderr.write('用法: node quality-gate.js <work-dir> [--no-history]\n');
  process.exit(1);
}

const VERDICT_THRESHOLDS = {
  PASS: 80,
  WARN: 50
};

const LOW_SCORE_FINDING_THRESHOLD = 70;

function getLastFixStatus(workDir, dimension) {
  const fixDir = join(workDir, 'fix');
  if (!existsSync(fixDir)) return null;
  const files = readdirSync(fixDir)
    .filter(f => f.startsWith(`${dimension}-round-`) && f.endsWith('-fix.md'))
    .sort();
  if (files.length === 0) return null;
  const text = readFileSync(join(fixDir, files[files.length - 1]), 'utf8');
  return readFrontmatter(text);
}

function scoreDimension(dimState, workDir, dimension, base) {
  switch (dimState.status) {
    case 'pass':
      return base;
    case 'failed': {
      const fixRate = dimState.issues_found > 0
        ? dimState.issues_fixed / dimState.issues_found
        : 0;
      return base * 0.15 * fixRate;
    }
    case 'exceeded': {
      const fixRate = dimState.issues_found > 0
        ? dimState.issues_fixed / dimState.issues_found
        : 0;
      return base * (0.2 + 0.3 * fixRate);
    }
    case 'cr_running':
    case 'cr_ready':
    case 'fix_running':
    case 'fix_ready':
    case 'in_progress':
    case 'needs_fix': {
      const fixMeta = getLastFixStatus(workDir, dimension);
      if (fixMeta && fixMeta.status === 'DONE_WITH_CONCERNS') {
        const fixRate = dimState.issues_found > 0
          ? dimState.issues_fixed / dimState.issues_found
          : 0;
        return base * (0.3 + 0.3 * fixRate);
      }
      return base * 0.3;
    }
    case 'skipped':
      return 0;
    case 'pending':
      return 0;
    default:
      return 0;
  }
}

function recordToHistory(workDir, gateOutput, state) {
  const { recordHistory } = require('./dashboard.js');
  return recordHistory(process.cwd(), workDir, gateOutput, state);
}

function main() {
  const state = readState(workDir);
  if (!state) {
    process.stderr.write('state.json not found\n');
    process.exit(1);
  }

  const breakdown = {};
  let totalScore = 0;
  const activeDimensions = DIMENSIONS.filter(dim => state.dimensions[dim].status !== 'skipped');
  const baseScore = activeDimensions.length > 0 ? 100 / activeDimensions.length : 0;
  const incomplete = activeDimensions.some(dim => state.dimensions[dim].status === 'pending');

  for (const dim of DIMENSIONS) {
    const dimState = state.dimensions[dim];
    const score = dimState.status === 'skipped' ? 0 : scoreDimension(dimState, workDir, dim, baseScore);
    totalScore += score;
    const fixRate = dimState.issues_found > 0
      ? Math.round((dimState.issues_fixed / dimState.issues_found) * 100)
      : null;
    breakdown[dim] = {
      status: dimState.status,
      score: Math.round(score * 10) / 10,
      issues_found: dimState.issues_found || 0,
      issues_fixed: dimState.issues_fixed || 0,
      fix_rate: fixRate !== null ? `${fixRate}%` : 'N/A',
      rounds: dimState.round || 0
    };
  }

  totalScore = Math.round(totalScore * 10) / 10;

  // Score-Finding consistency: if a dimension scored below threshold, it must have linked findings
  const scoreConsistencyWarnings = [];
  for (const dim of activeDimensions) {
    const dimScore = breakdown[dim].score;
    const normalizedScore = baseScore > 0 ? (dimScore / baseScore) * 100 : 0;
    if (normalizedScore < LOW_SCORE_FINDING_THRESHOLD && breakdown[dim].issues_found === 0) {
      scoreConsistencyWarnings.push(
        `${dim}: score ${Math.round(normalizedScore)}% < ${LOW_SCORE_FINDING_THRESHOLD}% but no findings linked`
      );
    }
  }

  let verdict;
  if (incomplete || activeDimensions.length === 0) {
    verdict = 'FAIL';
  } else if (totalScore >= VERDICT_THRESHOLDS.PASS) {
    verdict = 'PASS';
  } else if (totalScore >= VERDICT_THRESHOLDS.WARN) {
    verdict = 'WARN';
  } else {
    verdict = 'FAIL';
  }

  const output = {
    verdict,
    score: totalScore,
    max_score: 100,
    thresholds: VERDICT_THRESHOLDS,
    active_dimensions: activeDimensions.length,
    skipped_dimensions: DIMENSIONS.length - activeDimensions.length,
    incomplete,
    score_finding_consistency: scoreConsistencyWarnings.length === 0 ? 'OK' : scoreConsistencyWarnings,
    breakdown
  };

  if (state.status === 'completed' && !noHistory) {
    try {
      recordToHistory(workDir, output, state);
      output.history_recorded = true;
    } catch (error) {
      console.log(JSON.stringify({ ...failure(error), ...output, history_recorded: false }, null, 2));
      process.exitCode = error.code === 'E_STORE_CORRUPT'
        ? CLI_EXIT_CODES.INVALID_STATE
        : CLI_EXIT_CODES.FAILURE;
      return;
    }
  }
  console.log(JSON.stringify(success(output), null, 2));
}

main();
