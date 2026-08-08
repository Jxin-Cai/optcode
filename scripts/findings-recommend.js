#!/usr/bin/env node
/**
 * Findings recommendation engine — routes findings to optimal durable fix mechanisms
 * and generates actionable templates for hooks, rules, lint configs, and workflows.
 *
 * Usage:
 *   node findings-recommend.js route <work-dir> [--json]
 *   node findings-recommend.js generate <work-dir> --finding <id> --type <hook|rule|workflow|lint-config> [--output <dir>]
 *   node findings-recommend.js batch <work-dir> [--min-score <n>] [--json]
 */
const _fs = require('node:fs');
const _path = require('node:path');

const DEFAULT_DEPS = Object.freeze({
  existsSync: _fs.existsSync,
  readFileSync: _fs.readFileSync,
  writeFileSync: _fs.writeFileSync,
  mkdirSync: _fs.mkdirSync,
  readdirSync: _fs.readdirSync,
  join: _path.join,
  now: () => new Date().toISOString(),
});

function resolveDeps(deps) {
  if (!deps || Object.keys(deps).length === 0) return DEFAULT_DEPS;
  return { ...DEFAULT_DEPS, ...deps };
}

// --- Pattern classification ---

const LINT_PATTERNS = new Set([
  'naming', 'formatting', 'whitespace', 'indentation',
  'import-order', 'unused-exports', 'unused-imports',
  'trailing-comma', 'semicolons', 'quotes',
]);

const SECURITY_PATTERNS = new Set([
  'injection', 'xss', 'auth', 'authentication', 'authorization',
  'csrf', 'secrets', 'hardcoded-credentials', 'sql-injection',
  'path-traversal', 'command-injection', 'ssrf',
]);

const STRUCTURAL_PATTERNS = new Set([
  'coupling', 'circular-dependency', 'layering-violation',
  'abstraction-leak', 'god-class', 'deep-nesting',
  'interface-mismatch', 'dependency-direction',
]);

/**
 * Classify a finding's pattern into the best durable fix mechanism.
 * Returns: 'lint-config' | 'hook' | 'rule' | 'workflow' | 'human-gated'
 */
function classifyPattern(finding) {
  const pattern = (finding.pattern || '').toLowerCase();
  const dimension = (finding.dimension || '').toLowerCase();
  const tags = new Set((finding.tags || []).map(t => t.toLowerCase()));

  // Naming/formatting/whitespace → lint-config
  if (LINT_PATTERNS.has(pattern)) return 'lint-config';
  if (dimension === 'style' && (pattern.includes('format') || pattern.includes('naming'))) return 'lint-config';

  // Import order/unused exports → lint-config
  if (pattern.includes('import') && pattern.includes('order')) return 'lint-config';
  if (pattern.includes('unused') && (pattern.includes('export') || pattern.includes('import'))) return 'lint-config';

  // Recurs in pre-commit window → hook
  if (finding.recurs_in_precommit || finding.precommit_window) return 'hook';
  if (tags.has('precommit') || tags.has('pre-commit')) return 'hook';

  // Security/auth/injection → rule
  if (dimension === 'security') return 'rule';
  if (SECURITY_PATTERNS.has(pattern)) return 'rule';
  for (const sec of SECURITY_PATTERNS) {
    if (pattern.includes(sec)) return 'rule';
  }

  // Spans multiple packages → workflow
  if (finding.cross_package || finding.multi_package) return 'workflow';
  const affectedPkgs = new Set((finding.affected_files || []).map(f => f.split('/')[0]));
  if (affectedPkgs.size >= 3) return 'workflow';

  // Requires human judgment → human-gated
  if (finding.requires_judgment || finding.escalated || finding.manual_fix) return 'human-gated';

  // Structural/architecture → rule
  if (STRUCTURAL_PATTERNS.has(pattern)) return 'rule';
  if (dimension === 'design' || dimension === 'maintainability') return 'rule';

  // Default: rule
  return 'rule';
}

// --- Scoring ---

/**
 * Score a routing decision (0-10) based on four axes.
 */
