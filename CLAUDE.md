# CLAUDE.md

本仓库包含 `optcode` Claude Code 插件——多维度代码审查与自动修复循环。

## 组件

| 组件 | 路径 | 说明 |
|------|------|------|
| 主编排器 | `skills/optcode/SKILL.md` | `/optcode` 入口，调度 CR 和修复循环 |
| CR agent | `agents/agent-cr.md` | 通用审查 agent，按维度视角重入使用 |
| Fixer agent | `agents/agent-fixer.md` | 修复 agent，读取 CR 报告执行修复 |
| 维度视角 | `dimensions/*.md` | 7 个维度的检查清单和专属规则 |
| 状态机 | `scripts/workflow-lib.js` | 原子写入、状态读写、审计日志、停滞检测 |
| 恢复点 | `scripts/orchestration-status.js` | 每轮判定下一步 action |
| 门检查 | `scripts/gate-check.js` | 产物后置条件验证 |
| 维度状态 | `scripts/dimension-status.js` | 维度状态转换 CLI |
| 文件清单 | `scripts/file-inventory.js` | 目标路径文件扫描 |
| 质量门禁 | `scripts/quality-gate.js` | 基于维度结果计算质量评分（PASS/WARN/FAIL） |

## 产物目录

```
.optcode/{timestamp}/
├── state.json          # 工作流状态
├── audit-log.jsonl     # 审计日志
├── file-inventory.md   # 文件清单
├── cr/                 # CR 报告
└── fix/                # 修复报告
```
