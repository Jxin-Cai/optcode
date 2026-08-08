#!/usr/bin/env node
/**
 * Finding-bound mutation checkpoint.
 *
 * Captures the exact working-tree state for the configured target paths in a
 * temporary Git tree without touching the user's index. A rollback restores
 * only paths changed since that checkpoint, preserving edits that existed
 * before the fixer started.
 *
 * Usage:
 *   node mutation-checkpoint.js capture <work-dir> <dimension> <round>
 *   node mutation-checkpoint.js diff <work-dir> <dimension> <round>
 *   node mutation-checkpoint.js rollback <work-dir> <dimension> <round>
 */
const { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, rmSync } = require('node:fs');
const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path');
const { execFileSync } = require('node:child_process');
const { atomicReplace, appendAudit, readState } = require('./workflow-lib.js');

const SCHEMA_VERSION = 1;
const GIT_TIMEOUT_MS = 30_000;
const PATH_CHUNK_SIZE = 100;

function checkpointPath(workDir, dimension, round) {
  return join(workDir, 'transactions', `${dimension}-round-${round}.json`);
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitRoot(cwd = process.cwd()) {
  return git(['rev-parse', '--show-toplevel'], { cwd });
}

function normalizeTargets(root, cwd, targets) {
  const canonicalRoot = realpathSync(root);
  const canonicalCwd = realpathSync(cwd);
  const normalized = [];
  for (const target of targets) {
    const resolvedTarget = isAbsolute(target) ? resolve(target) : resolve(canonicalCwd, target);
    const absolute = existsSync(resolvedTarget) ? realpathSync(resolvedTarget) : resolvedTarget;
    const rel = relative(canonicalRoot, absolute);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw Object.assign(new Error(`target is outside repository: ${target}`), { code: 'E_TARGET_OUTSIDE_REPOSITORY' });
    }
    normalized.push(rel || '.');
  }
  return [...new Set(normalized)];
}

function tempIndexPath(workDir, dimension, round, label) {
  return resolve(workDir, 'transactions', `.${dimension}-round-${round}-${label}-${process.pid}.index`);
}

function createTree(root, targets, indexPath) {
  mkdirSync(dirname(indexPath), { recursive: true });
  if (existsSync(indexPath)) unlinkSync(indexPath);
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    git(['read-tree', 'HEAD'], { cwd: root, env });
    for (let i = 0; i < targets.length; i += PATH_CHUNK_SIZE) {
      git(['add', '-A', '--', ...targets.slice(i, i + PATH_CHUNK_SIZE)], { cwd: root, env });
    }
    return git(['write-tree'], { cwd: root, env });
  } finally {
    if (existsSync(indexPath)) unlinkSync(indexPath);
  }
}

function readCheckpoint(workDir, dimension, round) {
  const file = checkpointPath(workDir, dimension, round);
  if (!existsSync(file)) {
    throw Object.assign(new Error(`mutation checkpoint not found: ${file}`), { code: 'E_MUTATION_CHECKPOINT_MISSING' });
  }
  const checkpoint = JSON.parse(readFileSync(file, 'utf8'));
  if (checkpoint.schema_version !== SCHEMA_VERSION) {
    throw Object.assign(new Error(`unsupported mutation checkpoint schema: ${checkpoint.schema_version}`), { code: 'E_MUTATION_CHECKPOINT_SCHEMA' });
  }
  return checkpoint;
}

function capture(workDir, dimension, round, options = {}) {
  const state = readState(workDir);
  if (!state) throw Object.assign(new Error('state not initialized'), { code: 'E_STATE_MISSING' });
  const cwd = options.cwd || process.cwd();
  const root = gitRoot(cwd);
  const targets = normalizeTargets(root, cwd, state.target_paths || []);
  if (targets.length === 0) throw new Error('no target paths available for mutation checkpoint');
  const head = git(['rev-parse', 'HEAD'], { cwd: root });
  const tree = createTree(root, targets, tempIndexPath(workDir, dimension, round, 'capture'));
  const checkpoint = {
    schema_version: SCHEMA_VERSION,
    captured_at: new Date().toISOString(),
    dimension,
    round: Number(round),
    head,
    tree,
    targets,
  };
  atomicReplace(checkpointPath(workDir, dimension, round), JSON.stringify(checkpoint, null, 2) + '\n');
  appendAudit(workDir, { type: 'mutation_checkpoint_captured', dimension, round: Number(round), tree, target_count: targets.length });
  return { captured: true, dimension, round: Number(round), tree, target_count: targets.length };
}

