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
 *   node evidence-bundle.js migrate <work-dir>  — migrate a valid v1 bundle to v2
 */
const { existsSync, readFileSync, readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readState, appendAudit, atomicReplace } = require('./workflow-lib.js');
const { CLI_EXIT_CODES, createError } = require('./error-codes.js');

const BUNDLE_FILE = 'evidence-bundle.json';
const BUNDLE_SCHEMA = 'optcode/evidence-bundle';
const BUNDLE_VERSION = 2;

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function runGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
}

function gitHead(cwd) {
  try {
    return runGit(['rev-parse', 'HEAD'], cwd);
  } catch { return null; }
}

function gitIndexTreeHash(cwd) {
  try {
    return runGit(['write-tree'], cwd);
  } catch { return null; }
}

function gitBranch(cwd) {
  try {
    return runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  } catch { return null; }
}

function gitDirtyFiles(cwd) {
  try {
    const out = runGit(['status', '--porcelain'], cwd);
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

function collectGitContext(cwd) {
  return {
    head_commit: gitHead(cwd),
    index_tree_hash: gitIndexTreeHash(cwd),
    branch: gitBranch(cwd),
    dirty_files: gitDirtyFiles(cwd),
  };
}

function normalizeGitContext(gitContext) {
  const normalized = { ...gitContext };
  if (!Object.hasOwn(normalized, 'index_tree_hash')) {
    normalized.index_tree_hash = normalized.tree_hash ?? null;
  }
  delete normalized.tree_hash;
  return normalized;
}

function computeIntegrity(bundle) {
  return sha256(JSON.stringify({ context: bundle.context, manifest: bundle.manifest }));
}

function freeze(workDir, options = {}) {
  const state = readState(workDir);
  if (!state) throw createError('E_STATE_MISSING');

  const targetPaths = state.target_paths || [];
  const baseCommit = state.base_commit;

  const { manifest, discovery } = collectFileManifest(targetPaths);
  const gitContext = normalizeGitContext(options.gitContext || collectGitContext(state.project_root || process.cwd()));
  const bundle = Object.freeze({
    schema: BUNDLE_SCHEMA,
    version: BUNDLE_VERSION,
    frozen_at: new Date().toISOString(),
    sealed: true,
    context: Object.freeze({
      base_commit: baseCommit,
      ...gitContext,
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
    integrity: computeIntegrity(bundle),
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

function artifactVersion(bundle) {
  return Number(bundle?.version);
}

function migrate(workDir) {
  let bundle;
  try {
    bundle = read(workDir);
  } catch (error) {
    return { migrated: false, valid: false, code: 'E_BUNDLE_INVALID', error: error.message };
  }
  if (!bundle) return { migrated: false, valid: false, code: 'E_BUNDLE_MISSING' };
  const version = artifactVersion(bundle);
  if (version === BUNDLE_VERSION && bundle.schema === BUNDLE_SCHEMA) {
    return { migrated: false, valid: true, from_version: version, to_version: BUNDLE_VERSION, bundle };
  }
  if (version !== 1) {
    return { migrated: false, valid: false, code: 'E_BUNDLE_VERSION_UNSUPPORTED', version };
  }
  if (computeIntegrity(bundle) !== bundle.integrity) {
    return { migrated: false, valid: false, code: 'E_BUNDLE_TAMPERED' };
  }

  const context = normalizeGitContext(bundle.context || {});
  const migratedBundle = {
    ...bundle,
    schema: BUNDLE_SCHEMA,
    version: BUNDLE_VERSION,
    context,
    migrated_from_version: 1,
  };
  migratedBundle.integrity = computeIntegrity(migratedBundle);
  atomicReplace(join(workDir, BUNDLE_FILE), JSON.stringify(migratedBundle, null, 2) + '\n');
  appendAudit(workDir, { type: 'evidence_bundle_migrated', from_version: 1, to_version: BUNDLE_VERSION });
  return { migrated: true, valid: true, from_version: 1, to_version: BUNDLE_VERSION, bundle: migratedBundle };
}

function validate(workDir, options = {}) {
  let bundle;
  try {
    bundle = read(workDir);
  } catch (error) {
    return { valid: false, error: error.message, code: 'E_BUNDLE_INVALID' };
  }
  if (!bundle) return { valid: false, error: 'no evidence bundle found', code: 'E_BUNDLE_MISSING' };

  const violations = [];
  const context = bundle.context || {};
  const manifest = bundle.manifest || {};
  const version = artifactVersion(bundle);
  if (![1, BUNDLE_VERSION].includes(version)) {
    return { valid: false, code: 'E_BUNDLE_VERSION_UNSUPPORTED', version, violation_count: 1, violations: [
      { type: 'unsupported_version', version, supported_versions: [1, BUNDLE_VERSION] },
    ] };
  }
  if (version === BUNDLE_VERSION && bundle.schema !== BUNDLE_SCHEMA) {
    violations.push({ type: 'schema_invalid', expected: BUNDLE_SCHEMA, actual: bundle.schema ?? null });
  }

  const recomputedIntegrity = computeIntegrity(bundle);
  if (recomputedIntegrity !== bundle.integrity) {
    violations.push({ type: 'integrity_tampered', message: 'bundle integrity hash mismatch — file was modified after freeze' });
  }

  const currentHead = options.currentHead !== undefined
    ? options.currentHead
    : gitHead(options.cwd || process.cwd());
  if (context.head_commit && currentHead && context.head_commit !== currentHead) {
    violations.push({ type: 'head_moved', frozen: context.head_commit, current: currentHead });
  }

  for (const [filePath, meta] of Object.entries(manifest)) {
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
    schema: version === 1 ? 'legacy/v1' : bundle.schema,
    version,
    file_count: Object.keys(manifest).length,
    violation_count: violations.length,
    violations,
  };
  if (!result.valid) {
    if (violations.some(violation => violation.type === 'integrity_tampered')) result.code = 'E_BUNDLE_TAMPERED';
    else if (violations.some(violation => violation.type === 'schema_invalid')) result.code = 'E_BUNDLE_INVALID';
    else result.code = 'E_BUNDLE_DRIFTED';
  }

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
    process.stderr.write('用法: node evidence-bundle.js <freeze|read|validate|migrate> <work-dir>\n');
    process.exitCode = CLI_EXIT_CODES.USAGE;
    return;
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
        process.exitCode = CLI_EXIT_CODES.INVALID_ARTIFACT;
        break;
      }
      console.log(JSON.stringify(bundle, null, 2));
      break;
    }
    case 'validate': {
      const result = validate(workDir);
      console.log(JSON.stringify(result, null, 2));
      if (!result.valid) process.exitCode = result.code === 'E_BUNDLE_DRIFTED'
        ? CLI_EXIT_CODES.DRIFT
        : CLI_EXIT_CODES.INVALID_ARTIFACT;
      break;
    }
    case 'migrate': {
      const result = migrate(workDir);
      console.log(JSON.stringify({ ...result, bundle: undefined }, null, 2));
      if (!result.valid) process.exitCode = CLI_EXIT_CODES.INVALID_ARTIFACT;
      break;
    }
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      process.exitCode = CLI_EXIT_CODES.USAGE;
  }
}

if (require.main === module) main();
module.exports = {
  BUNDLE_FILE, BUNDLE_SCHEMA, BUNDLE_VERSION,
  freeze, read, validate, migrate, computeIntegrity, normalizeGitContext,
  collectFileManifest, collectGitContext,
};
