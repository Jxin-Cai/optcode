#!/usr/bin/env node
/**
 * optcode evidence lane isolation — fail-closed per-dimension evidence collection.
 *
 * Each dimension's evidence collection runs in an isolated "lane". If one lane
 * fails, it is marked unavailable without crashing the whole review. Other lanes
 * continue independently.
 *
 * Usage:
 *   node evidence-lanes.js create <work-dir> --lanes <lane1,lane2,...>
 *   node evidence-lanes.js capture <work-dir> --lane <name> --status <available|partial|unavailable> [--data <json>]
 *   node evidence-lanes.js status <work-dir> [--json]
 *   node evidence-lanes.js validate <work-dir> [--depth <quick|normal>]
 */
const _fs = require('node:fs');
const _path = require('node:path');

const DEFAULT_DEPS = Object.freeze({
  existsSync: _fs.existsSync,
  mkdirSync: _fs.mkdirSync,
  readFileSync: _fs.readFileSync,
  writeFileSync: _fs.writeFileSync,
  appendFileSync: _fs.appendFileSync,
  renameSync: _fs.renameSync,
  join: _path.join,
  now: () => new Date().toISOString(),
  pid: () => process.pid,
});

function resolveDeps(deps) {
  if (!deps || Object.keys(deps).length === 0) return DEFAULT_DEPS;
  return { ...DEFAULT_DEPS, ...deps };
}

const LANE_STATES = Object.freeze(['available', 'partial', 'unavailable']);

const LANES_FILE = 'evidence-lanes.json';

function lanesPath(workDir, deps = {}) {
  const d = resolveDeps(deps);
  return d.join(workDir, LANES_FILE);
}

function ensureDir(dir, deps = {}) {
  const d = resolveDeps(deps);
  d.mkdirSync(dir, { recursive: true });
}

function atomicReplace(targetPath, content, deps = {}) {
  const d = resolveDeps(deps);
  const tmp = `${targetPath}.${d.pid()}.tmp`;
  d.writeFileSync(tmp, content);
  d.renameSync(tmp, targetPath);
}

function appendAudit(workDir, entry, deps = {}) {
  const d = resolveDeps(deps);
  ensureDir(workDir, deps);
  const record = { ts: d.now(), ...entry };
  const file = d.join(workDir, 'audit-log.jsonl');
  const existing = d.existsSync(file) ? d.readFileSync(file, 'utf8') : '';
  const tmp = `${file}.${d.pid()}.tmp`;
  d.writeFileSync(tmp, existing + JSON.stringify(record) + '\n');
  d.renameSync(tmp, file);
}

function readLanes(workDir, deps = {}) {
  const d = resolveDeps(deps);
  const file = lanesPath(workDir, deps);
  if (!d.existsSync(file)) return null;
  return JSON.parse(d.readFileSync(file, 'utf8'));
}

function writeLanes(workDir, data, deps = {}) {
  ensureDir(workDir, deps);
  atomicReplace(lanesPath(workDir, deps), JSON.stringify(data, null, 2) + '\n', deps);
}

function envelope(laneName, state, data, error, confidence) {
  return {
    lane: laneName,
    state,
    captured_at: new Date().toISOString(),
    data: data || null,
    error: error || null,
    confidence,
  };
}

function envelopeWithTime(laneName, state, data, error, confidence, deps = {}) {
  const d = resolveDeps(deps);
  return {
    lane: laneName,
    state,
    captured_at: d.now(),
    data: data || null,
    error: error || null,
    confidence,
  };
}

/**
 * Initialize lane registry for a run.
 */
function createLanes(workDir, laneNames, deps = {}) {
  if (!laneNames || laneNames.length === 0) {
    throw new Error('at least one lane name required');
  }
  const duplicates = laneNames.filter((name, i) => laneNames.indexOf(name) !== i);
  if (duplicates.length > 0) {
    throw new Error(`duplicate lane names: ${[...new Set(duplicates)].join(', ')}`);
  }

  const d = resolveDeps(deps);
  const lanes = {};
  for (const name of laneNames) {
    lanes[name] = envelopeWithTime(name, 'pending', null, null, 'low', deps);
  }

  const registry = {
    version: 1,
    created_at: d.now(),
    updated_at: d.now(),
    lanes,
  };

  writeLanes(workDir, registry, deps);
  appendAudit(workDir, {
    type: 'evidence_lanes_created',
    lane_count: laneNames.length,
    lane_names: laneNames,
  }, deps);

  return registry;
}

