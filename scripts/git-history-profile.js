#!/usr/bin/env node
/**
 * optcode git history profiler — analyzes git history to identify risk hotspots
 * for smarter code review prioritization.
 *
 * Combines file churn frequency, contributor distribution, and size-based
 * complexity proxy to surface files most likely to harbor defects.
 *
 * Usage:
 *   node git-history-profile.js churn [--days <n>] [--top <n>] [--json]
 *   node git-history-profile.js contributors [--days <n>] [--json]
 *   node git-history-profile.js hotspots [--days <n>] [--top <n>] [--json]
 *   node git-history-profile.js profile [--json]
 */
const { execSync: _execSync } = require('node:child_process');

const IGNORED_PATTERNS = [
  /^node_modules\//,
  /^vendor\//,
  /^dist\//,
  /^build\//,
  /^\.git\//,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
];

const GIT_TIMEOUT = 5000;

function isIgnored(file) {
  return IGNORED_PATTERNS.some(p => p.test(file));
}

function execGit(command, deps = {}) {
  const execSyncFn = deps.execSync || _execSync;
  try {
    return execSyncFn(command, { encoding: 'utf8', timeout: GIT_TIMEOUT, maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    return '';
  }
}

function countFileLines(file, deps = {}) {
  const output = execGit(`git show HEAD:"${file}" 2>/dev/null | wc -l`, deps);
  const n = parseInt(output.trim(), 10);
  return Number.isNaN(n) ? 0 : n;
}

function getChurnForWindow(days, deps = {}) {
  const output = execGit(
    `git log --no-merges --name-only --pretty=format:'' --since="${days} days ago"`,
    deps
  );
  const counts = new Map();
  for (const line of output.split('\n')) {
    const file = line.trim();
    if (!file || isIgnored(file)) continue;
    counts.set(file, (counts.get(file) || 0) + 1);
  }
  return counts;
}

/**
 * Analyze file modification frequency across multiple time windows.
 */
function analyzeChurn(options = {}, deps = {}) {
  const top = options.top || 20;

  const churn30 = getChurnForWindow(30, deps);
  const churn90 = getChurnForWindow(90, deps);
  const churn180 = getChurnForWindow(180, deps);

  const allFiles = new Set([...churn30.keys(), ...churn90.keys(), ...churn180.keys()]);
  const results = [];

  for (const file of allFiles) {
    const c30 = churn30.get(file) || 0;
    const c90 = churn90.get(file) || 0;
    const c180 = churn180.get(file) || 0;
    results.push({
      file,
      churn30: c30,
      churn90: c90,
      churn180: c180,
      totalChurn: c30 + c90 + c180,
    });
  }

  results.sort((a, b) => b.totalChurn - a.totalChurn);
  return results.slice(0, top);
}

/**
 * Analyze contributor distribution per file.
 */
function analyzeContributors(options = {}, deps = {}) {
  const days = options.days || 180;

  const output = execGit(
    `git log --no-merges --pretty=format:'' --name-only --since="${days} days ago"`,
    deps
  );

  // Collect all files that were modified in the window
  const filesInWindow = new Set();
  for (const line of output.split('\n')) {
    const file = line.trim();
    if (file && !isIgnored(file)) filesInWindow.add(file);
  }

  const results = [];
  for (const file of filesInWindow) {
    const authorOutput = execGit(
      `git log --no-merges --pretty=format:'%ae' --since="${days} days ago" -- "${file}"`,
      deps
    );
    const authors = [...new Set(authorOutput.split('\n').map(l => l.trim()).filter(Boolean))];
    results.push({
      file,
      authorCount: authors.length,
      authors,
      busFactorRisk: authors.length <= 1,
    });
  }

  results.sort((a, b) => b.authorCount - a.authorCount);
  return results;
}

/**
 * Identify hotspots by combining churn, contributors, and complexity proxy.
 *
 * hotspot_score = churn_30 * 3 + churn_90 * 1 + author_count * 2 + (file_size > 500 ? 5 : 0)
 */
function identifyHotspots(options = {}, deps = {}) {
  const top = options.top || 20;
  const days = options.days || 90;

  const churn30 = getChurnForWindow(30, deps);
  const churn90 = getChurnForWindow(Math.min(days, 90), deps);

  const allFiles = new Set([...churn30.keys(), ...churn90.keys()]);
  const results = [];

  for (const file of allFiles) {
    const c30 = churn30.get(file) || 0;
    const c90 = churn90.get(file) || 0;

    // contributor count for this file
    const authorOutput = execGit(
      `git log --no-merges --pretty=format:'%ae' --since="${days} days ago" -- "${file}"`,
      deps
    );
    const authors = [...new Set(authorOutput.split('\n').map(l => l.trim()).filter(Boolean))];
    const authorCount = authors.length;

    // size proxy
    const lineCount = countFileLines(file, deps);
    const sizeRisk = lineCount > 500;

    const score = c30 * 3 + c90 * 1 + authorCount * 2 + (sizeRisk ? 5 : 0);

    let classification;
    if (score > 50) classification = 'critical';
    else if (score > 30) classification = 'high';
    else if (score > 15) classification = 'moderate';
    else classification = 'low';

    results.push({ file, score, churn30: c30, churn90: c90, authorCount, sizeRisk, classification });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, top);
}

/**
 * Build a full repository profile combining all analyses.
 */
function buildProfile(options = {}, deps = {}) {
  // Summary stats
  const totalCommitsOutput = execGit('git rev-list --count HEAD', deps);
  const totalCommits = parseInt(totalCommitsOutput.trim(), 10) || 0;

  const contributorsOutput = execGit('git log --no-merges --pretty=format:\'%ae\' | sort -u', deps);
  const activeContributors = contributorsOutput.split('\n').filter(Boolean).length;

  const firstCommitOutput = execGit('git log --reverse --pretty=format:\'%ai\' | head -1', deps);
  const repoAge = firstCommitOutput.trim() || 'unknown';

  const languagesOutput = execGit(
    'git ls-files | grep -oE \'\\.[a-zA-Z0-9]+$\' | sort | uniq -c | sort -rn | head -10',
    deps
  );
  const languages = languagesOutput.split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const parts = l.split(/\s+/);
      return { count: parseInt(parts[0], 10), ext: parts[1] };
    });

  const churnTop20 = analyzeChurn({ top: 20 }, deps);
  const hotspots = identifyHotspots({ top: 20 }, deps);
  const contributorStats = analyzeContributors(options, deps);

  return {
    summary: {
      totalCommits,
      activeContributors,
      repoAge,
      languages,
    },
    churnTop20,
    hotspots,
    contributorStats,
  };
}