function scoreRouting(finding, recommendedType) {
  const automationFeasibility = scoreAutomation(finding, recommendedType);
  const recurrenceLikelihood = scoreRecurrence(finding);
  const falsePositiveRisk = scoreFalsePositive(finding, recommendedType);
  const implementationCost = scoreImplementationCost(recommendedType);

  return {
    automation_feasibility: automationFeasibility,
    recurrence_likelihood: recurrenceLikelihood,
    false_positive_risk: falsePositiveRisk,
    implementation_cost: implementationCost,
    total: automationFeasibility + recurrenceLikelihood + falsePositiveRisk + implementationCost,
  };
}

function scoreAutomation(finding, type) {
  // 0-3: how automatable is this fix?
  if (type === 'lint-config') return 3;
  if (type === 'hook') return 3;
  if (type === 'workflow') return 2;
  if (type === 'rule') return 1;
  return 0; // human-gated
}

function scoreRecurrence(finding) {
  // 0-3: how likely to recur?
  const runCount = finding.seen_in_runs || finding.run_count || 1;
  if (runCount >= 5) return 3;
  if (runCount >= 3) return 2;
  if (runCount >= 2) return 1;
  return 0;
}

function scoreFalsePositive(finding, type) {
  // 0-2: risk of false positives (lower is better, inverted for scoring)
  if (type === 'lint-config') return 2; // low FP risk → high score
  if (type === 'hook') return 1;
  if (type === 'rule') return 1;
  if (type === 'workflow') return 1;
  return 0; // human-gated has inherently higher FP
}

function scoreImplementationCost(type) {
  // 0-2: inverted cost (cheap → high score)
  if (type === 'lint-config') return 2;
  if (type === 'hook') return 1;
  if (type === 'rule') return 2;
  if (type === 'workflow') return 1;
  return 0; // human-gated costs nothing to automate but doesn't prevent
}

// --- Template generation ---

