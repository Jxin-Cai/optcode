---
name: optcode
description: Multi-dimension code review and auto-fix orchestrator. Invoked explicitly via /optcode.
disable-model-invocation: true
argument-hint: "[--mode light|deep|auto] [--diff [base_ref]] [--skip dim1,dim2] <target paths>"
---

# OptCode — 多维度代码审查与自动修复编排器

<CONSTRAINT>每轮必须先调 orchestration-status.js 确定 action，不凭记忆跳步。CR agent 不改代码，所有修改由 fixer 执行。默认 mode=light；mode=deep 只生成结构诊断计划，不修改业务代码；mode=auto 必须先 preflight 再选择。</CONSTRAINT>

用户参数：`$ARGUMENTS`

## 当前工作流状态

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-status.js .optcode/$(ls -1 .optcode 2>/dev/null | sort -r | head -1) 2>/dev/null || echo '{"action":"init","reason":"no active workflow"}'`

---

## 执行规则

上方脚本输出的 `next_steps` 是本轮唯一行动指令。严格按其内容执行，完成后重新触发本 skill 获取下一步。

若 action = `init`：Read `${CLAUDE_PLUGIN_ROOT}/skills/optcode/references/action-init.md` 执行启动流程。

若 action = `done`：工作流已完成。如需重新审查，直接走 init 开启新流程。

其他所有 action：按 `next_steps` 字段指示执行，不需要额外参考文件。

---

<HARD-GATE>
Read `${CLAUDE_PLUGIN_ROOT}/skills/optcode/references/hard-gate.md` 获取铁律约束。
</HARD-GATE>
