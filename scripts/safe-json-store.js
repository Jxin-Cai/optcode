const fs = require('node:fs');
const path = require('node:path');
const { createError } = require('./error-codes.js');

const DEFAULT_DEPS = Object.freeze({
  existsSync: fs.existsSync,
  readFileSync: fs.readFileSync,
  writeFileSync: fs.writeFileSync,
  mkdirSync: fs.mkdirSync,
  renameSync: fs.renameSync,
  dirname: path.dirname,
  pid: () => process.pid,
});

function depsFor(deps = {}) {
  return { ...DEFAULT_DEPS, ...deps };
}

function cloneDefault(value) {
  const resolved = typeof value === 'function' ? value() : value;
  return resolved === undefined ? null : JSON.parse(JSON.stringify(resolved));
}

function parseDocument(raw, file, validate) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw createError('E_STORE_CORRUPT', { message: `invalid JSON store ${file}: ${error.message}`, store_file: file });
  }
  if (validate && !validate(value)) {
    throw createError('E_STORE_CORRUPT', { message: `invalid JSON store shape: ${file}`, store_file: file });
  }
  return value;
}

function atomicReplaceRaw(file, raw, deps = {}) {
  const d = depsFor(deps);
  d.mkdirSync(d.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${d.pid()}`;
  d.writeFileSync(tmp, raw);
  d.renameSync(tmp, file);
}

function readJsonDocument(file, options = {}) {
  const d = depsFor(options.deps);
  if (!d.existsSync(file)) {
    return { value: cloneDefault(options.defaultValue), recovered: false, missing: true };
  }
  try {
    return { value: parseDocument(d.readFileSync(file, 'utf8'), file, options.validate), recovered: false, missing: false };
  } catch (primaryError) {
    const backup = `${file}.backup`;
    if (d.existsSync(backup)) {
      try {
        const raw = d.readFileSync(backup, 'utf8');
        const value = parseDocument(raw, backup, options.validate);
        atomicReplaceRaw(file, raw, options.deps);
        return { value, recovered: true, missing: false };
      } catch { /* primary error remains authoritative */ }
    }
    throw primaryError;
  }
}

function readJsonFile(file, options = {}) {
  return readJsonDocument(file, options).value;
}

function writeJsonFile(file, value, options = {}) {
  const d = depsFor(options.deps);
  if (options.validate && !options.validate(value)) {
    throw createError('E_STORE_CORRUPT', { message: `refusing to write invalid JSON store shape: ${file}`, store_file: file });
  }
  if (d.existsSync(file)) {
    const currentRaw = d.readFileSync(file, 'utf8');
    parseDocument(currentRaw, file, options.validate);
    atomicReplaceRaw(`${file}.backup`, currentRaw, options.deps);
  }
  atomicReplaceRaw(file, `${JSON.stringify(value, null, 2)}\n`, options.deps);
  return value;
}

module.exports = { depsFor, parseDocument, atomicReplaceRaw, readJsonDocument, readJsonFile, writeJsonFile };
