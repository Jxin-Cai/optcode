#!/usr/bin/env node
/**
 * Evidence strength model — defines ceilings for finding confidence/scores
 * based on the strength of supporting evidence.
 *
 * Five levels (from weakest to strongest):
 *   Missing    → max 59  (no evidence, speculative)
 *   Present    → max 74  (evidence exists but unverified)
 *   Wired      → max 84  (evidence connected to system behavior)
 *   Exercised  → max 94  (evidence reproduced via test/grep/execution)
 *   Outcome    → max 100 (evidence demonstrates actual failure/impact)
 *
 * Usage:
 *   node evidence-strength.js classify <verification-method>
 *   node evidence-strength.js validate <report-path>
 */
const { existsSync, readFileSync } = require('node:fs');
const { readFrontmatter } = require('./workflow-lib.js');

const EVIDENCE_LEVELS = {
  missing: {
    label: 'Missing', ceiling: 59, order: 0,
    description: 'No concrete evidence; speculative or theoretical',
    prerequisite: null,
    promotion_requires: 'Show code snippet or reference that demonstrates the issue exists',
  },
  present: {
    label: 'Present', ceiling: 74, order: 1,
    description: 'Evidence exists (code snippet shown) but not verified',
    prerequisite: 'missing',
    promotion_requires: 'Connect evidence to system behavior via call graph, config, or dependency trace',
  },
  wired: {
    label: 'Wired', ceiling: 84, order: 2,
    description: 'Evidence connected to system behavior (call graph, config reference)',
    prerequisite: 'present',
    promotion_requires: 'Reproduce via grep, test run, static analysis, or build verification',
  },
  exercised: {
    label: 'Exercised', ceiling: 94, order: 3,
    description: 'Evidence reproduced via grep, test run, or static analysis',
    prerequisite: 'wired',
    promotion_requires: 'Demonstrate actual failure, crash, incorrect output, or production impact',
  },
  outcome: {
    label: 'Outcome-supported', ceiling: 100, order: 4,
    description: 'Evidence demonstrates actual failure, crash, or incorrect output',
    prerequisite: 'exercised',
    promotion_requires: null,
  },
};

const VERIFICATION_TO_LEVEL = {
  'read': 'present',
  'grep': 'wired',
  'static-analysis': 'wired',
  'test': 'exercised',
  'typecheck': 'exercised',
  'build': 'exercised',
  'runtime': 'outcome',
  'manual': 'present',
  'reproduction': 'outcome',
};

const LEVEL_ORDER = ['missing', 'present', 'wired', 'exercised', 'outcome'];

function classifyVerification(method) {
  const normalized = (method || '').toLowerCase().trim();
  for (const [key, level] of Object.entries(VERIFICATION_TO_LEVEL)) {
    if (normalized.includes(key)) return level;
  }
  return 'present';
}

function canPromote(currentLevel, targetLevel) {
  const currentOrder = EVIDENCE_LEVELS[currentLevel]?.order ?? -1;
  const targetOrder = EVIDENCE_LEVELS[targetLevel]?.order ?? -1;
  if (targetOrder <= currentOrder) return { allowed: false, reason: 'target is not higher than current level' };
  if (targetOrder - currentOrder > 1) {
    const skipped = LEVEL_ORDER.slice(currentOrder + 1, targetOrder);
    return { allowed: false, reason: `cannot skip levels: must pass through ${skipped.join(' → ')} first` };
  }
  return { allowed: true, promotion_requires: EVIDENCE_LEVELS[currentLevel].promotion_requires };
}

function validateLadder(evidenceChain) {
  if (!Array.isArray(evidenceChain) || evidenceChain.length === 0) {
    return { valid: false, error: 'evidence chain is empty' };
  }
  const violations = [];
  for (let i = 1; i < evidenceChain.length; i++) {
    const prev = evidenceChain[i - 1];
    const curr = evidenceChain[i];
    const prevOrder = EVIDENCE_LEVELS[prev]?.order ?? -1;
    const currOrder = EVIDENCE_LEVELS[curr]?.order ?? -1;
    if (currOrder - prevOrder > 1) {
      violations.push({
        step: i,
        from: prev,
        to: curr,
        message: `step ${i}: jumped from "${prev}" to "${curr}" — skipped intermediate levels`,
      });
    }
    if (currOrder < prevOrder) {
      violations.push({
        step: i,
        from: prev,
        to: curr,
        message: `step ${i}: regressed from "${prev}" to "${curr}"`,
      });
    }
  }
  return { valid: violations.length === 0, violations };
}

function getCeiling(level) {
  return EVIDENCE_LEVELS[level]?.ceiling ?? 59;
}

function validateReport(reportPath) {
  if (!existsSync(reportPath)) return { valid: false, error: 'file not found' };
  const text = readFileSync(reportPath, 'utf8');

  const issueMatches = [...text.matchAll(/^###\s+(?:[A-Za-z][\w-]*:)?(ISSUE-\d+)[^\n]*$/gm)];
  const violations = [];

  for (let i = 0; i < issueMatches.length; i++) {
    const start = issueMatches[i].index;
    const end = i + 1 < issueMatches.length ? issueMatches[i + 1].index : text.length;
    const block = text.slice(start, end);

    const id = (block.match(/^###\s+(?:[A-Za-z][\w-]*:)?(ISSUE-\d+)/) || [])[1] || 'unknown';
    const confidenceMatch = block.match(/- \*\*置信度\*\*:\s*(\d+)/);
    const verificationMatch = block.match(/- \*\*验证方式\*\*:\s*([^\n]+)/);

    if (!confidenceMatch || !verificationMatch) continue;

    const confidence = Number(confidenceMatch[1]);
    const verification = verificationMatch[1].trim();
    const level = classifyVerification(verification);
    const ceiling = getCeiling(level);

    if (confidence > ceiling) {
      violations.push({
        issueId: id,
        confidence,
        verificationMethod: verification,
        evidenceLevel: level,
        ceiling,
        message: `${id}: confidence ${confidence} exceeds ceiling ${ceiling} for evidence level "${level}" (verification: ${verification})`,
      });
    }
  }

  return {
    valid: violations.length === 0,
    issues_checked: issueMatches.length,
    violations,
  };
}

function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (!cmd) {
    process.stderr.write('用法: node evidence-strength.js <classify|validate> <arg>\n');
    process.exit(1);
  }
  switch (cmd) {
    case 'classify': {
      const level = classifyVerification(arg);
      const info = EVIDENCE_LEVELS[level];
      console.log(JSON.stringify({ method: arg, level, ...info }));
      break;
    }
    case 'validate': {
      const result = validateReport(arg);
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
module.exports = { EVIDENCE_LEVELS, LEVEL_ORDER, classifyVerification, getCeiling, canPromote, validateLadder, validateReport };