function main() {
  const args = process.argv.slice(2);
  const subcommand = args[0];
  const jsonFlag = args.includes('--json');

  const daysIdx = args.indexOf('--days');
  const days = daysIdx !== -1 ? Number(args[daysIdx + 1]) : undefined;

  const topIdx = args.indexOf('--top');
  const top = topIdx !== -1 ? Number(args[topIdx + 1]) : undefined;

  const options = {};
  if (days) options.days = days;
  if (top) options.top = top;

  if (!subcommand || !['churn', 'contributors', 'hotspots', 'profile'].includes(subcommand)) {
    process.stderr.write(
      '用法:\n' +
      '  node git-history-profile.js churn [--days <n>] [--top <n>] [--json]\n' +
      '  node git-history-profile.js contributors [--days <n>] [--json]\n' +
      '  node git-history-profile.js hotspots [--days <n>] [--top <n>] [--json]\n' +
      '  node git-history-profile.js profile [--json]\n'
    );
    process.exit(1);
  }

  let result;
  switch (subcommand) {
    case 'churn':
      result = analyzeChurn(options);
      break;
    case 'contributors':
      result = analyzeContributors(options);
      break;
    case 'hotspots':
      result = identifyHotspots(options);
      break;
    case 'profile':
      result = buildProfile(options);
      break;
  }

  if (jsonFlag) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    formatHuman(subcommand, result);
  }
}

function formatHuman(subcommand, result) {
  switch (subcommand) {
    case 'churn': {
      console.log('File Churn Analysis');
      console.log('='.repeat(60));
      for (const entry of result) {
        console.log(`  ${entry.file}`);
        console.log(`    30d: ${entry.churn30}  90d: ${entry.churn90}  180d: ${entry.churn180}  total: ${entry.totalChurn}`);
      }
      break;
    }
    case 'contributors': {
      console.log('Contributor Distribution');
      console.log('='.repeat(60));
      for (const entry of result.slice(0, 20)) {
        const risk = entry.busFactorRisk ? ' [BUS FACTOR RISK]' : '';
        console.log(`  ${entry.file} — ${entry.authorCount} author(s)${risk}`);
      }
      break;
    }
    case 'hotspots': {
      console.log('Risk Hotspots');
      console.log('='.repeat(60));
      for (const entry of result) {
        const icon = entry.classification === 'critical' ? '⛔' :
          entry.classification === 'high' ? '✗' :
          entry.classification === 'moderate' ? '⚠' : '✓';
        console.log(`  ${icon} [${entry.score}] ${entry.file} (${entry.classification})`);
        console.log(`      churn30=${entry.churn30} churn90=${entry.churn90} authors=${entry.authorCount} sizeRisk=${entry.sizeRisk}`);
      }
      break;
    }
    case 'profile': {
      console.log('Repository Profile');
      console.log('='.repeat(60));
      console.log(`  Total commits: ${result.summary.totalCommits}`);
      console.log(`  Active contributors: ${result.summary.activeContributors}`);
      console.log(`  Repo age (first commit): ${result.summary.repoAge}`);
      console.log(`  Top languages: ${result.summary.languages.map(l => l.ext).join(', ')}`);
      console.log('');
      console.log(`  Top churn files: ${result.churnTop20.length}`);
      console.log(`  Hotspots: ${result.hotspots.length}`);
      break;
    }
  }
}

if (require.main === module) main();
module.exports = { analyzeChurn, analyzeContributors, identifyHotspots, buildProfile };
