const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeBlastRadius, GitFailureError, isGitFailureError } = require('../scripts/blast-radius.js');

describe('fail-closed safety', () => {
  describe('GitFailureError', () => {
    it('isGitFailureError returns true for GitFailureError instances', () => {
      const err = new GitFailureError('test error', { code: 128, command: 'git diff', stderr: 'fatal', ref: 'HEAD~1' });
      assert.equal(isGitFailureError(err), true);
      assert.equal(err.name, 'GitFailureError');
      assert.equal(err.code, 128);
      assert.equal(err.command, 'git diff');
      assert.equal(err.stderr, 'fatal');
      assert.equal(err.ref, 'HEAD~1');
    });

    it('isGitFailureError returns false for regular errors', () => {
      assert.equal(isGitFailureError(new Error('normal')), false);
      assert.equal(isGitFailureError(null), false);
      assert.equal(isGitFailureError(undefined), false);
    });
  });

  describe('computeBlastRadius with injected failing execFileSync', () => {
    it('returns score=100 critical when git fails', () => {
      const deps = {
        execFileSync: () => { throw new Error('git command failed'); },
      };
      const result = computeBlastRadius('HEAD~1', null, deps);
      assert.equal(result.score, 100);
      assert.equal(result.severity, 'critical');
      assert.equal(result.shouldBlock, true);
      assert.equal(result.status, 'error');
      assert.ok(result.error.includes('git'));
      assert.deepEqual(result.changedFiles, []);
      assert.deepEqual(result.symbols, []);
      assert.deepEqual(result.dependents, []);
      assert.deepEqual(result.graph, {});
    });

    it('returns normal result when git succeeds with no changes', () => {
      const deps = {
        execFileSync: (_command, args) => {
          if (args.includes('--name-only')) return '';
          return '';
        },
      };
      const result = computeBlastRadius('HEAD~1', null, deps);
      assert.equal(result.score, 0);
      assert.equal(result.severity, 'low');
      assert.deepEqual(result.changedFiles, []);
    });

    it('computes score for provided target files without git', () => {
      const result = computeBlastRadius(null, ['file1.js', 'file2.js']);
      assert.ok(result.score >= 10);
      assert.deepEqual(result.changedFiles, ['file1.js', 'file2.js']);
    });
  });
});
