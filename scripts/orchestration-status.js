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
    case 'preflight':
      return `读取 ${W}/state.json 和 ${W}/file-inventory.md，保守判断 recommended_mode=light|deep，写入 ${W}/preflight.md，然后执行 node ${P}/scripts/dimension-status.js ${W} --preflight-done <light|deep> "<reason>" '{"file_count":0,"total_lines":0}'。不确定时选择 light。`;
    case 'deep_plan':
      return `Read ${P}/skills/optcode/references/deep-plan-template.md，读取 ${W}/file-inventory.md，只做结构诊断和分阶段计划，不修改业务代码；写入 ${W}/deep-plan.md → node ${P}/scripts/gate-check.js ${W} deep-plan-exists → node ${P}/scripts/dimension-status.js ${W} --deep-plan-done。`;
    case 'start_dimension':
      return `node ${P}/scripts/dimension-status.js ${W} --start ${dimension}`;
    case 'cr':
      return `必须先启动 agent-cr(opus) 并等待完成，TASK={work_dir:${W}, target_paths:<state.target_paths>, dimension:${dimension}, dimension_perspective:${P}/dimensions/${dimension}.md, round:${round}, prev_report:${round > 1 ? `${W}/cr/${dimension}-round-${round - 1}.md` : 'null'}, file_inventory:${W}/file-inventory.md}。确认 agent 已写入 ${W}/cr/${dimension}-round-${round}.md 或 ${W}/cr/${dimension}-pass.md 或 ${W}/cr/${dimension}-failed.md 后，才能执行 node ${P}/scripts/gate-check.js ${W} cr-complete:${dimension}:${round}，再执行 node ${P}/scripts/dimension-status.js ${W} --cr-done ${dimension} ${round} <result> <issues_count>。禁止在 agent-cr 返回前运行 gate-check。`;
    case 'fix':
      return `必须先启动 agent-fixer(sonnet) 并等待完成，TASK={work_dir:${W}, report_path:${W}/cr/${dimension}-round-${round}.md, dimension:${dimension}, round:${round}}。确认 agent 已写入 ${W}/fix/${dimension}-round-${round}-fix.md 后，才能执行 node ${P}/scripts/gate-check.js ${W} fix-complete:${dimension}:${round}，再执行 node ${P}/scripts/dimension-status.js ${W} --fix-done ${dimension} ${round} <result> <fixed_count> <status>。禁止在 agent-fixer 返回前运行 gate-check。`;
    case 'escalate':
      return `必须先启动 agent-fixer(sonnet) + escalation_context 并等待完成，report_path=${W}/cr/${dimension}-round-${round}.md。收集前几轮 CR/fix 报告摘要注入 escalation_context。确认 agent 已写入 ${W}/fix/${dimension}-round-${round}-fix.md 后，才能执行 node ${P}/scripts/gate-check.js ${W} fix-complete:${dimension}:${round}，再执行 dimension-status --fix-done。禁止在 agent-fixer 返回前运行 gate-check。`;
    case 'exceed':
      return `node ${P}/scripts/dimension-status.js ${W} --exceed ${dimension}`;
    case 'summary':
      return `获取 git diff --stat <base_commit>、dimension-status --summary、quality-gate.js 输出，Read summary-template.md，写入 ${W}/summary.md，gate-check summary-exists，最后调 dimension-status --complete 标记完成。`;
    case 'done':
      return '此工作流已完成。如需重新审查，请直接调用 /optcode 开启新流程。';
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
    const completed = DIMENSIONS.filter(d => ['pass', 'failed', 'exceeded', 'skipped'].includes(state.dimensions[d].status));
    const pending = DIMENSIONS.filter(d => state.dimensions[d].status === 'pending');
    output.state_summary = {
      mode: state.mode || 'light',
      resolved_mode: state.resolved_mode || null,
      preflight: state.preflight || null,
      deep_plan: state.deep_plan || null,
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
