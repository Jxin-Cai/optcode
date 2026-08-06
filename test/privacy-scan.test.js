const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PRIVACY_PATTERNS, scanText, redact, shannonEntropy, findHighEntropyStrings } = require('../scripts/privacy-scan.js');

describe('privacy-scan', () => {
  describe('PRIVACY_PATTERNS coverage', () => {
    it('detects macOS absolute paths', () => {
      const results = scanText('/Users/johndoe/project/secret.txt');
      assert.ok(results.some(r => r.label === 'absolute macOS path'));
    });

    it('detects Linux absolute paths', () => {
      const results = scanText('/home/johndoe/.ssh/id_rsa');
      assert.ok(results.some(r => r.label === 'absolute Linux path'));
    });

    it('detects Windows absolute paths', () => {
      const results = scanText('C:\\Users\\johndoe\\Documents\\keys.txt');
      assert.ok(results.some(r => r.label === 'absolute Windows path'));
    });

    it('detects session IDs', () => {
      const results = scanText('session_id=a1b2c3d4-e5f6-7890-abcd-ef1234567890');
      assert.ok(results.some(r => r.label === 'session ID'));
    });

    it('detects OpenAI/Anthropic secret keys', () => {
      const results = scanText('sk-abc123def456ghi789jkl012mno345pqr678');
      assert.ok(results.some(r => r.label === 'OpenAI/Anthropic secret key'));
    });

    it('detects AWS access keys', () => {
      const results = scanText('AKIAIOSFODNN7EXAMPLE1');
      assert.ok(results.some(r => r.label === 'AWS access key'));
    });

    it('detects Stripe keys', () => {
      const results = scanText('sk_live_abc123def456ghi789');
      assert.ok(results.some(r => r.label === 'Stripe key'));
    });

    it('detects GitLab PATs', () => {
      const results = scanText('glpat-abcdefghij1234567890klm');
      assert.ok(results.some(r => r.label === 'GitLab PAT'));
    });

    it('detects Slack tokens', () => {
      const results = scanText('xoxb-123456789012-1234567890123-AbCdEfGhIj');
      assert.ok(results.some(r => r.label === 'Slack token'));
    });

    it('detects GitHub PATs (ghp_)', () => {
      const results = scanText('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij');
      assert.ok(results.some(r => r.label === 'GitHub PAT'));
    });

    it('detects GitHub app tokens (ghs_)', () => {
      const results = scanText('ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij');
      assert.ok(results.some(r => r.label === 'GitHub app token'));
    });

    it('detects Bearer tokens', () => {
      const results = scanText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test');
      assert.ok(results.some(r => r.label === 'bearer token'));
    });

    it('detects embedded passwords', () => {
      const results = scanText("password = 'super_secret_123'");
      assert.ok(results.some(r => r.label === 'embedded password'));
    });

    it('detects API key literals', () => {
      const results = scanText('api_key = "abcdef123456789"');
      assert.ok(results.some(r => r.label === 'API key literal'));
    });

    it('detects .env variable references', () => {
      const results = scanText('\nDATABASE_URL=postgres://user:pass@host/db');
      assert.ok(results.some(r => r.label === '.env variable'));
    });
  });

  describe('shannonEntropy', () => {
    it('returns 0 for empty string', () => {
      assert.equal(shannonEntropy(''), 0);
    });

    it('returns 0 for single-char string', () => {
      assert.equal(shannonEntropy('aaaa'), 0);
    });

    it('returns 1.0 for two equally-distributed chars', () => {
      const e = shannonEntropy('ab');
      assert.ok(Math.abs(e - 1.0) < 0.01);
    });

    it('returns high entropy for random-looking base64', () => {
      const secret = 'aB3kL9mN2pQ7rT5wX1yZ4cF6hJ8oU0vG';
      const e = shannonEntropy(secret);
      assert.ok(e > 4.0, `expected >4.0 but got ${e}`);
    });
  });

  describe('findHighEntropyStrings', () => {
    it('catches base64 encoded secrets', () => {
      const text = 'token = aB3kL9mN2pQ7rT5wX1yZ4cF6hJ8oU0vGxEi';
      const results = findHighEntropyStrings(text);
      assert.ok(results.length > 0);
      assert.ok(results[0].entropy > 4.5);
    });

    it('ignores short tokens', () => {
      const results = findHighEntropyStrings('short');
      assert.equal(results.length, 0);
    });

    it('ignores low-entropy repeated strings', () => {
      const results = findHighEntropyStrings('aaaaaaaaaaaaaaaaaaaaaaaaaa');
      assert.equal(results.length, 0);
    });
  });

  describe('scanText', () => {
    it('returns empty array for clean text', () => {
      const results = scanText('This is a normal code comment with no secrets.');
      assert.equal(results.length, 0);
    });

    it('returns findings with label, match, and index', () => {
      const results = scanText('path is /Users/admin/code');
      assert.ok(results.length > 0);
      const finding = results[0];
      assert.ok('label' in finding);
      assert.ok('match' in finding);
      assert.ok('index' in finding);
    });

    it('handles null/empty input', () => {
      assert.deepEqual(scanText(null), []);
      assert.deepEqual(scanText(''), []);
    });
  });

  describe('redact', () => {
    it('replaces secrets with REDACTED labels', () => {
      const text = 'My key is sk-abc123def456ghi789jkl012mno345pqr678 ok?';
      const result = redact(text);
      assert.ok(!result.includes('sk-abc123'));
      assert.ok(result.includes('[REDACTED:'));
    });

    it('replaces multiple types of secrets', () => {
      const text = '/Users/admin/code and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
      const result = redact(text);
      assert.ok(!result.includes('/Users/admin'));
      assert.ok(!result.includes('ghp_'));
    });

    it('leaves clean text unchanged', () => {
      const text = 'Just a normal sentence.';
      assert.equal(redact(text), text);
    });

    it('handles null input', () => {
      assert.equal(redact(null), null);
    });
  });
});