/**
 * Execute operation in isolation and capture result as a lane envelope.
 */
async function captureLane(workDir, laneName, operation, deps = {}) {
  const d = resolveDeps(deps);
  let result;
  try {
    result = await operation();
    if (!result || (typeof result === 'object' && Object.keys(result).length === 0)) {
      const env = envelopeWithTime(laneName, 'partial', result, null, 'low', deps);
      persistLane(workDir, laneName, env, deps);
      return env;
    }
    const env = envelopeWithTime(laneName, 'available', result, null, 'high', deps);
    persistLane(workDir, laneName, env, deps);
    return env;
  } catch (error) {
    const env = envelopeWithTime(laneName, 'unavailable', null, { message: error.message, code: error.code || null }, 'low', deps);
    persistLane(workDir, laneName, env, deps);
    return env;
  }
}

/**
 * Synchronous version of captureLane.
 */
function captureLaneSync(workDir, laneName, operation, deps = {}) {
  const d = resolveDeps(deps);
  let result;
  try {
    result = operation();
    if (!result || (typeof result === 'object' && Object.keys(result).length === 0)) {
      const env = envelopeWithTime(laneName, 'partial', result, null, 'low', deps);
      persistLane(workDir, laneName, env, deps);
      return env;
    }
    const env = envelopeWithTime(laneName, 'available', result, null, 'high', deps);
    persistLane(workDir, laneName, env, deps);
    return env;
  } catch (error) {
    const env = envelopeWithTime(laneName, 'unavailable', null, { message: error.message, code: error.code || null }, 'low', deps);
    persistLane(workDir, laneName, env, deps);
    return env;
  }
}

/**
 * Persist a lane envelope to the registry and append audit.
 */
function persistLane(workDir, laneName, env, deps = {}) {
  const d = resolveDeps(deps);
  const registry = readLanes(workDir, deps);
  if (!registry) {
    throw new Error('lane registry not initialized — call createLanes first');
  }
  registry.lanes[laneName] = env;
  registry.updated_at = d.now();
  writeLanes(workDir, registry, deps);
  appendAudit(workDir, {
    type: 'evidence_lane_captured',
    lane: laneName,
    state: env.state,
    confidence: env.confidence,
  }, deps);
}

/**
 * Read all lane states.
 */
function getLaneStatus(workDir, deps = {}) {
  const registry = readLanes(workDir, deps);
  if (!registry) return null;
  const summary = {};
  for (const [name, env] of Object.entries(registry.lanes)) {
    summary[name] = {
      state: env.state,
      confidence: env.confidence,
      captured_at: env.captured_at,
      has_data: env.data !== null,
      has_error: env.error !== null,
    };
  }
  return {
    version: registry.version,
    created_at: registry.created_at,
    updated_at: registry.updated_at,
    lane_count: Object.keys(registry.lanes).length,
    lanes: summary,
    overall_confidence: aggregateConfidence(Object.values(registry.lanes)),
  };
}

/**
 * Validate lane completeness.
 * - depth='normal': all lanes must be 'available' or overall fails
 * - depth='quick': unavailable lanes reduce confidence but don't block
 */
function validateLanes(workDir, depth = 'normal', deps = {}) {
  const registry = readLanes(workDir, deps);
  if (!registry) {
    return { valid: false, error: 'lane registry not found', code: 'E_LANES_MISSING' };
  }

  const lanes = Object.values(registry.lanes);
  const laneNames = Object.keys(registry.lanes);

  const available = lanes.filter(l => l.state === 'available');
  const partial = lanes.filter(l => l.state === 'partial');
  const unavailable = lanes.filter(l => l.state === 'unavailable');
  const pending = lanes.filter(l => l.state === 'pending');

  const confidence = aggregateConfidence(lanes);

  if (depth === 'normal') {
    const valid = unavailable.length === 0 && pending.length === 0 && lanes.every(l => l.state === 'available');
    return {
      valid,
      depth,
      lane_count: lanes.length,
      available: available.length,
      partial: partial.length,
      unavailable: unavailable.length,
      pending: pending.length,
      confidence,
      blocking_lanes: unavailable.map(l => l.lane).concat(partial.map(l => l.lane)).concat(pending.map(l => l.lane)),
    };
  }

  // depth === 'quick'
  const valid = pending.length === 0 && (available.length + partial.length) > 0;
  return {
    valid,
    depth,
    lane_count: lanes.length,
    available: available.length,
    partial: partial.length,
    unavailable: unavailable.length,
    pending: pending.length,
    confidence,
    degraded_lanes: unavailable.map(l => l.lane),
  };
}

