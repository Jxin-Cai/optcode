#!/usr/bin/env node
/**
 * intervention-ledger.js — Longitudinal tracking of interventions across runs.
 * State machine: pending → improving/unchanged/regressing → outcome-supported (terminal).
 *
 * Usage:
 *   node intervention-ledger.js record <project-root> <entry-json>
 *   node intervention-ledger.js transition <project-root> <id> <new-state>
 *   node intervention-ledger.js summarize <project-root>
 *   node intervention-ledger.js list <project-root> [--state <state>]
 */
const { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } = require('node:fs');
const { join, dirname } = require('node:path');

const STATES = Object.freeze(['pending', 'improving', 'unchanged', 'regressing', 'outcome-supported']);

const ALLOWED_TRANSITIONS = Object.freeze({
  pending: ['improving', 'unchanged', 'regressing'],
  improving: ['outcome-supported', 'unchanged', 'regressing'],
  unchanged: ['improving', 'regressing'],
  regressing: ['improving', 'unchanged'],
  'outcome-supported': [],
});

function ledgerFile(projectRoot) {
  return join(projectRoot, '.optcode', 'intervention-ledger.json');
}

function loadLedger(projectRoot, deps = {}) {
  const _exists = deps.existsSync || existsSync;
  const _read = deps.readFileSync || readFileSync;
  const file = ledgerFile(projectRoot);
  if (!_exists(file)) return [];
  try { return JSON.parse(_read(file, 'utf8')); } catch { return []; }
}

function saveLedger(projectRoot, ledger, deps = {}) {
  const _write = deps.writeFileSync || writeFileSync;
  const _mkdir = deps.mkdirSync || mkdirSync;
  const _rename = deps.renameSync || renameSync;
  const file = ledgerFile(projectRoot);
  _mkdir(dirname(file), { recursive: true });
  const tmp = file + '.tmp.' + (deps.pid ? deps.pid() : process.pid);
  _write(tmp, JSON.stringify(ledger, null, 2) + '\n');
  _rename(tmp, file);
}

function validateTransition(currentState, newState) {
  if (!STATES.includes(newState)) return { valid: false, reason: `invalid state: ${newState}` };
  if (!currentState) return { valid: true };
  const allowed = ALLOWED_TRANSITIONS[currentState];
  if (!allowed) return { valid: false, reason: `unknown current state: ${currentState}` };
  if (!allowed.includes(newState)) {
    return { valid: false, reason: `transition ${currentState} → ${newState} not allowed. Valid: ${allowed.join(', ')}` };
  }
  return { valid: true };
}

function recordIntervention(projectRoot, entry, deps = {}) {
  if (!entry.id || !entry.dimension || !entry.state) {
    throw new Error('entry must have id, dimension, and state');
  }
  if (!STATES.includes(entry.state)) {
    throw new Error(`invalid state: ${entry.state}`);
  }

  // Privacy scan integration
  try {
    const { scanText } = require('./privacy-scan.js');
    const violations = scanText(JSON.stringify(entry));
    entry.privacy = violations.length === 0 ? 'clean' : violations.map(v => v.label);
  } catch {
    entry.privacy = 'scan-unavailable';
  }

  const ledger = loadLedger(projectRoot, deps);
  const existing = ledger.find(e => e.id === entry.id);
  if (existing) {
    const validation = validateTransition(existing.state, entry.state);
    if (!validation.valid) throw new Error(validation.reason);
    existing.state = entry.state;
    existing.comparison = entry.comparison || existing.comparison;
    existing.privacy = entry.privacy;
    existing.updated_at = new Date().toISOString();
    existing.history = existing.history || [];
    existing.history.push({ state: entry.state, timestamp: existing.updated_at });
  } else {
    entry.created_at = new Date().toISOString();
    entry.updated_at = entry.created_at;
    entry.history = [{ state: entry.state, timestamp: entry.created_at }];
    ledger.push(entry);
  }
  saveLedger(projectRoot, ledger, deps);
  return entry;
}

function transitionEntry(projectRoot, id, newState, deps = {}) {
  const ledger = loadLedger(projectRoot, deps);
  const entry = ledger.find(e => e.id === id);
  if (!entry) throw new Error(`intervention not found: ${id}`);
  const validation = validateTransition(entry.state, newState);
  if (!validation.valid) throw new Error(validation.reason);
  entry.state = newState;
  entry.updated_at = new Date().toISOString();
  entry.history = entry.history || [];
  entry.history.push({ state: newState, timestamp: entry.updated_at });
  saveLedger(projectRoot, ledger, deps);
  return entry;
}

function summarizeEffectiveness(projectRoot, deps = {}) {
  const ledger = loadLedger(projectRoot, deps);
  const summary = {
    total: ledger.length,
    by_state: {},
    by_dimension: {},
    improvement_rate: 0,
    regression_rate: 0,
  };
  for (const state of STATES) summary.by_state[state] = 0;
  for (const entry of ledger) {
    summary.by_state[entry.state] = (summary.by_state[entry.state] || 0) + 1;
    if (!summary.by_dimension[entry.dimension]) {
      summary.by_dimension[entry.dimension] = { total: 0, improving: 0, regressing: 0, outcome: 0 };
    }
    const dimSummary = summary.by_dimension[entry.dimension];
    dimSummary.total++;
    if (entry.state === 'improving') dimSummary.improving++;
    if (entry.state === 'regressing') dimSummary.regressing++;
    if (entry.state === 'outcome-supported') dimSummary.outcome++;
  }
  if (ledger.length > 0) {
    summary.improvement_rate = (summary.by_state.improving + summary.by_state['outcome-supported']) / ledger.length;
    summary.regression_rate = summary.by_state.regressing / ledger.length;
  }
  return summary;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) {
    process.stderr.write('用法: node intervention-ledger.js <record|transition|summarize|list> <project-root> [...]\n');
    process.exit(1);
  }
  switch (cmd) {
    case 'record': {
      const [projectRoot, entryJson] = rest;
      if (!projectRoot || !entryJson) { process.stderr.write('用法: record <project-root> <entry-json>\n'); process.exit(1); }
      const entry = JSON.parse(entryJson);
      const result = recordIntervention(projectRoot, entry);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'transition': {
      const [projectRoot, id, newState] = rest;
      if (!projectRoot || !id || !newState) { process.stderr.write('用法: transition <project-root> <id> <new-state>\n'); process.exit(1); }
      const result = transitionEntry(projectRoot, id, newState);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'summarize': {
      const [projectRoot] = rest;
      if (!projectRoot) { process.stderr.write('用法: summarize <project-root>\n'); process.exit(1); }
      console.log(JSON.stringify(summarizeEffectiveness(projectRoot), null, 2));
      break;
    }
    case 'list': {
      const [projectRoot] = rest;
      if (!projectRoot) { process.stderr.write('用法: list <project-root>\n'); process.exit(1); }
      const stateIdx = rest.indexOf('--state');
      const filterState = stateIdx !== -1 ? rest[stateIdx + 1] : null;
      const ledger = loadLedger(projectRoot);
      const filtered = filterState ? ledger.filter(e => e.state === filterState) : ledger;
      console.log(JSON.stringify(filtered, null, 2));
      break;
    }
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { STATES, ALLOWED_TRANSITIONS, loadLedger, saveLedger, recordIntervention, transitionEntry, summarizeEffectiveness, validateTransition, ledgerFile };
