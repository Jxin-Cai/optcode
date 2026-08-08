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
const { join } = require('node:path');
const { readJsonFile, writeJsonFile } = require('./safe-json-store.js');
const { guardCli } = require('./cli-result.js');

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
  return readJsonFile(ledgerFile(projectRoot), { defaultValue: [], validate: Array.isArray, deps });
}

function saveLedger(projectRoot, ledger, deps = {}) {
  writeJsonFile(ledgerFile(projectRoot), ledger, { validate: Array.isArray, deps });
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

const METRIC_DIRECTIONS = Object.freeze(['lower-is-better', 'higher-is-better']);

function validateMetrics(entry) {
  if (entry.primaryMetric) {
    if (typeof entry.primaryMetric !== 'object') throw new Error('primaryMetric must be an object');
    if (entry.primaryMetric.direction && !METRIC_DIRECTIONS.includes(entry.primaryMetric.direction)) {
      throw new Error(`primaryMetric.direction must be one of: ${METRIC_DIRECTIONS.join(', ')}`);
    }
  }
  if (entry.guardrailMetric) {
    if (typeof entry.guardrailMetric !== 'object') throw new Error('guardrailMetric must be an object');
  }
  if (entry.comparisonWindow) {
    if (typeof entry.comparisonWindow !== 'object') throw new Error('comparisonWindow must be an object');
  }
}

function recordIntervention(projectRoot, entry, deps = {}) {
  if (!entry.id || !entry.dimension || !entry.state) {
    throw new Error('entry must have id, dimension, and state');
  }
  if (!STATES.includes(entry.state)) {
    throw new Error(`invalid state: ${entry.state}`);
  }
  validateMetrics(entry);

  // Inline privacy check — never skipped, no external dependency fallback
  const INLINE_PRIVACY_PATTERNS = [
    { pattern: /\/Users\/[^\s/]+/g, label: 'absolute-path' },
    { pattern: /\/home\/[^\s/]+/g, label: 'absolute-path' },
    { pattern: /C:\\Users\\[^\s\\]+/g, label: 'absolute-path' },
    { pattern: /sk-[a-zA-Z0-9]{20,}/g, label: 'secret-key' },
    { pattern: /AKIA[A-Z0-9]{16,}/g, label: 'aws-key' },
    { pattern: /(?:sk|pk|rk)_(?:live|test)_[a-zA-Z0-9]{10,}/g, label: 'stripe-key' },
    { pattern: /ghp_[a-zA-Z0-9]{36,}/g, label: 'github-pat' },
    { pattern: /password\s*[:=]\s*["'][^"']{4,}["']/gi, label: 'credential' },
    { pattern: /api[_-]?key\s*[:=]\s*["'][^"']{8,}["']/gi, label: 'api-key' },
  ];
  const entryText = JSON.stringify(entry);
  const privacyViolations = [];
  for (const { pattern, label } of INLINE_PRIVACY_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    if (re.test(entryText)) privacyViolations.push(label);
  }
  entry.privacy = privacyViolations.length === 0 ? 'clean' : [...new Set(privacyViolations)];

  const ledger = loadLedger(projectRoot, deps);
  const existing = ledger.find(e => e.id === entry.id);
  if (existing) {
    const validation = validateTransition(existing.state, entry.state);
    if (!validation.valid) throw new Error(validation.reason);
    existing.state = entry.state;
    existing.comparison = entry.comparison || existing.comparison;
    existing.privacy = entry.privacy;
    if (entry.primaryMetric) existing.primaryMetric = entry.primaryMetric;
    if (entry.guardrailMetric) existing.guardrailMetric = entry.guardrailMetric;
    if (entry.comparisonWindow) existing.comparisonWindow = entry.comparisonWindow;
    if (entry.baseline !== undefined) existing.baseline = entry.baseline;
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

if (require.main === module) guardCli(main);
module.exports = { STATES, ALLOWED_TRANSITIONS, METRIC_DIRECTIONS, loadLedger, saveLedger, recordIntervention, transitionEntry, summarizeEffectiveness, validateTransition, validateMetrics, ledgerFile };