/**
 * Compute overall confidence from lane states.
 * - All available -> 'high'
 * - Any partial, none unavailable -> 'medium'
 * - Any unavailable -> 'low'
 */
function aggregateConfidence(lanes) {
  if (!lanes || lanes.length === 0) return 'low';

  const states = lanes.map(l => l.state);
  const hasUnavailable = states.includes('unavailable');
  const hasPartial = states.includes('partial');
  const hasPending = states.includes('pending');

  if (hasUnavailable) return 'low';
  if (hasPartial || hasPending) return 'medium';
  if (states.every(s => s === 'available')) return 'high';
  return 'medium';
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--lanes' && argv[i + 1]) {
      args.lanes = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    } else if (argv[i] === '--lane' && argv[i + 1]) {
      args.lane = argv[++i];
    } else if (argv[i] === '--status' && argv[i + 1]) {
      args.status = argv[++i];
    } else if (argv[i] === '--data' && argv[i + 1]) {
      args.data = JSON.parse(argv[++i]);
    } else if (argv[i] === '--json') {
      args.json = true;
    } else if (argv[i] === '--depth' && argv[i + 1]) {
      args.depth = argv[++i];
    }
  }
  return args;
}

function main() {
  const [cmd, workDir, ...rest] = process.argv.slice(2);
  if (!cmd || !workDir) {
    process.stderr.write('用法: node evidence-lanes.js <create|capture|status|validate> <work-dir> [options]\n');
    process.exit(1);
  }

  const args = parseArgs(rest);

  switch (cmd) {
    case 'create': {
      if (!args.lanes || args.lanes.length === 0) {
        process.stderr.write('--lanes required (comma-separated lane names)\n');
        process.exit(1);
      }
      const registry = createLanes(workDir, args.lanes);
      console.log(JSON.stringify({
        created: true,
        lane_count: args.lanes.length,
        lane_names: args.lanes,
      }, null, 2));
      break;
    }
    case 'capture': {
      if (!args.lane) {
        process.stderr.write('--lane required\n');
        process.exit(1);
      }
      if (!args.status || !LANE_STATES.includes(args.status)) {
        process.stderr.write(`--status required (one of: ${LANE_STATES.join(', ')})\n`);
        process.exit(1);
      }
      const confidence = args.status === 'available' ? 'high' : 'low';
      const env = envelopeWithTime(args.lane, args.status, args.data || null, null, confidence);
      persistLane(workDir, args.lane, env);
      console.log(JSON.stringify(env, null, 2));
      break;
    }
    case 'status': {
      const status = getLaneStatus(workDir);
      if (!status) {
        process.stderr.write('no lane registry found\n');
        process.exit(1);
      }
      if (args.json) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        console.log(`Lanes: ${status.lane_count} | Confidence: ${status.overall_confidence}`);
        for (const [name, info] of Object.entries(status.lanes)) {
          console.log(`  ${name}: ${info.state} (${info.confidence})`);
        }
      }
      break;
    }
    case 'validate': {
      const depth = args.depth || 'normal';
      if (!['quick', 'normal'].includes(depth)) {
        process.stderr.write('--depth must be "quick" or "normal"\n');
        process.exit(1);
      }
      const result = validateLanes(workDir, depth);
      console.log(JSON.stringify(result, null, 2));
      if (!result.valid) process.exit(1);
      break;
    }
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      process.exit(1);
  }
}

if (require.main === module) main();
module.exports = {
  LANE_STATES,
  DEFAULT_DEPS,
  resolveDeps,
  createLanes,
  captureLane,
  captureLaneSync,
  getLaneStatus,
  validateLanes,
  aggregateConfidence,
};
