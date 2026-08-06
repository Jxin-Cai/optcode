const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDeps, seedState, seedFile, getFile } = require('./helpers.js');

// evidence-bundle uses real fs/crypto; we test via the module's exported functions
// by injecting a controlled workDir with pre-seeded state
const { join } = require('node:path');
const { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');

const { freeze, read, validate } = require('../scripts/evidence-bundle.js');

function setupWorkDir() {
  const workDir = mkdtempSync(join(tmpdir(), 'optcode-bundle-'));
  const state = {
    schema_version: 2,
    _seq: 1,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    target_paths: [join(workDir, 'src')],
    base_commit: 'abc123',
    mode: 'light',
    resolved_mode: 'light',
    dimensions: { 'dead-code': { status: 'pending' }, design: { status: 'pending' } },
  };
  writeFileSync(join(workDir, 'state.json'), JSON.stringify(state, null, 2) + '\n');
  mkdirSync(join(workDir, 'src'), { recursive: true });
  writeFileSync(join(workDir, 'src', 'main.js'), 'console.log("hello");\n');
  writeFileSync(join(workDir, 'src', 'util.js'), 'module.exports = {};\n');
  return workDir;
}

test('freeze creates immutable bundle with manifest', () => {
  const workDir = setupWorkDir();
  try {
    const bundle = freeze(workDir);
    assert.equal(bundle.version, 1);
    assert.equal(bundle.sealed, true);
    assert.ok(bundle.frozen_at);
    assert.ok(bundle.integrity);
    assert.equal(bundle.context.base_commit, 'abc123');
    assert.equal(bundle.context.mode, 'light');
    assert.deepEqual(bundle.context.target_paths, [join(workDir, 'src')]);
    const manifestKeys = Object.keys(bundle.manifest);
    assert.equal(manifestKeys.length, 2);
    assert.ok(bundle.manifest[join(workDir, 'src', 'main.js')]);
    assert.ok(bundle.manifest[join(workDir, 'src', 'util.js')]);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('read returns null when no bundle exists', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'optcode-bundle-'));
  try {
    assert.equal(read(workDir), null);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('read returns frozen bundle', () => {
  const workDir = setupWorkDir();
  try {
    freeze(workDir);
    const bundle = read(workDir);
    assert.ok(bundle);
    assert.equal(bundle.sealed, true);
    assert.equal(bundle.context.base_commit, 'abc123');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('validate passes when files unchanged', () => {
  const workDir = setupWorkDir();
  try {
    freeze(workDir);
    const result = validate(workDir);
    assert.equal(result.valid, true);
    assert.equal(result.violation_count, 0);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('validate detects file modification', () => {
  const workDir = setupWorkDir();
  try {
    freeze(workDir);
    writeFileSync(join(workDir, 'src', 'main.js'), 'console.log("modified");\n');
    const result = validate(workDir);
    assert.equal(result.valid, false);
    assert.ok(result.violation_count >= 1);
    const modified = result.violations.find(v => v.type === 'file_modified');
    assert.ok(modified);
    assert.ok(modified.path.includes('main.js'));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('validate detects file deletion', () => {
  const workDir = setupWorkDir();
  try {
    freeze(workDir);
    rmSync(join(workDir, 'src', 'util.js'));
    const result = validate(workDir);
    assert.equal(result.valid, false);
    const deleted = result.violations.find(v => v.type === 'file_deleted');
    assert.ok(deleted);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('validate detects integrity tampering', () => {
  const workDir = setupWorkDir();
  try {
    freeze(workDir);
    const bundlePath = join(workDir, 'evidence-bundle.json');
    const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
    bundle.context.mode = 'deep';
    writeFileSync(bundlePath, JSON.stringify(bundle, null, 2) + '\n');
    const result = validate(workDir);
    assert.equal(result.valid, false);
    const tampered = result.violations.find(v => v.type === 'integrity_tampered');
    assert.ok(tampered);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
