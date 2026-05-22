---
dimension: <dimension-id>
round: <N>
result: pass | needs_fix | failed
issues_count: <N>
---

# CR Report: <dimension-name> — Round <N>

## 审查范围

- 目标路径：<target_paths>
- 审查维度：<dimension-name>
- 本轮轮次：<N>
- 审查模式：light / deep / auto

## 审查结论

<pass / needs_fix / failed>

结论摘要（1-2 句话说明整体情况）。如果没有 confidence ≥ 80 的问题，result 必须为 pass。

## 问题列表

> 仅当 result = needs_fix 时填写。每个问题必须有确凿代码证据、confidence ≥ 80、验证方式和可执行修复方案。

### ISSUE-001: <问题标题>

- **严重程度**: high / medium / low
- **置信度**: 80-100
- **修复风险**: safe / local / structural / behavior-risk
- **范围内问题**: yes / no
- **Pre-existing**: yes / no / unknown
- **验证方式**: read / grep / test / manual
- **文件**: `<file_path>`
- **位置**: L<start>-L<end>
- **问题描述**: 具体描述问题是什么，为什么它是问题。
- **代码证据**:
```
<相关代码片段>
```
- **修复方案**: 具体、可执行的修复步骤。
- **预期修复后代码**:
```
<修复后的代码片段>
```

### ISSUE-002: <问题标题>

（同上格式）

## 上轮修复验证

> 仅当 round > 1 时填写。逐项验证上一轮报告中的问题是否已修复。

| Issue ID | 上轮问题 | 修复结果 | 证据 |
|----------|---------|---------|------|
| ISSUE-001 | <问题描述> | fixed / not_fixed / partial | <文件:行号> |