function toKebabCase(str) {
  return (str || 'unnamed')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function generateTemplate(finding, type) {
  switch (type) {
    case 'hook': return generateHookTemplate(finding);
    case 'rule': return generateRuleTemplate(finding);
    case 'lint-config': return generateLintConfigTemplate(finding);
    case 'workflow': return generateWorkflowTemplate(finding);
    default: return null;
  }
}

function generateHookTemplate(finding) {
  const name = toKebabCase(finding.pattern || finding.id || 'check');
  const event = finding.dimension === 'security' ? 'PreToolUse' : 'PostToolUse';
  const matcher = finding.dimension === 'security' ? 'Write' : 'Bash|Write';

  const scriptTemplate = `#!/usr/bin/env node
/**
 * Hook: ${finding.title || finding.description || name}
 * Auto-generated from finding ${finding.id || 'unknown'}
 */
const { readFileSync } = require('node:fs');

const PATTERN = ${JSON.stringify(finding.pattern || 'TODO')};

function check(toolInput) {
  // TODO: implement pattern detection logic
  // Return { blocked: true, reason: '...' } to block
  // Return { blocked: false } to allow
  return { blocked: false };
}

if (require.main === module) {
const input = JSON.parse(readFileSync(0, 'utf8'));
  const result = check(input);
  console.log(JSON.stringify(result));
  process.exit(result.blocked ? 1 : 0);
}
module.exports = { check };
`;

  return {
    hookEntry: {
      event,
      matcher,
      script: `\${CLAUDE_PLUGIN_ROOT}/hooks/${name}.js`,
    },
    scriptTemplate,
    installPath: `hooks/${name}.js`,
  };
}

function generateRuleTemplate(finding) {
  const name = toKebabCase(finding.pattern || finding.id || 'custom-rule');
  const dimension = finding.dimension || 'maintainability';
  const severity = finding.severity || 'medium';
  const title = finding.title || finding.description || 'Custom Rule';

  const markdown = `---
name: ${name}
dimension: ${dimension}
severity: ${severity}
---
# Rule: ${title}

## When to flag
- ${finding.description || 'TODO: describe when this rule should trigger'}

## Examples

### Bad
\`\`\`
// TODO: add negative example
\`\`\`

### Good
\`\`\`
// TODO: add positive example
\`\`\`
`;

  return {
    content: markdown,
    installPath: `.optcode/rules/${name}.md`,
    metadata: { name, dimension, severity },
  };
}

function generateLintConfigTemplate(finding) {
  const pattern = (finding.pattern || '').toLowerCase();
  let tool = 'eslint';
  let rule = '';
  let config = {};

  if (pattern.includes('format') || pattern.includes('whitespace') || pattern.includes('indentation')) {
    tool = 'prettier';
    rule = pattern;
    config = { printWidth: 100, tabWidth: 2, useTabs: false };
  } else if (pattern.includes('import') && pattern.includes('order')) {
    rule = 'import/order';
    config = { groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'] };
  } else if (pattern.includes('unused') && pattern.includes('export')) {
    rule = 'no-unused-exports';
    config = { severity: 'warn' };
  } else if (pattern.includes('unused') && pattern.includes('import')) {
    rule = 'no-unused-imports';
    config = { severity: 'warn' };
  } else if (pattern.includes('naming')) {
    rule = '@typescript-eslint/naming-convention';
    config = { selector: 'default', format: ['camelCase'] };
  } else if (pattern.includes('semicolons') || pattern.includes('semi')) {
    rule = 'semi';
    config = ['error', 'always'];
  } else if (pattern.includes('quotes')) {
    rule = 'quotes';
    config = ['error', 'single'];
  } else {
    rule = pattern || 'TODO';
    config = {};
  }

  return { tool, rule, config };
}

function generateWorkflowTemplate(finding) {
  const dimension = finding.dimension || 'design';
  const packages = [...new Set((finding.affected_files || []).map(f => f.split('/')[0]))];

  return {
    steps: [
      { name: 'detect', action: `scan affected packages for ${finding.pattern || 'pattern'}` },
      { name: 'validate', action: 'run cross-package consistency check' },
      { name: 'report', action: 'aggregate results and flag violations' },
    ],
    trigger: 'pre-merge',
    scope: packages.length > 0 ? packages.join(', ') : 'all packages',
    dimension,
  };
}

// --- Core functions ---

/**
 * Load findings from CR reports in a work directory.
 */
function loadFindings(workDir, deps) {
  const { existsSync, readFileSync, readdirSync, join } = deps;
  const findings = [];

  // Read from cr/ directory
  const crDir = join(workDir, 'cr');
  if (!existsSync(crDir)) return findings;

  const crFiles = readdirSync(crDir).filter(f => f.endsWith('.json'));
  for (const file of crFiles) {
    try {
      const content = JSON.parse(readFileSync(join(crDir, file), 'utf8'));
      const items = content.findings || content.issues || [];
      for (const item of items) {
        findings.push({
          ...item,
          source_file: file,
          id: item.id || `${item.dimension || 'unknown'}:${item.pattern || 'unknown'}-${findings.length}`,
        });
      }
    } catch { /* skip unparseable files */ }
  }

  return findings;
}

/**
 * Route all findings to their optimal durable fix mechanism.
 */
function routeFindings(workDir, deps) {
  deps = resolveDeps(deps);
  const findings = loadFindings(workDir, deps);
  const recommendations = [];

  for (const finding of findings) {
    const recommendedType = classifyPattern(finding);
    const scores = scoreRouting(finding, recommendedType);
    const template = generateTemplate(finding, recommendedType);

    // Determine alternative types
    const alternativeTypes = computeAlternatives(finding, recommendedType);

    recommendations.push({
      findingId: finding.id,
      dimension: finding.dimension || 'unknown',
      recommendedType,
      score: scores.total,
      reasoning: buildReasoning(finding, recommendedType),
      template,
      alternativeTypes,
      scores,
    });
  }

  recommendations.sort((a, b) => b.score - a.score);
  return { total: findings.length, recommendations };
}

function computeAlternatives(finding, primary) {
  const all = ['lint-config', 'hook', 'rule', 'workflow', 'human-gated'];
  const alternatives = [];

  for (const type of all) {
    if (type === primary) continue;
    // Only include plausible alternatives
    if (type === 'hook' && (finding.recurs_in_precommit || finding.seen_in_runs >= 2)) {
      alternatives.push(type);
    } else if (type === 'rule' && finding.dimension === 'security') {
      alternatives.push(type);
    } else if (type === 'lint-config' && LINT_PATTERNS.has(finding.pattern)) {
      alternatives.push(type);
    } else if (type === 'workflow' && finding.cross_package) {
      alternatives.push(type);
    }
  }

  return alternatives.filter(t => t !== primary);
}

function buildReasoning(finding, type) {
  const pattern = finding.pattern || 'unknown pattern';
  switch (type) {
    case 'lint-config':
      return `Pattern "${pattern}" is a style/formatting concern best enforced by lint tooling`;
    case 'hook':
      return `Pattern "${pattern}" recurs in pre-commit window, best caught by hook automation`;
    case 'rule':
      return `Pattern "${pattern}" requires context-aware review, best as custom review rule`;
    case 'workflow':
      return `Pattern "${pattern}" spans multiple packages, needs cross-package workflow`;
    case 'human-gated':
      return `Pattern "${pattern}" requires human judgment, flagged for manual review`;
    default:
      return `Pattern "${pattern}" routed to ${type}`;
  }
}

/**
 * Batch route all findings, filter by minimum score.
 */
function batchRecommend(workDir, minScore, deps) {
  deps = resolveDeps(deps);
  minScore = typeof minScore === 'number' ? minScore : 5;
  const { total, recommendations } = routeFindings(workDir, deps);
  const filtered = recommendations.filter(r => r.score >= minScore);
  return {
    total,
    filtered: filtered.length,
    minScore,
    recommendations: filtered,
  };
}

// --- CLI ---

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const jsonFlag = rest.includes('--json');

  switch (cmd) {
    case 'route': {
      const workDir = rest.find(a => !a.startsWith('--'));
      if (!workDir) {
        process.stderr.write('Error: <work-dir> is required\n');
        process.exit(1);
      }
      const result = routeFindings(workDir);
      if (jsonFlag) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Routed ${result.total} findings:`);
        for (const rec of result.recommendations) {
          console.log(`  [${rec.score}/10] ${rec.findingId} → ${rec.recommendedType} (${rec.dimension})`);
        }
        if (result.recommendations.length === 0) console.log('  (no findings found)');
      }
      break;
    }
    case 'generate': {
      const workDir = rest.find(a => !a.startsWith('--'));
      const findingIdx = rest.indexOf('--finding');
      const typeIdx = rest.indexOf('--type');
      const outputIdx = rest.indexOf('--output');

      if (!workDir || findingIdx < 0 || typeIdx < 0) {
        process.stderr.write('Error: <work-dir> --finding <id> --type <type> required\n');
        process.exit(1);
      }

      const findingId = rest[findingIdx + 1];
      const type = rest[typeIdx + 1];
      const outputDir = outputIdx >= 0 ? rest[outputIdx + 1] : null;

      const deps = resolveDeps();
      const findings = loadFindings(workDir, deps);
      const finding = findings.find(f => f.id === findingId);

      if (!finding) {
        process.stderr.write(`Error: finding "${findingId}" not found\n`);
        process.exit(1);
      }

      const template = generateTemplate(finding, type);
      if (!template) {
        process.stderr.write(`Error: unsupported type "${type}"\n`);
        process.exit(1);
      }

      if (outputDir) {
        const { mkdirSync, writeFileSync, join } = deps;
        mkdirSync(outputDir, { recursive: true });
        writeFileSync(join(outputDir, 'template.json'), JSON.stringify(template, null, 2) + '\n');
        console.log(`Template written to ${join(outputDir, 'template.json')}`);
      } else {
        console.log(JSON.stringify(template, null, 2));
      }
      break;
    }
    case 'batch': {
      const workDir = rest.find(a => !a.startsWith('--'));
      if (!workDir) {
        process.stderr.write('Error: <work-dir> is required\n');
        process.exit(1);
      }
      const minScoreIdx = rest.indexOf('--min-score');
      const minScore = minScoreIdx >= 0 ? Number(rest[minScoreIdx + 1]) : 5;
      const result = batchRecommend(workDir, minScore);
      if (jsonFlag) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Batch: ${result.filtered}/${result.total} findings meet min-score ${result.minScore}:`);
        for (const rec of result.recommendations) {
          console.log(`  [${rec.score}/10] ${rec.findingId} → ${rec.recommendedType}`);
        }
        if (result.filtered === 0) console.log('  (none)');
      }
      break;
    }
    default:
      process.stderr.write('用法: node findings-recommend.js <route|generate|batch> [...args]\n');
      process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { routeFindings, generateTemplate, batchRecommend, classifyPattern };
