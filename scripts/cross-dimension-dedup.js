#!/usr/bin/env node
/**
 * Cross-dimension finding deduplication with stable fingerprinting
 * and cross-run dedup registry.
 *
 * Merge rule: same target file + same observed consequence + same owner + same repair route.
 * Preserves independent consequences even if they share a theme.
 *
 * Usage:
 *   node cross-dimension-dedup.js <work-dir>                    — deduplicate within current run
 *   node cross-dimension-dedup.js <work-dir> --with-registry    — also check cross-run registry
 *   node cross-dimension-dedup.js registry sync <work-dir>      — update registry from current run
 *   node cross-dimension-dedup.js registry status               — show registry stats
 *   node cross-dimension-dedup.js registry suppress <fingerprint> — suppress a finding
 *
 * Input: reads all CR reports in <work-dir>/cr/
 * Output: JSON with original findings, merged groups, and deduplicated result.
 */
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { readFrontmatter } = require('./workflow-lib.js');

// ---------------------------------------------------------------------------
// Finding extraction (unchanged logic)
// ---------------------------------------------------------------------------

function extractFindings(crDir) {
  if (!existsSync(crDir)) return [];
  const files = readdirSync(crDir).filter(f => f.endsWith('.md'));
  const findings = [];

  for (const file of files) {
    const text = readFileSync(join(crDir, file), 'utf8');
    const fm = readFrontmatter(text);
    if (fm.result !== 'needs_fix') continue;

    const dimMatch = file.match(/^([a-z][\w-]*)-(?:round-\d+|pass|failed)\.md$/);
    const dimension = dimMatch ? dimMatch[1] : fm.dimension || 'unknown';

    const issueMatches = [...text.matchAll(/^###\s+(?:([A-Za-z][\w-]*):)?(ISSUE-\d+):\s*(.+)$/gm)];
    for (const match of issueMatches) {
      const start = match.index;
      const nextIssue = text.indexOf('\n### ', start + 1);
      const block = text.slice(start, nextIssue > 0 ? nextIssue : text.length);

      const filePath = parseField(block, '文件');
      const location = parseField(block, '位置');
      const fixProposal = parseField(block, '修复方案');
      const description = parseField(block, '问题描述');
      const severity = parseField(block, '严重程度');

      findings.push({
        id: `${match[1] || dimension}:${match[2]}`,
        dimension,
        title: match[3],
        file: filePath,
        location,
        description,
        fixProposal,
        severity,
        sourceReport: file,
      });
    }
  }
  return findings;
}

function parseField(block, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`- \\*\\*${escaped}\\*\\*:\\s*([^\\n]+)`));
  return match ? match[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Stable fingerprinting
// ---------------------------------------------------------------------------

/**
 * Normalize text for fingerprinting: strip whitespace variations, lowercase,
 * remove line numbers (they shift between runs), remove backticks.
 */
function normalizeForFingerprint(text) {
  if (!text) return '';
  return text
    .replace(/`/g, '')
    .replace(/\b(?:line|L|行)\s*\d+(?:\s*[-–~]\s*\d+)?/gi, '') // remove line refs
    .replace(/:\d+(?::\d+)?/g, '') // remove :123 or :123:45 patterns
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Compute a stable SHA-256 fingerprint for a finding.
 * Survives minor rewording by AI across runs because it normalizes
 * text before hashing.
 */
function computeFingerprint(finding) {
  const file = normalizeForFingerprint(finding.file || '');
  const desc = normalizeForFingerprint(finding.description || finding.title || '');
  const dimension = (finding.dimension || '').toLowerCase();
  const payload = `${file}||${desc}||${dimension}`;
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Legacy dedup key (kept for backward compat)
// ---------------------------------------------------------------------------

function buildDedupKey(finding) {
  const file = (finding.file || '').replace(/`/g, '').trim();
  const consequence = (finding.description || finding.title || '').toLowerCase().slice(0, 80);
  const repair = (finding.fixProposal || '').toLowerCase().slice(0, 60);
  return `${file}|||${consequence}|||${repair}`;
}

// ---------------------------------------------------------------------------
// Jaccard similarity dedup
// ---------------------------------------------------------------------------

/**
 * Tokenize text for similarity comparison.
 * Removes numbers, path-specific segments, lowercases.
 */
function tokenize(text) {
  if (!text) return new Set();
  const normalized = text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[0-9]+/g, '')       // remove all numbers
    .replace(/[/\\]/g, ' ')       // path separators to spaces
    .replace(/[^a-z一-鿿\s]/g, ' ') // keep letters, CJK, spaces
    .replace(/\s+/g, ' ')
    .trim();
  const words = normalized.split(' ').filter(w => w.length > 1);
  return new Set(words);
}

/**
 * Compute Jaccard similarity between two token sets.
 * Returns value between 0 and 1.
 */
function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  const smaller = setA.size <= setB.size ? setA : setB;
  const larger = setA.size <= setB.size ? setB : setA;

  for (const item of smaller) {
    if (larger.has(item)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const SIMILARITY_THRESHOLD = 0.7;

// ---------------------------------------------------------------------------
// Cross-run dedup registry
// ---------------------------------------------------------------------------

const REGISTRY_FILENAME = 'dedup-registry.json';

function getRegistryPath(workDir) {
  // Registry lives at project root .optcode/dedup-registry.json
  // workDir is like .optcode/<timestamp>/, so registry is at parent
  const optcodeDir = dirname(workDir);
  return join(optcodeDir, REGISTRY_FILENAME);
}

function loadRegistry(registryPath) {
  if (!existsSync(registryPath)) {
    return { version: 1, entries: [] };
  }
  try {
    const raw = readFileSync(registryPath, 'utf8');
    const registry = JSON.parse(raw);
    if (!registry.version) registry.version = 1;
    if (!Array.isArray(registry.entries)) registry.entries = [];
    return registry;
  } catch {
    return { version: 1, entries: [] };
  }
}

function saveRegistry(registryPath, registry) {
  const dir = dirname(registryPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
}

/**
 * Update the registry with findings from the current run.
 * - New findings are added with status 'active'
 * - Existing findings update last_seen and seen_count
 * - Previously active findings not in current run are marked 'resolved'
 */
function updateRegistry(registryPath, findings, runId) {
  const registry = loadRegistry(registryPath);
  const now = new Date().toISOString();
  const currentFingerprints = new Set();

  for (const finding of findings) {
    const fp = computeFingerprint(finding);
    currentFingerprints.add(fp);

    const existing = registry.entries.find(e => e.fingerprint === fp);
    if (existing) {
      existing.last_seen = now;
      existing.seen_count = (existing.seen_count || 1) + 1;
      if (!existing.run_ids.includes(runId)) {
        existing.run_ids.push(runId);
      }
      // Reactivate if it was resolved
      if (existing.status === 'resolved') {
        existing.status = 'active';
      }
    } else {
      registry.entries.push({
        fingerprint: fp,
        first_seen: now,
        last_seen: now,
        seen_count: 1,
        run_ids: [runId],
        dimension: finding.dimension,
        file: (finding.file || '').replace(/`/g, '').trim(),
        title: finding.title || '',
        status: 'active',
      });
    }
  }

  // Mark resolved: previously active findings not seen in this run
  for (const entry of registry.entries) {
    if (entry.status === 'active' && !currentFingerprints.has(entry.fingerprint)) {
      entry.status = 'resolved';
      entry.resolved_at = now;
    }
  }

  saveRegistry(registryPath, registry);
  return registry;
}

/**
 * Suppress a finding in the registry by fingerprint.
 */
function suppressInRegistry(registryPath, fingerprint) {
  const registry = loadRegistry(registryPath);
  const entry = registry.entries.find(e => e.fingerprint === fingerprint);
  if (!entry) {
    return { success: false, error: 'fingerprint not found' };
  }
  entry.status = 'suppressed';
  entry.suppressed_at = new Date().toISOString();
  saveRegistry(registryPath, registry);
  return { success: true, entry };
}

// ---------------------------------------------------------------------------
// Enhanced deduplication
// ---------------------------------------------------------------------------

/**
 * Deduplicate findings with exact match, similarity match,
 * and optionally cross-run registry awareness.
 */
function deduplicate(findings, options = {}) {
  const { withRegistry = false, registryPath = null } = options;

  // Load registry if requested
  let registry = null;
  let suppressedFingerprints = new Set();
  if (withRegistry && registryPath) {
    registry = loadRegistry(registryPath);
    suppressedFingerprints = new Set(
      registry.entries
        .filter(e => e.status === 'suppressed')
        .map(e => e.fingerprint)
    );
  }

  // Phase 1: filter suppressed findings
  const suppressed = [];
  const active = [];
  for (const finding of findings) {
    const fp = computeFingerprint(finding);
    if (suppressedFingerprints.has(fp)) {
      suppressed.push({ id: finding.id, fingerprint: fp, reason: 'suppressed in registry' });
    } else {
      active.push(finding);
    }
  }

  // Phase 2: exact dedup (by dedupKey)
  const groups = new Map();
  for (const finding of active) {
    const key = buildDedupKey(finding);
    if (!groups.has(key)) {
      groups.set(key, { primary: finding, duplicates: [] });
    } else {
      groups.get(key).duplicates.push(finding);
    }
  }

  // Phase 3: similarity dedup across remaining groups
  const groupList = [...groups.values()];
  const merged = new Set(); // indices that have been merged into another

  for (let i = 0; i < groupList.length; i++) {
    if (merged.has(i)) continue;
    const tokensI = tokenize(
      (groupList[i].primary.description || '') + ' ' + (groupList[i].primary.title || '')
    );
    const fileI = (groupList[i].primary.file || '').replace(/`/g, '').trim();

    for (let j = i + 1; j < groupList.length; j++) {
      if (merged.has(j)) continue;
      const fileJ = (groupList[j].primary.file || '').replace(/`/g, '').trim();

      // Only merge similar findings if they target the same file
      if (fileI !== fileJ) continue;

      const tokensJ = tokenize(
        (groupList[j].primary.description || '') + ' ' + (groupList[j].primary.title || '')
      );
      const sim = jaccardSimilarity(tokensI, tokensJ);
      if (sim >= SIMILARITY_THRESHOLD) {
        merged.add(j);
        groupList[i].duplicates.push(groupList[j].primary);
        groupList[i].duplicates.push(...groupList[j].duplicates);
      }
    }
  }

  // Build result
  const deduplicated = [];
  const mergeLog = [];

  for (let i = 0; i < groupList.length; i++) {
    if (merged.has(i)) continue;
    const group = groupList[i];

    // Annotate with registry info
    if (registry) {
      const fp = computeFingerprint(group.primary);
      const entry = registry.entries.find(e => e.fingerprint === fp);
      if (entry && entry.seen_count > 1) {
        group.primary._recurring = true;
        group.primary._seen_count = entry.seen_count;
      }
    }

    deduplicated.push(group.primary);
    for (const dup of group.duplicates) {
      const reason = merged.has(groupList.indexOf(group))
        ? 'similarity merge'
        : 'same file + consequence + repair';
      mergeLog.push({
        id: dup.id,
        mergedInto: group.primary.id,
        reason: dup._similarityMerge ? 'similarity >= 0.7' : 'same file + consequence + repair',
      });
    }
  }

  // Add suppressed entries to merge log
  for (const s of suppressed) {
    mergeLog.push(s);
  }

  return { deduplicated, mergeLog, suppressed };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);

  // Registry sub-commands
  if (args[0] === 'registry') {
    return handleRegistryCommand(args.slice(1));
  }

  const workDir = args[0];
  if (!workDir) {
    process.stderr.write(
      '用法:\n' +
      '  node cross-dimension-dedup.js <work-dir>                    — 当前运行去重\n' +
      '  node cross-dimension-dedup.js <work-dir> --with-registry    — 含跨运行注册表\n' +
      '  node cross-dimension-dedup.js registry sync <work-dir>      — 同步注册表\n' +
      '  node cross-dimension-dedup.js registry status               — 注册表统计\n' +
      '  node cross-dimension-dedup.js registry suppress <fingerprint> — 抑制发现\n'
    );
    process.exit(1);
  }

  const withRegistry = args.includes('--with-registry');
  const crDir = join(workDir, 'cr');
  const findings = extractFindings(crDir);
  const registryPath = withRegistry ? getRegistryPath(workDir) : null;

  const { deduplicated, mergeLog, suppressed } = deduplicate(findings, {
    withRegistry,
    registryPath,
  });

  const output = {
    original_count: findings.length,
    deduplicated_count: deduplicated.length,
    removed_count: mergeLog.length,
    suppressed_count: (suppressed || []).length,
    merge_log: mergeLog,
    deduplicated_ids: deduplicated.map(f => f.id),
  };

  if (withRegistry) {
    output.recurring = deduplicated.filter(f => f._recurring).map(f => ({
      id: f.id,
      seen_count: f._seen_count,
    }));
  }

  console.log(JSON.stringify(output, null, 2));
}

function handleRegistryCommand(args) {
  const subCmd = args[0];

  if (subCmd === 'sync') {
    const workDir = args[1];
    if (!workDir) {
      process.stderr.write('用法: node cross-dimension-dedup.js registry sync <work-dir>\n');
      process.exit(1);
    }
    const crDir = join(workDir, 'cr');
    const findings = extractFindings(crDir);
    const registryPath = getRegistryPath(workDir);
    // Use workDir basename as run ID
    const runId = require('node:path').basename(workDir);
    const registry = updateRegistry(registryPath, findings, runId);
    const stats = {
      total: registry.entries.length,
      active: registry.entries.filter(e => e.status === 'active').length,
      resolved: registry.entries.filter(e => e.status === 'resolved').length,
      suppressed: registry.entries.filter(e => e.status === 'suppressed').length,
      synced_findings: findings.length,
    };
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  if (subCmd === 'status') {
    // Try to find registry in cwd/.optcode/
    const registryPath = args[1] || join(process.cwd(), '.optcode', REGISTRY_FILENAME);
    const registry = loadRegistry(registryPath);
    const stats = {
      version: registry.version,
      total: registry.entries.length,
      active: registry.entries.filter(e => e.status === 'active').length,
      resolved: registry.entries.filter(e => e.status === 'resolved').length,
      suppressed: registry.entries.filter(e => e.status === 'suppressed').length,
    };
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  if (subCmd === 'suppress') {
    const fingerprint = args[1];
    if (!fingerprint) {
      process.stderr.write('用法: node cross-dimension-dedup.js registry suppress <fingerprint>\n');
      process.exit(1);
    }
    const registryPath = args[2] || join(process.cwd(), '.optcode', REGISTRY_FILENAME);
    const result = suppressInRegistry(registryPath, fingerprint);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  process.stderr.write('未知的注册表命令: ' + subCmd + '\n');
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  extractFindings,
  deduplicate,
  buildDedupKey,
  computeFingerprint,
  jaccardSimilarity,
  updateRegistry,
  loadRegistry,
  // Internal helpers exported for testing
  normalizeForFingerprint,
  tokenize,
  getRegistryPath,
  suppressInRegistry,
  saveRegistry,
  SIMILARITY_THRESHOLD,
};
