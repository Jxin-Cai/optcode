#!/usr/bin/env node
/**
 * optcode score-finding bidirectional consistency checker.
 *
 * Enforces two invariants:
 *   1. Forward: dimension scoring below threshold MUST have ≥1 linked finding
 *   2. Reverse: every finding MUST back-reference a valid active dimension
 *
 * Prevents orphan scores (claim problems without findings) and orphan findings
 * (findings not linked to any dimension score).
 *
 * Usage: node score-finding-consistency.js <work-dir> [--json]
 */
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { readState, DIMENSIONS, readFrontmatter, appendAudit } = require('./workflow-lib.js');

const LOW_SCORE_THRESHOLD = 70;

function extractFindingDimensionRefs(workDir) {
  const crDir = join(workDir, 'cr');
  if (!existsSync(crDir)) return { findings: [], dimensionRefs: new Map() };

  const findings = [];
  const dimensionRefs = new Map();

  const files = readdirSync(crDir).filter(f => f.endsWith('.md'));
  for (const file of files) {
    const text = readFileSync(join(crDir, file), 'utf8');
    const fm = readFrontmatter(text);
    const dimFromFile = file.replace(/-(?:round-\d+|pass|failed)\.md$/, '');

    const issueMatches = [...text.matchAll(/^###\s+(?:([A-Za-z][\w-]*):)?(ISSUE-\d+)/gm)];
    for (const match of issueMatches) {
      const dimPrefix = match[1] || dimFromFile;
      const issueId = match[2];
      const fullId = `${dimPrefix}:${issueId}`;
      findings.push({ id: fullId, dimension: dimPrefix, file });

      if (!dimensionRefs.has(dimPrefix)) dimensionRefs.set(dimPrefix, []);
      dimensionRefs.get(dimPrefix).push(fullId);
    }
  }

  return { findings, dimensionRefs };
}

function check(workDir) {
  const state = readState(workDir);
  if (!state) return { valid: false, error: 'state.json not found', code: 'E_STATE_MISSING' };

  const { findings, dimensionRefs } = extractFindingDimensionRefs(workDir);
  const violations = [];

  const activeDimensions = DIMENSIONS.filter(d => state.dimensions[d] && state.dimensions[d].status !== 'skipped');

  // Forward check: low-score dimensions must have findings
  for (const dim of activeDimensions) {
    const dimState = state.dimensions[dim];
    if (!dimState) continue;

    const hasFindings = (dimensionRefs.get(dim) || []).length > 0;
    const inFailState = ['failed', 'exceeded', 'needs_fix'].includes(dimState.status);

    if (inFailState && !hasFindings) {
      violations.push({
        direction: 'forward',
        dimension: dim,
        status: dimState.status,
        message: `${dim}: status="${dimState.status}" implies problems but no findings linked`,
      });
    }

    if (dimState.issues_found > 0 && !hasFindings) {
      violations.push({
        direction: 'forward',
        dimension: dim,
        issues_found: dimState.issues_found,
        message: `${dim}: state claims ${dimState.issues_found} issues found but no ISSUE blocks exist in CR reports`,
      });
    }
  }

  // Reverse check: every finding must reference a valid active dimension
  const activeDimSet = new Set(activeDimensions);
  for (const finding of findings) {
    if (!activeDimSet.has(finding.dimension)) {
      violations.push({
        direction: 'reverse',
        finding_id: finding.id,
        dimension: finding.dimension,
        file: finding.file,
        message: `${finding.id}: references dimension "${finding.dimension}" which is not active (skipped or unknown)`,
      });
    }
  }

  // Cross-check: state.issues_found count vs actual finding count per dimension
  for (const dim of activeDimensions) {
    const dimState = state.dimensions[dim];
    const actualCount = (dimensionRefs.get(dim) || []).length;
    if (dimState.issues_found > 0 && actualCount > 0 && Math.abs(dimState.issues_found - actualCount) > actualCount * 0.5) {
      violations.push({
        direction: 'cross',
        dimension: dim,
        state_count: dimState.issues_found,
        actual_count: actualCount,
        message: `${dim}: state.issues_found=${dimState.issues_found} diverges from actual findings count=${actualCount} (>50% deviation)`,
      });
    }
  }

  const result = {
    valid: violations.length === 0,
    checked_dimensions: activeDimensions.length,
    total_findings: findings.length,
    violation_count: violations.length,
    violations,
  };

  appendAudit(workDir, {
    type: 'score_finding_consistency',
    valid: result.valid,
    violation_count: result.violation_count,
  });

  return result;
}

function main() {
  const workDir = process.argv[2];
  const jsonFlag = process.argv.includes('--json');
  if (!workDir) {
    process.stderr.write('用法: node score-finding-consistency.js <work-dir> [--json]\n');
    process.exit(1);
  }
  const result = check(workDir);
  if (jsonFlag) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.valid) {
      console.log(`✓ Score-Finding consistency: ${result.checked_dimensions} dimensions, ${result.total_findings} findings — all linked`);
    } else {
      console.log(`✗ ${result.violation_count} consistency violation(s):`);
      for (const v of result.violations) {
        console.log(`  [${v.direction}] ${v.message}`);
      }
    }
  }
  if (!result.valid) process.exit(1);
}

if (require.main === module) main();
module.exports = { check, extractFindingDimensionRefs };
