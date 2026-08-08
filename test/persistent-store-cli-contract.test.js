const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { CLI_EXIT_CODES } = require('../scripts/error-codes.js');

const scripts = join(__dirname, '..', 'scripts');

test('persistent-store CLIs fail closed without overwriting corrupt history', () => {
  const root = mkdtempSync(join(tmpdir(), 'optcode-store-cli-'));
  const optcodeDir = join(root, '.optcode');
  mkdirSync(optcodeDir);
  const cases = [
    { script: 'known-issues.js', args: ['list'], file: 'known-issues.json' },
    { script: 'dashboard.js', args: ['history'], file: 'health-history.json' },
    { script: 'intervention-ledger.js', args: ['list', root], file: 'intervention-ledger.json' },
    { script: 'cross-dimension-dedup.js', args: ['registry', 'status', join(optcodeDir, 'dedup-registry.json')], file: 'dedup-registry.json' },
    { script: 'loop-discovery.js', args: ['history'], file: 'loop-registry.json' },
    { script: 'effectiveness-tracker.js', args: ['history', root], file: 'effectiveness-history.json' },
  ];
  try {
    for (const testCase of cases) {
      const file = join(optcodeDir, testCase.file);
      writeFileSync(file, '{broken');
      const result = spawnSync(process.execPath, [join(scripts, testCase.script), ...testCase.args], { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, CLI_EXIT_CODES.INVALID_STATE, `${testCase.script}: ${result.stderr || result.stdout}`);
      const output = JSON.parse(result.stderr);
      assert.equal(output.ok, false);
      assert.equal(output.code, 'E_STORE_CORRUPT');
      assert.equal(readFileSync(file, 'utf8'), '{broken');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('persistent-store CLIs recover a corrupt primary from a valid backup', () => {
  const root = mkdtempSync(join(tmpdir(), 'optcode-store-cli-recover-'));
  const optcodeDir = join(root, '.optcode');
  mkdirSync(optcodeDir);
  const file = join(optcodeDir, 'known-issues.json');
  try {
    writeFileSync(file, '{broken');
    writeFileSync(`${file}.backup`, '[]\n');
    const result = spawnSync(process.execPath, [join(scripts, 'known-issues.js'), 'list'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No issues found/);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
