const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { DIMENSIONS } = require('../scripts/workflow-lib.js');

const script = join(__dirname, '..', 'scripts', 'quality-gate.js');

function writeState(statuses) {
  const dir = mkdtempSync(join(tmpdir(), 'optcode-quality-'));
  const dimensions = {};
  for (const dim of DIMENSIONS) {
    dimensions[dim] = {
      status: statuses[dim] || 'pass',
      round: 1,
      issues_found: 0,
      issues_fixed: 0,
      issue_history: []
    };
  }
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ dimensions }, null, 2));
  return dir;
}

function runQualityGate(dir) {
  const result = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('completed quality gate reports corrupt history without hiding its score', () => {
  const dir = writeState({});
  const projectRoot = mkdtempSync(join(tmpdir(), 'optcode-quality-history-'));
  mkdirSync(join(projectRoot, '.optcode'));
  writeFileSync(join(projectRoot, '.optcode', 'health-history.json'), '{broken');
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  state.status = 'completed';
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  const result = spawnSync(process.execPath, [script, dir], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(result.status, 3, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.code, 'E_STORE_CORRUPT');
  assert.equal(output.history_recorded, false);
  assert.equal(output.verdict, 'PASS');
});

test('pending dimensions force FAIL even when score is high', () => {
  const dir = writeState({ 'dead-code': 'pending' });

  const output = runQualityGate(dir);

  assert.equal(output.verdict, 'FAIL');
  assert.equal(output.incomplete, true);
});

test('skipped dimensions are excluded from active denominator', () => {
  const dir = writeState({ 'style': 'skipped' });

  const output = runQualityGate(dir);

  assert.equal(output.verdict, 'PASS');
  assert.equal(output.active_dimensions, DIMENSIONS.length - 1);
  assert.equal(output.skipped_dimensions, 1);
  assert.equal(output.breakdown.style.score, 0);
});
