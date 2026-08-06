#!/usr/bin/env node
/**
 * optcode privacy scan — detects secrets, PII, and sensitive paths in text.
 *
 * Exports:
 *   PRIVACY_PATTERNS — array of { pattern, label } regex rules
 *   scanText(text) — returns [{label, match, index}]
 *   redact(text) — returns sanitized string
 *   shannonEntropy(str) — returns bits-per-char entropy
 *   findHighEntropyStrings(text) — returns [{value, entropy, index}]
 *
 * CLI:
 *   node privacy-scan.js scan <text>
 *   node privacy-scan.js redact <file>
 */
const { readFileSync } = require('node:fs');

const PRIVACY_PATTERNS = [
  // Filesystem paths
  { pattern: /\/Users\/[^\s/]+/g, label: 'absolute macOS path' },
  { pattern: /\/home\/[^\s/]+/g, label: 'absolute Linux path' },
  { pattern: /C:\\Users\\[^\s\\]+/g, label: 'absolute Windows path' },
  // Session IDs
  { pattern: /session[_-]?id\s*[:=]\s*["']?[a-f0-9-]{8,}/gi, label: 'session ID' },
  // OpenAI / Anthropic keys
  { pattern: /sk-[a-zA-Z0-9]{20,}/g, label: 'OpenAI/Anthropic secret key' },
  // AWS access keys
  { pattern: /AKIA[A-Z0-9]{16,}/g, label: 'AWS access key' },
  // Stripe keys
  { pattern: /(?:sk|pk|rk)_(?:live|test)_[a-zA-Z0-9]{10,}/g, label: 'Stripe key' },
  // GitLab PATs
  { pattern: /glpat-[a-zA-Z0-9_-]{20,}/g, label: 'GitLab PAT' },
  // Slack tokens
  { pattern: /xox[bpras]-[a-zA-Z0-9-]{10,}/g, label: 'Slack token' },
  // GitHub PATs and app tokens
  { pattern: /ghp_[a-zA-Z0-9]{36,}/g, label: 'GitHub PAT' },
  { pattern: /ghs_[a-zA-Z0-9]{36,}/g, label: 'GitHub app token' },
  // Bearer tokens
  { pattern: /Bearer\s+[a-zA-Z0-9._-]{20,}/gi, label: 'bearer token' },
  // Embedded passwords
  { pattern: /password\s*[:=]\s*["'][^"']{4,}["']/gi, label: 'embedded password' },
  // API key literals
  { pattern: /api[_-]?key\s*[:=]\s*["'][^"']{8,}["']/gi, label: 'API key literal' },
  // .env file references with values
  { pattern: /(?:^|\n)[A-Z_]{2,}=\S{8,}/gm, label: '.env variable' },
];

/**
 * Compute Shannon entropy (bits per character) for a string.
 */
function shannonEntropy(str) {
  if (!str || str.length === 0) return 0;
  const freq = {};
  for (const ch of str) {
    freq[ch] = (freq[ch] || 0) + 1;
  }
  const len = str.length;
  let entropy = 0;
  for (const count of Object.values(freq)) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Find high-entropy strings (potential secrets) in text.
 * Threshold: entropy > 4.5 and length >= 20.
 */
function findHighEntropyStrings(text, threshold = 4.5, minLength = 20) {
  const results = [];
  // Match contiguous non-whitespace tokens that look like secrets
  const tokenRe = /[A-Za-z0-9+/=_-]{20,}/g;
  let match;
  while ((match = tokenRe.exec(text)) !== null) {
    const value = match[0];
    if (value.length < minLength) continue;
    const entropy = shannonEntropy(value);
    if (entropy > threshold) {
      results.push({ value, entropy, index: match.index });
    }
  }
  return results;
}

/**
 * Scan text for privacy/secret violations.
 * Returns array of {label, match, index}.
 */
function scanText(text) {
  if (!text) return [];
  const findings = [];

  // Regex-based patterns
  for (const { pattern, label } of PRIVACY_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = re.exec(text)) !== null) {
      findings.push({ label, match: match[0], index: match.index });
    }
  }

  // High-entropy strings
  const highEntropy = findHighEntropyStrings(text);
  for (const { value, entropy, index } of highEntropy) {
    findings.push({ label: 'high-entropy string', match: value, index });
  }

  return findings;
}

/**
 * Redact all detected secrets from text.
 */
function redact(text) {
  if (!text) return text;
  let result = text;

  // Redact pattern matches
  for (const { pattern, label } of PRIVACY_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    result = result.replace(re, `[REDACTED:${label}]`);
  }

  // Redact high-entropy strings
  const highEntropy = findHighEntropyStrings(result);
  for (const { value } of highEntropy) {
    result = result.replace(value, '[REDACTED:high-entropy]');
  }

  return result;
}

function main() {
  const command = process.argv[2];
  const arg = process.argv[3];

  if (!command || !arg) {
    process.stderr.write('Usage:\n  node privacy-scan.js scan <text>\n  node privacy-scan.js redact <file>\n');
    process.exit(1);
  }

  if (command === 'scan') {
    const results = scanText(arg);
    if (results.length === 0) {
      console.log('No privacy violations found.');
    } else {
      console.log(JSON.stringify(results, null, 2));
    }
  } else if (command === 'redact') {
    const content = readFileSync(arg, 'utf8');
    console.log(redact(content));
  } else {
    process.stderr.write(`Unknown command: ${command}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { PRIVACY_PATTERNS, scanText, redact, shannonEntropy, findHighEntropyStrings };
