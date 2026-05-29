---
dimension: <dimension>
round: <round>
result: success | fixed | partial | failed
status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
fixed_count: <N>
total_count: <N>
---

# Fix Report: <dimension> — Round <round>

`fixed`/`success` 必须满足 fixed_count = total_count；`partial` 必须满足 fixed_count < total_count；`failed` 必须满足 fixed_count = 0 且 status 为 NEEDS_CONTEXT 或 BLOCKED。

## 修复结果

| Issue ID | 问题 | 严重度 | 修复风险 | 修复状态 | 说明 |
|----------|------|-------|---------|---------|------|
| ISSUE-001 | <问题描述> | high/medium/low | safe/local/structural/behavior-risk | fixed / skipped / failed / deferred | <说明> |

## 自检结果

- **完整性**: <所有 ISSUE 均已处理 / 遗漏 ISSUE-XXX，原因：...>
- **安全性**: <diff 无越界改动 / 存在越界改动，说明：...>
- **副作用**: <调用方检查通过 / 发现潜在影响，说明：...>
- **一致性**: <符合项目风格 / 存在偏差，说明：...>
- **行为保真**: <输入输出契约不变 / 有变化，说明：...>

## Diff 检查

- 修改文件数：N
- 新增行数：N
- 删除行数：N
- 无关改动：无 / 有（说明）

## 行为保真检查

- 输入输出契约：保持 / 有变化（说明）
- 错误处理语义：保持 / 有变化（说明）
- 调用方兼容性：保持 / 有风险（说明）

## Concerns

> 仅当 status = DONE_WITH_CONCERNS 时填写，且不得留空。列出具体的风险点和建议的人工确认项。

## 阻塞原因

> 仅当 status = NEEDS_CONTEXT 或 BLOCKED 时填写。
> status = NEEDS_CONTEXT 或 BLOCKED 时必须填写，且不得留空。
> NEEDS_CONTEXT: 说明缺少什么上下文，需要什么信息才能继续。
> BLOCKED: 说明具体的技术阻塞原因。
