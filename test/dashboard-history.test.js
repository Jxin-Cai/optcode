const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { loadHistory, recordHistory } = require('../scripts/dashboard.js');
const { DIMENSIONS } = require('../scripts/workflow-lib.js');

test('recordHistory upserts the same run instead of duplicating it', () => {
  const root = mkdtempSync(join(tmpdir(), 'optcode-history-'));
  const workDir = join(root, '.optcode', 'run-1');
  const state = { target_paths: ['src'], mode: 'deep' };
  const firstGate = {
    score: 80,
    verdict: 'PASS',
    active_dimensions: 2,
    breakdown: { design: { score: 40, status: 'pass' } },
  };
  const updatedGate = {
    ...firstGate,
    score: 90,
    breakdown: { design: { score: 50, status: 'pass' } },
  };

  try {
    const first = recordHistory(root, workDir, firstGate, state);
    const second = recordHistory(root, workDir, updatedGate, state);
    const history = loadHistory(root);
    assert.equal(history.length, 1);
    assert.equal(history[0].score, 90);
    assert.equal(second.timestamp, first.timestamp);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dashboard generation does not create a cross-run history entry', () => {
  const root = mkdtempSync(join(tmpdir(), 'optcode-dashboard-readonly-'));
  const workDir = join(root, 'run-1');
  const dimensions = Object.fromEntries(DIMENSIONS.map(dimension => [dimension, {
    status: 'pass', round: 1, issues_found: 0, issues_fixed: 0, issue_history: [],
  }]));
  try {
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, 'state.json'), JSON.stringify({
      status: 'completed', mode: 'light', target_paths: ['src'], dimensions,
    }));
    const script = join(__dirname, '..', 'scripts', 'dashboard.js');
    const result = spawnSync(process.execPath, [script, 'generate', workDir], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(workDir, 'dashboard.md')), true);
    assert.equal(existsSync(join(root, '.optcode', 'health-history.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
