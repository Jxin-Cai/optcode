const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { CLI_EXIT_CODES } = require('../scripts/error-codes.js');
const { freeze } = require('../scripts/evidence-bundle.js');

const script = join(__dirname, '..', 'scripts', 'evidence-bundle.js');

function run(args, cwd) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

test('evidence CLI has stable usage and invalid-artifact exits', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'optcode-evidence-cli-'));
  try {
    assert.equal(run([], workDir).status, CLI_EXIT_CODES.USAGE);
    assert.equal(run(['unknown', workDir], workDir).status, CLI_EXIT_CODES.USAGE);
    assert.equal(run(['read', workDir], workDir).status, CLI_EXIT_CODES.INVALID_ARTIFACT);
    const validation = run(['validate', workDir], workDir);
    assert.equal(validation.status, CLI_EXIT_CODES.INVALID_ARTIFACT);
    assert.equal(JSON.parse(validation.stdout).code, 'E_BUNDLE_MISSING');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('evidence CLI distinguishes workspace drift from malformed artifacts', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'optcode-evidence-drift-'));
  const target = join(workDir, 'src', 'main.js');
  try {
    mkdirSync(join(workDir, 'src'), { recursive: true });
    writeFileSync(target, 'original\n');
    writeFileSync(join(workDir, 'state.json'), JSON.stringify({
      project_root: workDir, target_paths: [target], base_commit: null, mode: 'light', resolved_mode: 'light',
      dimensions: { design: { status: 'pending' } },
    }));
    freeze(workDir, { gitContext: { head_commit: null, index_tree_hash: null, branch: null, dirty_files: [] } });
    writeFileSync(target, 'changed\n');
    const drift = run(['validate', workDir], workDir);
    assert.equal(drift.status, CLI_EXIT_CODES.DRIFT);
    assert.equal(JSON.parse(drift.stdout).code, 'E_BUNDLE_DRIFTED');

    writeFileSync(join(workDir, 'evidence-bundle.json'), '{not json');
    const malformed = run(['validate', workDir], workDir);
    assert.equal(malformed.status, CLI_EXIT_CODES.INVALID_ARTIFACT);
    assert.equal(JSON.parse(malformed.stdout).code, 'E_BUNDLE_INVALID');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
