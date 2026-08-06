/**
 * Test dependency factory — provides in-memory stubs for fs/child_process operations.
 * Eliminates the need for temp directories or real filesystem in tests.
 */
const { join } = require('node:path');

function createDeps(overrides = {}) {
  const files = new Map();

  const deps = {
    existsSync: (path) => files.has(path),
    readFileSync: (path, encoding) => {
      if (!files.has(path)) {
        const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(path);
    },
    writeFileSync: (path, data) => { files.set(path, typeof data === 'string' ? data : data.toString()); },
    appendFileSync: (path, data) => { files.set(path, (files.get(path) || '') + data); },
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    mkdirSync: () => {},
    readdirSync: (dir, opts) => {
      const prefix = dir.endsWith('/') ? dir : dir + '/';
      const entries = new Set();
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const first = rest.split('/')[0];
          if (first) entries.add(first);
        }
      }
      return [...entries];
    },
    statSync: (path) => ({
      isFile: () => files.has(path),
      isDirectory: () => !files.has(path),
      mtimeMs: Date.now(),
      mode: 0o644,
    }),
    openSync: (path, flags) => {
      if (flags === 'wx' && files.has(path)) {
        const err = new Error(`EEXIST: file already exists, open '${path}'`);
        err.code = 'EEXIST';
        throw err;
      }
      files.set(path, '');
      return 999;
    },
    closeSync: () => {},
    unlinkSync: (path) => { files.delete(path); },
    join,
    now: () => '2024-01-01T00:00:00.000Z',
    pid: () => 12345,
    execSync: () => '',
    _files: files,
    ...overrides,
  };
  return deps;
}

function seedState(deps, workDir, state) {
  const path = join(workDir, 'state.json');
  deps._files.set(path, JSON.stringify(state, null, 2) + '\n');
}

function seedFile(deps, filePath, content) {
  deps._files.set(filePath, content);
}

function getFile(deps, filePath) {
  return deps._files.get(filePath) || null;
}

module.exports = { createDeps, seedState, seedFile, getFile };
