#!/usr/bin/env node
/**
 * optcode finding-bound fix contract — per-finding repair tracking.
 *
 * Each confirmed finding gets a contract that tracks:
 *   - findingId: unique issue identifier
 *   - dimension: owning dimension
 *   - revision: current contract revision (for OCC)
 *   - status: pending → in_progress → verified | partial | blocked | skipped
 *   - attempts: array of fix attempt records
 *
 * Usage:
 *   node finding-contract.js init <work-dir>           — create contracts from confirmed findings
 *   node finding-contract.js status <work-dir>         — show all contract statuses
 *   node finding-contract.js update <work-dir> <id> <status> [--revision <n>]
 *   node finding-contract.js record-attempt <work-dir> <id> --round <n> --result <result>
 */
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { readState, appendAudit, atomicReplace, ensureDir } = require('./workflow-lib.js');
const { parseCrFindings } = require('./report-parser.js');

const CONTRACT_FILE = 'finding-contracts.json';
const VALID_STATUSES = ['pending', 'in_progress', 'verified', 'partial', 'blocked', 'skipped'];

function contractsPath(workDir) {
  return join(workDir, CONTRACT_FILE);
}

function readContracts(workDir) {
  const file = contractsPath(workDir);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeContracts(workDir, contracts) {
  atomicReplace(contractsPath(workDir), JSON.stringify(contracts, null, 2) + '\n');
}

function initContracts(workDir, confirmedFindings) {
  const contracts = {
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    findings: {},
  };

  for (const finding of confirmedFindings) {
    contracts.findings[finding.issueId] = {
      findingId: finding.issueId,
      dimension: finding.dimension,
      reportPath: finding.reportPath,
      revision: 0,
      status: 'pending',
      attempts: [],
      created_at: new Date().toISOString(),
    };
  }

  writeContracts(workDir, contracts);
  appendAudit(workDir, {
    type: 'finding_contracts_initialized',
    count: confirmedFindings.length,
  });
  return contracts;
}

function updateStatus(workDir, findingId, newStatus, expectedRevision) {
  if (!VALID_STATUSES.includes(newStatus)) {
    throw Object.assign(
      new Error(`invalid contract status: ${newStatus}`),
      { code: 'E_INVALID_STATUS', findingId, newStatus },
    );
  }

  const contracts = readContracts(workDir);
  if (!contracts) {
    throw Object.assign(new Error('contracts not initialized'), { code: 'E_STATE_MISSING' });
  }

  const contract = contracts.findings[findingId];
  if (!contract) {
    throw Object.assign(
      new Error(`finding ${findingId} not found in contracts`),
      { code: 'E_FINDING_NOT_FOUND', findingId },
    );
  }

  if (expectedRevision !== undefined && contract.revision !== expectedRevision) {
    throw Object.assign(
      new Error(`contract OCC conflict for ${findingId}: expected rev ${expectedRevision}, got ${contract.revision}`),
      { code: 'E_FIX_REVISION_CONFLICT', findingId, expected: expectedRevision, actual: contract.revision },
    );
  }

  contract.status = newStatus;
  contract.revision += 1;
  contract.updated_at = new Date().toISOString();
  contracts.updated_at = new Date().toISOString();

  writeContracts(workDir, contracts);
  appendAudit(workDir, {
    type: 'finding_contract_updated',
    findingId,
    status: newStatus,
    revision: contract.revision,
  });

  return contract;
}

function recordAttempt(workDir, findingId, attempt) {
  const contracts = readContracts(workDir);
  if (!contracts || !contracts.findings[findingId]) {
    throw Object.assign(new Error(`finding ${findingId} not found`), { code: 'E_FINDING_NOT_FOUND' });
  }

  const contract = contracts.findings[findingId];
  contract.attempts.push({
    round: attempt.round,
    result: attempt.result,
    timestamp: new Date().toISOString(),
    ...(attempt.fixPath && { fixPath: attempt.fixPath }),
    ...(attempt.reason && { reason: attempt.reason }),
  });
  contract.revision += 1;
  contract.updated_at = new Date().toISOString();
  contracts.updated_at = new Date().toISOString();

  writeContracts(workDir, contracts);
  return contract;
}

function getSummary(workDir) {
  const contracts = readContracts(workDir);
  if (!contracts) return { initialized: false };

  const findings = Object.values(contracts.findings);
  const byStatus = {};
  for (const f of findings) {
    byStatus[f.status] = (byStatus[f.status] || 0) + 1;
  }

  return {
    initialized: true,
    total: findings.length,
    by_status: byStatus,
    by_dimension: findings.reduce((acc, f) => {
      if (!acc[f.dimension]) acc[f.dimension] = { total: 0, verified: 0, blocked: 0 };
      acc[f.dimension].total++;
      if (f.status === 'verified') acc[f.dimension].verified++;
      if (f.status === 'blocked') acc[f.dimension].blocked++;
      return acc;
    }, {}),
  };
}

function main() {
  const [cmd, workDir, ...rest] = process.argv.slice(2);
  if (!cmd || !workDir) {
    process.stderr.write('用法: node finding-contract.js <init|status|update|record-attempt> <work-dir> [...args]\n');
    process.exit(1);
  }

  switch (cmd) {
    case 'init': {
      const state = readState(workDir);
      const crDir = join(workDir, 'cr');
      const findings = [];
      if (existsSync(crDir)) {
        const { readdirSync } = require('node:fs');
        for (const file of readdirSync(crDir).filter(f => f.endsWith('.md'))) {
          const text = readFileSync(join(crDir, file), 'utf8');
          const dim = file.replace(/-(?:round-\d+|pass|failed)\.md$/, '');
          for (const finding of parseCrFindings(text, { dimension: dim, sourceReport: file })) {
            findings.push({ issueId: finding.id, dimension: finding.dimension, reportPath: join(crDir, file) });
          }
        }
      }
      const contracts = initContracts(workDir, findings);
      console.log(JSON.stringify({ initialized: true, count: Object.keys(contracts.findings).length }));
      break;
    }
    case 'status': {
      const summary = getSummary(workDir);
      console.log(JSON.stringify(summary, null, 2));
      break;
    }
    case 'update': {
      const [findingId, newStatus] = rest;
      const revIdx = rest.indexOf('--revision');
      const expectedRevision = revIdx >= 0 ? Number(rest[revIdx + 1]) : undefined;
      try {
        const result = updateStatus(workDir, findingId, newStatus, expectedRevision);
        console.log(JSON.stringify({ updated: true, findingId, status: result.status, revision: result.revision }));
      } catch (err) {
        console.error(JSON.stringify({ error: err.message, code: err.code }));
        process.exit(1);
      }
      break;
    }
    case 'record-attempt': {
      const [findingId] = rest;
      const roundIdx = rest.indexOf('--round');
      const resultIdx = rest.indexOf('--result');
      const round = roundIdx >= 0 ? Number(rest[roundIdx + 1]) : 0;
      const attemptResult = resultIdx >= 0 ? rest[resultIdx + 1] : 'unknown';
      try {
        const contract = recordAttempt(workDir, findingId, { round, result: attemptResult });
        console.log(JSON.stringify({ recorded: true, findingId, attempts: contract.attempts.length }));
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
module.exports = { initContracts, updateStatus, recordAttempt, readContracts, getSummary };
