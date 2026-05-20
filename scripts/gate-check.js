#!/usr/bin/env node
/**
 * optcode gate check — validates postconditions for each step.
 *
 * Usage: node gate-check.js <work-dir> <gate-id>
 * Gates:
 *   - state-initialized: state.json exists and is valid
 *   - cr-complete:<dimension>:<round>: CR report exists with valid frontmatter
 *   - fix-complete:<dimension>:<round>: Fix report exists with valid frontmatter + self-review
 *   - summary-exists: summary.md exists
 */
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { readState, readFrontmatter, appendAudit, FIX_STATUSES } = require('./workflow-lib.js');

function result(gate, pass, reason = '') {
  return { pass, gate, reason };
}

function checkGate(workDir, gateId) {
  if (!workDir || !existsSync(workDir)) {
    return result(gateId, false, 'work directory does not exist');
  }

  if (gateId === 'state-initialized') {
    const state = readState(workDir);
    if (!state) return result(gateId, false, 'state.json missing');
    if (!state.target_paths || !Array.isArray(state.target_paths)) return result(gateId, false, 'state.json missing target_paths');
    if (!state.dimensions) return result(gateId, false, 'state.json missing dimensions');
    return result(gateId, true);
  }

  if (gateId === 'summary-exists') {
    const summaryPath = join(workDir, 'summary.md');
    if (!existsSync(summaryPath)) return result(gateId, false, 'summary.md missing');
    const text = readFileSync(summaryPath, 'utf8');
    if (text.length < 100) return result(gateId, false, 'summary.md has insufficient content');
    return result(gateId, true);
  }

  // cr-complete:<dimension>:<round>
  const crMatch = gateId.match(/^cr-complete:([^:]+):(\d+)$/);
  if (crMatch) {
    const [, dimension, roundStr] = crMatch;
    const round = Number(roundStr);
    // Check for pass file first
    const passFile = join(workDir, 'cr', `${dimension}-pass.md`);
    if (existsSync(passFile)) {
      const fm = readFrontmatter(readFileSync(passFile, 'utf8'));
      if (fm.result === 'pass') return result(gateId, true);
    }
    // Check for failed file
    const failedFile = join(workDir, 'cr', `${dimension}-failed.md`);
    if (existsSync(failedFile)) {
      const fm = readFrontmatter(readFileSync(failedFile, 'utf8'));
      if (fm.result === 'failed') return result(gateId, true);
    }
    // Check for round file
    const roundFile = join(workDir, 'cr', `${dimension}-round-${round}.md`);
    if (!existsSync(roundFile)) return result(gateId, false, `CR report missing: ${dimension}-round-${round}.md`);
    const text = readFileSync(roundFile, 'utf8');
    const fm = readFrontmatter(text);
    if (!fm.result) return result(gateId, false, 'CR report missing result in frontmatter');
    if (!['pass', 'needs_fix', 'failed'].includes(fm.result)) return result(gateId, false, `invalid result: ${fm.result}`);
    if (fm.result === 'needs_fix' && !text.includes('ISSUE-')) return result(gateId, false, 'needs_fix report must contain at least one ISSUE');
    if (fm.result === 'needs_fix' && fm.issues_count !== undefined) {
      const actualIssues = [...text.matchAll(/###\s+ISSUE-\d+/g)].length;
      if (actualIssues !== Number(fm.issues_count)) {
        return result(gateId, false, `frontmatter issues_count (${fm.issues_count}) does not match actual ISSUE count (${actualIssues})`);
      }
    }
    return result(gateId, true);
  }

  // fix-complete:<dimension>:<round>
  const fixMatch = gateId.match(/^fix-complete:([^:]+):(\d+)$/);
  if (fixMatch) {
    const [, dimension, roundStr] = fixMatch;
    const round = Number(roundStr);
    const fixFile = join(workDir, 'fix', `${dimension}-round-${round}-fix.md`);
    if (!existsSync(fixFile)) return result(gateId, false, `Fix report missing: ${dimension}-round-${round}-fix.md`);
    const text = readFileSync(fixFile, 'utf8');
    const fm = readFrontmatter(text);
    if (!fm.result) return result(gateId, false, 'Fix report missing result in frontmatter');
    if (!['success', 'partial', 'failed'].includes(fm.result)) return result(gateId, false, `invalid fix result: ${fm.result}`);
    if (!fm.status) return result(gateId, false, 'Fix report missing status in frontmatter');
    if (!FIX_STATUSES.includes(fm.status)) return result(gateId, false, `invalid fix status: ${fm.status}, expected one of: ${FIX_STATUSES.join(', ')}`);
    if (!text.includes('## 自检结果')) return result(gateId, false, 'Fix report missing self-review section (## 自检结果)');
    if (!text.includes('## Diff 检查')) return result(gateId, false, 'Fix report missing diff check section (## Diff 检查)');
    if (!text.includes('## 行为保真检查')) return result(gateId, false, 'Fix report missing behavior preservation section (## 行为保真检查)');
    if (fm.total_count !== undefined && fm.fixed_count !== undefined) {
      const fixed = Number(fm.fixed_count);
      const total = Number(fm.total_count);
      if (fixed > total) return result(gateId, false, `fixed_count (${fixed}) exceeds total_count (${total})`);
      const rows = [...text.matchAll(/\|\s*ISSUE-\d+\s*\|/g)].length;
      if (rows > 0 && rows !== total) {
        return result(gateId, false, `fix report table has ${rows} ISSUE rows but total_count is ${total}`);
      }
    }
    return result(gateId, true);
  }

  return result(gateId, false, `unknown gate: ${gateId}`);
}

function main() {
  const workDir = process.argv[2];
  const gateId = process.argv[3];
  if (!workDir || !gateId) {
    process.stderr.write('用法: node gate-check.js <work-dir> <gate-id>\n');
    process.exit(1);
  }
  const checked = checkGate(workDir, gateId);
  appendAudit(workDir, { type: 'gate_result', gate: gateId, pass: checked.pass, reason: checked.reason || '' });
  console.log(JSON.stringify(checked));
  if (!checked.pass) process.exit(1);
}

main();

module.exports = { checkGate };
