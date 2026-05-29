#!/usr/bin/env node
/**
 * PostToolUse hook: injects workflow reminders after Write to .optcode/ paths.
 * Reminds the orchestrator to run gate-check after writing CR/fix reports.
 */
const { readFileSync } = require('node:fs');
const { resolve, relative } = require('node:path');

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

  const parts = relPath.split(/[/\\]/);
  if (parts.length < 3) return;

  const subPath = parts.slice(2).join('/');

  if (subPath.startsWith('cr/')) {
    const match = subPath.match(/cr\/([^/]+)-round-(\d+)\.md$/);
    if (match) {
      const [, dimension, round] = match;
      injectContext(`CR report written: ${subPath}. Record readiness with dimension-status --cr-ready ${dimension} ${round}, then rerun orchestration-status before any gate-check.`);
      return;
    }
    if (subPath.includes('-pass.md') || subPath.includes('-failed.md')) {
      injectContext(`CR final report written: ${subPath}. Record result via dimension-status.js and proceed to next step.`);
      return;
    }
  }

  if (subPath.startsWith('fix/')) {
    const match = subPath.match(/fix\/([^/]+)-round-(\d+)-fix\.md$/);
    if (match) {
      const [, dimension, round] = match;
      injectContext(`Fix report written: ${subPath}. Record readiness with dimension-status --fix-ready ${dimension} ${round}, then rerun orchestration-status before any gate-check.`);
      return;
    }
  }

  if (subPath === 'summary.md') {
    injectContext('Summary written. Rerun orchestration-status and follow the returned summary gate step.');
  }
}

main();
