# OptCode 优化总结

## 基本信息

- **执行时间**: <timestamp>
- **目标路径**: <target_paths>
- **执行维度**: dead-code, duplication, concurrency, design, style, maintainability, legacy-safety

## 质量门禁

- **判定**: PASS / WARN / FAIL
- **评分**: <score> / 100
- **通过阈值**: PASS ≥ 80, WARN ≥ 50, FAIL < 50

| 维度 | 得分 | 状态 |
|------|------|------|
| 无效代码残料 | <score> | pass / failed / exceeded |
| 重复代码 | <score> | pass / failed / exceeded |
| 并发安全 | <score> | pass / failed / exceeded |
| 设计原则 | <score> | pass / failed / exceeded |
| 代码风格 | <score> | pass / failed / exceeded |
| 可维护性 | <score> | pass / failed / exceeded |
| 遗留安全 | <score> | pass / failed / exceeded |

## 各维度结果总览

| 维度 | 最终状态 | 执行轮次 | 发现问题数 | 修复问题数 |
|------|---------|---------|-----------|-----------|
| 无效代码残料 | pass / needs_fix / failed / skipped | N | N | N |
| 重复代码 | pass / needs_fix / failed / skipped | N | N | N |
| 并发安全 | pass / needs_fix / failed / skipped | N | N | N |
| 设计原则 | pass / needs_fix / failed / skipped | N | N | N |
| 代码风格 | pass / needs_fix / failed / skipped | N | N | N |
| 可维护性 | pass / needs_fix / failed / skipped | N | N | N |
| 遗留安全 | pass / needs_fix / failed / skipped | N | N | N |

## 变更统计

- 变更文件数：N
- 新增行数：N
- 删除行数：N

## 主要优化内容

### 1. <优化类别>

- <具体优化描述>
- 涉及文件：`<file_path>`

### 2. <优化类别>

（同上格式）

## 完整 Diff 摘要

```diff
<git diff --stat 输出>
```

## 未解决问题汇总

> 从 failed/exceeded 维度的最后一轮 CR 报告中提取仍存在的问题。如果所有维度均 pass 则写"无"。

| 维度 | Issue ID | 问题描述 | 严重度 | 修复风险 | 未修复原因 |
|------|----------|---------|--------|---------|-----------|

## 下一步建议

> 基于质量门禁结果和未解决问题，给出 2-3 条具体的后续优化建议。

1. <建议>
2. <建议>

## 注意事项

> 列出本次优化中需要人工关注的风险点或未能自动修复的问题。
