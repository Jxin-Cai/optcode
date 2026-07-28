#!/usr/bin/env node
/**
 * known-issues.js — Cross-run persistent issue tracking for optcode.
 * Maintains .optcode/known-issues.json at the project root.
 *
 * Library exports + CLI:
 *   node known-issues.js sync <workDir>
 *   node known-issues.js context <workDir>
 *   node known-issues.js defer <id> [reason]
 *   node known-issues.js resolve <id>
 *   node known-issues.js list [--status active|deferred|resolved]
 */
const { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync } = require('node:fs');
const { join, dirname } = require('node:path');

function knownIssuesFile(projectRoot) {
  return join(projectRoot, '.optcode', 'known-issues.json');
}

function loadKnownIssues(projectRoot) {
  const file = knownIssuesFile(projectRoot);
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch { return []; }
}

function saveKnownIssues(projectRoot, issues) {
  const file = knownIssuesFile(projectRoot);
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp.' + process.pid;
  writeFileSync(tmp, JSON.stringify(issues, null, 2), 'utf8');
  renameSync(tmp, file);
}

function makeFingerprint(dimension, title, file) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
  return `${dimension}:${slug}:${file}`;
}

function dimensionFromFilename(filename) {
  const match = filename.match(/^([a-z][\w-]*?)(?:-round-\d+|-pass|-failed)\.md$/);
  return match ? match[1] : null;
}

function parseCrReport(content, filenameDimension) {
  const findings = [];
  const dimensionMatch = content.match(/^dimension:\s*(.+)$/m);
  const dimension = dimensionMatch ? dimensionMatch[1].trim() : (filenameDimension || 'unknown');

  const issuePattern = /###\s+(?:ISSUE-\d+|[A-Za-z-]+:ISSUE-\d+):\s*(.+)/g;
  let match;
  while ((match = issuePattern.exec(content)) !== null) {
    const title = match[1].trim();
    const afterTitle = content.slice(match.index);
    const fileMatch = afterTitle.match(/\*\*文件\*\*:\s*`([^`]+)`/);
    const severityMatch = afterTitle.match(/\*\*严重程度\*\*:\s*(high|medium|low)/);
    if (fileMatch) {
      findings.push({
        dimension,
        title,
        file: fileMatch[1],
        severity: severityMatch ? severityMatch[1] : 'medium',
      });
    }
  }
  return findings;
}

function syncFromCrReports(projectRoot, workDir) {
  const crDir = join(workDir, 'cr');
  if (!existsSync(crDir)) return;

  const issues = loadKnownIssues(projectRoot);
  const now = new Date().toISOString();
  const reports = readdirSync(crDir).filter(f => f.endsWith('.md'));

  for (const report of reports) {
    const content = readFileSync(join(crDir, report), 'utf8');
    const findings = parseCrReport(content, dimensionFromFilename(report));

    for (const finding of findings) {
      const id = makeFingerprint(finding.dimension, finding.title, finding.file);
      const existing = issues.find(i => i.id === id);
      if (existing) {
        existing.last_seen = now;
        existing.run_count += 1;
        if (existing.status === 'resolved') {
          existing.status = 'active';
        }
      } else {
        issues.push({
          id,
          dimension: finding.dimension,
          severity: finding.severity,
          file: finding.file,
          title: finding.title,
          first_seen: now,
          last_seen: now,
          run_count: 1,
          status: 'active',
          deferred_reason: null,
        });
      }
    }
  }

  saveKnownIssues(projectRoot, issues);
}

function getContext(projectRoot) {
  const issues = loadKnownIssues(projectRoot);
  const active = issues.filter(i => i.status === 'active');
  const deferred = issues.filter(i => i.status === 'deferred');

  if (active.length === 0 && deferred.length === 0) return 'none';

  const lines = [];
  if (deferred.length > 0) {
    lines.push(`Deferred (do NOT re-report): ${deferred.map(i => `${i.dimension}:${i.title} in ${i.file}`).join('; ')}`);
  }
  if (active.length > 0) {
    lines.push(`Active (${active.length} issues): ${active.slice(0, 10).map(i => `${i.dimension}:${i.title} in ${i.file} (seen ${i.run_count}x)`).join('; ')}`);
  }
  return lines.join('\n');
}

function defer(projectRoot, id, reason) {
  const issues = loadKnownIssues(projectRoot);
  const issue = issues.find(i => i.id === id);
  if (!issue) { console.error(`Issue not found: ${id}`); process.exit(1); }
  issue.status = 'deferred';
  issue.deferred_reason = reason || null;
  saveKnownIssues(projectRoot, issues);
  console.log(`Deferred: ${id}`);
}

function resolve(projectRoot, id) {
  const issues = loadKnownIssues(projectRoot);
  const issue = issues.find(i => i.id === id);
  if (!issue) { console.error(`Issue not found: ${id}`); process.exit(1); }
  issue.status = 'resolved';
  saveKnownIssues(projectRoot, issues);
  console.log(`Resolved: ${id}`);
}

function list(projectRoot, statusFilter) {
  const issues = loadKnownIssues(projectRoot);
  const filtered = statusFilter ? issues.filter(i => i.status === statusFilter) : issues;
  if (filtered.length === 0) { console.log('No issues found.'); return; }
  for (const i of filtered) {
    console.log(`[${i.status}] ${i.id} — ${i.title} (${i.severity}, seen ${i.run_count}x)`);
  }
}

function suggestRules(projectRoot) {
  const issues = loadKnownIssues(projectRoot);
  const falsePositives = issues.filter(i => i.status === 'deferred' && i.deferred_reason && i.deferred_reason.toLowerCase().includes('false'));
  if (falsePositives.length === 0) {
    console.log('No false-positive deferrals found. Defer issues with reason containing "false" to generate suggestions.');
    return;
  }

  const byDimension = {};
  for (const fp of falsePositives) {
    if (!byDimension[fp.dimension]) byDimension[fp.dimension] = [];
    byDimension[fp.dimension].push(fp);
  }

  console.log('## 基于历史误报的规则建议\n');
  for (const [dim, fps] of Object.entries(byDimension)) {
    if (fps.length < 2) continue;
    console.log(`### ${dim} (${fps.length} 次误报)\n`);
    console.log('建议创建规则 `.optcode/rules/${dim}-exceptions.md`:\n');
    console.log('```markdown');
    console.log('---');
    console.log(`scope: ${dim}`);
    console.log('severity: low');
    console.log('---\n');
    console.log(`# ${dim} 维度例外\n`);
    console.log('以下模式在本项目中属于有意设计，不应报告为问题：\n');
    for (const fp of fps) {
      console.log(`- ${fp.title} (${fp.file}) — ${fp.deferred_reason || ''}`);
    }
    console.log('```\n');
  }
}

