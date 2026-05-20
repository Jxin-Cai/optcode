#!/usr/bin/env node
/**
 * optcode file inventory generator.
 * Scans target paths for source code files and outputs a markdown table.
 *
 * Usage:
 *   node file-inventory.js <target_path1> [target_path2 ...]
 *   node file-inventory.js --diff [base_ref]
 * Output: markdown table with line counts, written to stdout.
 */
const { execSync } = require('node:child_process');

const SOURCE_EXTENSIONS = [
  'go', 'java', 'py', 'js', 'ts', 'tsx', 'jsx', 'rs',
  'cpp', 'c', 'h', 'hpp', 'rb', 'php', 'swift', 'kt',
  'scala', 'cs', 'vue', 'svelte', 'lua', 'sh', 'bash',
  'sql', 'proto', 'graphql', 'yaml', 'yml', 'toml', 'json'
];

const EXCLUDE_DIRS = [
  'node_modules', '.git', 'vendor', 'dist', 'build',
  '.optcode', '__pycache__', '.next', '.nuxt', 'target',
  'coverage', '.idea', '.vscode'
];

const args = process.argv.slice(2);
const isDiffMode = args[0] === '--diff';

let files;

if (isDiffMode) {
  const baseRef = args[1] || 'HEAD';
  const staged = execSync('git diff --cached --name-only --diff-filter=d 2>/dev/null || true', { encoding: 'utf8' }).trim();
  const unstaged = execSync('git diff --name-only --diff-filter=d 2>/dev/null || true', { encoding: 'utf8' }).trim();
  const vsBase = baseRef !== 'HEAD'
    ? execSync(`git diff --name-only --diff-filter=d ${baseRef} 2>/dev/null || true`, { encoding: 'utf8' }).trim()
    : '';

  const allFiles = new Set([
    ...staged.split('\n').filter(Boolean),
    ...unstaged.split('\n').filter(Boolean),
    ...vsBase.split('\n').filter(Boolean)
  ]);

  const extSet = new Set(SOURCE_EXTENSIONS);
  const excludeSet = new Set(EXCLUDE_DIRS);
  files = [...allFiles].filter(f => {
    const ext = f.split('.').pop();
    if (!extSet.has(ext)) return false;
    const parts = f.split('/');
    return !parts.some(p => excludeSet.has(p));
  });

  if (files.length === 0) {
    console.log('# File Inventory (diff mode)\n\nNo changed source files found.');
    process.exit(0);
  }
} else {
  const targets = args;
  if (targets.length === 0) {
    process.stderr.write('用法: node file-inventory.js <target_path1> [target_path2 ...]\n      node file-inventory.js --diff [base_ref]\n');
    process.exit(1);
  }

  const extPattern = SOURCE_EXTENSIONS.map(e => `-name "*.${e}"`).join(' -o ');
  const excludePattern = EXCLUDE_DIRS.map(d => `! -path "*/${d}/*"`).join(' ');
  const findCmd = `find ${targets.join(' ')} -type f \\( ${extPattern} \\) ${excludePattern} 2>/dev/null`;

  let output;
  try {
    output = execSync(findCmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    if (err.stdout) output = err.stdout;
    else { process.stderr.write('find command failed\n'); process.exit(1); }
  }
  files = output.trim().split('\n').filter(Boolean);

  if (files.length === 0) {
    console.log('# File Inventory\n\nNo source files found in the specified paths.');
    process.exit(0);
  }
}

const entries = [];
let totalLines = 0;

for (const file of files) {
  try {
    const wc = execSync(`wc -l < "${file}"`, { encoding: 'utf8' }).trim();
    const lines = parseInt(wc, 10) || 0;
    entries.push({ lines, file });
    totalLines += lines;
  } catch {
    entries.push({ lines: 0, file });
  }
}

entries.sort((a, b) => b.lines - a.lines);

const header = isDiffMode ? '# File Inventory (diff mode)\n' : '# File Inventory\n';
console.log(header);
console.log('| Lines | File |');
console.log('|-------|------|');
for (const e of entries) {
  console.log(`| ${e.lines} | ${e.file} |`);
}
console.log(`\nTotal: ${entries.length} files, ${totalLines} lines`);
