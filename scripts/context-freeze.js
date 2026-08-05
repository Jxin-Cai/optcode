#!/usr/bin/env node
/**
 * optcode context freeze — captures and verifies immutable workspace snapshots.
 *
 * Ensures the working tree hasn't drifted between review phases.
 *
 * Usage:
 *   node context-freeze.js capture <work-dir>     — snapshot current state
 *   node context-freeze.js verify <work-dir>      — compare against frozen snapshot
 *   node context-freeze.js status <work-dir>      — show snapshot metadata
 */
const { existsSync, readFileSync, writeFileSync, readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');
const { execSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { ensureDir, readState, appendAudit } = require('./workflow-lib.js');

const FREEZE_FILE = 'context-freeze.json';

function hashFile(filePath) {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

function gitTreeHash() {
  try {
    return execSync('git write-tree', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function gitDiffStat(baseCommit) {
  try {
    return execSync(`git diff --stat ${baseCommit}`, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function collectTargetHashes(targetPaths) {
  const hashes = {};
  for (const target of targetPaths) {
    if (!existsSync(target)) continue;
    const stat = statSync(target);
    if (stat.isFile()) {
      hashes[target] = hashFile(target);
    } else if (stat.isDirectory()) {
      try {
        const files = readdirSync(target, { recursive: true });
        for (const f of files) {
          const fullPath = join(target, f);
          if (statSync(fullPath).isFile()) {
            hashes[fullPath] = hashFile(fullPath);
          }
        }
      } catch { /* ignore read errors for nested dirs */ }
    }
  }
  return hashes;
}

function capture(workDir) {
  const state = readState(workDir);
  if (!state) throw new Error('state not initialized — run init first');

  const targetPaths = state.target_paths || [];
  const baseCommit = state.base_commit;

  const freeze = {
    version: 1,
    captured_at: new Date().toISOString(),
    base_commit: baseCommit,
    tree_hash: gitTreeHash(),
    diff_stat: gitDiffStat(baseCommit),
    target_file_count: 0,
    target_hashes: collectTargetHashes(targetPaths),
  };
  freeze.target_file_count = Object.keys(freeze.target_hashes).length;

  const freezePath = join(workDir, FREEZE_FILE);
  writeFileSync(freezePath, JSON.stringify(freeze, null, 2) + '\n');
  appendAudit(workDir, { type: 'context_freeze_captured', file_count: freeze.target_file_count });
  return freeze;
}

function verify(workDir) {
  const freezePath = join(workDir, FREEZE_FILE);
  if (!existsSync(freezePath)) {
    return { drifted: false, reason: 'no freeze snapshot exists — skipping verification' };
  }

  const freeze = JSON.parse(readFileSync(freezePath, 'utf8'));
  const drifts = [];

  // Check tree-level drift
  const currentTree = gitTreeHash();
  if (freeze.tree_hash && currentTree && freeze.tree_hash !== currentTree) {
    drifts.push({ type: 'tree_hash', frozen: freeze.tree_hash, current: currentTree });
  }

  // Check per-file drift
  for (const [filePath, frozenHash] of Object.entries(freeze.target_hashes)) {
    const currentHash = hashFile(filePath);
    if (currentHash === null) {
      drifts.push({ type: 'file_deleted', path: filePath });
    } else if (currentHash !== frozenHash) {
      drifts.push({ type: 'file_modified', path: filePath });
    }
  }

  const result = {
    drifted: drifts.length > 0,
    drift_count: drifts.length,
    frozen_at: freeze.captured_at,
    verified_at: new Date().toISOString(),
    drifts,
  };

  appendAudit(workDir, { type: 'context_freeze_verified', drifted: result.drifted, drift_count: result.drift_count });
  return result;
}

function status(workDir) {
  const freezePath = join(workDir, FREEZE_FILE);
  if (!existsSync(freezePath)) return { exists: false };
  const freeze = JSON.parse(readFileSync(freezePath, 'utf8'));
  return {
    exists: true,
    captured_at: freeze.captured_at,
    base_commit: freeze.base_commit,
    target_file_count: freeze.target_file_count,
  };
}

function main() {
  const [cmd, workDir] = process.argv.slice(2);
  if (!cmd || !workDir) {
    process.stderr.write('用法: node context-freeze.js <capture|verify|status> <work-dir>\n');
    process.exit(1);
  }

  let result;
  switch (cmd) {
    case 'capture':
      result = capture(workDir);
      console.log(JSON.stringify({ captured: true, file_count: result.target_file_count }, null, 2));
      break;
    case 'verify':
      result = verify(workDir);
      console.log(JSON.stringify(result, null, 2));
      if (result.drifted) process.exit(1);
      break;
    case 'status':
      result = status(workDir);
      console.log(JSON.stringify(result, null, 2));
      break;
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { capture, verify, status };