function changedEntries(workDir, dimension, round, options = {}) {
  const checkpoint = readCheckpoint(workDir, dimension, round);
  const cwd = options.cwd || process.cwd();
  const root = gitRoot(cwd);
  const currentHead = git(['rev-parse', 'HEAD'], { cwd: root });
  if (currentHead !== checkpoint.head) {
    throw Object.assign(new Error(`HEAD moved after checkpoint: ${checkpoint.head} -> ${currentHead}`), { code: 'E_MUTATION_HEAD_MOVED' });
  }
  const currentTree = createTree(root, checkpoint.targets, tempIndexPath(workDir, dimension, round, 'current'));
  const raw = execFileSync('git', ['diff', '--name-status', '-z', '--no-renames', checkpoint.tree, currentTree], {
    cwd: root,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });
  const fields = raw.split('\0').filter(Boolean);
  const entries = [];
  for (let i = 0; i < fields.length; i += 2) {
    entries.push({ status: fields[i], path: fields[i + 1] });
  }
  return { checkpoint, root, currentTree, entries };
}

function diff(workDir, dimension, round, options = {}) {
  const result = changedEntries(workDir, dimension, round, options);
  return {
    valid: true,
    dimension,
    round: Number(round),
    changed_count: result.entries.length,
    changed_files: result.entries,
  };
}

function rollback(workDir, dimension, round, options = {}) {
  const result = changedEntries(workDir, dimension, round, options);
  const added = result.entries.filter((entry) => entry.status === 'A').map((entry) => entry.path);
  const restore = result.entries.filter((entry) => entry.status !== 'A').map((entry) => entry.path);

  for (const relPath of added) {
    const absolute = resolve(result.root, relPath);
    const rel = relative(result.root, absolute);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`refusing to remove path outside repository: ${relPath}`);
    }
    rmSync(absolute, { recursive: true, force: true });
  }
  for (let i = 0; i < restore.length; i += PATH_CHUNK_SIZE) {
    git(['restore', `--source=${result.checkpoint.tree}`, '--worktree', '--', ...restore.slice(i, i + PATH_CHUNK_SIZE)], { cwd: result.root });
  }

  const after = changedEntries(workDir, dimension, round, options);
  if (after.entries.length !== 0) {
    throw Object.assign(new Error(`rollback incomplete: ${after.entries.length} path(s) still differ`), { code: 'E_MUTATION_ROLLBACK_INCOMPLETE', entries: after.entries });
  }
  appendAudit(workDir, { type: 'mutation_checkpoint_rolled_back', dimension, round: Number(round), restored_count: result.entries.length });
  return {
    rolled_back: true,
    dimension,
    round: Number(round),
    restored_count: result.entries.length,
    restored_files: result.entries,
  };
}

function main() {
  const [command, workDir, dimension, roundValue] = process.argv.slice(2);
  const round = Number(roundValue);
  if (!command || !workDir || !dimension || !Number.isInteger(round) || round < 1) {
    process.stderr.write('Usage: mutation-checkpoint.js <capture|diff|rollback> <work-dir> <dimension> <round>\n');
    process.exit(1);
  }
  try {
    const result = command === 'capture'
      ? capture(workDir, dimension, round)
      : command === 'diff'
        ? diff(workDir, dimension, round)
        : command === 'rollback'
          ? rollback(workDir, dimension, round)
          : null;
    if (!result) throw new Error(`unknown command: ${command}`);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error.message, code: error.code || 'E_MUTATION_CHECKPOINT' }) + '\n');
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { capture, diff, rollback, normalizeTargets, checkpointPath };
