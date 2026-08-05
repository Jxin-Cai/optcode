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
  missing: { label: 'Missing', ceiling: 59, description: 'No concrete evidence; speculative or theoretical' },
  present: { label: 'Present', ceiling: 74, description: 'Evidence exists (code snippet shown) but not verified' },
  wired: { label: 'Wired', ceiling: 84, description: 'Evidence connected to system behavior (call graph, config reference)' },
  exercised: { label: 'Exercised', ceiling: 94, description: 'Evidence reproduced via grep, test run, or static analysis' },
  outcome: { label: 'Outcome-supported', ceiling: 100, description: 'Evidence demonstrates actual failure, crash, or incorrect output' },
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

function classifyVerification(method) {
  const normalized = (method || '').toLowerCase().trim();
  for (const [key, level] of Object.entries(VERIFICATION_TO_LEVEL)) {
    if (normalized.includes(key)) return level;
  }
  return 'present';
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
module.exports = { EVIDENCE_LEVELS, classifyVerification, getCeiling, validateReport };
