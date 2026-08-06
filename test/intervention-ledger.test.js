const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createDeps, getFile } = require('./helpers.js');
const {
  STATES, ALLOWED_TRANSITIONS,
  loadLedger, saveLedger,
  recordIntervention, transitionEntry,
  summarizeEffectiveness, validateTransition, ledgerFile,
} = require('../scripts/intervention-ledger.js');

function makeDeps() {
  const deps = createDeps();
  deps.pid = () => 12345;
  return deps;
}

describe('recordIntervention', () => {
  it('creates new entry with history', () => {
    const deps = makeDeps();
    const entry = recordIntervention('/project', {
      id: 'INT-001',
      dimension: 'design',
      state: 'pending',
      comparison: 'baseline',
    }, deps);
    assert.equal(entry.id, 'INT-001');
    assert.equal(entry.state, 'pending');
    assert.ok(entry.created_at);
    assert.ok(entry.history);
    assert.equal(entry.history.length, 1);
    assert.equal(entry.history[0].state, 'pending');

    const saved = JSON.parse(getFile(deps, ledgerFile('/project')));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, 'INT-001');
  });

  it('updates existing entry on valid transition', () => {
    const deps = makeDeps();
    recordIntervention('/project', {
      id: 'INT-002',
      dimension: 'style',
      state: 'pending',
    }, deps);
    const updated = recordIntervention('/project', {
      id: 'INT-002',
      dimension: 'style',
      state: 'improving',
    }, deps);
    const saved = JSON.parse(getFile(deps, ledgerFile('/project')));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].state, 'improving');
    assert.equal(saved[0].history.length, 2);
  });

  it('rejects invalid transition (pending to outcome-supported)', () => {
    const deps = makeDeps();
    recordIntervention('/project', {
      id: 'INT-003',
      dimension: 'design',
      state: 'pending',
    }, deps);
    assert.throws(() => {
      recordIntervention('/project', {
        id: 'INT-003',
        dimension: 'design',
        state: 'outcome-supported',
      }, deps);
    }, /not allowed/);
  });

  it('rejects missing fields', () => {
    const deps = makeDeps();
    assert.throws(() => {
      recordIntervention('/project', { id: 'X' }, deps);
    }, /must have id, dimension, and state/);
    assert.throws(() => {
      recordIntervention('/project', { dimension: 'design', state: 'pending' }, deps);
    }, /must have id, dimension, and state/);
  });
});

describe('validateTransition', () => {
  it('returns valid for allowed transitions', () => {
    assert.deepEqual(validateTransition('pending', 'improving'), { valid: true });
    assert.deepEqual(validateTransition('pending', 'unchanged'), { valid: true });
    assert.deepEqual(validateTransition('improving', 'outcome-supported'), { valid: true });
  });

  it('returns invalid for disallowed transitions', () => {
    const result = validateTransition('pending', 'outcome-supported');
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('not allowed'));
  });

  it('outcome-supported is terminal (no transitions allowed out)', () => {
    for (const state of STATES) {
      const result = validateTransition('outcome-supported', state);
      assert.equal(result.valid, false, `should not allow outcome-supported -> ${state}`);
    }
  });
});

describe('transitionEntry', () => {
  it('throws for unknown id', () => {
    const deps = makeDeps();
    assert.throws(() => {
      transitionEntry('/project', 'UNKNOWN', 'improving', deps);
    }, /intervention not found/);
  });
});

describe('summarizeEffectiveness', () => {
  it('aggregates correctly', () => {
    const deps = makeDeps();
    recordIntervention('/project', { id: 'A', dimension: 'design', state: 'pending' }, deps);
    recordIntervention('/project', { id: 'B', dimension: 'design', state: 'pending' }, deps);
    recordIntervention('/project', { id: 'C', dimension: 'style', state: 'pending' }, deps);
    // Transition some
    recordIntervention('/project', { id: 'A', dimension: 'design', state: 'improving' }, deps);
    recordIntervention('/project', { id: 'C', dimension: 'style', state: 'regressing' }, deps);

    const summary = summarizeEffectiveness('/project', deps);
    assert.equal(summary.total, 3);
    assert.equal(summary.by_state.improving, 1);
    assert.equal(summary.by_state.pending, 1);
    assert.equal(summary.by_state.regressing, 1);
    assert.equal(summary.by_dimension.design.total, 2);
    assert.equal(summary.by_dimension.design.improving, 1);
    assert.equal(summary.by_dimension.style.regressing, 1);
    assert.ok(summary.improvement_rate > 0);
    assert.ok(summary.regression_rate > 0);
  });
});

describe('privacy field', () => {
  it('is populated on new entries', () => {
    const deps = makeDeps();
    const entry = recordIntervention('/project', {
      id: 'PRIV-1',
      dimension: 'security',
      state: 'pending',
    }, deps);
    // privacy-scan module may or may not be loadable, but field should exist
    assert.ok('privacy' in entry);
    assert.ok(entry.privacy === 'clean' || entry.privacy === 'scan-unavailable' || Array.isArray(entry.privacy));
  });
});
