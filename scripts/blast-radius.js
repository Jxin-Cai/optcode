#!/usr/bin/env node
/**
 * optcode blast radius calculator — estimates the impact scope of code changes.
 *
 * Parses git diff to extract changed symbols, builds a reverse dependency graph
 * via grep-based fan-in analysis, then BFS-propagates to compute a risk score.
 *
 * Risk score formula:
 *   score = min(100, directFanIn * 10 + transitiveReach * 3 + changedFileCount * 5)
 *
 * Severity thresholds:
 *   0-25: low (safe to auto-fix)
 *   26-50: moderate (review recommended)
 *   51-75: high (manual review required)
 *   76-100: critical (block auto-fix)
 *
 * Usage:
 *   node blast-radius.js <base-commit> [--json] [--threshold <n>]
 *   node blast-radius.js --files <file1> <file2> ... [--json]
 */
const { execSync: _execSync, execFileSync: _execFileSync } = require('node:child_process');
const { existsSync: _existsSync, readFileSync: _readFileSync } = require('node:fs');
const { basename, extname, resolve } = require('node:path');

const SEVERITY_THRESHOLDS = { low: 25, moderate: 50, high: 75, critical: 100 };

class GitFailureError extends Error {
  constructor(message, { code, command, stderr, ref } = {}) {
    super(message);
    this.name = 'GitFailureError';
    this.code = code;
    this.command = command || '';
    this.stderr = stderr || '';
    this.ref = ref || '';
  }
}

function isGitFailureError(error) {
  if (!error) return false;
  return error instanceof GitFailureError || error.name === 'GitFailureError';
}

const SYMBOL_PATTERNS = {
  '.js': /(?:function\s+|const\s+|let\s+|var\s+|class\s+|export\s+(?:default\s+)?(?:function\s+|class\s+|const\s+))([A-Za-z_$][\w$]*)/g,
  '.ts': /(?:function\s+|const\s+|let\s+|var\s+|class\s+|interface\s+|type\s+|enum\s+|export\s+(?:default\s+)?(?:function\s+|class\s+|const\s+|interface\s+|type\s+))([A-Za-z_$][\w$]*)/g,
  '.py': /(?:def\s+|class\s+)([A-Za-z_][\w]*)/g,
  '.go': /(?:func\s+(?:\([^)]*\)\s+)?|type\s+)([A-Z_a-z][\w]*)/g,
  '.rb': /(?:def\s+|class\s+|module\s+)([A-Za-z_][\w]*)/g,
  '.java': /(?:class\s+|interface\s+|enum\s+|(?:public|private|protected)\s+(?:static\s+)?(?:\w+\s+))([A-Z][\w]*)/g,
};

function getChangedFiles(baseCommit, deps = {}) {
  const execFileSyncFn = deps.execFileSync || _execFileSync;
  const gitArgs = ['diff', '--name-only', baseCommit];
  try {
    const output = execFileSyncFn('git', gitArgs, { encoding: 'utf8' });
    return output.trim().split('\n').filter(Boolean);
  } catch (err) {
    throw new GitFailureError(`git diff failed: ${err.message}`, {
      code: err.status || err.code,
      command: `git ${gitArgs.join(' ')}`,
      stderr: err.stderr || '',
      ref: baseCommit,
    });
  }
}

