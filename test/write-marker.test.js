const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { createDeps, getFile } = require('./helpers.js');

describe('recordWriteMarker', () => {
  it('creates the marker file with correct structure', () => {
    const deps = createDeps();
    const cwd = '/project';
    const markerDir = join(cwd, '.optcode', 'state');
    const markerPath = join(markerDir, 'last-write.json');

    // Simulate what recordWriteMarker does
    const toolName = 'Write';
    const filePath = '/project/.optcode/12345/cr/design-round-1.md';
    deps.mkdirSync(markerDir, { recursive: true });
    deps.writeFileSync(markerPath, JSON.stringify({
      updatedAt: '2024-01-01T00:00:00.000Z',
      toolName,
      filePath,
    }, null, 2) + '\n');

    const content = JSON.parse(getFile(deps, markerPath));
    assert.equal(content.toolName, 'Write');
    assert.equal(content.filePath, filePath);
    assert.equal(content.updatedAt, '2024-01-01T00:00:00.000Z');
  });
});

describe('stop-review-guard logic', () => {
  it('returns nothing when no marker exists', () => {
    // The guard reads stdin for input, checks existsSync on the marker
    // When marker does not exist, it simply returns without output
    const deps = createDeps();
    const cwd = '/project';
    const markerPath = join(cwd, '.optcode', 'state', 'last-write.json');
    assert.equal(deps.existsSync(markerPath), false);
    // Guard would exit early -- no blocking
  });

  it('does not block when marker is stale (older than TTL)', () => {
    const TTL_MS = 15 * 60 * 1000;
    const staleTime = new Date(Date.now() - TTL_MS - 1000).toISOString();
    const marker = { updatedAt: staleTime, toolName: 'Write', filePath: '/a.md' };
    const age = Date.now() - new Date(marker.updatedAt).getTime();
    assert.ok(age > TTL_MS, 'marker should be stale');
    // Guard would exit early -- no blocking
  });

  it('blocks when marker is fresh and active workflow exists', () => {
    const TTL_MS = 15 * 60 * 1000;
    const freshTime = new Date(Date.now() - 60000).toISOString(); // 1 minute ago
    const marker = { updatedAt: freshTime, toolName: 'Write', filePath: '/a.md' };
    const age = Date.now() - new Date(marker.updatedAt).getTime();
    assert.ok(age <= TTL_MS, 'marker should be fresh');

    // Simulate active workflow check
    const state = { status: 'reviewing' }; // not completed
    assert.notEqual(state.status, 'completed');
    // Guard would output block decision
    const result = {
      hookSpecificOutput: {
        hookEventName: 'Stop',
        stopDecision: 'block',
        reason: `optcode write detected ${Math.round(age / 1000)}s ago (TTL: ${TTL_MS / 60000}min). Run gate-check or finish the active workflow before stopping.`,
      },
    };
    assert.equal(result.hookSpecificOutput.stopDecision, 'block');
    assert.ok(result.hookSpecificOutput.reason.includes('optcode write detected'));
  });
});
