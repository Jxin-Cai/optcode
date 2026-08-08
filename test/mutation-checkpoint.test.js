const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { capture, diff, rollback, normalizeTargets } = require('../scripts/mutation-checkpoint.js');

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'optcode-mutation-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'OptCode Test']);
  git(root, ['config', 'user.email', 'optcode@example.invalid']);
  writeFileSync(join(root, '.gitignore'), '.optcode/\n');
  writeFileSync(join(root, 'tracked.txt'), 'committed\n');
  git(root, ['add', '.gitignore', 'tracked.txt']);
  git(root, ['commit', '-qm', 'fixture']);

  const workDir = join(root, '.optcode', 'run');
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(workDir, 'state.json'), JSON.stringify({
    schema_version: 2,
    _seq: 1,
    target_paths: ['.'],
    base_commit: git(root, ['rev-parse', 'HEAD']),
    dimensions: {},
  }));
  return { root, workDir };
}

test('rollback restores the pre-fix dirty tree without touching the index', () => {
  const { root, workDir } = fixture();
  try {
    writeFileSync(join(root, 'tracked.txt'), 'user edit\n');
    git(root, ['add', 'tracked.txt']);
    writeFileSync(join(root, 'user-untracked.txt'), 'user draft\n');

    const checkpoint = capture(workDir, 'design', 1, { cwd: root });
    assert.equal(checkpoint.captured, true);

    writeFileSync(join(root, 'tracked.txt'), 'fixer edit\n');
    writeFileSync(join(root, 'user-untracked.txt'), 'fixer changed draft\n');
    writeFileSync(join(root, 'fixer-created.txt'), 'new file\n');

    const changes = diff(workDir, 'design', 1, { cwd: root });
    assert.deepEqual(changes.changed_files.map(entry => entry.path).sort(), [
      'fixer-created.txt',
      'tracked.txt',
      'user-untracked.txt',
    ]);

    const result = rollback(workDir, 'design', 1, { cwd: root });
    assert.equal(result.rolled_back, true);
    assert.equal(readFileSync(join(root, 'tracked.txt'), 'utf8'), 'user edit\n');
    assert.equal(readFileSync(join(root, 'user-untracked.txt'), 'utf8'), 'user draft\n');
    assert.equal(existsSync(join(root, 'fixer-created.txt')), false);
    assert.equal(git(root, ['show', ':tracked.txt']), 'user edit');
    assert.equal(diff(workDir, 'design', 1, { cwd: root }).changed_count, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rollback fails closed when HEAD moved after capture', () => {
  const { root, workDir } = fixture();
  try {
    capture(workDir, 'security', 1, { cwd: root });
    writeFileSync(join(root, 'tracked.txt'), 'new commit\n');
    git(root, ['add', 'tracked.txt']);
    git(root, ['commit', '-qm', 'move head']);
    assert.throws(
      () => rollback(workDir, 'security', 1, { cwd: root }),
      error => error.code === 'E_MUTATION_HEAD_MOVED',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('target normalization rejects paths outside the repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'optcode-normalize-'));
  try {
    assert.throws(
      () => normalizeTargets(root, root, ['../outside']),
      error => error.code === 'E_TARGET_OUTSIDE_REPOSITORY',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
