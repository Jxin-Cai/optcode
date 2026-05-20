#!/usr/bin/env node
/**
 * optcode init — initializes workflow state.
 *
 * Usage: node init-state.js <work-dir> <base-commit> <target_path1> [target_path2 ...] [--skip dim1,dim2]
 */
const { initState } = require('./workflow-lib.js');

const rawArgs = process.argv.slice(2);
const skipIdx = rawArgs.indexOf('--skip');
let skipDimensions = [];
let positional = rawArgs;
if (skipIdx !== -1) {
  const skipArg = rawArgs[skipIdx + 1] || '';
  skipDimensions = skipArg.split(',').map(s => s.trim()).filter(Boolean);
  positional = [...rawArgs.slice(0, skipIdx), ...rawArgs.slice(skipIdx + 2)];
}

const [workDir, baseCommit, ...targets] = positional;

if (!workDir || !baseCommit || targets.length === 0) {
  process.stderr.write('用法: node init-state.js <work-dir> <base-commit> <target_path1> [target_path2 ...] [--skip dim1,dim2]\n');
  process.exit(1);
}

const state = initState(workDir, targets, baseCommit, skipDimensions);
console.log(JSON.stringify({
  initialized: true,
  work_dir: workDir,
  target_paths: state.target_paths,
  base_commit: state.base_commit,
  skipped_dimensions: skipDimensions.length > 0 ? skipDimensions : undefined
}, null, 2));
