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
const { existsSync, lstatSync, readdirSync, readFileSync } = require('node:fs');
const { join, basename } = require('node:path');
const { spawnSync } = require('node:child_process');

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
const extSet = new Set(SOURCE_EXTENSIONS);
const excludeSet = new Set(EXCLUDE_DIRS);

function sourceFile(file) {
  const ext = file.split('.').pop();
  if (!extSet.has(ext)) return false;
  const parts = file.split(/[\\/]/);
  return !parts.some(part => excludeSet.has(part));
}

function safeGitDiff(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) return '';
  return result.stdout.trim();
}

function validateBaseRef(baseRef) {
  if (!baseRef || baseRef.startsWith('-') || /[\0\n\r]/.test(baseRef)) {
    process.stderr.write('invalid base ref\n');
    process.exit(1);
  }
  return baseRef;
}

function scanPath(target, files) {
  if (!existsSync(target)) return;
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  if (stat.isFile()) {
    if (sourceFile(target)) files.add(target);
    return;
  }
  if (!stat.isDirectory()) return;
  if (excludeSet.has(basename(target))) return;

  for (const entry of readdirSync(target)) {
    scanPath(join(target, entry), files);
  }
}

function countLines(file) {
  try {
    const text = readFileSync(file, 'utf8');
    if (text.length === 0) return 0;
    return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
  } catch {
    return 0;
  }
}

let files;

if (isDiffMode) {
  const baseRef = validateBaseRef(args[1] || 'HEAD');
  const staged = safeGitDiff(['diff', '--cached', '--name-only', '--diff-filter=d']);
  const unstaged = safeGitDiff(['diff', '--name-only', '--diff-filter=d']);
  const vsBase = baseRef !== 'HEAD'
    ? safeGitDiff(['diff', '--name-only', '--diff-filter=d', baseRef])
    : '';

  const allFiles = new Set([
    ...staged.split('\n').filter(Boolean),
    ...unstaged.split('\n').filter(Boolean),
    ...vsBase.split('\n').filter(Boolean)
  ]);

  files = [...allFiles].filter(sourceFile);

  if (files.length === 0) {
    console.log('# File Inventory (diff mode)\n\nNo changed source files found.');
    process.exit(0);
  }
} else {
  const targets = args.flatMap(arg => arg.split(',').map(s => s.trim()).filter(Boolean));
  if (targets.length === 0) {
    process.stderr.write('用法: node file-inventory.js <target_path1> [target_path2 ...]\n      node file-inventory.js --diff [base_ref]\n');
    process.exit(1);
  }

  const fileSet = new Set();
  for (const target of targets) {
    scanPath(target, fileSet);
  }
  files = [...fileSet];

  if (files.length === 0) {
    console.log('# File Inventory\n\nNo source files found in the specified paths.');
    process.exit(0);
  }
}

const entries = [];
let totalLines = 0;

for (const file of files) {
  const lines = countLines(file);
  entries.push({ lines, file });
  totalLines += lines;
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
