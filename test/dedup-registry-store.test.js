const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { loadRegistry, updateRegistry } = require('../scripts/cross-dimension-dedup.js');

const FINDING = {
  dimension: 'design',
  title: 'Repeated issue',
  file: 'src/a.js',
  location: 'L1',
  description: 'Observable consequence',
  fixProposal: 'Apply a concrete repair',
};

test('dedup registry counts a fingerprint once per run', () => {
  const root = mkdtempSync(join(tmpdir(), 'optcode-dedup-registry-'));
  const file = join(root, 'dedup-registry.json');
  try {
    updateRegistry(file, [FINDING], 'run-1');
    updateRegistry(file, [FINDING], 'run-1');
    let [entry] = loadRegistry(file).entries;
    assert.equal(entry.seen_count, 1);
    assert.deepEqual(entry.run_ids, ['run-1']);

    updateRegistry(file, [FINDING], 'run-2');
    [entry] = loadRegistry(file).entries;
    assert.equal(entry.seen_count, 2);
    assert.deepEqual(entry.run_ids, ['run-1', 'run-2']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
