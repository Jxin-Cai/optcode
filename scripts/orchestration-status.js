#!/usr/bin/env node
/**
 * optcode orchestration status — the single source of truth for resume point.
 * Called by the main skill every turn to determine what to do next.
 *
 * Usage: node orchestration-status.js <work-dir>
 * Output: JSON with action, dimension, round, reason
 */
const { getResumePoint, readState, DIMENSIONS, MAX_ROUNDS } = require('./workflow-lib.js');

const workDir = process.argv[2];

if (!workDir) {
  process.stderr.write('用法: node orchestration-status.js <work-dir>\n');
  process.exit(1);
}

function buildNextSteps(resume) {
  const { action, dimension, round } = resume;
  const P = '${CLAUDE_PLUGIN_ROOT}';
  const W = '${WORK_DIR}';
  switch (action) {
    case 'init':
      return `Read ${P}/skills/optcode/references/action-init.md 执行启动流程。`;
    case 'start_dimension':
      return `node ${P}/scripts/dimension-status.js ${W} --start ${dimension}`;
    case 'cr':
      return `启动 agent-cr(opus)，dimension=${dimension}，dimension_perspective=${P}/dimensions/${dimension}.md，round=${round}。完成后→ gate-check cr-complete:${dimension}:${round} → dimension-status --cr-done ${dimension} ${round} <result> <issues_count>`;
    case 'fix':
      return `启动 agent-fixer(sonnet)，report_path=${W}/cr/${dimension}-round-${round}.md，dimension=${dimension}，round=${round}。完成后→ gate-check fix-complete:${dimension}:${round} → dimension-status --fix-done ${dimension} ${round} <result> <fixed_count> <status>`;
    case 'escalate':
      return `启动 agent-fixer(sonnet) + escalation_context，report_path=${W}/cr/${dimension}-round-${round}.md。收集前几轮 CR/fix 报告摘要注入 escalation_context。完成后→ gate-check fix-complete:${dimension}:${round} → dimension-status --fix-done`;
    case 'exceed':
      return `node ${P}/scripts/dimension-status.js ${W} --exceed ${dimension}`;
    case 'summary':
      return `获取 git diff --stat <base_commit>、dimension-status --summary、quality-gate.js 输出，Read summary-template.md，写入 ${W}/summary.md，gate-check summary-exists。`;
    default:
      return '';
  }
}

function main() {
  const resume = getResumePoint(workDir);
  const state = readState(workDir);

  const output = {
    ...resume,
    next_steps: buildNextSteps(resume),
    state_summary: null
  };

  if (state) {
    const completed = DIMENSIONS.filter(d => ['pass', 'failed', 'exceeded'].includes(state.dimensions[d].status));
    const pending = DIMENSIONS.filter(d => state.dimensions[d].status === 'pending');
    output.state_summary = {
      completed: completed.length,
      pending: pending.length,
      total: DIMENSIONS.length,
      current_dimension: state.current_dimension,
      current_round: state.current_round,
      dimensions: state.dimensions
    };
  }

  console.log(JSON.stringify(output, null, 2));
}

main();
