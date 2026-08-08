const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { readJsonDocument, readJsonFile, writeJsonFile } = require('../scripts/safe-json-store.js');

const isArray = Array.isArray;

test('missing stores initialize only from an explicit default', () => {
  const root = mkdtempSync(join(tmpdir(), 'optcode-store-missing-'));
  try {
    const file = join(root, 'store.json');
    assert.deepEqual(readJsonFile(file, { defaultValue: [], validate: isArray }), []);
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writes preserve a valid previous generation as backup', () => {
  const root = mkdtempSync(join(tmpdir(), 'optcode-store-backup-'));
  try {
    const file = join(root, 'store.json');
    writeJsonFile(file, [{ version: 1 }], { validate: isArray });
    writeJsonFile(file, [{ version: 2 }], { validate: isArray });
    assert.deepEqual(JSON.parse(readFileSync(`${file}.backup`, 'utf8')), [{ version: 1 }]);
    assert.deepEqual(readJsonFile(file, { validate: isArray }), [{ version: 2 }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('corrupt primary recovers only from a valid backup', () => {
  const root = mkdtempSync(join(tmpdir(), 'optcode-store-recover-'));
  try {
    const file = join(root, 'store.json');
    writeFileSync(file, '{broken');
    writeFileSync(`${file}.backup`, JSON.stringify([{ safe: true }]));
    const document = readJsonDocument(file, { validate: isArray });
    assert.equal(document.recovered, true);
    assert.deepEqual(document.value, [{ safe: true }]);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), [{ safe: true }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('corrupt stores are never interpreted or overwritten as empty', () => {
  const root = mkdtempSync(join(tmpdir(), 'optcode-store-corrupt-'));
  try {
    const file = join(root, 'store.json');
    writeFileSync(file, '{broken');
    writeFileSync(`${file}.backup`, '{also broken');
    assert.throws(() => readJsonFile(file, { defaultValue: [], validate: isArray }), error => error.code === 'E_STORE_CORRUPT');
    assert.throws(() => writeJsonFile(file, [], { validate: isArray }), error => error.code === 'E_STORE_CORRUPT');
    assert.equal(readFileSync(file, 'utf8'), '{broken');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
