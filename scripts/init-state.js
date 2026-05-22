#!/usr/bin/env node
/**
 * optcode init — initializes workflow state.
 *
 * Usage: node init-state.js <work-dir> <base-commit> <target_path1> [target_path2 ...] [--mode light|deep|auto] [--profile light|deep|auto] [--diff [base_ref]] [--skip dim1,dim2]
 */
const { initState, MODES, DEFAULT_MODE } = require('./workflow-lib.js');

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function parseArgs(rawArgs) {
  const positional = [];
  const options = {
    mode: null,
    profile: null,
    diff: false,
    diff_base_ref: null,
    skipDimensions: []
  };

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--skip') {
      const skipArg = rawArgs[++i];
      if (!skipArg) fail('--skip needs comma-separated dimensions');
      options.skipDimensions = skipArg.split(',').map(s => s.trim()).filter(Boolean);
    } else if (arg === '--mode') {
      const mode = rawArgs[++i];
      if (!mode) fail('--mode needs one of: light, deep, auto');
      options.mode = mode;
    } else if (arg === '--profile') {
      const profile = rawArgs[++i];
      if (!profile) fail('--profile needs one of: light, deep, auto');
      options.profile = profile;
    } else if (arg === '--diff') {
      options.diff = true;
      const next = rawArgs[i + 1];
      if (next && !next.startsWith('--')) {
        options.diff_base_ref = next;
        i++;
      } else {
        options.diff_base_ref = 'HEAD';
      }
    } else {
      positional.push(arg);
    }
  }

  const requestedModes = [options.mode, options.profile].filter(Boolean);
  const requestedMode = requestedModes[0] || DEFAULT_MODE;
  if (requestedModes.length === 2 && options.mode !== options.profile) {
    fail(`--mode (${options.mode}) and --profile (${options.profile}) disagree`);
  }
  if (!MODES.includes(requestedMode)) {
    fail(`invalid mode: ${requestedMode}; expected one of: ${MODES.join(', ')}`);
  }

  return { positional, options: { ...options, requestedMode } };
}

const { positional, options } = parseArgs(process.argv.slice(2));
const [workDir, baseCommit, ...targets] = positional;

if (!workDir || !baseCommit || targets.length === 0) {
  process.stderr.write('用法: node init-state.js <work-dir> <base-commit> <target_path1> [target_path2 ...] [--mode light|deep|auto] [--profile light|deep|auto] [--diff [base_ref]] [--skip dim1,dim2]\n');
  process.exit(1);
}

const state = initState(workDir, targets, baseCommit, options.skipDimensions, {
  mode: options.requestedMode,
  requested_mode: options.requestedMode,
  diff: options.diff,
  diff_base_ref: options.diff_base_ref
});

console.log(JSON.stringify({
  initialized: true,
  work_dir: workDir,
  target_paths: state.target_paths,
  base_commit: state.base_commit,
  mode: state.mode,
  resolved_mode: state.resolved_mode,
  diff: state.init_options.diff,
  diff_base_ref: state.init_options.diff_base_ref || undefined,
  skipped_dimensions: options.skipDimensions.length > 0 ? options.skipDimensions : undefined
}, null, 2));
