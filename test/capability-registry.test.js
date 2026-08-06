const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ACTIVATION_CAPABILITIES, DIMENSION_DESCRIPTORS, dimensionsFor, shouldActivate } = require('../scripts/workflow-lib.js');

describe('capability registry', () => {
  describe('dimensionsFor', () => {
    it('returns 6 entries for "always" capability', () => {
      const always = dimensionsFor('always');
      assert.equal(always.length, 6);
      const ids = always.map(d => d.id);
      assert.ok(ids.includes('dead-code'));
      assert.ok(ids.includes('duplication'));
      assert.ok(ids.includes('design'));
      assert.ok(ids.includes('style'));
      assert.ok(ids.includes('maintainability'));
      assert.ok(ids.includes('ai-sdd-smells'));
    });

    it('returns 1 entry with id "security" for "security" capability', () => {
      const security = dimensionsFor('security');
      assert.equal(security.length, 1);
      assert.equal(security[0].id, 'security');
    });

    it('returns 1 entry for "concurrency" capability', () => {
      const concurrency = dimensionsFor('concurrency');
      assert.equal(concurrency.length, 1);
      assert.equal(concurrency[0].id, 'concurrency');
    });

    it('returns 1 entry for "legacy" capability', () => {
      const legacy = dimensionsFor('legacy');
      assert.equal(legacy.length, 1);
      assert.equal(legacy[0].id, 'legacy-safety');
    });

    it('returns empty array for unknown capability', () => {
      const unknown = dimensionsFor('nonexistent');
      assert.equal(unknown.length, 0);
    });
  });

  describe('shouldActivate', () => {
    it('returns activated:false for security on plain code', () => {
      const result = shouldActivate('security', 'plain code with no security keywords');
      assert.equal(result.activated, false);
      assert.ok(result.reason.includes('no activation keywords'));
    });

    it('returns activated:true for security when password keyword present', () => {
      const result = shouldActivate('security', 'const password = getSecret()');
      assert.equal(result.activated, true);
      assert.ok(result.reason.includes('keywords found'));
      assert.ok(result.reason.includes('password'));
    });

    it('returns activated:true with reason "always active" for design dimension', () => {
      const result = shouldActivate('design', 'anything at all');
      assert.equal(result.activated, true);
      assert.equal(result.reason, 'always active');
    });

    it('returns activated:true for unknown dimension (default active)', () => {
      const result = shouldActivate('nonexistent-dim', 'some code');
      assert.equal(result.activated, true);
      assert.ok(result.reason.includes('unknown dimension'));
    });

    it('returns activated:false for concurrency on plain code', () => {
      const result = shouldActivate('concurrency', 'const x = 1 + 2;');
      assert.equal(result.activated, false);
    });

    it('returns activated:true for concurrency when async keyword present', () => {
      const result = shouldActivate('concurrency', 'async function fetchData() {}');
      assert.equal(result.activated, true);
      assert.ok(result.reason.includes('async'));
    });

    it('returns activated:false for legacy-safety on normal code', () => {
      const result = shouldActivate('legacy-safety', 'function add(a, b) { return a + b; }');
      assert.equal(result.activated, false);
    });

    it('returns activated:true for legacy-safety when deprecated keyword present', () => {
      const result = shouldActivate('legacy-safety', '/** @deprecated use newApi instead */');
      assert.equal(result.activated, true);
    });
  });

  describe('ACTIVATION_CAPABILITIES constants', () => {
    it('has expected capability keys', () => {
      assert.equal(ACTIVATION_CAPABILITIES.ALWAYS, 'always');
      assert.equal(ACTIVATION_CAPABILITIES.CONCURRENCY, 'concurrency');
      assert.equal(ACTIVATION_CAPABILITIES.LEGACY, 'legacy');
      assert.equal(ACTIVATION_CAPABILITIES.SECURITY, 'security');
    });
  });

  describe('DIMENSION_DESCRIPTORS', () => {
    it('contains 9 dimensions', () => {
      assert.equal(DIMENSION_DESCRIPTORS.length, 9);
    });

    it('each descriptor has id, displayName, capabilities, keywords', () => {
      for (const d of DIMENSION_DESCRIPTORS) {
        assert.ok(d.id, `missing id`);
        assert.ok(d.displayName, `missing displayName for ${d.id}`);
        assert.ok(Array.isArray(d.capabilities), `capabilities not array for ${d.id}`);
        assert.ok(Array.isArray(d.keywords), `keywords not array for ${d.id}`);
      }
    });
  });
});
