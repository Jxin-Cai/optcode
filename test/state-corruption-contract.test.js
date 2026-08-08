const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { CLI_EXIT_CODES } = require('../scripts/error-codes.js');
const { readState, writeState } = require('../scripts/workflow-lib.js');

const scripts = join(__dirname, '..', 'scripts');

function tempRun() {
  return mkdtempSync(join(tmpdir(), 'optcode-state-corrupt-'));
}

test('readState restores a corrupt primary from a valid backup', () => {
  const workDir = tempRun();
  const recovered = { _seq: 3, dimensions: {}, target_paths: ['src'] };
  try {
    writeFileSync(join(workDir, 'state.json'), '{broken');
    writeFileSync(join(workDir, 'state.json.backup'), JSON.stringify(recovered));
    assert.deepEqual(readState(workDir), recovered);
    assert.deepEqual(JSON.parse(readFileSync(join(workDir, 'state.json'), 'utf8')), recovered);
    assert.match(readFileSync(join(workDir, 'audit-log.jsonl'), 'utf8'), /state_recovered_from_backup/);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('readState and OCC writes fail closed with E_STATE_CORRUPT', () => {
  const workDir = tempRun();
  try {
    writeFileSync(join(workDir, 'state.json'), '{broken');
    writeFileSync(join(workDir, 'state.json.backup'), '{also broken');
    assert.throws(() => readState(workDir), error => error.code === 'E_STATE_CORRUPT');
    assert.throws(() => writeState(workDir, { _seq: 1 }, 0), error => error.code === 'E_STATE_CORRUPT');
    assert.equal(readFileSync(join(workDir, 'state.json'), 'utf8'), '{broken');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('state-facing CLIs return structured corruption results and exit 3', () => {
  const workDir = tempRun();
  try {
    writeFileSync(join(workDir, 'state.json'), '{broken');
    for (const invocation of [
      ['orchestration-status.js', workDir],
      ['dimension-status.js', workDir, '--summary'],
      ['gate-check.js', workDir, 'state-initialized'],
    ]) {
      const result = spawnSync(process.execPath, [join(scripts, invocation[0]), ...invocation.slice(1)], { encoding: 'utf8' });
      assert.equal(result.status, CLI_EXIT_CODES.INVALID_STATE, `${invocation[0]}: ${result.stderr || result.stdout}`);
      const output = JSON.parse(result.stdout || result.stderr);
      assert.equal(output.ok, false);
      assert.equal(output.code, 'E_STATE_CORRUPT');
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('orchestration status success keeps legacy fields and adds ok envelope', () => {
  const workDir = tempRun();
  try {
    writeFileSync(join(workDir, 'state.json'), JSON.stringify({
      mode: 'light', dimensions: {}, target_paths: [],
    }));
    const result = spawnSync(process.execPath, [join(scripts, 'orchestration-status.js'), workDir], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.status, 'in_progress');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
