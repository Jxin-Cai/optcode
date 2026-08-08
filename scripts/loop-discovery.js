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
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { readJsonFile, writeJsonFile } = require('./safe-json-store.js');
const { guardCli } = require('./cli-result.js');

const KNOWN_ISSUES_PATH = join(process.cwd(), '.optcode', 'known-issues.json');
const HEALTH_HISTORY_PATH = join(process.cwd(), '.optcode', 'health-history.json');
const LOOP_REGISTRY_PATH = join(process.cwd(), '.optcode', 'loop-registry.json');
const PROMOTION_THRESHOLD = 7;

// ---------------------------------------------------------------------------
// Coverage Ladder — graduated improvement path from weakest to strongest prevention
// ---------------------------------------------------------------------------
const COVERAGE_LADDER = Object.freeze([
  { level: 0, name: 'observed', description: 'Issue detected by manual review or AI CR', prevention: 'none', durability: 'ephemeral' },
  { level: 1, name: 'documented', description: 'Issue documented in rules or guidelines', prevention: 'advisory', durability: 'low' },
  { level: 2, name: 'configured', description: 'Lint rule or static check configured', prevention: 'passive', durability: 'medium' },
  { level: 3, name: 'enforced', description: 'Hook or gate blocks the pattern', prevention: 'active', durability: 'high' },
  { level: 4, name: 'eliminated', description: 'Architecture makes the pattern impossible', prevention: 'structural', durability: 'permanent' },
]);

function readKnownIssues() {
  const data = readJsonFile(KNOWN_ISSUES_PATH, {
    defaultValue: [],
    validate: value => Array.isArray(value) || (value && Array.isArray(value.issues)),
  });
  return Array.isArray(data) ? data : data.issues;
}

function readHealthHistory() {
  const data = readJsonFile(HEALTH_HISTORY_PATH, {
    defaultValue: [],
    validate: value => Array.isArray(value) || (value && Array.isArray(value.entries)),
  });
  return Array.isArray(data) ? data : data.entries;
}

function readLoopRegistry() {
  return readJsonFile(LOOP_REGISTRY_PATH, {
    defaultValue: { version: 1, loops: [], promoted_at: [] },
    validate: value => value && Array.isArray(value.loops) && Array.isArray(value.promoted_at),
  });
}

