#!/usr/bin/env node
/**
 * optcode evidence bundle — freezes immutable analysis context before CR.
 *
 * Creates a sealed evidence bundle that captures workspace state at analysis start.
 * All subsequent agents reference this frozen context, preventing drift during review.
 *
 * Usage:
 *   node evidence-bundle.js freeze <work-dir>   — create immutable bundle
 *   node evidence-bundle.js read <work-dir>     — read existing bundle (exits 1 if absent)
 *   node evidence-bundle.js validate <work-dir> — check bundle integrity vs current state
 */
const { existsSync, readFileSync, writeFileSync, readdirSync, statSync } = require('node:fs');
const { join, relative } = require('node:path');
const { execSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { ensureDir, readState, appendAudit, atomicReplace } = require('./workflow-lib.js');

const BUNDLE_FILE = 'evidence-bundle.json';
const BUNDLE_VERSION = 1;

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function gitHead() {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch { return null; }
}

function gitTreeHash() {
  try {
    return execSync('git write-tree', { encoding: 'utf8' }).trim();
  } catch { return null; }
}

function gitBranch() {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
  } catch { return null; }
}

function gitDirtyFiles() {
  try {
    const out = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
    return out ? out.split('\n').map(l => l.slice(3)) : [];
  } catch { return []; }
}

const EVIDENCE_LIMITS = Object.freeze({
  maxFiles: 500,
  maxFileSizeBytes: 2 * 1024 * 1024, // 2 MB per file
});

function collectFileManifest(targetPaths, limits = EVIDENCE_LIMITS) {
  const manifest = {};
  const discovery = { scanned: 0, tracked: 0, omitted_size: 0, omitted_count: 0 };

  for (const target of targetPaths) {
    if (!existsSync(target)) continue;
    const stat = statSync(target);
    if (stat.isFile()) {
      discovery.scanned++;
      if (stat.size > limits.maxFileSizeBytes) {
        discovery.omitted_size++;
        continue;
      }
      if (discovery.tracked >= limits.maxFiles) {
        discovery.omitted_count++;
        continue;
      }
      const content = readFileSync(target);
      manifest[target] = { size: content.length, hash: sha256(content) };
      discovery.tracked++;
    } else if (stat.isDirectory()) {
      try {
        const files = readdirSync(target, { recursive: true });
        for (const f of files) {
          if (discovery.tracked >= limits.maxFiles) {
            discovery.omitted_count++;
            continue;
          }
          const fullPath = join(target, f);
          try {
            const fstat = statSync(fullPath);
            if (fstat.isFile()) {
              discovery.scanned++;
              if (fstat.size > limits.maxFileSizeBytes) {
                discovery.omitted_size++;
                continue;
              }
              const content = readFileSync(fullPath);
              manifest[fullPath] = { size: content.length, hash: sha256(content) };
              discovery.tracked++;
            }
          } catch { /* skip unreadable */ }
        }
      } catch { /* skip unreadable dirs */ }
    }
  }
  return { manifest, discovery };
}

function freeze(workDir) {
  const state = readState(workDir);
  if (!state) throw Object.assign(new Error('state not initialized'), { code: 'E_STATE_MISSING' });

  const targetPaths = state.target_paths || [];
  const baseCommit = state.base_commit;

  const { manifest, discovery } = collectFileManifest(targetPaths);
  const bundle = Object.freeze({
    version: BUNDLE_VERSION,
    frozen_at: new Date().toISOString(),
    sealed: true,
    context: Object.freeze({
      base_commit: baseCommit,
      head_commit: gitHead(),
      tree_hash: gitTreeHash(),
      branch: gitBranch(),
      dirty_files: gitDirtyFiles(),
      mode: state.mode,
      resolved_mode: state.resolved_mode,
      active_dimensions: Object.keys(state.dimensions).filter(d => state.dimensions[d].status !== 'skipped'),
      target_paths: targetPaths,
    }),
    manifest: Object.freeze(manifest),
    discovery: Object.freeze(discovery),
    integrity: null,
  });

  const bundleWithIntegrity = {
    ...bundle,
    integrity: sha256(JSON.stringify({ context: bundle.context, manifest: bundle.manifest })),
  };

  const bundlePath = join(workDir, BUNDLE_FILE);
  atomicReplace(bundlePath, JSON.stringify(bundleWithIntegrity, null, 2) + '\n');
  appendAudit(workDir, {
    type: 'evidence_bundle_frozen',
    file_count: Object.keys(bundle.manifest).length,
    integrity: bundleWithIntegrity.integrity,
  });

  return bundleWithIntegrity;
}

function read(workDir) {
  const bundlePath = join(workDir, BUNDLE_FILE);
  if (!existsSync(bundlePath)) return null;
  return JSON.parse(readFileSync(bundlePath, 'utf8'));
}

function validate(workDir) {
  const bundle = read(workDir);
  if (!bundle) return { valid: false, error: 'no evidence bundle found', code: 'E_BUNDLE_MISSING' };

  const violations = [];

  const recomputedIntegrity = sha256(JSON.stringify({ context: bundle.context, manifest: bundle.manifest }));
  if (recomputedIntegrity !== bundle.integrity) {
    violations.push({ type: 'integrity_tampered', message: 'bundle integrity hash mismatch — file was modified after freeze' });
  }

  const currentHead = gitHead();
  if (bundle.context.head_commit && currentHead && bundle.context.head_commit !== currentHead) {
    violations.push({ type: 'head_moved', frozen: bundle.context.head_commit, current: currentHead });
  }

  for (const [filePath, meta] of Object.entries(bundle.manifest)) {
    if (!existsSync(filePath)) {
      violations.push({ type: 'file_deleted', path: filePath });
      continue;
    }
    const content = readFileSync(filePath);
    const currentHash = sha256(content);
    if (currentHash !== meta.hash) {
      violations.push({ type: 'file_modified', path: filePath, frozen_hash: meta.hash, current_hash: currentHash });
    }
  }

  const result = {
    valid: violations.length === 0,
    frozen_at: bundle.frozen_at,
    validated_at: new Date().toISOString(),
    file_count: Object.keys(bundle.manifest).length,
    violation_count: violations.length,
    violations,
  };

  appendAudit(workDir, {
    type: 'evidence_bundle_validated',
    valid: result.valid,
    violation_count: result.violation_count,
  });

  return result;
}

function main() {
  const [cmd, workDir] = process.argv.slice(2);
  if (!cmd || !workDir) {
    process.stderr.write('用法: node evidence-bundle.js <freeze|read|validate> <work-dir>\n');
    process.exit(1);
  }

  switch (cmd) {
    case 'freeze': {
      const bundle = freeze(workDir);
      console.log(JSON.stringify({
        frozen: true,
        file_count: Object.keys(bundle.manifest).length,
        integrity: bundle.integrity,
        frozen_at: bundle.frozen_at,
      }, null, 2));
      break;
    }
    case 'read': {
      const bundle = read(workDir);
      if (!bundle) {
        process.stderr.write('no evidence bundle found\n');
        process.exit(1);
      }
      console.log(JSON.stringify(bundle, null, 2));
      break;
    }
    case 'validate': {
      const result = validate(workDir);
      console.log(JSON.stringify(result, null, 2));
      if (!result.valid) process.exit(1);
      break;
    }
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { freeze, read, validate };
