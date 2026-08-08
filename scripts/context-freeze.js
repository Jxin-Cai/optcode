#!/usr/bin/env node
/**
 * Deprecated compatibility facade for evidence-bundle.js.
 * New captures use the canonical evidence-bundle artifact. Legacy v1
 * context-freeze.json files remain readable and verifiable.
 */
const { createHash } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const evidenceBundle = require('./evidence-bundle.js');
const { CLI_EXIT_CODES } = require('./error-codes.js');

const LEGACY_FREEZE_FILE = 'context-freeze.json';

function hashFile(filePath) {
  if (!existsSync(filePath)) return null;
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function capture(workDir, options = {}) {
  const bundle = evidenceBundle.freeze(workDir, options);
  return {
    version: bundle.version,
    canonical_artifact: evidenceBundle.BUNDLE_FILE,
    captured_at: bundle.frozen_at,
    base_commit: bundle.context.base_commit,
    index_tree_hash: bundle.context.index_tree_hash,
    target_file_count: Object.keys(bundle.manifest).length,
    target_hashes: Object.fromEntries(
      Object.entries(bundle.manifest).map(([filePath, metadata]) => [filePath, metadata.hash])
    ),
  };
}

function verifyLegacy(workDir) {
  const freeze = JSON.parse(readFileSync(join(workDir, LEGACY_FREEZE_FILE), 'utf8'));
  const drifts = [];
  for (const [filePath, frozenHash] of Object.entries(freeze.target_hashes || {})) {
    const currentHash = hashFile(filePath);
    if (currentHash === null) drifts.push({ type: 'file_deleted', path: filePath });
    else if (currentHash !== frozenHash) drifts.push({ type: 'file_modified', path: filePath });
  }
  return {
    drifted: drifts.length > 0,
    drift_count: drifts.length,
    frozen_at: freeze.captured_at,
    verified_at: new Date().toISOString(),
    legacy: true,
    drifts,
  };
}

function verify(workDir, options = {}) {
  if (evidenceBundle.read(workDir)) {
    const result = evidenceBundle.validate(workDir, options);
    return {
      drifted: !result.valid,
      drift_count: result.violation_count || 0,
      frozen_at: result.frozen_at,
      verified_at: result.validated_at,
      canonical_artifact: evidenceBundle.BUNDLE_FILE,
      code: result.code,
      drifts: result.violations || [],
    };
  }
  if (existsSync(join(workDir, LEGACY_FREEZE_FILE))) return verifyLegacy(workDir);
  return { drifted: false, reason: 'no freeze snapshot exists — skipping verification' };
}

function status(workDir) {
  const bundle = evidenceBundle.read(workDir);
  if (bundle) {
    return {
      exists: true,
      canonical_artifact: evidenceBundle.BUNDLE_FILE,
      schema: bundle.schema || 'legacy/v1',
      version: bundle.version,
      captured_at: bundle.frozen_at,
      base_commit: bundle.context?.base_commit,
      target_file_count: Object.keys(bundle.manifest || {}).length,
    };
  }
  const legacyPath = join(workDir, LEGACY_FREEZE_FILE);
  if (!existsSync(legacyPath)) return { exists: false };
  const freeze = JSON.parse(readFileSync(legacyPath, 'utf8'));
  return {
    exists: true,
    legacy: true,
    version: freeze.version,
    captured_at: freeze.captured_at,
    base_commit: freeze.base_commit,
    target_file_count: freeze.target_file_count,
  };
}

function main() {
  const [command, workDir] = process.argv.slice(2);
  if (!command || !workDir) {
    process.stderr.write('用法: node context-freeze.js <capture|verify|status> <work-dir>\n');
    process.exitCode = CLI_EXIT_CODES.USAGE;
    return;
  }
  process.stderr.write('warning: context-freeze is deprecated; use evidence-bundle instead\n');
  switch (command) {
    case 'capture': {
      const result = capture(workDir);
      console.log(JSON.stringify({ captured: true, canonical_artifact: result.canonical_artifact, file_count: result.target_file_count }, null, 2));
      break;
    }
    case 'verify': {
      const result = verify(workDir);
      console.log(JSON.stringify(result, null, 2));
      if (result.drifted) process.exitCode = result.code === 'E_BUNDLE_DRIFTED'
        ? CLI_EXIT_CODES.DRIFT
        : CLI_EXIT_CODES.INVALID_ARTIFACT;
      break;
    }
    case 'status':
      console.log(JSON.stringify(status(workDir), null, 2));
      break;
    default:
      process.stderr.write(`unknown command: ${command}\n`);
      process.exitCode = CLI_EXIT_CODES.USAGE;
  }
}

if (require.main === module) main();
module.exports = { LEGACY_FREEZE_FILE, capture, verify, verifyLegacy, status };
