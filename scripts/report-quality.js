#!/usr/bin/env node
/**
 * optcode report quality validator — 8 quality gates for CR findings.
 *
 * Gates:
 *   1. Evidence eligibility — only observed consequences, not speculation
 *   2. Concrete reader value — titles name consequences, not detectors
 *   3. Fact consistency — counts from same canonical source
 *   4. Asset accountability — every inspected file tracked
 *   5. Privacy — no secrets, session IDs, absolute paths, raw prompts
 *   6. Executable repair — fix proposal references discoverable tools/commands
 *   7. Score discipline — scores match evidence strength
 *   8. Candidate promotion — new findings justify their existence
 *
 * Usage: node report-quality.js <report-path> [--json]
 */
const { existsSync, readFileSync } = require('node:fs');
const { readFrontmatter } = require('./workflow-lib.js');
const { parseIssueField, splitIssueBlocks: parseIssueBlocks } = require('./report-parser.js');

const PRIVACY_PATTERNS = [
  /\/Users\/[^\s/]+/g,
  /\/home\/[^\s/]+/g,
  /C:\\Users\\[^\s\\]+/g,
  /session[_-]?id\s*[:=]\s*["']?[a-f0-9-]{8,}/gi,
  /sk-[a-zA-Z0-9]{20,}/g,
  /ghp_[a-zA-Z0-9]{36,}/g,
  /Bearer\s+[a-zA-Z0-9._-]{20,}/gi,
  /password\s*[:=]\s*["'][^"']{4,}["']/gi,
  /api[_-]?key\s*[:=]\s*["'][^"']{8,}["']/gi,
];

const SPECULATIVE_PHRASES = [
  /可能会?导致/,
  /might\s+cause/i,
  /could\s+potentially/i,
  /maybe\s+this/i,
  /seems?\s+like\s+it\s+(?:could|might)/i,
  /理论上/,
  /hypothetically/i,
];

const DETECTOR_TITLE_PATTERNS = [
  /^检查.+$/,
  /^Check\s+for/i,
  /^Lint:\s/i,
  /^Rule\s+violation/i,
];

function splitIssueBlocks(text) {
  return parseIssueBlocks(text).map(issue => issue.block);
}

function parseField(block, label) {
  return parseIssueField(block, label);
}

function gate1EvidenceEligibility(blocks) {
  const violations = [];
  for (const block of blocks) {
    const id = (block.match(/^###\s+(?:[A-Za-z][\w-]*:)?(ISSUE-\d+)/) || [])[1] || 'unknown';
    const evidence = parseField(block, '代码证据') || '';
    const description = parseField(block, '问题描述') || '';
    const content = evidence + description;
    for (const pattern of SPECULATIVE_PHRASES) {
      if (pattern.test(content)) {
        violations.push(`${id}: speculative language in evidence/description ("${content.match(pattern)?.[0]}")`);
        break;
      }
    }
    if (!evidence && !block.includes('```')) {
      violations.push(`${id}: no concrete code evidence provided`);
    }
  }
  return violations;
}

function gate2ConcreteReaderValue(blocks) {
  const violations = [];
  for (const block of blocks) {
    const titleMatch = block.match(/^###\s+(?:[A-Za-z][\w-]*:)?ISSUE-\d+:\s*(.+)$/m);
    if (!titleMatch) continue;
    const title = titleMatch[1];
    for (const pattern of DETECTOR_TITLE_PATTERNS) {
      if (pattern.test(title)) {
        violations.push(`ISSUE title "${title}" names a detector, not a consequence`);
        break;
      }
    }
  }
  return violations;
}

function gate3FactConsistency(text, fm) {
  const violations = [];
  const blocks = splitIssueBlocks(text);
  if (fm.issues_count !== undefined && blocks.length !== Number(fm.issues_count)) {
    violations.push(`frontmatter issues_count=${fm.issues_count} but actual ISSUE blocks=${blocks.length}`);
  }
  return violations;
}

function gate4AssetAccountability(text) {
  const violations = [];
  const fileRefs = [...text.matchAll(/- \*\*文件\*\*:\s*`([^`]+)`/g)].map(m => m[1]);
  const uniqueFiles = [...new Set(fileRefs)];
  if (uniqueFiles.length === 0 && text.includes('ISSUE-')) {
    violations.push('findings present but no file references tracked');
  }
  return violations;
}

function gate5Privacy(text) {
  const violations = [];
  for (const pattern of PRIVACY_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      violations.push(`privacy leak: ${matches[0].slice(0, 40)}...`);
    }
  }
  return violations;
}

function gate6ExecutableRepair(blocks) {
  const violations = [];
  for (const block of blocks) {
    const id = (block.match(/^###\s+(?:[A-Za-z][\w-]*:)?(ISSUE-\d+)/) || [])[1] || 'unknown';
    const fix = parseField(block, '修复方案');
    if (!fix) {
      violations.push(`${id}: missing 修复方案`);
      continue;
    }
    if (fix.length < 10) {
      violations.push(`${id}: fix proposal too vague (${fix.length} chars)`);
    }
    if (!block.includes('预期修复后代码')) {
      violations.push(`${id}: missing expected post-fix code`);
    }
  }
  return violations;
}

function gate7ScoreDiscipline(blocks) {
  const violations = [];
  for (const block of blocks) {
    const id = (block.match(/^###\s+(?:[A-Za-z][\w-]*:)?(ISSUE-\d+)/) || [])[1] || 'unknown';
    const confidence = Number(parseField(block, '置信度'));
    const severity = parseField(block, '严重程度');
    const verification = parseField(block, '验证方式');
    const isReadOnly = verification && !(/test|grep|build|typecheck|runtime|reproduction|static.analysis/i.test(verification));
    if (confidence > 95 && isReadOnly) {
      violations.push(`${id}: confidence ${confidence} but verification is read-only (cap at 94 for non-executed evidence)`);
    }
    if (severity === 'high' && confidence < 80) {
      violations.push(`${id}: high severity requires confidence >= 80, got ${confidence}`);
    }
  }
  return violations;
}

function gate8CandidatePromotion(blocks) {
  const violations = [];
  for (const block of blocks) {
    const id = (block.match(/^###\s+(?:[A-Za-z][\w-]*:)?(ISSUE-\d+)/) || [])[1] || 'unknown';
    const scope = parseField(block, '范围内问题');
    if (scope === 'no') {
      violations.push(`${id}: finding marked out of scope (范围内问题=no) should not be promoted`);
    }
  }
  return violations;
}

function validateReport(reportPath) {
  if (!existsSync(reportPath)) return { pass: false, error: 'report file not found' };
  const text = readFileSync(reportPath, 'utf8');
  const fm = readFrontmatter(text);
  const blocks = splitIssueBlocks(text);

  const gates = {
    evidence_eligibility: gate1EvidenceEligibility(blocks),
    concrete_reader_value: gate2ConcreteReaderValue(blocks),
    fact_consistency: gate3FactConsistency(text, fm),
    asset_accountability: gate4AssetAccountability(text),
    privacy: gate5Privacy(text),
    executable_repair: gate6ExecutableRepair(blocks),
    score_discipline: gate7ScoreDiscipline(blocks),
    candidate_promotion: gate8CandidatePromotion(blocks),
  };

  const allViolations = Object.entries(gates).flatMap(([gate, v]) => v.map(msg => ({ gate, msg })));
  return {
    pass: allViolations.length === 0,
    total_violations: allViolations.length,
    gates: Object.fromEntries(
      Object.entries(gates).map(([k, v]) => [k, { pass: v.length === 0, violations: v }])
    ),
    violations: allViolations,
  };
}

function main() {
  const reportPath = process.argv[2];
  const jsonFlag = process.argv.includes('--json');
  if (!reportPath) {
    process.stderr.write('用法: node report-quality.js <report-path> [--json]\n');
    process.exit(1);
  }
  const result = validateReport(reportPath);
  if (jsonFlag) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.pass) {
      console.log('✓ All 8 quality gates passed');
    } else {
      console.log(`✗ ${result.total_violations} violation(s) across quality gates:`);
      for (const { gate, msg } of result.violations) {
        console.log(`  [${gate}] ${msg}`);
      }
    }
  }
  if (!result.pass) process.exit(1);
}

if (require.main === module) main();
module.exports = { validateReport };
