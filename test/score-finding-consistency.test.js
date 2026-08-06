const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');

const { check } = require('../scripts/score-finding-consistency.js');

function setupWorkDir(state, crFiles = {}) {
  const workDir = mkdtempSync(join(tmpdir(), 'optcode-sfc-'));
  writeFileSync(join(workDir, 'state.json'), JSON.stringify(state, null, 2) + '\n');
  mkdirSync(join(workDir, 'cr'), { recursive: true });
  for (const [name, content] of Object.entries(crFiles)) {
    writeFileSync(join(workDir, 'cr', name), content);
  }
  return workDir;
}

const baseState = {
  schema_version: 2, _seq: 1,
  created_at: '2024-01-01T00:00:00.000Z', updated_at: '2024-01-01T00:00:00.000Z',
  target_paths: ['/tmp/src'], base_commit: 'abc123', mode: 'light',
  dimensions: {
    'dead-code': { status: 'pass', round: 1, issues_found: 0, issues_fixed: 0, issue_history: [] },
    'design': { status: 'needs_fix', round: 1, issues_found: 2, issues_fixed: 0, issue_history: [] },
    'style': { status: 'skipped', round: 0, issues_found: 0, issues_fixed: 0, issue_history: [] },
  },
};

test('valid when findings match state', () => {
  const workDir = setupWorkDir(baseState, {
    'design-round-1.md': `---
result: needs_fix
issues_count: 2
---
### design:ISSUE-001: something bad
- **置信度**: 85
### design:ISSUE-002: another issue
- **置信度**: 90
`,
  });
  try {
    const result = check(workDir);
    assert.equal(result.valid, true);
    assert.equal(result.violation_count, 0);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('forward violation: state claims issues but no CR findings', () => {
  const workDir = setupWorkDir(baseState, {
    'design-round-1.md': `---
result: needs_fix
issues_count: 0
---
No issues in detail.
`,
  });
  try {
    const result = check(workDir);
    assert.equal(result.valid, false);
    const forward = result.violations.filter(v => v.direction === 'forward');
    assert.ok(forward.length > 0);
    assert.ok(forward[0].message.includes('design'));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('reverse violation: finding references unknown dimension', () => {
  const workDir = setupWorkDir(baseState, {
    'design-round-1.md': `---
result: needs_fix
issues_count: 2
---
### design:ISSUE-001: ok
- **置信度**: 85
### unknown-dim:ISSUE-002: orphan
- **置信度**: 90
`,
  });
  try {
    const result = check(workDir);
    assert.equal(result.valid, false);
    const reverse = result.violations.filter(v => v.direction === 'reverse');
    assert.ok(reverse.length > 0);
    assert.ok(reverse[0].message.includes('unknown-dim'));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('skipped dimensions are excluded from checks', () => {
  const state = { ...baseState, dimensions: { ...baseState.dimensions, design: { status: 'pass', round: 1, issues_found: 0, issues_fixed: 0, issue_history: [] } } };
  const workDir = setupWorkDir(state, {});
  try {
    const result = check(workDir);
    assert.equal(result.valid, true);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
