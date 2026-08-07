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

// --- Deep Privacy Governance Enhancements ---

const PRIVATE_FIELD_PATTERNS = [
  /^session[_-]?id$/i,
  /^absolute[_-]?path$/i,
  /^user[_-]?home$/i,
  /^private[_-]?key$/i,
  /^secret$/i,
  /^token$/i,
  /^credential/i,
  /^password$/i,
  /^api[_-]?key$/i,
];

const PATH_TRAVERSAL_PATTERNS = [
  { pattern: /\.\.[/\\]/g, label: 'path traversal (../)' },
  { pattern: /(?:^|[\s"'`])\/(?!\/)(?:[^/\s"'`]+\/){2,}/g, label: 'embedded absolute POSIX path' },
  { pattern: /[A-Za-z]:[\\/](?:[^\\/\s"'`]+[\\/])+/g, label: 'embedded Windows drive path' },
  { pattern: /\\\\[^\\]+\\/g, label: 'UNC path' },
];

const RAW_CONTENT_FIELD_RE = /(?:^|_)(?:raw_?)?(?:prompt|command|content|transcript|user_?text|assistant_?text)$/i;

function scanObjectDeep(obj, path = '', maxDepth = 10) {
  if (maxDepth <= 0) return [];
  if (!obj || typeof obj !== 'object') {
    if (typeof obj === 'string' && obj.length > 0) {
      return scanText(obj).map(v => ({ ...v, path }));
    }
    return [];
  }
  const findings = [];
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      findings.push(...scanObjectDeep(obj[i], `${path}[${i}]`, maxDepth - 1));
    }
  } else {
    for (const [key, value] of Object.entries(obj)) {
      const fieldPath = path ? `${path}.${key}` : key;
      findings.push(...scanObjectDeep(value, fieldPath, maxDepth - 1));
    }
  }
  return findings;
}

function detectPrivateFields(obj, path = '') {
  if (!obj || typeof obj !== 'object') return [];
  const findings = [];
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      findings.push(...detectPrivateFields(obj[i], `${path}[${i}]`));
    }
  } else {
    for (const [key, value] of Object.entries(obj)) {
      const fieldPath = path ? `${path}.${key}` : key;
      for (const pattern of PRIVATE_FIELD_PATTERNS) {
        if (pattern.test(key)) {
          findings.push({ path: fieldPath, field: key, reason: 'private identifier field name' });
          break;
        }
      }
      if (value && typeof value === 'object') {
        findings.push(...detectPrivateFields(value, fieldPath));
      }
    }
  }
  return findings;
}

function detectPathTraversal(text) {
  if (!text) return [];
  const findings = [];
  for (const { pattern, label } of PATH_TRAVERSAL_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = re.exec(text)) !== null) {
      findings.push({ pattern: label, match: match[0], index: match.index, risk: 'path traversal allows escaping sandbox' });
    }
  }
  return findings;
}

function detectRawContentFields(obj, path = '') {
  if (!obj || typeof obj !== 'object') return [];
  const findings = [];
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      findings.push(...detectRawContentFields(obj[i], `${path}[${i}]`));
    }
  } else {
    for (const [key, value] of Object.entries(obj)) {
      const fieldPath = path ? `${path}.${key}` : key;
      if (RAW_CONTENT_FIELD_RE.test(key) && typeof value === 'string' && value.trim().length > 0) {
        findings.push({ path: fieldPath, field: key, reason: 'raw transcript/prompt content must not appear in outputs' });
      }
      if (value && typeof value === 'object') {
        findings.push(...detectRawContentFields(value, fieldPath));
      }
    }
  }
  return findings;
}

function scanDeep(input, options = {}) {
  const { maxDepth = 10, includePathTraversal = true, includeFieldNames = true, includeRawContent = true } = options;
  const violations = [];

  if (typeof input === 'string') {
    violations.push(...scanText(input).map(v => ({ ...v, type: 'privacy' })));
    if (includePathTraversal) {
      violations.push(...detectPathTraversal(input).map(v => ({ ...v, type: 'path_traversal' })));
    }
  } else if (typeof input === 'object' && input !== null) {
    violations.push(...scanObjectDeep(input, '', maxDepth).map(v => ({ ...v, type: 'privacy' })));
    if (includeFieldNames) {
      violations.push(...detectPrivateFields(input).map(v => ({ ...v, type: 'private_field' })));
    }
    if (includeRawContent) {
      violations.push(...detectRawContentFields(input).map(v => ({ ...v, type: 'raw_content' })));
    }
    if (includePathTraversal) {
      const jsonStr = JSON.stringify(input);
      violations.push(...detectPathTraversal(jsonStr).map(v => ({ ...v, type: 'path_traversal' })));
    }
  }

  const byType = {};
  for (const v of violations) {
    byType[v.type] = (byType[v.type] || 0) + 1;
  }

  return {
    violations,
    summary: { total: violations.length, by_type: byType },
    clean: violations.length === 0,
  };
}

function main() {
  const command = process.argv[2];
  const arg = process.argv[3];

  if (!command) {
    process.stderr.write('Usage:\n  node privacy-scan.js scan <text>\n  node privacy-scan.js redact <file>\n  node privacy-scan.js deep <file-or-json>\n  node privacy-scan.js validate-ledger <path>\n');
    process.exit(1);
  }

  if (command === 'scan') {
    if (!arg) { process.stderr.write('missing text argument\n'); process.exit(1); }
    const results = scanText(arg);
    if (results.length === 0) {
      console.log('No privacy violations found.');
    } else {
      console.log(JSON.stringify(results, null, 2));
    }
  } else if (command === 'redact') {
    if (!arg) { process.stderr.write('missing file argument\n'); process.exit(1); }
    const content = readFileSync(arg, 'utf8');
    console.log(redact(content));
  } else if (command === 'deep') {
    if (!arg) { process.stderr.write('missing file argument\n'); process.exit(1); }
    const content = readFileSync(arg, 'utf8');
    let input;
    try { input = JSON.parse(content); } catch { input = content; }
    const result = scanDeep(input);
    console.log(JSON.stringify(result, null, 2));
    if (!result.clean) process.exit(1);
  } else if (command === 'validate-ledger') {
    if (!arg) { process.stderr.write('missing path argument\n'); process.exit(1); }
    const content = readFileSync(arg, 'utf8');
    let ledger;
    try { ledger = JSON.parse(content); } catch { process.stderr.write('invalid JSON\n'); process.exit(1); }
    const result = scanDeep(ledger, { includePathTraversal: true, includeFieldNames: true, includeRawContent: true });
    console.log(JSON.stringify(result, null, 2));
    if (!result.clean) process.exit(1);
  } else {
    process.stderr.write(`Unknown command: ${command}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  PRIVACY_PATTERNS, scanText, redact, shannonEntropy, findHighEntropyStrings,
  PRIVATE_FIELD_PATTERNS, PATH_TRAVERSAL_PATTERNS, RAW_CONTENT_FIELD_RE,
  scanObjectDeep, detectPrivateFields, detectPathTraversal, detectRawContentFields, scanDeep,
};
