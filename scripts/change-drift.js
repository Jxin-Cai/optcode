#!/usr/bin/env node
/**
 * optcode change drift analyzer — estimates diff impact and identifies core candidates.
 *
 * Enhances context-freeze by providing quantitative analysis of what changed
 * and which changed files deserve extra review attention based on their centrality.
 *
 * Usage:
 *   node change-drift.js diff-impact <base-commit> [--json]
 *   node change-drift.js core-candidates <base-commit> [--max-commits <n>] [--json]
 *   node change-drift.js full <base-commit> [--json]
 */
const { execSync: _execSync } = require('node:child_process');
const { extname } = require('node:path');

// --- File role classification constants ---

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.java', '.rs', '.rb', '.c', '.cpp', '.h']);
const TEST_PATTERNS = [/\.test\./, /\.spec\./, /__tests__\//, /test\//, /tests\//];
const CONFIG_PATTERNS = [/\.config\./, /rc$/, /package\.json$/, /tsconfig/, /webpack/, /vite\.config/, /\.json$.*config/i, /jest\./, /babel\./, /eslint/, /prettier/];
const DOC_EXTENSIONS = new Set(['.md', '.txt', '.rst', '.adoc']);

// --- Impact weights ---

const ROLE_WEIGHTS = { source: 3, test: 1, config: 2, docs: 0.5, generated: 0 };
const CORE_THRESHOLD = 15;

// --- Helpers ---

function classifyFileRole(filePath) {
  if (TEST_PATTERNS.some(p => p.test(filePath))) return 'test';
  if (CONFIG_PATTERNS.some(p => p.test(filePath))) return 'config';
  const ext = extname(filePath);
  if (DOC_EXTENSIONS.has(ext)) return 'docs';
  if (SOURCE_EXTENSIONS.has(ext)) return 'source';
  // lock files, generated manifests, etc.
  if (/package-lock\.json$|yarn\.lock$|\.lock$|node_modules\//.test(filePath)) return 'generated';
  return 'source'; // default: treat unknown as source for safety
}

function parseDiffNumstat(output) {
  const files = [];
  for (const line of output.trim().split('\n')) {
    if (!line) continue;
    const [added, removed, filePath] = line.split('\t');
    if (!filePath) continue;
    // binary files show '-' for added/removed
    const linesAdded = added === '-' ? 0 : Number(added);
    const linesRemoved = removed === '-' ? 0 : Number(removed);
    files.push({ path: filePath, linesAdded, linesRemoved, totalDelta: linesAdded + linesRemoved });
  }
  return files;
}

// --- Core functions ---

function analyzeDiffImpact(baseCommit, deps = {}) {
  const execSyncFn = deps.execSync || _execSync;

  let numstatOutput;
  try {
    numstatOutput = execSyncFn(`git diff --numstat ${baseCommit}`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    return { error: `git diff failed: ${err.message}`, files: [], summary: {}, weightedImpact: 0 };
  }

  const files = parseDiffNumstat(numstatOutput);
  const byRole = { source: [], test: [], config: [], docs: [], generated: [] };
  const summary = { source: 0, test: 0, config: 0, docs: 0, generated: 0, totalFiles: files.length, totalDelta: 0 };

  for (const file of files) {
    const role = classifyFileRole(file.path);
    file.role = role;
    byRole[role] = byRole[role] || [];
    byRole[role].push(file);
    summary[role] += file.totalDelta;
    summary.totalDelta += file.totalDelta;
  }

  const weightedImpact =
    summary.source * ROLE_WEIGHTS.source +
    summary.test * ROLE_WEIGHTS.test +
    summary.config * ROLE_WEIGHTS.config +
    summary.docs * ROLE_WEIGHTS.docs +
    summary.generated * ROLE_WEIGHTS.generated;

  return {
    baseCommit,
    files,
    byRole,
    summary,
    weightedImpact: Math.round(weightedImpact * 100) / 100,
  };
}

function identifyCoreCandidates(baseCommit, opts = {}, deps = {}) {
  const execSyncFn = deps.execSync || _execSync;
  const maxCommits = opts.maxCommits || 500;
  const threshold = opts.threshold || CORE_THRESHOLD;

  // Get changed source files
  let numstatOutput;
  try {
    numstatOutput = execSyncFn(`git diff --numstat ${baseCommit}`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    return { error: `git diff failed: ${err.message}`, candidates: [] };
  }

  const allFiles = parseDiffNumstat(numstatOutput);
  const sourceFiles = allFiles
    .map(f => ({ ...f, role: classifyFileRole(f.path) }))
    .filter(f => f.role === 'source');

  if (sourceFiles.length === 0) {
    return { baseCommit, candidates: [], sourceFileCount: 0, threshold };
  }

  // Get all tracked files for fan-in analysis
  let trackedFiles = [];
  try {
    const output = execSyncFn('git ls-files', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    trackedFiles = output.trim().split('\n').filter(Boolean);
  } catch { /* ignore — fan-in will be 0 */ }

  // For each source file, compute fan-in (how many other tracked files import/require it)
  const candidates = [];
  for (const file of sourceFiles) {
    const fileName = file.path.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
    // skip very short names to avoid false positives
    if (fileName.length <= 2) {
      candidates.push({ path: file.path, fanIn: 0, churn30: 0, churn90: 0, churn180: 0, score: 0, isCore: false });
      continue;
    }

    // Fan-in: count files that import/require this file
    let fanIn = 0;
    try {
      const grepOutput = execSyncFn(
        `git grep -l -E "(import|require).*${fileName}" -- '*.js' '*.ts' '*.jsx' '*.tsx' '*.mjs' '*.cjs' 2>/dev/null | wc -l`,
        { encoding: 'utf8', timeout: 5000 }
      );
      fanIn = Math.max(0, Number(grepOutput.trim()) - 1); // subtract self
    } catch { fanIn = 0; }

    // Churn: count commits touching this file in 30/90/180 day windows
    let churn30 = 0, churn90 = 0, churn180 = 0;
    try {
      const c30 = execSyncFn(
        `git log --oneline --since="30 days ago" -n ${maxCommits} -- "${file.path}" 2>/dev/null | wc -l`,
        { encoding: 'utf8', timeout: 5000 }
      );
      churn30 = Number(c30.trim());
    } catch { churn30 = 0; }
    try {
      const c90 = execSyncFn(
        `git log --oneline --since="90 days ago" -n ${maxCommits} -- "${file.path}" 2>/dev/null | wc -l`,
        { encoding: 'utf8', timeout: 5000 }
      );
      churn90 = Number(c90.trim());
    } catch { churn90 = 0; }
    try {
      const c180 = execSyncFn(
        `git log --oneline --since="180 days ago" -n ${maxCommits} -- "${file.path}" 2>/dev/null | wc -l`,
        { encoding: 'utf8', timeout: 5000 }
      );
      churn180 = Number(c180.trim());
    } catch { churn180 = 0; }

    const score = fanIn * 5 + churn30 * 3 + churn90 * 1;
    candidates.push({
      path: file.path,
      fanIn,
      churn30,
      churn90,
      churn180,
      score,
      isCore: score >= threshold,
    });
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  return {
    baseCommit,
    candidates,
    sourceFileCount: sourceFiles.length,
    coreCount: candidates.filter(c => c.isCore).length,
    threshold,
  };
}

function analyzeFullDrift(baseCommit, opts = {}, deps = {}) {
  const impact = analyzeDiffImpact(baseCommit, deps);
  const core = identifyCoreCandidates(baseCommit, opts, deps);

  return {
    baseCommit,
    impact,
    core,
    summary: {
      totalFiles: impact.summary ? impact.summary.totalFiles : 0,
      totalDelta: impact.summary ? impact.summary.totalDelta : 0,
      weightedImpact: impact.weightedImpact || 0,
      coreCount: core.coreCount || 0,
      sourceFileCount: core.sourceFileCount || 0,
    },
  };
}

// --- CLI ---

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const jsonFlag = args.includes('--json');
  const maxCommitsIdx = args.indexOf('--max-commits');
  const maxCommits = maxCommitsIdx !== -1 ? Number(args[maxCommitsIdx + 1]) : 500;

  if (!cmd || cmd.startsWith('--')) {
    process.stderr.write(
      '用法:\n' +
      '  node change-drift.js diff-impact <base-commit> [--json]\n' +
      '  node change-drift.js core-candidates <base-commit> [--max-commits <n>] [--json]\n' +
      '  node change-drift.js full <base-commit> [--json]\n'
    );
    process.exit(1);
  }

  const baseCommit = args[1];
  if (!baseCommit || baseCommit.startsWith('--')) {
    process.stderr.write('错误: 必须提供 base-commit 参数\n');
    process.exit(1);
  }

  // Reject refs that look like shell injection
  if (/[;&|`$]/.test(baseCommit)) {
    process.stderr.write('错误: invalid base ref\n');
    process.exit(1);
  }

  let result;
  switch (cmd) {
    case 'diff-impact':
      result = analyzeDiffImpact(baseCommit);
      break;
    case 'core-candidates':
      result = identifyCoreCandidates(baseCommit, { maxCommits });
      break;
    case 'full':
      result = analyzeFullDrift(baseCommit, { maxCommits });
      break;
    default:
      process.stderr.write(`未知命令: ${cmd}\n`);
      process.exit(1);
  }

  if (jsonFlag) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(cmd, result);
  }
}

function printHuman(cmd, result) {
  if (result.error) {
    console.log(`✗ ${result.error}`);
    return;
  }

  if (cmd === 'diff-impact' || cmd === 'full') {
    const impact = cmd === 'full' ? result.impact : result;
    console.log(`■ Diff Impact Analysis (base: ${impact.baseCommit})`);
    console.log(`  Total files changed: ${impact.summary.totalFiles}`);
    console.log(`  Total lines delta: ${impact.summary.totalDelta}`);
    console.log(`  Weighted impact score: ${impact.weightedImpact}`);
    console.log(`  Breakdown: source=${impact.summary.source} test=${impact.summary.test} config=${impact.summary.config} docs=${impact.summary.docs}`);
  }

  if (cmd === 'core-candidates' || cmd === 'full') {
    const core = cmd === 'full' ? result.core : result;
    if (cmd === 'full') console.log('');
    console.log(`■ Core Candidates (threshold: ${core.threshold})`);
    console.log(`  Source files analyzed: ${core.sourceFileCount}`);
    console.log(`  Core candidates found: ${core.coreCount}`);
    const coreCandidates = core.candidates.filter(c => c.isCore);
    if (coreCandidates.length > 0) {
      console.log('  ─────────────────────────────────────');
      for (const c of coreCandidates.slice(0, 15)) {
        console.log(`  ★ ${c.path} (score=${c.score}, fan-in=${c.fanIn}, churn30=${c.churn30})`);
      }
    }
  }
}

if (require.main === module) main();
module.exports = {
  analyzeDiffImpact,
  identifyCoreCandidates,
  analyzeFullDrift,
  classifyFileRole,
  SOURCE_EXTENSIONS,
  TEST_PATTERNS,
  CONFIG_PATTERNS,
  DOC_EXTENSIONS,
  ROLE_WEIGHTS,
  CORE_THRESHOLD,
};
