#!/usr/bin/env node
/**
 * PostToolUse hook: injects workflow reminders after Write to .optcode/ paths.
 * Reminds the orchestrator to run gate-check after writing CR/fix reports.
 */
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { resolve, relative, join, dirname } = require('node:path');

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch { return ''; }
}

function injectContext(context) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: context
    }
  }));
}

function recordWriteMarker(cwd, toolName, filePath) {
  const markerDir = join(cwd, '.optcode', 'state');
  const markerPath = join(markerDir, 'last-write.json');
  try {
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(markerPath, JSON.stringify({
      updatedAt: new Date().toISOString(),
      toolName,
      filePath,
    }, null, 2) + '\n');
  } catch { /* best effort */ }
}

function main() {
  const raw = readStdin();
  if (!raw) return;

  let input;
  try { input = JSON.parse(raw); } catch { return; }

  const filePath = input.tool_input?.file_path;
  if (!filePath) return;

  const cwd = input.cwd || process.cwd();
  const absPath = resolve(cwd, filePath);
  const relPath = relative(cwd, absPath);

  if (!relPath.startsWith('.optcode/') && !relPath.startsWith('.optcode\\')) return;

  recordWriteMarker(cwd, input.tool_name || 'Write', absPath);

  const parts = relPath.split(/[/\\]/);
  if (parts.length < 3) return;

  const subPath = parts.slice(2).join('/');

  if (subPath.startsWith('cr/')) {
    const match = subPath.match(/cr\/([^/]+)-round-(\d+)\.md$/);
    if (match) {
      const [, dimension, round] = match;
      injectContext(`CR report written: ${subPath}. Run gate-check to validate: node scripts/gate-check.js <work-dir> cr-complete:${dimension}:${round}`);
      return;
    }
    if (subPath.includes('-pass.md') || subPath.includes('-failed.md')) {
      injectContext(`CR final report written: ${subPath}.`);
      return;
    }
  }

  if (subPath.startsWith('fix/')) {
    const match = subPath.match(/fix\/([^/]+)-round-(\d+)-fix\.md$/);
    if (match) {
      const [, dimension, round] = match;
      injectContext(`Fix report written: ${subPath}. Run gate-check to validate: node scripts/gate-check.js <work-dir> fix-complete:${dimension}:${round}`);
      return;
    }
  }

  if (subPath === 'summary.md') {
    injectContext('Summary written.');
  }
}

main();

module.exports = { recordWriteMarker };
