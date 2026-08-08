# CLAUDE.md

本仓库包含 `optcode` Claude Code 插件——多维度代码审查与自动修复循环。

## 规则

- 每次提交代码到主干前，必须更新 `.claude-plugin/plugin.json` 中的 `version` 字段（遵循 semver：fix→patch，feat→minor，breaking→major）

## 组件

| 组件 | 路径 | 说明 |
|------|------|------|
| 主编排器 | `skills/optcode/SKILL.md` | `/optcode` 入口，调度 CR 和修复循环 |
| CR agent | `agents/agent-cr.md` | 通用审查 agent，按维度视角重入使用 |
| RCA agent | `agents/agent-rca.md` | 根因分析 agent，聚类问题并产出原则对齐策略 |
| Fixer agent | `agents/agent-fixer.md` | 修复 agent，按 RCA 策略或 CR 报告执行修复 |
| 维度视角 | `dimensions/*.md` | 9 个维度的检查清单和专属规则 |
| 状态机 | `scripts/workflow-lib.js` | 原子写入、状态读写、审计日志、停滞检测 |
| 恢复点 | `scripts/orchestration-status.js` | 每轮判定下一步 action |
| 门检查 | `scripts/gate-check.js` | 产物后置条件验证 |
| 证据快照 | `scripts/evidence-bundle.js` | 版本化快照、完整性校验和漂移检测唯一事实源；`context-freeze.js` 仅兼容 |
| 报告解析 | `scripts/report-parser.js` | ISSUE heading、区块边界、字段和 qualified ID 唯一事实源 |
| 持久化 JSON | `scripts/safe-json-store.js` | 原子写入、有效备份恢复、损坏数据 fail-closed 唯一事实源 |
| 维度状态 | `scripts/dimension-status.js` | 维度状态转换 CLI |
| 脚本入口 | `scripts/optcode.js` + `scripts/cli-schema.js` | shell-free 分发与命令清单唯一事实源 |
| 文件清单 | `scripts/file-inventory.js` | 目标路径文件扫描 |
| 质量门禁 | `scripts/quality-gate.js` | 基于维度结果计算质量评分（PASS/WARN/FAIL） |
| 观测仪表盘 | `scripts/dashboard.js` | 质量评分+趋势+债务统一仪表盘（generate/open/history） |
| 团队规则 | `scripts/rules-loader.js` | 加载 `.optcode/rules/*.md` 自定义审查规则 |
| 修复检查点 | `scripts/mutation-checkpoint.js` | 保留修复前工作树，只回滚单轮 fixer 差异 |

## 产物目录

```
.optcode/{timestamp}/
├── state.json          # 工作流状态
├── audit-log.jsonl     # 审计日志
├── evidence-bundle.json # 版本化证据快照（schema v2）
├── dashboard.md        # 观测仪表盘（可重复打开）
├── file-inventory.md   # 文件清单
├── cr/                 # CR 报告
│   └── arch-diagram.mmd  # 架构图（design 维度产出）
├── verification/       # 验证报告
├── rca/                # RCA 根因分析报告
├── fix/                # 修复报告
├── regression/         # 回归检查报告
└── transactions/       # finding-bound mutation 检查点

.optcode/
├── health-history.json # 跨运行健康分历史
├── known-issues.json   # 跨运行已知问题
└── rules/*.md          # 团队自定义审查规则
```
