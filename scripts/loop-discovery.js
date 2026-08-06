#!/usr/bin/env node
/**
 * optcode loop discovery — identifies recurring issues and proposes durable automation.
 *
 * Analyzes cross-run known-issues history to find patterns that recur across
 * multiple runs, then recommends the smallest durable intervention to prevent them.
 *
 * Decision gate (10-point): an issue qualifies for loop promotion when it scores ≥7:
 *   1. Recurrence (0-3): appeared in ≥2 runs (1), ≥3 runs (2), ≥5 runs (3)
 *   2. Fix stability (0-2): was fixed but reappeared (1), fixed ≥2x and reappeared (2)
 *   3. Impact scope (0-2): affects ≥2 files (1), ≥5 files or cross-package (2)
 *   4. Category concentration (0-2): same dimension+pattern ≥3x (1), ≥5x (2)
 *   5. Human intervention (0-1): required manual fix or was escalated (1)
 *
 * Runtime-fit classification (what to create):
 *   - hook: pre-commit or post-write check (catches before commit)
 *   - rule: .optcode/rules/*.md (custom review rule for future CR runs)
 *   - workflow: automated check sequence
 *   - human-gated: requires human decision — flag but don't automate
 *
 * Usage:
 *   node loop-discovery.js analyze [--threshold <n>] [--json]
 *   node loop-discovery.js promote <issue-fingerprint> --type <hook|rule|workflow|human-gated>
 *   node loop-discovery.js history
 */
