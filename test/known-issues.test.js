const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { parseCrReport, syncFromCrReports } = require('../scripts/known-issues.js');

const REPORT = `---
dimension: design
result: needs_fix
---
### design:ISSUE-001: Missing local evidence

**严重程度**: high

### design:ISSUE-002: Real issue

**文件**: \`src/real.js\`
**严重程度**: low
`;

test('CR parsing never borrows a file field from the next finding', () => {
  const findings = parseCrReport(REPORT, 'design');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].title, 'Real issue');
  assert.equal(findings[0].file, 'src/real.js');
  assert.equal(findings[0].severity, 'low');
});

test('CR parsing never borrows a file field from a trailing report section', () => {
  const report = `${REPORT}\n## Appendix\n\n**文件**: \`src/appendix.js\`\n`;
  const findings = parseCrReport(report, 'design');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'src/real.js');
});

test('known-issue sync accepts only explicitly gated dimensions', () => {
  const root = mkdtempSync(join(tmpdir(), 'optcode-known-'));
  const workDir = join(root, '.optcode', 'run');
  const crDir = join(workDir, 'cr');
  mkdirSync(crDir, { recursive: true });
  try {
    writeFileSync(join(crDir, 'design-round-1.md'), REPORT);
    writeFileSync(join(crDir, 'security-round-1.md'), REPORT.replaceAll('design', 'security').replace('src/real.js', 'src/security.js'));
    syncFromCrReports(root, workDir, { dimensions: ['design'] });
    const issues = JSON.parse(readFileSync(join(root, '.optcode', 'known-issues.json'), 'utf8'));
    assert.equal(issues.length, 1);
    assert.equal(issues[0].dimension, 'design');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('known-issue sync counts a finding once per run', () => {
  const root = mkdtempSync(join(tmpdir(), 'optcode-known-idempotent-'));
  const firstRun = join(root, '.optcode', 'run-1');
  const secondRun = join(root, '.optcode', 'run-2');
  try {
    for (const workDir of [firstRun, secondRun]) {
      mkdirSync(join(workDir, 'cr'), { recursive: true });
      writeFileSync(join(workDir, 'cr', 'design-round-1.md'), REPORT);
    }

    syncFromCrReports(root, firstRun);
    syncFromCrReports(root, firstRun);
    let [issue] = JSON.parse(readFileSync(join(root, '.optcode', 'known-issues.json'), 'utf8'));
    assert.equal(issue.run_count, 1);
    assert.deepEqual(issue.seen_runs, ['.optcode/run-1']);

    syncFromCrReports(root, secondRun);
    [issue] = JSON.parse(readFileSync(join(root, '.optcode', 'known-issues.json'), 'utf8'));
    assert.equal(issue.run_count, 2);
    assert.deepEqual(issue.seen_runs, ['.optcode/run-1', '.optcode/run-2']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
