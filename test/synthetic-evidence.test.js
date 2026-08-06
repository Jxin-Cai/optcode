const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');

const { detectSynthetic, extractFileRefs, extractSymbolRefs } = require('../scripts/synthetic-evidence.js');

function setupTestDir() {
  const dir = mkdtempSync(join(tmpdir(), 'optcode-synth-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'main.js'), 'function realFunc() {\n  return 42;\n}\nmodule.exports = { realFunc };\n');
  writeFileSync(join(dir, 'src', 'util.js'), 'const x = 1;\n');
  return dir;
}

test('extractFileRefs extracts file references', () => {
  const text = `### design:ISSUE-001: something
- **文件**: \`src/main.js\`
- **位置**: \`L5\`
### design:ISSUE-002: another
- **文件**: \`src/util.js\`
`;
  const refs = extractFileRefs(text);
  assert.equal(refs.length, 2);
  assert.equal(refs[0].value, 'src/main.js');
  assert.equal(refs[1].value, 'src/util.js');
});

test('extractSymbolRefs extracts symbols and lines', () => {
  const text = `### design:ISSUE-001: x
- **位置**: \`processData L42\`
### design:ISSUE-002: y
- **位置**: \`handleRequest()\`
`;
  const refs = extractSymbolRefs(text);
  const symbols = refs.filter(r => r.type === 'symbol');
  const lines = refs.filter(r => r.type === 'line');
  assert.ok(symbols.length >= 1);
  assert.ok(lines.length >= 1);
  assert.equal(lines[0].value, 42);
});

test('detects fabricated file path', () => {
  const dir = setupTestDir();
  const reportPath = join(dir, 'report.md');
  writeFileSync(reportPath, `---
result: needs_fix
---
### design:ISSUE-001: bad ref
- **文件**: \`src/nonexistent.js\`
- **位置**: \`someFunc\`
`);
  try {
    const result = detectSynthetic(reportPath, { baseDir: dir, skipSymbolGrep: true });
    assert.equal(result.valid, false);
    assert.ok(result.violations.some(v => v.type === 'fabricated_file'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detects fabricated line number', () => {
  const dir = setupTestDir();
  const reportPath = join(dir, 'report.md');
  writeFileSync(reportPath, `---
result: needs_fix
---
### design:ISSUE-001: over line
- **文件**: \`src/util.js\`
- **位置**: \`L999\`
`);
  try {
    const result = detectSynthetic(reportPath, { baseDir: dir, skipSymbolGrep: true });
    assert.equal(result.valid, false);
    assert.ok(result.violations.some(v => v.type === 'fabricated_line'));
    assert.ok(result.violations[0].message.includes('999'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('passes when all references are valid', () => {
  const dir = setupTestDir();
  const reportPath = join(dir, 'report.md');
  writeFileSync(reportPath, `---
result: needs_fix
---
### design:ISSUE-001: real ref
- **文件**: \`src/main.js\`
- **位置**: \`realFunc L2\`
`);
  try {
    const result = detectSynthetic(reportPath, { baseDir: dir });
    assert.equal(result.valid, true);
    assert.equal(result.violation_count, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('returns error for missing report', () => {
  const result = detectSynthetic('/tmp/nonexistent-report.md', { baseDir: '/tmp' });
  assert.equal(result.valid, false);
  assert.equal(result.code, 'E_FILE_MISSING');
});
