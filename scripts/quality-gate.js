#!/usr/bin/env node
/**
 * optcode quality gate — computes a quality score from dimension results.
 *
 * Usage: node quality-gate.js <work-dir>
 * Output: JSON with verdict (PASS/WARN/FAIL), score, and per-dimension breakdown.
 */
const { readState, DIMENSIONS } = require('./workflow-lib.js');

const workDir = process.argv[2];

if (!workDir) {
  process.stderr.write('用法: node quality-gate.js <work-dir>\n');
  process.exit(1);
}

const SCORE_PER_DIMENSION = 100 / DIMENSIONS.length;

const VERDICT_THRESHOLDS = {
  PASS: 80,
  WARN: 50
};

function scoreDimension(dimState) {
  switch (dimState.status) {
    case 'pass':
      return SCORE_PER_DIMENSION;
    case 'failed':
    case 'exceeded':
      return 0;
    case 'in_progress':
    case 'needs_fix':
      return SCORE_PER_DIMENSION * 0.3;
    case 'pending':
      return SCORE_PER_DIMENSION * 0.5;
    default:
      return 0;
  }
}

function main() {
  const state = readState(workDir);
  if (!state) {
    process.stderr.write('state.json not found\n');
    process.exit(1);
  }

  const breakdown = {};
  let totalScore = 0;

  for (const dim of DIMENSIONS) {
    const dimState = state.dimensions[dim];
    const score = scoreDimension(dimState);
    totalScore += score;
    breakdown[dim] = {
      status: dimState.status,
      score: Math.round(score * 10) / 10,
      issues_found: dimState.issues_found || 0,
      issues_fixed: dimState.issues_fixed || 0,
      rounds: dimState.round || 0
    };
  }

  totalScore = Math.round(totalScore * 10) / 10;

  let verdict;
  if (totalScore >= VERDICT_THRESHOLDS.PASS) {
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
    breakdown
  };

  console.log(JSON.stringify(output, null, 2));
}

main();
