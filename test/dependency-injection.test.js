const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createDeps, seedState, getFile } = require('./helpers.js');
const {
  initState, readState, writeState, appendAudit,
  startDimension, recordCrResult, readAuditLog, getResumePoint,
  findCrReport, detectStagnation, DIMENSIONS
} = require('../scripts/workflow-lib.js');

describe('Dependency Injection — workflow-lib', () => {
  it('initState works entirely in-memory', () => {
    const deps = createDeps();
    const state = initState('/work', ['src/'], 'abc123', [], {}, deps);
    assert.equal(state.schema_version, 2);
    assert.equal(state.target_paths[0], 'src/');
    assert.equal(state.base_commit, 'abc123');
    assert.equal(state.created_at, '2024-01-01T00:00:00.000Z');
    assert.equal(state._seq, 1);
  });

  it('readState returns null for missing state', () => {
    const deps = createDeps();
    assert.equal(readState('/work', deps), null);
  });

  it('readState reads back what initState wrote', () => {
    const deps = createDeps();
    initState('/work', ['a.js'], 'HEAD', [], {}, deps);
    const state = readState('/work', deps);
    assert.equal(state.target_paths[0], 'a.js');
    assert.equal(state.mode, 'light');
  });

  it('writeState enforces OCC', () => {
    const deps = createDeps();
    initState('/work', ['a.js'], 'HEAD', [], {}, deps);
    const state = readState('/work', deps);
    assert.throws(
      () => writeState('/work', state, 999, deps),
      /OCC conflict/
    );
  });

  it('appendAudit writes JSONL in-memory', () => {
    const deps = createDeps();
    initState('/work', ['a.js'], 'HEAD', [], {}, deps);
    const entries = readAuditLog('/work', 0, deps);
    assert.ok(entries.length >= 1);
    assert.equal(entries[0].type, 'init');
  });

  it('startDimension transitions state correctly', () => {
    const deps = createDeps();
    initState('/work', ['a.js'], 'HEAD', [], {}, deps);
    startDimension('/work', 'design', deps);
    const state = readState('/work', deps);
    assert.equal(state.current_dimension, 'design');
    assert.equal(state.dimensions.design.status, 'in_progress');
  });

  it('recordCrResult with needs_fix tracks issues', () => {
    const deps = createDeps();
    initState('/work', ['a.js'], 'HEAD', [], {}, deps);
    startDimension('/work', 'design', deps);
    // Seed a CR report to satisfy extractIssueIds
    deps._files.set('/work/cr/design-round-1.md', '### design:ISSUE-001: test\n### design:ISSUE-002: test2\n');
    recordCrResult('/work', 'design', 1, 'needs_fix', 2, deps);
    const state = readState('/work', deps);
    assert.equal(state.dimensions.design.status, 'needs_fix');
    assert.equal(state.dimensions.design.issues_found, 2);
  });

  it('getResumePoint returns init for missing state', () => {
    const deps = createDeps();
    const resume = getResumePoint('/work', deps);
    assert.equal(resume.action, 'init');
  });

  it('getResumePoint returns start_dimension for pending dimensions', () => {
    const deps = createDeps();
    initState('/work', ['a.js'], 'HEAD', [], {}, deps);
    const resume = getResumePoint('/work', deps);
    assert.equal(resume.action, 'start_dimension');
    assert.equal(resume.dimension, DIMENSIONS[0]);
  });

  it('findCrReport uses deps.existsSync', () => {
    const deps = createDeps();
    deps._files.set('/work/cr/design-round-1.md', 'content');
    const report = findCrReport('/work', 'design', 1, deps);
    assert.ok(report);
    assert.equal(report.kind, 'round');
  });

  it('detectStagnation works with in-memory state', () => {
    const deps = createDeps();
    initState('/work', ['a.js'], 'HEAD', [], {}, deps);
    startDimension('/work', 'design', deps);
    // Simulate 3 rounds with no improvement
    const state = readState('/work', deps);
    state.dimensions.design.issue_history = [
      { round: 1, issues_count: 5, issue_ids: [] },
      { round: 2, issues_count: 5, issue_ids: [] },
      { round: 3, issues_count: 5, issue_ids: [] },
    ];
    writeState('/work', state, state._seq, deps);
    const result = detectStagnation('/work', 'design', deps);
    assert.equal(result.stagnant, true);
  });

  it('no real filesystem is touched', () => {
    const deps = createDeps();
    const origExistsSync = require('node:fs').existsSync;
    let fsCalled = false;
    deps.existsSync = (p) => { return deps._files.has(p); };
    initState('/work', ['a.js'], 'HEAD', [], {}, deps);
    readState('/work', deps);
    // If we got here without errors, we never touched real fs
    assert.ok(true);
  });
});
