#!/usr/bin/env node
/**
 * optcode dimension status — manage dimension loop state transitions.
 *
 * Usage:
 *   node dimension-status.mjs <work-dir> --start <dimension>
 *   node dimension-status.mjs <work-dir> --cr-done <dimension> <round> <result> [issues_count]
 *   node dimension-status.mjs <work-dir> --fix-done <dimension> <round> <result> [fixed_count] [status]
 *   node dimension-status.mjs <work-dir> --exceed <dimension>
 *   node dimension-status.mjs <work-dir> --summary
 */
import {
  readState,
  startDimension,
  recordCrResult,
  recordFixResult,
  exceedDimension,
  DIMENSIONS
} from './workflow-lib.mjs';

function fail(msg) {
  process.stderr.write(JSON.stringify({ error: msg }) + '\n');
  process.exit(1);
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function main() {
  const [workDir, command, ...args] = process.argv.slice(2);
  if (!workDir || !command) {
    fail('用法: node dimension-status.mjs <work-dir> <command> [args...]');
  }

  try {
    switch (command) {
      case '--start': {
        const dimension = args[0];
        if (!dimension) fail('--start needs dimension');
        const state = startDimension(workDir, dimension);
        print({ started: true, dimension, state: state.dimensions[dimension] });
        break;
      }
      case '--cr-done': {
        const [dimension, roundStr, result, issuesStr] = args;
        if (!dimension || !roundStr || !result) fail('--cr-done needs dimension, round, result');
        const round = Number(roundStr);
        const issues = Number(issuesStr || 0);
        const state = recordCrResult(workDir, dimension, round, result, issues);
        print({ recorded: true, dimension, round, result, state: state.dimensions[dimension] });
        break;
      }
      case '--fix-done': {
        const [dimension, roundStr, result, fixedStr, status] = args;
        if (!dimension || !roundStr || !result) fail('--fix-done needs dimension, round, result');
        const round = Number(roundStr);
        const fixed = Number(fixedStr || 0);
        const fixStatus = status || 'DONE';
        const state = recordFixResult(workDir, dimension, round, result, fixed, fixStatus);
        print({ recorded: true, dimension, round, result, status: fixStatus, state: state.dimensions[dimension] });
        break;
      }
      case '--exceed': {
        const dimension = args[0];
        if (!dimension) fail('--exceed needs dimension');
        const state = exceedDimension(workDir, dimension);
        print({ exceeded: true, dimension, state: state.dimensions[dimension] });
        break;
      }
      case '--summary': {
        const state = readState(workDir);
        if (!state) fail('state not initialized');
        const summary = {
          current_dimension: state.current_dimension,
          current_round: state.current_round,
          dimensions: {}
        };
        for (const dim of DIMENSIONS) {
          summary.dimensions[dim] = state.dimensions[dim];
        }
        print(summary);
        break;
      }
      default:
        fail(`unknown command: ${command}`);
    }
  } catch (err) {
    fail(err.message);
  }
}

main();