const { existsSync, readFileSync, writeFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { atomicReplace } = require('./workflow-lib.js');

const KNOWN_ISSUES_PATH = join(process.cwd(), '.optcode', 'known-issues.json');
const HEALTH_HISTORY_PATH = join(process.cwd(), '.optcode', 'health-history.json');
const LOOP_REGISTRY_PATH = join(process.cwd(), '.optcode', 'loop-registry.json');
const PROMOTION_THRESHOLD = 7;

function readKnownIssues() {
  if (!existsSync(KNOWN_ISSUES_PATH)) return [];
  try {
    const data = JSON.parse(readFileSync(KNOWN_ISSUES_PATH, 'utf8'));
    return Array.isArray(data) ? data : (data.issues || []);
  } catch { return []; }
}

function readHealthHistory() {
  if (!existsSync(HEALTH_HISTORY_PATH)) return [];
  try {
    const data = JSON.parse(readFileSync(HEALTH_HISTORY_PATH, 'utf8'));
    return Array.isArray(data) ? data : (data.entries || []);
  } catch { return []; }
}

function readLoopRegistry() {
  if (!existsSync(LOOP_REGISTRY_PATH)) return { version: 1, loops: [], promoted_at: [] };
  try {
    return JSON.parse(readFileSync(LOOP_REGISTRY_PATH, 'utf8'));
  } catch { return { version: 1, loops: [], promoted_at: [] }; }
}

function writeLoopRegistry(registry) {
  atomicReplace(LOOP_REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
}

function scoreRecurrence(issue) {
  const runs = issue.seen_in_runs || issue.run_count || 1;
  if (runs >= 5) return 3;
  if (runs >= 3) return 2;
  if (runs >= 2) return 1;
  return 0;
}

function scoreFixStability(issue) {
  const fixedThenReappeared = issue.fixed_count || 0;
  if (fixedThenReappeared >= 2) return 2;
  if (fixedThenReappeared >= 1) return 1;
  return 0;
}

function scoreImpactScope(issue) {
  const files = issue.affected_files || [];
  if (files.length >= 5 || issue.cross_package) return 2;
  if (files.length >= 2) return 1;
  return 0;
}

function scoreCategoryConcentration(issue, allIssues) {
  if (!issue.dimension || !issue.pattern) return 0;
  const samePattern = allIssues.filter(i =>
    i.dimension === issue.dimension && i.pattern === issue.pattern
  ).length;
  if (samePattern >= 5) return 2;
  if (samePattern >= 3) return 1;
  return 0;
}

function scoreHumanIntervention(issue) {
  return (issue.escalated || issue.manual_fix) ? 1 : 0;
}

function computeScore(issue, allIssues) {
  return {
    recurrence: scoreRecurrence(issue),
    fix_stability: scoreFixStability(issue),
    impact_scope: scoreImpactScope(issue),
    category_concentration: scoreCategoryConcentration(issue, allIssues),
    human_intervention: scoreHumanIntervention(issue),
  };
}

function classifyRuntime(issue) {
  if (issue.dimension === 'style' || issue.pattern === 'naming') return 'hook';
  if (issue.dimension === 'security') return 'rule';
  if (issue.escalated || issue.manual_fix) return 'human-gated';
  if (issue.cross_package) return 'workflow';
  return 'rule';
}

function analyze(options = {}) {
  const { threshold = PROMOTION_THRESHOLD } = options;
  const issues = readKnownIssues();
  const registry = readLoopRegistry();
  const alreadyPromoted = new Set(registry.loops.map(l => l.fingerprint));

  const candidates = [];
  for (const issue of issues) {
    if (alreadyPromoted.has(issue.fingerprint || issue.id)) continue;
    if (issue.status === 'resolved') continue;

    const scores = computeScore(issue, issues);
    const total = Object.values(scores).reduce((sum, s) => sum + s, 0);

    if (total >= threshold) {
      candidates.push({
        fingerprint: issue.fingerprint || issue.id,
        dimension: issue.dimension,
        pattern: issue.pattern,
        description: issue.description || issue.title,
        total_score: total,
        scores,
        recommended_type: classifyRuntime(issue),
        affected_files: issue.affected_files || [],
      });
    }
  }

  candidates.sort((a, b) => b.total_score - a.total_score);

  return {
    analyzed: issues.length,
    candidates: candidates.length,
    threshold,
    already_promoted: alreadyPromoted.size,
    recommendations: candidates,
  };
}

function promote(fingerprint, type, description = '') {
  const registry = readLoopRegistry();
  const existing = registry.loops.find(l => l.fingerprint === fingerprint);
  if (existing) {
    return { promoted: false, reason: 'already promoted', existing };
  }

  const entry = {
    fingerprint,
    type,
    description,
    promoted_at: new Date().toISOString(),
    status: 'active',
  };
  registry.loops.push(entry);
  registry.promoted_at.push({ fingerprint, at: entry.promoted_at });
  writeLoopRegistry(registry);

  return { promoted: true, entry };
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const jsonFlag = rest.includes('--json');
  const thresholdIdx = rest.indexOf('--threshold');
  const threshold = thresholdIdx >= 0 ? Number(rest[thresholdIdx + 1]) : PROMOTION_THRESHOLD;

  switch (cmd) {
    case 'analyze': {
      const result = analyze({ threshold });
      if (jsonFlag) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Analyzed ${result.analyzed} issues, ${result.candidates} qualify for loop promotion (threshold=${threshold}):`);
        for (const rec of result.recommendations) {
          console.log(`  [${rec.total_score}/10] ${rec.fingerprint} → ${rec.recommended_type} (${rec.dimension}/${rec.pattern})`);
        }
        if (result.candidates === 0) console.log('  (none)');
      }
      break;
    }
    case 'promote': {
      const fingerprint = rest.find(a => !a.startsWith('--'));
      const typeIdx = rest.indexOf('--type');
      const type = typeIdx >= 0 ? rest[typeIdx + 1] : 'rule';
      const result = promote(fingerprint, type);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'history': {
      const registry = readLoopRegistry();
      console.log(JSON.stringify(registry, null, 2));
      break;
    }
    default:
      process.stderr.write('用法: node loop-discovery.js <analyze|promote|history> [...args]\n');
      process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { analyze, promote, readLoopRegistry, computeScore, classifyRuntime };
