const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { checkGate } = require('../scripts/gate-check.js');

function workDir() {
  const dir = mkdtempSync(join(tmpdir(), 'optcode-gate-'));
  mkdirSync(join(dir, 'cr'));
  mkdirSync(join(dir, 'fix'));
  return dir;
}

test('rejects deep plans without actionable verification strategy', () => {
  const dir = workDir();
  writeFileSync(join(dir, 'deep-plan.md'), `# OptCode Deep Plan\n\n## 结构诊断\n\n这里有足够长的结构诊断内容，用来说明职责边界和模块依赖的问题，避免长度不足。\n\n## 风险分层\n\n| 优先级 | 问题 | 影响范围 | 风险 | 建议阶段 |\n|---|---|---|---|---|\n| P1 | demo | src | medium | Phase 1 |\n\n## 分阶段实施计划\n\n### Phase 1: 低风险整理\n\n执行小步整理。\n\n## 验证策略\n\n太短。\n\n## 不在本阶段执行的改动\n\n不做大重构。\n`.repeat(2));

  const result = checkGate(dir, 'deep-plan-exists');

  assert.equal(result.pass, false);
  assert.match(result.reason, /verification strategy/);
});

test('rejects pass CR reports containing ISSUE entries', () => {
  const dir = workDir();
  writeFileSync(join(dir, 'cr', 'dead-code-pass.md'), `---\nresult: pass\n---\n\n# CR\n\n## 审查结论\n\n没有高置信度问题。\n\n### ISSUE-001: should not exist\n`);

  const result = checkGate(dir, 'cr-complete:dead-code:1');

  assert.equal(result.pass, false);
  assert.match(result.reason, /pass report/);
});

test('rejects failed CR reports without failure reason', () => {
  const dir = workDir();
  writeFileSync(join(dir, 'cr', 'design-failed.md'), `---\nresult: failed\n---\n\n# CR\n\n## 审查结论\n\n失败。\n`);

  const result = checkGate(dir, 'cr-complete:design:1');

  assert.equal(result.pass, false);
  assert.match(result.reason, /failure reason/);
});

test('rejects round pass CR reports containing ISSUE entries', () => {
  const dir = workDir();
  writeFileSync(join(dir, 'cr', 'design-round-1.md'), `---\nresult: pass\n---\n\n# CR\n\n## 审查结论\n\n没有高置信度问题。\n\n### ISSUE-001: should not exist\n`);

  const result = checkGate(dir, 'cr-complete:design:1');

  assert.equal(result.pass, false);
  assert.match(result.reason, /pass report/);
});

test('rejects round failed CR reports without failure reason', () => {
  const dir = workDir();
  writeFileSync(join(dir, 'cr', 'design-round-1.md'), `---\nresult: failed\n---\n\n# CR\n\n## 审查结论\n\n失败。\n`);

  const result = checkGate(dir, 'cr-complete:design:1');

  assert.equal(result.pass, false);
  assert.match(result.reason, /failure reason/);
});

function writeFixReport(dir, body) {
  writeFileSync(join(dir, 'fix', 'design-round-1-fix.md'), body);
}

test('requires concerns when fix status is DONE_WITH_CONCERNS', () => {
  const dir = workDir();
  writeFixReport(dir, `---\nresult: partial\nstatus: DONE_WITH_CONCERNS\nfixed_count: 0\ntotal_count: 1\n---\n\n# Fix\n\n## 修复结果\n\n| Issue ID | 问题 | 严重度 | 修复风险 | 修复状态 | 说明 |\n|----------|------|-------|---------|---------|------|\n| ISSUE-001 | demo | medium | local | skipped | risky |\n\n## 自检结果\n\n- **完整性**: 已处理\n\n## Diff 检查\n\n- 无关改动：无\n\n## 行为保真检查\n\n- 输入输出契约：保持\n\n## Concerns\n\n`);

  const result = checkGate(dir, 'fix-complete:design:1');

  assert.equal(result.pass, false);
  assert.match(result.reason, /Concerns/);
});

test('rejects fixed result when fixed_count is less than total_count', () => {
  const dir = workDir();
  writeFixReport(dir, `---\nresult: fixed\nstatus: DONE\nfixed_count: 1\ntotal_count: 2\n---\n\n# Fix\n\n## 修复结果\n\n| Issue ID | 问题 | 严重度 | 修复风险 | 修复状态 | 说明 |\n|----------|------|-------|---------|---------|------|\n| ISSUE-001 | demo | medium | local | fixed | ok |\n| ISSUE-002 | demo | medium | local | skipped | no |\n\n## 自检结果\n\n- **完整性**: 已处理\n\n## Diff 检查\n\n- 无关改动：无\n\n## 行为保真检查\n\n- 输入输出契约：保持\n`);

  const result = checkGate(dir, 'fix-complete:design:1');

  assert.equal(result.pass, false);
  assert.match(result.reason, /fixed_count to equal total_count/);
});

test('rejects failed result when fixed_count is nonzero', () => {
  const dir = workDir();
  writeFixReport(dir, `---\nresult: failed\nstatus: BLOCKED\nfixed_count: 1\ntotal_count: 2\n---\n\n# Fix\n\n## 修复结果\n\n| Issue ID | 问题 | 严重度 | 修复风险 | 修复状态 | 说明 |\n|----------|------|-------|---------|---------|------|\n| ISSUE-001 | demo | medium | local | fixed | ok |\n| ISSUE-002 | demo | medium | local | failed | blocked |\n\n## 自检结果\n\n- **完整性**: 已处理\n\n## Diff 检查\n\n- 无关改动：无\n\n## 行为保真检查\n\n- 输入输出契约：保持\n\n## 阻塞原因\n\n技术阻塞，无法继续。\n`);

  const result = checkGate(dir, 'fix-complete:design:1');

  assert.equal(result.pass, false);
  assert.match(result.reason, /fixed_count to be 0/);
});
