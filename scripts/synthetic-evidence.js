#!/usr/bin/env node
/**
 * optcode synthetic evidence detector — catches AI-fabricated references.
 *
 * Scans CR report findings for file paths, function/symbol names, and line
 * references, then verifies they actually exist in the target codebase.
 *
 * Catches:
 *   - File paths that don't exist
 *   - Function/method names not found via grep
 *   - Line number references beyond file length
 *   - Invented module/package names
 *
 * Usage: node synthetic-evidence.js <report-path> [--base-dir <dir>] [--json]
 */
const { existsSync, readFileSync } = require('node:fs');
const { join, isAbsolute, dirname } = require('node:path');
const { execSync } = require('node:child_process');
const { appendAudit } = require('./workflow-lib.js');

function extractFileRefs(text) {
  const refs = [];
  const filePattern = /- \*\*文件\*\*:\s*`([^`]+)`/g;
  for (const match of text.matchAll(filePattern)) {
    refs.push({ type: 'file', value: match[1], index: match.index });
  }
  const codeBlockRefs = /(?:^|\n)(?:\/\/|#)\s*(?:file|File|FILE):\s*(.+)/g;
  for (const match of text.matchAll(codeBlockRefs)) {
    refs.push({ type: 'file', value: match[1].trim(), index: match.index });
  }
  return refs;
}

function extractSymbolRefs(text) {
  const refs = [];
  const symbolPattern = /- \*\*位置\*\*:\s*`?([^`\n]+)`?/g;
  for (const match of text.matchAll(symbolPattern)) {
    const raw = match[1].trim();
    const lineMatch = raw.match(/(?:L|line\s*)(\d+)/i);
    const funcMatch = raw.match(/(?:function|method|class|def)\s+([A-Za-z_][\w.]*)/i);
    if (!funcMatch) {
      const symbolOnly = raw.match(/^([A-Za-z_][\w.]*(?:\(\))?)/);
      if (symbolOnly && symbolOnly[1].length > 2) {
        refs.push({ type: 'symbol', value: symbolOnly[1].replace(/\(\)$/, ''), index: match.index });
      }
    } else {
      refs.push({ type: 'symbol', value: funcMatch[1], index: match.index });
    }
    if (lineMatch) {
      refs.push({ type: 'line', value: Number(lineMatch[1]), index: match.index });
    }
  }
  return refs;
}

function resolveFilePath(ref, baseDir) {
  if (isAbsolute(ref)) return ref;
  return join(baseDir, ref);
}

function grepSymbol(symbol, baseDir) {
  try {
    const { execFileSync } = require('node:child_process');
    const result = execFileSync(
      'grep',
      ['-rl', '--fixed-strings', symbol, baseDir,
       '--include=*.js', '--include=*.ts', '--include=*.tsx', '--include=*.jsx',
       '--include=*.py', '--include=*.go', '--include=*.java', '--include=*.rs'],
      { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const lines = result.trim().split('\n').filter(Boolean);
    return lines.length > 0;
  } catch {
    return false;
  }
}

function getFileLineCount(filePath) {
  try {
    const content = readFileSync(filePath, 'utf8');
    return content.split('\n').length;
  } catch {
    return -1;
  }
}

function detectSynthetic(reportPath, options = {}) {
  const { baseDir = process.cwd(), skipSymbolGrep = false } = options;

  if (!existsSync(reportPath)) {
    return { valid: false, error: 'report file not found', code: 'E_FILE_MISSING' };
  }

  const text = readFileSync(reportPath, 'utf8');
  const fileRefs = extractFileRefs(text);
  const symbolRefs = extractSymbolRefs(text);
  const violations = [];

  const issueBlocks = [...text.matchAll(/^###\s+(?:([A-Za-z][\w-]*):)?(ISSUE-\d+)/gm)];

  for (const ref of fileRefs) {
    const resolved = resolveFilePath(ref.value, baseDir);
    if (!existsSync(resolved)) {
      const issueCtx = issueBlocks.filter(m => m.index < ref.index).pop();
      const issueId = issueCtx ? `${issueCtx[1] || ''}:${issueCtx[2]}` : 'unknown';
      violations.push({
        type: 'fabricated_file',
        reference: ref.value,
        resolved,
        issue: issueId,
        message: `${issueId}: references non-existent file "${ref.value}"`,
      });
    }
  }

  for (const ref of symbolRefs) {
    if (ref.type === 'symbol' && !skipSymbolGrep) {
      if (!grepSymbol(ref.value, baseDir)) {
        const issueCtx = issueBlocks.filter(m => m.index < ref.index).pop();
        const issueId = issueCtx ? `${issueCtx[1] || ''}:${issueCtx[2]}` : 'unknown';
        violations.push({
          type: 'fabricated_symbol',
          reference: ref.value,
          issue: issueId,
          message: `${issueId}: references symbol "${ref.value}" not found in codebase`,
        });
      }
    } else if (ref.type === 'line') {
      const nearestFile = fileRefs.filter(f => f.index < ref.index).pop();
      if (nearestFile) {
        const resolved = resolveFilePath(nearestFile.value, baseDir);
        const lineCount = getFileLineCount(resolved);
        if (lineCount > 0 && ref.value > lineCount) {
          const issueCtx = issueBlocks.filter(m => m.index < ref.index).pop();
          const issueId = issueCtx ? `${issueCtx[1] || ''}:${issueCtx[2]}` : 'unknown';
          violations.push({
            type: 'fabricated_line',
            reference: `L${ref.value}`,
            file: nearestFile.value,
            actual_lines: lineCount,
            issue: issueId,
            message: `${issueId}: references line ${ref.value} but file has only ${lineCount} lines`,
          });
        }
      }
    }
  }

  return {
    valid: violations.length === 0,
    file_refs_checked: fileRefs.length,
    symbol_refs_checked: symbolRefs.filter(r => r.type === 'symbol').length,
    line_refs_checked: symbolRefs.filter(r => r.type === 'line').length,
    violation_count: violations.length,
    violations,
  };
}

function main() {
  const args = process.argv.slice(2);
  const reportPath = args.find(a => !a.startsWith('--'));
  const jsonFlag = args.includes('--json');
  const baseDirIdx = args.indexOf('--base-dir');
  const baseDir = baseDirIdx >= 0 ? args[baseDirIdx + 1] : process.cwd();

  if (!reportPath) {
    process.stderr.write('用法: node synthetic-evidence.js <report-path> [--base-dir <dir>] [--json]\n');
    process.exit(1);
  }

  const result = detectSynthetic(reportPath, { baseDir });
  if (jsonFlag) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.valid) {
      console.log(`✓ No synthetic evidence: ${result.file_refs_checked} files, ${result.symbol_refs_checked} symbols checked`);
    } else {
      console.log(`✗ ${result.violation_count} synthetic evidence violation(s):`);
      for (const v of result.violations) {
        console.log(`  [${v.type}] ${v.message}`);
      }
    }
  }
  if (!result.valid) process.exit(1);
}

if (require.main === module) main();
module.exports = { detectSynthetic, extractFileRefs, extractSymbolRefs };
