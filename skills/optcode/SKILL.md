---
name: optcode
description: 当用户想要对现有代码进行多维度质量审查和自动修复时触发。即使用户没说"审查"，只要涉及代码质量优化、清理无效代码、消除重复、改善设计、遗留系统治理就应匹配。
argument-hint: "<目标路径，多个用逗号分隔>"
---

# OptCode — 多维度代码审查与自动修复编排器

<CONSTRAINT>每轮必须先调 orchestration-status.js 确定 action，不凭记忆跳步。CR agent 不改代码，所有修改由 fixer 执行。</CONSTRAINT>

用户参数：`$ARGUMENTS`

## 当前工作流状态

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-status.js .optcode/$(ls -1 .optcode 2>/dev/null | sort -r | head -1) 2>/dev/null || echo '{"action":"init","reason":"no active workflow"}'`

---

## action = `init`

Read `${CLAUDE_PLUGIN_ROOT}/skills/optcode/references/action-init.md` 执行启动流程。

## 维度执行循环

每轮：调 `node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-status.js ${WORK_DIR}` → 取 action → 按下方路由执行 → 回到本步骤。

### action = `start_dimension`

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/dimension-status.js ${WORK_DIR} --start <dimension>
```

### action = `cr`

启动 **agent-cr**（opus），TASK：
- `work_dir`: `${WORK_DIR}`
- `target_paths`: 目标路径
- `dimension` / `dimension_perspective`: `${CLAUDE_PLUGIN_ROOT}/dimensions/<dimension>.md`
- `round`: 当前轮次
- `prev_report`: round>1 时为 `${WORK_DIR}/cr/<dimension>-round-<round-1>.md`
- `file_inventory`: `${WORK_DIR}/file-inventory.md`

完成后：
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/gate-check.js ${WORK_DIR} cr-complete:<dimension>:<round>
node ${CLAUDE_PLUGIN_ROOT}/scripts/dimension-status.js ${WORK_DIR} --cr-done <dimension> <round> <result> <issues_count>
```

### action = `fix`

启动 **agent-fixer**（sonnet），TASK：
- `work_dir`: `${WORK_DIR}`
- `report_path`: `${WORK_DIR}/cr/<dimension>-round-<round>.md`
- `dimension` / `round`

完成后：
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/gate-check.js ${WORK_DIR} fix-complete:<dimension>:<round>
node ${CLAUDE_PLUGIN_ROOT}/scripts/dimension-status.js ${WORK_DIR} --fix-done <dimension> <round> <result> <fixed_count> <status>
```

**status 路由**：`DONE` → 继续 re-CR | `DONE_WITH_CONCERNS` → 展示 Concerns，继续 re-CR | `NEEDS_CONTEXT`/`BLOCKED` → 展示原因，维度标记 failed

### action = `escalate`

同 `fix`，但额外传入 `escalation_context`：前 3 轮 CR/fix 摘要 + "分析根因，改变修复策略，severity=low 标记 deferred 跳过"。

### action = `exceed`

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/dimension-status.js ${WORK_DIR} --exceed <dimension>
```

### action = `summary`

1. `git diff --stat <base_commit>` + `git diff <base_commit> | head -500`
2. `node ${CLAUDE_PLUGIN_ROOT}/scripts/dimension-status.js ${WORK_DIR} --summary`
3. `node ${CLAUDE_PLUGIN_ROOT}/scripts/quality-gate.js ${WORK_DIR}`
4. Read `${CLAUDE_PLUGIN_ROOT}/skills/optcode/references/summary-template.md`
5. 写入 `${WORK_DIR}/summary.md`
6. `node ${CLAUDE_PLUGIN_ROOT}/scripts/gate-check.js ${WORK_DIR} summary-exists`
7. 向用户展示总结摘要

---

<HARD-GATE>
1. orchestration-status 输出 = 唯一恢复点，不凭记忆决定下一步
2. 每轮必须调用恢复点脚本
3. gate-check 通过才能继续
4. CR agent 不改代码，所有修改由 fixer 执行
5. 产物必须落盘，不依赖上下文记忆
6. 20 轮上限由脚本强制执行
7. 严格按序执行维度，不跳过、不并行
8. fixer 只修改 CR 报告中指出的问题，不引入无关改动
</HARD-GATE>
