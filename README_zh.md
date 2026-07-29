<div align="center">

# OptCode

**多维度代码审查与自动修复循环 —— Claude Code 插件。**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Plugin-D97757.svg)](https://github.com/anthropics/claude-code)
[![Version](https://img.shields.io/badge/Version-0.11.0-green.svg)](./.claude-plugin/plugin.json)

[English](./README.md)&ensp;|&ensp;[License](./LICENSE)

</div>

<br/>

OptCode 是一个 [Claude Code](https://github.com/anthropics/claude-code) 插件，编排**多维度代码审查**与**自动修复闭环**。它将代码质量视为闭环系统：跨 8 个维度审查、根因分析、原则对齐修复、验证、回归检查——全部由轻量状态机驱动。

三种运行模式满足不同深度需求：

| 模式 | 行为 | 是否修改代码 |
|------|------|:---:|
| `light` | 8 维 CR → 修复 → diff 验证闭环。适合局部清理和低风险修复 | 是 |
| `deep` | 结构诊断、风险分层、分阶段重构计划。适合大类拆分、领域沉淀 | 否 |
| `auto` | 先预检，再保守选择 `light` 或 `deep` plan-only | 视决策而定 |

<br/>

## 目录

- [审查维度](#审查维度)
- [安装](#安装)
- [使用](#使用)
- [工作流程](#工作流程)
- [产物目录](#产物目录)
- [架构](#架构)
- [团队规则](#团队规则)
- [贡献](#贡献)
- [许可证](#许可证)

<br/>

## 审查维度

| 维度 | 检查内容 |
|------|----------|
| dead-code | 无效代码残料（未使用变量/函数/import、死代码块） |
| duplication | 重复代码（复制粘贴、可抽象的重复逻辑） |
| concurrency | 并发安全（竞态条件、死锁、原子性违反） |
| design | 设计原则（SRP、OCP、高内聚低耦合、分层边界） |
| style | 代码风格一致性（命名规范、格式、注释） |
| maintainability | 可维护性（可读性、模块化、错误处理） |
| legacy-safety | 遗留系统安全性（隐式业务规则、高风险核心路径） |
| ai-sdd-smells | AI/SDD 坏味道（需求漂移、过度工程、上下文污染） |

<br/>

## 安装

### 通过插件市场

```bash
# 添加市场
claude plugin marketplace add git@github.com:Jxin-Cai/optcode.git

# 安装插件
claude plugin install optcode@optcode
```

### 管理命令

```bash
claude plugin marketplace list          # 查看已添加的市场
claude plugin marketplace update        # 更新市场索引
claude plugin list                      # 查看已安装插件
claude plugin update optcode            # 更新插件
claude plugin uninstall optcode         # 卸载插件
claude plugin marketplace remove optcode  # 移除市场
```

<br/>

## 使用

```bash
# 审查当前目录（默认 light 模式）
/optcode

# 审查指定路径
/optcode src/

# 审查多个路径
/optcode src/core,src/utils,lib/

# 审查指定文件
/optcode src/main.go,src/handler.go

# 显式轻量模式
/optcode --mode light src/

# 重度结构诊断（仅生成计划，不修改代码）
/optcode --mode deep src/

# 自动预检后选择 light 或 deep
/optcode --mode auto src/

# 仅审查 git 变更文件
/optcode --diff
/optcode --diff main

# 跳过指定维度
/optcode --skip style,design src/

# 组合使用
/optcode --mode auto --diff main
```

<br/>

## 工作流程

```
/optcode <paths>
    │
    ▼
orchestration-status.js（每轮调用，确定 action）
    │
    ├─ init             → 初始化状态 + 文件清单
    ├─ preflight        → auto 模式预检，选择 light/deep
    ├─ deep_plan        → deep 模式结构诊断与计划
    ├─ start_dimension  → light 模式切入下一个维度
    ├─ cr               → agent-cr(opus) 审查，输出 CR 报告
    ├─ rca              → agent-rca 聚类问题，输出原则对齐策略
    ├─ fix              → agent-fixer(sonnet) 按 RCA 策略修复
    ├─ verify           → 验证修复结果
    ├─ escalate         → 停滞检测后升级修复策略
    ├─ exceed           → 超出轮次上限，跳过维度
    └─ summary          → 所有维度完成，输出总结 + 仪表盘
```

每轮通过 `gate-check.js` 验证产物合规性，通过 `dimension-status.js` 推进状态机。

<br/>

## 产物目录

运行时产物存储在目标项目的 `.optcode/` 下：

```
.optcode/{timestamp}/
├── state.json          # 工作流状态
├── audit-log.jsonl     # 审计日志
├── dashboard.md        # 观测仪表盘（可重复打开）
├── file-inventory.md   # 文件清单
├── preflight.md        # auto 模式预检结果
├── deep-plan.md        # deep 模式结构诊断计划
├── cr/                 # CR 报告
│   └── arch-diagram.mmd  # 架构图（design 维度产出）
├── verification/       # 验证报告
├── rca/                # RCA 根因分析报告
├── fix/                # 修复报告
├── regression/         # 回归检查报告
└── summary.md          # 最终总结

.optcode/
├── health-history.json # 跨运行健康分历史
├── known-issues.json   # 跨运行已知问题
└── rules/*.md          # 团队自定义审查规则
```

<br/>

## 架构

| 组件 | 路径 | 说明 |
|------|------|------|
| 主编排器 | `skills/optcode/SKILL.md` | `/optcode` 入口，调度 CR 和修复循环 |
| CR Agent | `agents/agent-cr.md` | 通用审查 agent，按维度视角重入使用 |
| RCA Agent | `agents/agent-rca.md` | 根因分析 agent，聚类问题并产出原则对齐策略 |
| Fixer Agent | `agents/agent-fixer.md` | 修复 agent，按 RCA 策略或 CR 报告执行修复 |
| Verifier Agent | `agents/agent-verifier.md` | 验证 agent，校验修复正确性 |
| Regression Agent | `agents/agent-regression-check.md` | 回归检查 agent |
| 维度视角 | `dimensions/*.md` | 8 个维度的检查清单和专属规则 |
| 状态机 | `scripts/workflow-lib.js` | 原子写入、状态读写、审计日志、停滞检测 |
| 编排恢复点 | `scripts/orchestration-status.js` | 每轮判定下一步 action |
| 门检查 | `scripts/gate-check.js` | 产物后置条件验证 |
| 质量门禁 | `scripts/quality-gate.js` | 基于维度结果计算质量评分（PASS/WARN/FAIL） |
| 观测仪表盘 | `scripts/dashboard.js` | 质量评分+趋势+债务统一仪表盘 |
| 规则加载器 | `scripts/rules-loader.js` | 加载 `.optcode/rules/*.md` 自定义审查规则 |

<br/>

## 团队规则

OptCode 支持项目级自定义审查规则。将 Markdown 文件放置在目标项目的 `.optcode/rules/` 目录下：

```
.optcode/rules/
├── naming.md           # 命名规范
├── error-handling.md   # 错误处理标准
└── api-design.md       # API 设计规范
```

规则会自动加载并注入到 CR agent 的审查视角中。

<br/>

## 贡献

如果你计划贡献重大变更，请**先创建 issue** 讨论方向和范围。欢迎提交 Bug 报告、功能建议和 Pull Request。

<br/>

## 许可证

基于 [Apache License 2.0](./LICENSE) 开源。

Copyright 2026 jxin
