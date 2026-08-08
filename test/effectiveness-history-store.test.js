const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { appendEffectivenessHistory, getEffectivenessHistory } = require('../scripts/effectiveness-tracker.js');

test('effectiveness history upserts an explicitly identified run', () => {
  const root = mkdtempSync(join(tmpdir(), 'optcode-effectiveness-history-'));
  try {
    const first = appendEffectivenessHistory(root, { run_id: 'run-1', score_delta: 2, verdict: 'proceed' });
    const second = appendEffectivenessHistory(root, { run_id: 'run-1', score_delta: 5, verdict: 'proceed' });
    const history = getEffectivenessHistory(root);
    assert.equal(history.length, 1);
    assert.equal(history[0].primary_delta, 5);
    assert.equal(second.timestamp, first.timestamp);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
