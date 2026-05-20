#!/usr/bin/env node
/**
 * optcode init — initializes workflow state.
 *
 * Usage: node init-state.js <work-dir> <base-commit> <target_path1> [target_path2 ...]
 */
const { initState } = require('./workflow-lib.js');

const [workDir, baseCommit, ...targets] = process.argv.slice(2);

if (!workDir || !baseCommit || targets.length === 0) {
  process.stderr.write('用法: node init-state.js <work-dir> <base-commit> <target_path1> [target_path2 ...]\n');
  process.exit(1);
}

const state = initState(workDir, targets, baseCommit);
console.log(JSON.stringify({ initialized: true, work_dir: workDir, target_paths: state.target_paths, base_commit: state.base_commit }, null, 2));
