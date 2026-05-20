#!/usr/bin/env node
/**
 * optcode file inventory generator.
 * Scans target paths for source code files and outputs a markdown table.
 *
 * Usage: node file-inventory.js <target_path1> [target_path2 ...]
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

const targets = process.argv.slice(2);

if (targets.length === 0) {
  process.stderr.write('用法: node file-inventory.js <target_path1> [target_path2 ...]\n');
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

const files = output.trim().split('\n').filter(Boolean);

if (files.length === 0) {
  console.log('# File Inventory\n\nNo source files found in the specified paths.');
  process.exit(0);
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

console.log('# File Inventory\n');
console.log('| Lines | File |');
console.log('|-------|------|');
for (const e of entries) {
  console.log(`| ${e.lines} | ${e.file} |`);
}
console.log(`\nTotal: ${entries.length} files, ${totalLines} lines`);
