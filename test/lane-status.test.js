const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { availableLane, unavailableLane, laneIsAvailable, compositeStatus } = require('../scripts/workflow-lib.js');

describe('availableLane', () => {
  it('returns correct structure with default status', () => {
    const result = availableLane({ foo: 'bar' });
    assert.deepEqual(result, { status: 'available', data: { foo: 'bar' } });
  });

  it('accepts a custom status', () => {
    const result = availableLane({ x: 1 }, 'partial');
    assert.deepEqual(result, { status: 'partial', data: { x: 1 } });
  });
});

describe('unavailableLane', () => {
  it('with Error object extracts message', () => {
    const result = unavailableLane('agent-cr', new Error('timeout'));
    assert.equal(result.status, 'unavailable');
    assert.equal(result.owner, 'agent-cr');
    assert.equal(result.error, 'timeout');
  });

  it('with string uses it directly', () => {
    const result = unavailableLane('agent-fixer', 'disk full');
    assert.equal(result.status, 'unavailable');
    assert.equal(result.owner, 'agent-fixer');
    assert.equal(result.error, 'disk full');
  });
});

describe('laneIsAvailable', () => {
  it('returns true for available status', () => {
    assert.equal(laneIsAvailable({ status: 'available' }), true);
  });

  it('returns true for partial status', () => {
    assert.equal(laneIsAvailable({ status: 'partial' }), true);
  });

  it('returns false for unavailable status', () => {
    assert.equal(laneIsAvailable({ status: 'unavailable' }), false);
  });

  it('returns false for null', () => {
    assert.ok(!laneIsAvailable(null));
  });
});

describe('compositeStatus', () => {
  it('with all available returns complete', () => {
    const lanes = [{ status: 'available' }, { status: 'available' }];
    assert.equal(compositeStatus(lanes), 'complete');
  });

  it('with mix returns partial in light mode', () => {
    const lanes = [{ status: 'available' }, { status: 'unavailable' }];
    assert.equal(compositeStatus(lanes, 'light'), 'partial');
  });

  it('with unavailable in deep mode returns failed', () => {
    const lanes = [{ status: 'available' }, { status: 'unavailable' }];
    assert.equal(compositeStatus(lanes, 'deep'), 'failed');
  });

  it('with empty array returns failed', () => {
    assert.equal(compositeStatus([]), 'failed');
  });
});
