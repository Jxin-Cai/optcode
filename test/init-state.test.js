const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

const script = join(__dirname, '..', 'scripts', 'init-state.js');

function runInit(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

test('initializes AI/SDD smell dimension', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optcode-init-'));
  const result = runInit([dir, 'base123', 'src']);

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.target_paths.length, 1);
  const state = require('node:fs').readFileSync(join(dir, 'state.json'), 'utf8');
  assert.match(state, /ai-sdd-smells/);
});

test('splits comma-separated target paths during initialization', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optcode-init-'));
  const result = runInit([dir, 'base123', 'src,lib']);

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.target_paths, ['src', 'lib']);
});

test('rejects unknown skipped dimensions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optcode-init-'));
  const result = runInit([dir, 'base123', 'src', '--skip', 'style,unknown-dim']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown skip dimension/);
});
