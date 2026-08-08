const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCrFindings, parseIssueField, splitIssueBlocks } = require('../scripts/report-parser.js');

test('parser supports qualified and fallback dimensions with both field styles', () => {
  const report = `### security:ISSUE-001: Qualified\n\n- **文件**: \`src/a.js\`\n- **严重程度**: high\n\n### ISSUE-002: Fallback\n\n**文件**: \`src/b.js\`\n**严重程度**: low\n`;
  const findings = parseCrFindings(report, { dimension: 'design' });
  assert.deepEqual(findings.map(finding => finding.id), ['security:ISSUE-001', 'design:ISSUE-002']);
  assert.deepEqual(findings.map(finding => finding.file), ['src/a.js', 'src/b.js']);
});

test('issue blocks stop at the next peer or parent heading', () => {
  const report = `### design:ISSUE-001: Real issue\n\n#### Details\n\n- **代码证据**: observed\n\n## Appendix\n\n- **文件**: \`src/not-the-issue.js\`\n`;
  const [issue] = splitIssueBlocks(report);
  assert.match(issue.block, /#### Details/);
  assert.doesNotMatch(issue.block, /Appendix/);
  assert.equal(parseIssueField(issue.block, '文件'), null);
});

test('non-issue headings containing ISSUE text are ignored', () => {
  const report = `## ISSUE summary\n\nText ISSUE-001\n\n### design:ISSUE-002: Actual\n`;
  const findings = parseCrFindings(report, { dimension: 'design' });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].issue_id, 'ISSUE-002');
});
