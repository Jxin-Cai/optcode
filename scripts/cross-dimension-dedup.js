#!/usr/bin/env node
/**
 * Cross-dimension finding deduplication.
 *
 * Merge rule: same target file + same observed consequence + same owner + same repair route.
 * Preserves independent consequences even if they share a theme.
 *
 * Usage: node cross-dimension-dedup.js <work-dir>
 * Input: reads all CR reports in <work-dir>/cr/
 * Output: JSON with original findings, merged groups, and deduplicated result.
 */
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { readFrontmatter } = require('./workflow-lib.js');

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

function buildDedupKey(finding) {
  const file = (finding.file || '').replace(/`/g, '').trim();
  const consequence = (finding.description || finding.title || '').toLowerCase().slice(0, 80);
  const repair = (finding.fixProposal || '').toLowerCase().slice(0, 60);
  return `${file}|||${consequence}|||${repair}`;
}

function deduplicate(findings) {
  const groups = new Map();

  for (const finding of findings) {
    const key = buildDedupKey(finding);
    if (!groups.has(key)) {
      groups.set(key, { primary: finding, duplicates: [] });
    } else {
      groups.get(key).duplicates.push(finding);
    }
  }

  const merged = [];
  const removedIds = [];

  for (const [, group] of groups) {
    merged.push(group.primary);
    for (const dup of group.duplicates) {
      removedIds.push({ id: dup.id, mergedInto: group.primary.id, reason: 'same file + consequence + repair' });
    }
  }

  return { deduplicated: merged, mergeLog: removedIds };
}

function main() {
  const workDir = process.argv[2];
  if (!workDir) {
    process.stderr.write('用法: node cross-dimension-dedup.js <work-dir>\n');
    process.exit(1);
  }

  const crDir = join(workDir, 'cr');
  const findings = extractFindings(crDir);
  const { deduplicated, mergeLog } = deduplicate(findings);

  const output = {
    original_count: findings.length,
    deduplicated_count: deduplicated.length,
    removed_count: mergeLog.length,
    merge_log: mergeLog,
    deduplicated_ids: deduplicated.map(f => f.id),
  };

  console.log(JSON.stringify(output, null, 2));
}

if (require.main === module) main();
module.exports = { extractFindings, deduplicate, buildDedupKey };
