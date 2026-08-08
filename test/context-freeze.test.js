const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { capture, verify, status } = require('../scripts/context-freeze.js');

function setup() {
  const workDir = mkdtempSync(join(tmpdir(), 'optcode-context-'));
  const target = join(workDir, 'src', 'main.js');
  mkdirSync(join(workDir, 'src'), { recursive: true });
  writeFileSync(target, 'original\n');
  writeFileSync(join(workDir, 'state.json'), JSON.stringify({
    target_paths: [target], base_commit: 'abc', mode: 'light', resolved_mode: 'light',
    dimensions: { design: { status: 'pending' } },
  }));
  return { workDir, target };
}

test('context-freeze capture writes only the canonical evidence bundle', () => {
  const { workDir } = setup();
  try {
    const result = capture(workDir, { gitContext: { head_commit: null, index_tree_hash: null, branch: null, dirty_files: [] } });
    assert.equal(result.canonical_artifact, 'evidence-bundle.json');
    assert.equal(status(workDir).canonical_artifact, 'evidence-bundle.json');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('context-freeze still verifies legacy per-file snapshots', () => {
  const { workDir, target } = setup();
  try {
    const hash = createHash('sha256').update('original\n').digest('hex');
    writeFileSync(join(workDir, 'context-freeze.json'), JSON.stringify({
      version: 1, captured_at: '2024-01-01T00:00:00.000Z', target_hashes: { [target]: hash },
    }));
    assert.equal(verify(workDir).drifted, false);
    writeFileSync(target, 'changed\n');
    const result = verify(workDir);
    assert.equal(result.drifted, true);
    assert.equal(result.legacy, true);
    assert.equal(result.drifts[0].type, 'file_modified');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
