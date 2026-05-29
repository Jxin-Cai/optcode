---
name: optcode
description: 仅当用户明确输入 /optcode 或明确要求运行 optcode 插件时触发。不要因普通代码审查、质量优化、重构、清理无效代码、消除重复、改善设计或遗留系统治理请求而自动触发。
disable-model-invocation: true
argument-hint: "[--mode light|deep|auto] [--profile light|deep|auto] [--diff [base_ref]] [--skip dim1,dim2] <目标路径，多个用逗号分隔>"
---

# OptCode — 多维度代码审查与自动修复编排器

<CONSTRAINT>每轮必须先调 orchestration-status.js 确定 action，不凭记忆跳步。CR agent 不改代码，所有修改由 fixer 执行。默认 mode=light，保持现有 7 维 CR/fix 工作流；mode=deep 只生成结构诊断计划，不修改业务代码；mode=auto 必须先 preflight 再选择 light 或 deep plan-only。</CONSTRAINT>

用户参数：`$ARGUMENTS`

## 当前工作流状态

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-status.js .optcode/$(ls -1 .optcode 2>/dev/null | sort -r | head -1) 2>/dev/null || echo '{"action":"init","reason":"no active workflow"}'`

---

## action = `init`

Read `${CLAUDE_PLUGIN_ROOT}/skills/optcode/references/action-init.md` 执行启动流程。

## action = `done`

上一次工作流已完成，直接走 init 开启新流程。

## action = `preflight`

1. Read `${WORK_DIR}/state.json` 和 `${WORK_DIR}/file-inventory.md`
2. 保守判断推荐模式：
   - diff 模式且文件范围较小 → `light`
   - 目标范围较大、跨多个模块、明显是结构治理诉求 → `deep`
   - 不确定 → `light`
3. 写入 `${WORK_DIR}/preflight.md`，记录 signals 和推荐理由
4. 执行：
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/dimension-status.js ${WORK_DIR} --preflight-done <light|deep> "<reason>" '<signals_json>'
   ```
5. 回到维度执行循环

## action = `deep_plan`

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/optcode/references/deep-plan-template.md`
2. Read `${WORK_DIR}/file-inventory.md`
3. 只做结构诊断与分阶段计划，不启动 fixer，不修改业务代码
4. 写入 `${WORK_DIR}/deep-plan.md`
5. 执行：
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/gate-check.js ${WORK_DIR} deep-plan-exists
   node ${CLAUDE_PLUGIN_ROOT}/scripts/dimension-status.js ${WORK_DIR} --deep-plan-done
   ```
6. 向用户展示 deep plan 摘要

## 维度执行循环

每轮：调 `node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-status.js ${WORK_DIR}` → 取 action → 按下方路由执行 → 回到本步骤。

### action = `start_dimension`

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/dimension-status.js ${WORK_DIR} --start <dimension>
```

### action = `cr`

1. 先执行：
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/dimension-status.js ${WORK_DIR} --cr-started <dimension> <round>
   ```
2. 启动 **agent-cr**（opus）并等待 agent 返回。禁止在 agent-cr 返回前运行 `gate-check cr-complete`。

TASK：
- `work_dir`: `${WORK_DIR}`
- `target_paths`: 目标路径
- `dimension` / `dimension_perspective`: `${CLAUDE_PLUGIN_ROOT}/dimensions/<dimension>.md`
- `round`: 当前轮次
- `prev_report`: round>1 时为 `${WORK_DIR}/cr/<dimension>-round-<round-1>.md`
- `file_inventory`: `${WORK_DIR}/file-inventory.md`

agent-cr 必须写入以下任一报告后才算完成：
- `${WORK_DIR}/cr/<dimension>-round-<round>.md`（result: needs_fix）
- `${WORK_DIR}/cr/<dimension>-pass.md`（result: pass）
- `${WORK_DIR}/cr/<dimension>-failed.md`（result: failed）

agent 返回后只标记报告就绪：
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/dimension-status.js ${WORK_DIR} --cr-ready <dimension> <round>
```

下一轮 `orchestration-status` 返回 `cr_gate` 后，才能执行：
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/gate-check.js ${WORK_DIR} cr-complete:<dimension>:<round>
node ${CLAUDE_PLUGIN_ROOT}/scripts/dimension-status.js ${WORK_DIR} --cr-done <dimension> <round> <result> <issues_count>
```

### action = `cr_wait`

等待 agent-cr 写入 CR 报告。确认报告存在后执行：
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/dimension-status.js ${WORK_DIR} --cr-ready <dimension> <round>
```
禁止运行 `cr-complete` gate。

### action = `cr_gate`

CR 报告已落盘，执行：
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/gate-check.js ${WORK_DIR} cr-complete:<dimension>:<round>
node ${CLAUDE_PLUGIN_ROOT}/scripts/dimension-status.js ${WORK_DIR} --cr-done <dimension> <round> <result> <issues_count>
```

### action = `fix`

1. 先执行：
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/dimension-status.js ${WORK_DIR} --fix-started <dimension> <round>
   ```
2. 启动 **agent-fixer**（sonnet）并等待 agent 返回。禁止在 agent-fixer 返回前运行 `gate-check fix-complete`。

TASK：
- `work_dir`: `${WORK_DIR}`
- `report_path`: `${WORK_DIR}/cr/<dimension>-round-<round>.md`
- `dimension` / `round`

agent 返回后只标记报告就绪：
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/dimension-status.js ${WORK_DIR} --fix-ready <dimension> <round>
```

下一轮 `orchestration-status` 返回 `fix_gate` 后，才能执行：
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/gate-check.js ${WORK_DIR} fix-complete:<dimension>:<round>
node ${CLAUDE_PLUGIN_ROOT}/scripts/dimension-status.js ${WORK_DIR} --fix-done <dimension> <round> <result> <fixed_count> <status>
```

### action = `fix_wait`

等待 agent-fixer 写入 fix 报告。确认报告存在后执行：
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/dimension-status.js ${WORK_DIR} --fix-ready <dimension> <round>
```
禁止运行 `fix-complete` gate。

### action = `fix_gate`

Fix 报告已落盘，执行：
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
7. `node ${CLAUDE_PLUGIN_ROOT}/scripts/dimension-status.js ${WORK_DIR} --complete`
8. 向用户展示总结摘要

---

<HARD-GATE>
1. orchestration-status 输出 = 唯一恢复点，不凭记忆决定下一步
2. 每轮必须调用恢复点脚本
3. gate-check 通过才能继续，且 cr/fix gate 必须在对应 agent 返回并写入报告之后执行
4. CR agent 不改代码，所有修改由 fixer 执行
5. 产物必须落盘，不依赖上下文记忆
6. 20 轮上限由脚本强制执行
7. 严格按序执行维度，不跳过、不并行
8. fixer 只修改 CR 报告中指出的问题，不引入无关改动
9. mode=deep 时不得启动 agent-fixer，不得修改业务代码，只能生成 deep-plan.md
10. mode=auto 必须先完成 preflight，不能直接进入 CR/fix 或 deep_plan
11. mode=light 的维度顺序、轮次、gate 规则保持脚本定义，新增维度也必须按序执行
</HARD-GATE>