function writeLoopRegistry(registry) {
  writeJsonFile(LOOP_REGISTRY_PATH, registry, {
    validate: value => value && Array.isArray(value.loops) && Array.isArray(value.promoted_at),
  });
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
  const issueId = issue.fingerprint || issue.id;
  const samePattern = allIssues.filter(i =>
    i.dimension === issue.dimension && i.pattern === issue.pattern &&
    (i.fingerprint || i.id) !== issueId
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

// ---------------------------------------------------------------------------
// Coverage Ladder — assessment and promotion logic
// ---------------------------------------------------------------------------

/**
 * Assess the current coverage level of a known issue.
 * Checks from highest level down and returns the first match.
 */
function assessCoverageLevel(issue, projectRoot) {
  const root = projectRoot || process.cwd();

  // Level 4 — architectural constraint (manual tag on the issue)
  if (issue.coverage_level === 4 || issue.eliminated || issue.architectural_constraint) {
    return COVERAGE_LADDER[4];
  }

  // Level 3 — hook or CI gate catches this pattern
  const hasHook = (() => {
    // Check plugin hooks.json
    const hooksPath = join(root, '.claude', 'settings.json');
    if (existsSync(hooksPath)) {
      try {
        const settings = JSON.parse(readFileSync(hooksPath, 'utf8'));
        const hooks = settings.hooks || {};
        const allHookEntries = [
          ...(hooks.PreToolUse || []),
          ...(hooks.PostToolUse || []),
        ];
        const pattern = issue.pattern || issue.fingerprint || '';
        if (allHookEntries.some(h => {
          const matcher = (h.matcher || '') + ' ' + (h.command || '') + ' ' + (h.prompt || '');
          return matcher.toLowerCase().includes(pattern.toLowerCase());
        })) return true;
      } catch { /* ignore */ }
    }
    // Check GitHub workflows
    const workflowsDir = join(root, '.github', 'workflows');
    if (existsSync(workflowsDir)) {
      try {
        const files = readdirSync(workflowsDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
        const pattern = issue.pattern || issue.fingerprint || '';
        for (const file of files) {
          const content = readFileSync(join(workflowsDir, file), 'utf8');
          if (content.toLowerCase().includes(pattern.toLowerCase())) return true;
        }
      } catch { /* ignore */ }
    }
    return false;
  })();
  if (hasHook) return COVERAGE_LADDER[3];

  // Level 2 — lint/config rule exists
  const hasLintRule = (() => {
    const pattern = issue.pattern || issue.fingerprint || '';
    const configFiles = [
      '.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml',
      'eslint.config.js', 'eslint.config.mjs', 'eslint.config.ts',
      '.prettierrc', '.prettierrc.json', '.prettierrc.js',
      'tsconfig.json', 'biome.json', 'biome.jsonc',
    ];
    for (const cf of configFiles) {
      const cfPath = join(root, cf);
      if (existsSync(cfPath)) {
        try {
          const content = readFileSync(cfPath, 'utf8');
          if (content.toLowerCase().includes(pattern.toLowerCase())) return true;
        } catch { /* ignore */ }
      }
    }
    return false;
  })();
  if (hasLintRule) return COVERAGE_LADDER[2];

  // Level 1 — documented in .optcode/rules/
  const hasRule = (() => {
    const rulesDir = join(root, '.optcode', 'rules');
    if (!existsSync(rulesDir)) return false;
    try {
      const files = readdirSync(rulesDir).filter(f => f.endsWith('.md'));
      const pattern = issue.pattern || issue.fingerprint || '';
      const id = issue.fingerprint || issue.id || '';
      for (const file of files) {
        // Match by filename containing pattern/fingerprint or content referencing it
        if (file.toLowerCase().includes(pattern.toLowerCase()) ||
            file.toLowerCase().includes(id.toLowerCase())) return true;
        const content = readFileSync(join(rulesDir, file), 'utf8');
        if (content.toLowerCase().includes(pattern.toLowerCase()) ||
            content.toLowerCase().includes(id.toLowerCase())) return true;
      }
    } catch { /* ignore */ }
    return false;
  })();
  if (hasRule) return COVERAGE_LADDER[1];

  // Level 0 — only found via CR run
  return COVERAGE_LADDER[0];
}

/**
 * Recommend the next coverage level promotion for an issue.
 * Returns actionable guidance for advancing one level.
 */
function recommendPromotion(issue, currentLevel) {
  const current = COVERAGE_LADDER[currentLevel];
  if (currentLevel >= 4) {
    return {
      current: { level: current.level, name: current.name },
      next: null,
      action: 'Already at maximum coverage (eliminated)',
      effort: 'none',
      impact: 'No further promotion needed',
    };
  }

  const next = COVERAGE_LADDER[currentLevel + 1];
  const pattern = issue.pattern || issue.fingerprint || 'unknown-pattern';
  const dimension = issue.dimension || 'general';

  let action, effort, impact;

  switch (currentLevel) {
    case 0:
      // observed -> documented
      action = `Create .optcode/rules/${pattern.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}.md documenting this ${dimension} issue`;
      effort = 'low';
      impact = 'Prevents recurrence in future CR runs by encoding as a review rule';
      break;
    case 1:
      // documented -> configured
      if (dimension === 'style' || pattern.includes('naming') || pattern.includes('format')) {
        action = `Add lint/prettier rule for "${pattern}" in project config`;
      } else if (dimension === 'security') {
        action = `Add security-focused lint rule or static analysis check for "${pattern}"`;
      } else {
        action = `Add eslint/static analysis rule to detect "${pattern}" automatically`;
      }
      effort = 'medium';
      impact = 'Catches violations passively during development with IDE/CI feedback';
      break;
    case 2:
      // configured -> enforced
      if (dimension === 'security') {
        action = `Add pre-commit hook or CI gate that blocks commits containing "${pattern}" violations`;
      } else {
        action = `Add PreToolUse/PostToolUse hook or CI check that actively blocks "${pattern}"`;
      }
      effort = 'medium';
      impact = 'Blocks at commit/PR time — violations cannot enter codebase';
      break;
    case 3:
      // enforced -> eliminated
      action = `Refactor architecture to make "${pattern}" structurally impossible (e.g., type system, API design, encapsulation)`;
      effort = 'high';
      impact = 'Pattern becomes impossible by design — permanent elimination';
      break;
    default:
      action = 'Unknown promotion path';
      effort = 'unknown';
      impact = 'Unknown';
  }

  return {
    current: { level: current.level, name: current.name },
    next: { level: next.level, name: next.name },
    action,
    effort,
    impact,
  };
}

/**
 * Aggregate summary of all known issues by coverage level.
 * Returns level counts, weighted coverage score, and promotable issues.
 */
function ladderSummary(projectRoot) {
  const root = projectRoot || process.cwd();
  const issues = readKnownIssues();

  const levels = { observed: 0, documented: 0, configured: 0, enforced: 0, eliminated: 0 };
  const promotable = [];
  const assessments = [];

  for (const issue of issues) {
    if (issue.status === 'resolved') continue;

    const assessed = assessCoverageLevel(issue, root);
    levels[assessed.name]++;

    assessments.push({
      fingerprint: issue.fingerprint || issue.id,
      level: assessed.level,
      name: assessed.name,
    });

    // Anything below level 4 is promotable
    if (assessed.level < 4) {
      const recommendation = recommendPromotion(issue, assessed.level);
      promotable.push({
        fingerprint: issue.fingerprint || issue.id,
        dimension: issue.dimension,
        pattern: issue.pattern,
        description: issue.description || issue.title,
        current_level: assessed.level,
        current_name: assessed.name,
        recommendation,
      });
    }
  }

  // Weighted coverage score: (l0*0 + l1*25 + l2*50 + l3*75 + l4*100) / total / 100
  const total = Object.values(levels).reduce((sum, n) => sum + n, 0);
  const weightedSum = levels.observed * 0 +
    levels.documented * 25 +
    levels.configured * 50 +
    levels.enforced * 75 +
    levels.eliminated * 100;
  const coverage_score = total > 0 ? Math.round(weightedSum / total) : 0;

  // Sort promotable by effort (low first) then by level (lowest first for most impact)
  const effortOrder = { low: 0, medium: 1, high: 2, unknown: 3, none: 4 };
  promotable.sort((a, b) => {
    const ea = effortOrder[a.recommendation.effort] ?? 3;
    const eb = effortOrder[b.recommendation.effort] ?? 3;
    if (ea !== eb) return ea - eb;
    return a.current_level - b.current_level;
  });

  return {
    levels,
    coverage_score,
    total_issues: total,
    promotable,
  };
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

if (require.main === module) guardCli(main);
module.exports = { analyze, promote, readLoopRegistry, computeScore, classifyRuntime };
