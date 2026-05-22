#!/usr/bin/env node
/**
 * optcode dimension status — manage dimension loop state transitions.
 *
 * Usage:
 *   node dimension-status.js <work-dir> --start <dimension>
 *   node dimension-status.js <work-dir> --cr-done <dimension> <round> <result> [issues_count]
 *   node dimension-status.js <work-dir> --fix-done <dimension> <round> <result> [fixed_count] [status]
 *   node dimension-status.js <work-dir> --preflight-done <light|deep> [reason] [signals_json]
 *   node dimension-status.js <work-dir> --deep-plan-done
 *   node dimension-status.js <work-dir> --exceed <dimension>
 *   node dimension-status.js <work-dir> --complete
 *   node dimension-status.js <work-dir> --summary
 */
const {
  readState,
  startDimension,
  recordCrResult,
  recordFixResult,
  recordPreflightResult,
  recordDeepPlanDone,
  exceedDimension,
  completeWorkflow,
  DIMENSIONS
} = require('./workflow-lib.js');

function fail(msg) {
  process.stderr.write(JSON.stringify({ error: msg }) + '\n');
  process.exit(1);
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function parseSignals(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('signals_json must be an object');
    return parsed;
  } catch (err) {
    fail(`invalid signals_json: ${err.message}`);
  }
}

function main() {
  const [workDir, command, ...args] = process.argv.slice(2);
  if (!workDir || !command) {
    fail('用法: node dimension-status.js <work-dir> <command> [args...]');
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
      case '--preflight-done': {
        const [recommendedMode, reason = '', signalsJson] = args;
        if (!recommendedMode) fail('--preflight-done needs recommended mode');
        const state = recordPreflightResult(workDir, recommendedMode, reason, parseSignals(signalsJson));
        print({ recorded: true, recommended_mode: recommendedMode, resolved_mode: state.resolved_mode, preflight: state.preflight });
        break;
      }
      case '--deep-plan-done': {
        const state = recordDeepPlanDone(workDir);
        print({ completed: true, deep_plan: state.deep_plan, completed_at: state.completed_at });
        break;
      }
      case '--exceed': {
        const dimension = args[0];
        if (!dimension) fail('--exceed needs dimension');
        const state = exceedDimension(workDir, dimension);
        print({ exceeded: true, dimension, state: state.dimensions[dimension] });
        break;
      }
      case '--complete': {
        const state = completeWorkflow(workDir);
        print({ completed: true, completed_at: state.completed_at });
        break;
      }
      case '--summary': {
        const state = readState(workDir);
        if (!state) fail('state not initialized');
        const summary = {
          mode: state.mode || 'light',
          resolved_mode: state.resolved_mode || null,
          preflight: state.preflight || null,
          deep_plan: state.deep_plan || null,
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
