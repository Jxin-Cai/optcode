const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createDeps, getFile } = require('./helpers.js');
const { acquireLockSync, releaseLock, atomicReplace } = require('../scripts/workflow-lib.js');

describe('pessimistic file lock', () => {
  describe('acquireLockSync', () => {
    it('acquires successfully on first try', () => {
      const deps = createDeps();
      const result = acquireLockSync('/tmp/test.lock', {}, deps);
      assert.equal(result.lockPath, '/tmp/test.lock');
      assert.equal(result.handle, 999);
      // Lock file should contain pid and createdAt
      const content = JSON.parse(getFile(deps, '/tmp/test.lock'));
      assert.equal(content.pid, 12345);
      assert.equal(content.createdAt, '2024-01-01T00:00:00.000Z');
    });

    it('throws on timeout when lock already held', () => {
      const deps = createDeps({
        openSync: (path, flags) => {
          // Always throw EEXIST to simulate a held lock
          const err = new Error('EEXIST');
          err.code = 'EEXIST';
          throw err;
        },
        statSync: () => ({ mtimeMs: Date.now() }), // fresh lock, not stale
      });
      assert.throws(
        () => acquireLockSync('/tmp/test.lock', { timeoutMs: 100, pollMs: 10 }, deps),
        /acquireLock timeout/
      );
    });

    it('detects and removes stale lock then succeeds', () => {
      let firstCall = true;
      const deps = createDeps({
        openSync: (path, flags) => {
          if (flags === 'wx' && firstCall) {
            firstCall = false;
            const err = new Error('EEXIST');
            err.code = 'EEXIST';
            throw err;
          }
          // Second call succeeds
          return 888;
        },
        statSync: () => ({ mtimeMs: Date.now() - 700000 }), // stale (> 600000ms)
        unlinkSync: () => {},
      });
      const result = acquireLockSync('/tmp/test.lock', { staleMs: 600000 }, deps);
      assert.equal(result.handle, 888);
      assert.equal(result.lockPath, '/tmp/test.lock');
    });

    it('propagates non-EEXIST errors', () => {
      const deps = createDeps({
        openSync: () => {
          const err = new Error('EACCES');
          err.code = 'EACCES';
          throw err;
        },
      });
      assert.throws(
        () => acquireLockSync('/tmp/test.lock', {}, deps),
        /EACCES/
      );
    });
  });

  describe('releaseLock', () => {
    it('cleans up lock file', () => {
      const deps = createDeps();
      // First acquire
      deps._files.set('/tmp/test.lock', '{"pid":12345}');
      releaseLock('/tmp/test.lock', 999, deps);
      assert.equal(deps._files.has('/tmp/test.lock'), false);
    });

    it('does not throw if file already removed', () => {
      const deps = createDeps({
        closeSync: () => {},
        unlinkSync: () => { throw new Error('ENOENT'); },
      });
      // Should not throw
      releaseLock('/tmp/test.lock', 999, deps);
    });
  });

  describe('atomicReplace', () => {
    it('writes via temp file then renames', () => {
      const deps = createDeps();
      atomicReplace('/tmp/target.json', '{"data":true}', deps);
      assert.equal(getFile(deps, '/tmp/target.json'), '{"data":true}');
      // Temp file should not remain
      assert.equal(deps._files.has('/tmp/target.json.12345.tmp'), false);
    });

    it('overwrites existing content', () => {
      const deps = createDeps();
      deps._files.set('/tmp/target.json', '{"old":true}');
      atomicReplace('/tmp/target.json', '{"new":true}', deps);
      assert.equal(getFile(deps, '/tmp/target.json'), '{"new":true}');
    });
  });
});
