#!/usr/bin/env node
/**
 * optcode fix record — atomic fix report writer with optimistic concurrency control.
 *
 * Ensures fix reports cannot be overwritten by concurrent/stale agents.
 * Each finding carries a revision number; write is rejected if the expected
 * revision does not match the current one.
 *
 * Usage:
 *   node fix-record.js write <work-dir> <dimension> <round> --expected-revision <n>
 *   node fix-record.js read <work-dir> <dimension> <round>
 *   node fix-record.js revision <work-dir> <dimension> <round>
 */
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { readFrontmatter, appendAudit, atomicReplace, acquireLockSync, releaseLock } = require('./workflow-lib.js');

const REVISION_META_KEY = '_fix_revision';
const LOCK_TIMEOUT_MS = 5000;

function fixReportPath(workDir, dimension, round) {
  return join(workDir, 'fix', `${dimension}-round-${round}-fix.md`);
}

function revisionPath(workDir, dimension, round) {
  return join(workDir, 'fix', `${dimension}-round-${round}.rev`);
}

function lockPath(workDir, dimension, round) {
  return join(workDir, 'fix', `${dimension}-round-${round}.lock`);
}

function currentRevision(workDir, dimension, round) {
  const revFile = revisionPath(workDir, dimension, round);
  if (!existsSync(revFile)) return 0;
  try {
    return Number(readFileSync(revFile, 'utf8').trim()) || 0;
  } catch { return 0; }
}

function writeFixReport(workDir, dimension, round, content, expectedRevision) {
  const lp = lockPath(workDir, dimension, round);
  let lock;
  try {
    lock = acquireLockSync(lp, { timeoutMs: LOCK_TIMEOUT_MS });
  } catch (err) {
    throw Object.assign(
      new Error(`fix-record lock failed: ${err.message}`),
      { code: 'E_FIX_LOCK_TIMEOUT', dimension, round },
    );
  }

  try {
    const current = currentRevision(workDir, dimension, round);
    if (expectedRevision !== undefined && current !== expectedRevision) {
      throw Object.assign(
        new Error(`fix-record OCC conflict: expected revision ${expectedRevision}, current is ${current}`),
        { code: 'E_FIX_REVISION_CONFLICT', dimension, round, expected: expectedRevision, actual: current },
      );
    }

    const newRevision = current + 1;
    const reportFile = fixReportPath(workDir, dimension, round);
    atomicReplace(reportFile, content);
    atomicReplace(revisionPath(workDir, dimension, round), String(newRevision) + '\n');

    appendAudit(workDir, {
      type: 'fix_report_written',
      dimension,
      round,
      revision: newRevision,
      expected_revision: expectedRevision,
    });

    return { written: true, revision: newRevision, path: reportFile };
  } finally {
    releaseLock(lp, lock.handle);
  }
}

function readFixReport(workDir, dimension, round) {
  const reportFile = fixReportPath(workDir, dimension, round);
  if (!existsSync(reportFile)) return null;
  const content = readFileSync(reportFile, 'utf8');
  const revision = currentRevision(workDir, dimension, round);
  return { content, revision, path: reportFile };
}

function main() {
  const [cmd, workDir, dimension, roundStr, ...rest] = process.argv.slice(2);
  if (!cmd || !workDir) {
    process.stderr.write('用法: node fix-record.js <write|read|revision> <work-dir> <dimension> <round> [--expected-revision <n>]\n');
    process.exit(1);
  }

  const round = Number(roundStr);

  switch (cmd) {
    case 'revision': {
      const rev = currentRevision(workDir, dimension, round);
      console.log(JSON.stringify({ dimension, round, revision: rev }));
      break;
    }
    case 'read': {
      const report = readFixReport(workDir, dimension, round);
      if (!report) {
        process.stderr.write('fix report not found\n');
        process.exit(1);
      }
      console.log(JSON.stringify({ revision: report.revision, path: report.path, content_length: report.content.length }));
      break;
    }
    case 'write': {
      const revIdx = rest.indexOf('--expected-revision');
      const expectedRevision = revIdx >= 0 ? Number(rest[revIdx + 1]) : undefined;
      const content = readFileSync('/dev/stdin', 'utf8');
      try {
        const result = writeFixReport(workDir, dimension, round, content, expectedRevision);
        console.log(JSON.stringify(result));
      } catch (err) {
        console.error(JSON.stringify({ error: err.message, code: err.code }));
        process.exit(1);
      }
      break;
    }
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { writeFixReport, readFixReport, currentRevision, fixReportPath };