// CLI
if (require.main === module) {
  const [,, command, ...rest] = process.argv;
  const projectRoot = process.cwd();

  switch (command) {
    case 'sync': {
      const workDir = rest[0];
      if (!workDir) { console.error('Usage: known-issues.js sync <workDir>'); process.exit(1); }
      syncFromCrReports(projectRoot, workDir);
      console.log('Synced known issues from CR reports.');
      break;
    }
    case 'context': {
      console.log(getContext(projectRoot));
      break;
    }
    case 'defer': {
      const [id, ...reasonParts] = rest;
      if (!id) { console.error('Usage: known-issues.js defer <id> [reason]'); process.exit(1); }
      defer(projectRoot, id, reasonParts.join(' ') || null);
      break;
    }
    case 'resolve': {
      const id = rest[0];
      if (!id) { console.error('Usage: known-issues.js resolve <id>'); process.exit(1); }
      resolve(projectRoot, id);
      break;
    }
    case 'list': {
      const statusIdx = rest.indexOf('--status');
      const statusFilter = statusIdx >= 0 ? rest[statusIdx + 1] : null;
      list(projectRoot, statusFilter);
      break;
    }
    case 'suggest-rules': {
      suggestRules(projectRoot);
      break;
    }
    default:
      console.error('Usage: known-issues.js <sync|context|defer|resolve|list|suggest-rules> [args]');
      process.exit(1);
  }
}

module.exports = { loadKnownIssues, saveKnownIssues, syncFromCrReports, getContext, defer, resolve, knownIssuesFile };
