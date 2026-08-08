const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readdirSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

const script = join(__dirname, '..', 'scripts', 'optcode.js');

function run(args, cwd) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

test('help is discoverable and has no filesystem side effects', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'optcode-cli-help-'));
  try {
    const before = readdirSync(cwd);
    const result = run(['help'], cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: optcode <command>/);
    assert.match(result.stdout, /quality-gate/);
    assert.deepEqual(readdirSync(cwd), before);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('unknown commands fail with a stable usage exit and no side effects', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'optcode-cli-unknown-'));
  try {
    const result = run(['does-not-exist'], cwd);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unknown command: does-not-exist/);
    assert.deepEqual(readdirSync(cwd), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('facade delegates argv without a shell and preserves machine output', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'optcode-cli-delegate-'));
  try {
    const result = run(['cli-schema', '--audience', 'workflow'], cwd);
    assert.equal(result.status, 0, result.stderr);
    const schema = JSON.parse(result.stdout);
    assert.equal(schema.audience, 'workflow');
    assert.equal(schema.command_count, 5);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