function getChangedSymbols(baseCommit, deps = {}) {
  const execFileSyncFn = deps.execFileSync || _execFileSync;
  const symbols = new Map();
  const gitArgs = ['diff', '-U0', baseCommit];
  try {
    const diff = execFileSyncFn('git', gitArgs, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    let currentFile = null;
    for (const line of diff.split('\n')) {
      if (line.startsWith('+++ b/')) {
        currentFile = line.slice(6);
      } else if (line.startsWith('+') && !line.startsWith('+++') && currentFile) {
        const ext = extname(currentFile);
        const patterns = SYMBOL_PATTERNS[ext];
        if (!patterns) continue;
        const regex = new RegExp(patterns.source, patterns.flags);
        let match;
        while ((match = regex.exec(line)) !== null) {
          if (match[1] && match[1].length > 2) {
            if (!symbols.has(match[1])) symbols.set(match[1], new Set());
            symbols.get(match[1]).add(currentFile);
          }
        }
      }
    }
  } catch (err) {
    throw new GitFailureError(`git diff -U0 failed: ${err.message}`, {
      code: err.status || err.code,
      command: `git ${gitArgs.join(' ')}`,
      stderr: err.stderr || '',
      ref: baseCommit,
    });
  }
  return symbols;
}

function findReferences(symbol, changedFiles, maxResults = 50, deps = {}) {
  const execFileSyncFn = deps.execFileSync || _execFileSync;
  try {
    const output = execFileSyncFn(
      'git',
      ['grep', '-l', '--fixed-strings', symbol, '--', '*.js', '*.ts', '*.py', '*.go', '*.rb', '*.java', '*.jsx', '*.tsx'],
      { encoding: 'utf8', timeout: 5000 }
    );
    return output.trim().split('\n').filter(f => f && !changedFiles.includes(f)).slice(0, maxResults);
  } catch {
    return [];
  }
}

function computeBlastRadius(baseCommit, targetFiles, deps = {}) {
  try {
    const changedFiles = targetFiles || getChangedFiles(baseCommit, deps);
    if (changedFiles.length === 0) {
      return { score: 0, severity: 'low', changedFiles: [], symbols: [], dependents: [], graph: {} };
    }

    const symbols = baseCommit ? getChangedSymbols(baseCommit, deps) : new Map();
    const graph = {};
    const allDependents = new Set();

    for (const [symbol, definedIn] of symbols) {
      const refs = findReferences(symbol, changedFiles, 50, deps);
      if (refs.length > 0) {
        graph[symbol] = { definedIn: [...definedIn], referencedBy: refs };
        refs.forEach(f => allDependents.add(f));
      }
    }

    // BFS: transitive dependents (one level deep to avoid explosion)
    const transitiveReach = new Set();
    for (const dep of allDependents) {
      const depBasename = basename(dep, extname(dep));
      if (depBasename.length > 2) {
        const transRefs = findReferences(depBasename, [...changedFiles, ...allDependents], 10, deps);
        transRefs.forEach(f => transitiveReach.add(f));
      }
    }

    const directFanIn = allDependents.size;
    const score = Math.min(100, directFanIn * 10 + transitiveReach.size * 3 + changedFiles.length * 5);
    const severity = score <= 25 ? 'low' : score <= 50 ? 'moderate' : score <= 75 ? 'high' : 'critical';

    return {
      score,
      severity,
      changedFiles,
      changedFileCount: changedFiles.length,
      symbols: [...symbols.keys()],
      directFanIn,
      transitiveReach: transitiveReach.size,
      dependents: [...allDependents].slice(0, 20),
      graph,
    };
  } catch (err) {
    if (isGitFailureError(err)) {
      return {
        score: 100,
        severity: 'critical',
        shouldBlock: true,
        status: 'error',
        error: err.message,
        changedFiles: [],
        symbols: [],
        dependents: [],
        graph: {},
      };
    }
    throw err;
  }
}

function shouldBlock(score, threshold = 75) {
  return score >= threshold;
}

function main() {
  const args = process.argv.slice(2);
  const jsonFlag = args.includes('--json');
  const thresholdIdx = args.indexOf('--threshold');
  const threshold = thresholdIdx !== -1 ? Number(args[thresholdIdx + 1]) : 75;
  const filesIdx = args.indexOf('--files');

  let result;
  if (filesIdx !== -1) {
    const files = args.slice(filesIdx + 1).filter(f => !f.startsWith('--'));
    result = computeBlastRadius(null, files);
  } else {
    const baseCommit = args.find(a => !a.startsWith('--'));
    if (!baseCommit) {
      process.stderr.write('用法: node blast-radius.js <base-commit> [--json] [--threshold <n>]\n');
      process.exit(1);
    }
    result = computeBlastRadius(baseCommit);
  }

  result.shouldBlock = shouldBlock(result.score, threshold);
  result.threshold = threshold;

  if (jsonFlag) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const icon = result.severity === 'low' ? '✓' : result.severity === 'moderate' ? '⚠' : result.severity === 'high' ? '✗' : '⛔';
    console.log(`${icon} Blast radius: ${result.score}/100 (${result.severity})`);
    console.log(`  Changed files: ${result.changedFileCount}`);
    console.log(`  Changed symbols: ${result.symbols.length}`);
    console.log(`  Direct fan-in: ${result.directFanIn}`);
    console.log(`  Transitive reach: ${result.transitiveReach}`);
    if (result.shouldBlock) {
      console.log(`  ⛔ BLOCKED: score ${result.score} >= threshold ${threshold}`);
    }
    if (result.dependents.length > 0) {
      console.log(`  Dependent files (top ${Math.min(result.dependents.length, 20)}):`);
      result.dependents.forEach(f => console.log(`    - ${f}`));
    }
  }

  if (result.shouldBlock) process.exit(2);
}

if (require.main === module) main();
module.exports = { computeBlastRadius, shouldBlock, SEVERITY_THRESHOLDS, GitFailureError, isGitFailureError };
