#!/usr/bin/env node
/**
 * optcode population binding — cross-validates claimed vs actual finding counts.
 *
 * Catches AI agents that exaggerate ("found 12 critical issues") or minimize
 * ("only 1 minor concern") by independently counting actual ISSUE blocks and
 * comparing against:
 *   1. Frontmatter claims (issues_count)
 *   2. Structured output claims (issueIds array length from workflow)
 *   3. State machine records (dimensions[dim].issues_found)
 *
 * Usage: node population-binding.js <work-dir> [--json]
 */
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { readState, readFrontmatter, appendAudit } = require('./workflow-lib.js');

const TOLERANCE_RATIO = 0.2;

function countIssueBlocks(text) {
  return [...text.matchAll(/^#{2,4}\s+(?:[A-Za-z][\w-]*:\s*)?ISSUE-\d+/gm)].length;
}

function extractIssueIds(text) {
  return [...text.matchAll(/^#{2,4}\s+(?:([A-Za-z][\w-]*):\s*)?(ISSUE-\d+)/gm)]
    .map(m => `${m[1] || 'unknown'}:${m[2]}`);
}

function validate(workDir) {
  const state = readState(workDir);
  if (!state) return { valid: false, error: 'state.json not found', code: 'E_STATE_MISSING' };

  const crDir = join(workDir, 'cr');
  if (!existsSync(crDir)) return { valid: true, dimensions: [], violations: [], message: 'no CR dir yet' };

  const violations = [];
  const dimensionBindings = [];

  const crFiles = readdirSync(crDir).filter(f => f.endsWith('.md'));

  for (const file of crFiles) {
    const filePath = join(crDir, file);
    const text = readFileSync(filePath, 'utf8');
    const fm = readFrontmatter(text);
    const actualCount = countIssueBlocks(text);
    const actualIds = extractIssueIds(text);
    const dimFromFile = file.replace(/-(?:round-\d+|pass|failed)\.md$/, '');

    const binding = {
      file,
      dimension: dimFromFile,
      actual_count: actualCount,
      actual_ids: actualIds,
      frontmatter_claim: fm.issues_count !== undefined ? Number(fm.issues_count) : null,
      state_claim: null,
    };

    // Cross-check vs frontmatter
    if (binding.frontmatter_claim !== null && binding.frontmatter_claim !== actualCount) {
      violations.push({
        type: 'frontmatter_mismatch',
        dimension: dimFromFile,
        file,
        claimed: binding.frontmatter_claim,
        actual: actualCount,
        message: `${dimFromFile}: frontmatter claims ${binding.frontmatter_claim} issues but report contains ${actualCount}`,
      });
    }

    // Cross-check vs state machine
    const dimState = state.dimensions[dimFromFile];
    if (dimState && dimState.issues_found > 0) {
      binding.state_claim = dimState.issues_found;
      const deviation = Math.abs(dimState.issues_found - actualCount);
      const threshold = Math.max(1, Math.ceil(actualCount * TOLERANCE_RATIO));
      if (deviation > threshold && actualCount > 0) {
        violations.push({
          type: 'state_mismatch',
          dimension: dimFromFile,
          file,
          state_claim: dimState.issues_found,
          actual: actualCount,
          deviation,
          message: `${dimFromFile}: state records ${dimState.issues_found} issues_found but report has ${actualCount} (deviation ${deviation} exceeds tolerance)`,
        });
      }
    }

    // Exaggeration detection: if agent claimed needs_fix but 0 actual issues
    if (fm.result === 'needs_fix' && actualCount === 0) {
      violations.push({
        type: 'phantom_findings',
        dimension: dimFromFile,
        file,
        message: `${dimFromFile}: claims result=needs_fix but contains zero ISSUE blocks (phantom findings)`,
      });
    }

    // Minimization detection: pass result but issues exist
    if (fm.result === 'pass' && actualCount > 0) {
      violations.push({
        type: 'hidden_findings',
        dimension: dimFromFile,
        file,
        actual: actualCount,
        message: `${dimFromFile}: claims result=pass but contains ${actualCount} ISSUE blocks (hidden findings)`,
      });
    }

    dimensionBindings.push(binding);
  }

  // Cross-lane consistency: detect if multiple dimensions claim findings on
  // the same file but with contradictory assertions (same file, wildly different counts)
  const fileClaims = {};
  for (const binding of dimensionBindings) {
    for (const id of binding.actual_ids) {
      const parts = id.split(':');
      if (parts.length >= 2) {
        // Track which dimensions reference which files (from CR reports)
        if (!fileClaims[binding.file]) fileClaims[binding.file] = [];
        fileClaims[binding.file].push({ dimension: binding.dimension, count: binding.actual_count });
      }
    }
  }
  // If the same CR report file appears with conflicting counts from different reads, flag it
  for (const [file, claims] of Object.entries(fileClaims)) {
    if (claims.length <= 1) continue;
    const counts = [...new Set(claims.map(c => c.count))];
    if (counts.length > 1) {
      violations.push({
        type: 'cross_lane_conflict',
        file,
        claims: claims.map(c => `${c.dimension}:${c.count}`),
        message: `cross-lane conflict: ${file} has inconsistent counts across lanes (${claims.map(c => `${c.dimension}=${c.count}`).join(', ')})`,
      });
    }
  }

  const result = {
    valid: violations.length === 0,
    dimensions_checked: dimensionBindings.length,
    total_actual_findings: dimensionBindings.reduce((sum, b) => sum + b.actual_count, 0),
    violation_count: violations.length,
    violations,
    bindings: dimensionBindings,
  };

  appendAudit(workDir, {
    type: 'population_binding',
    valid: result.valid,
    violation_count: result.violation_count,
    dimensions_checked: result.dimensions_checked,
  });

  return result;
}

function main() {
  const workDir = process.argv[2];
  const jsonFlag = process.argv.includes('--json');
  if (!workDir) {
    process.stderr.write('用法: node population-binding.js <work-dir> [--json]\n');
    process.exit(1);
  }
  const result = validate(workDir);
  if (jsonFlag) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.valid) {
      console.log(`✓ Population binding: ${result.dimensions_checked} dimensions, ${result.total_actual_findings} findings — all counts consistent`);
    } else {
      console.log(`✗ ${result.violation_count} population binding violation(s):`);
      for (const v of result.violations) {
        console.log(`  [${v.type}] ${v.message}`);
      }
    }
  }
  if (!result.valid) process.exit(1);
}

if (require.main === module) main();
module.exports = { validate, countIssueBlocks };
