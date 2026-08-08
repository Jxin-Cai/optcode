<div align="center">

# OptCode

**多维度代码审查与自动修复循环 —— Claude Code 插件。**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Plugin-D97757.svg)](https://github.com/anthropics/claude-code)
[![Version](https://img.shields.io/badge/Version-0.23.0-green.svg)](./.claude-plugin/plugin.json)

[English](./README.md)&ensp;|&ensp;[License](./LICENSE)

</div>

<br/>

OptCode 是一个 [Claude Code](https://github.com/anthropics/claude-code) 插件，编排**多维度代码审查**与**自动修复闭环**。它将代码质量视为闭环系统：跨 9 个维度审查、对抗式 finding 验证、根因分析、finding-bound 修复和回归检查——由 Claude Code Dynamic Workflow 统一编排。

三种运行模式满足不同深度需求：

| 模式 | 行为 | 是否修改代码 |
|------|------|:---:|
| `light` | 快速证据通道 → CR → finding 验证 → 有界修复。适合局部和低风险变更 | 是 |
| `deep` | 正常深度证据通道 + 结构计划检查点，再执行经验证的有界修复 | 是 |
| `auto` | 先记录只读预检结果，再选择 `light` 或 `deep` | 视 finding 而定 |

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
| security | 注入、鉴权、密钥处理、不安全执行与信任边界 |

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

# 只审查和验证，不修改代码
/optcode review src/

# 单维度快速检查（最多 3 个 finding，不修复）
/optcode check security src/api/

# 恢复已有审查运行的修复
/optcode fix .optcode/20240720-143000

# 仅审查 git 变更文件
/optcode --diff
/optcode --diff main

# 跳过指定维度
/optcode --skip style,design src/

# 组合使用
/optcode --mode auto --diff main
```

### 脚本 CLI

维护者和 CI 可通过一个不经过 shell 的统一入口发现并调用全部可执行能力：

```bash
npm run cli -- help                 # 工作流常用命令
npm run cli -- help --all           # 完整维护者命令清单
npm run cli -- help --json          # 机器可读 schema
npm run cli -- quality-gate <work-dir> --no-history
npm run cli -- evidence-bundle migrate <work-dir>  # 校验后执行 v1 → v2 迁移
```

测试会校验命令清单与可执行脚本完全对应，因此新增能力却遗漏注册会直接失败。帮助和未知命令路径不会写入项目文件。

<br/>

## 工作流程

```
/optcode <paths>
    │
    ├─ Activate  → 可选 auto 预检 + 适用维度集合
    ├─ CR        → 并行只读维度审查 + 证据门禁
    ├─ Verify    → 对每个 finding 做独立对抗式验证
    ├─ RCA       → 对确认 finding 并行做根因聚类
    └─ Fix       → 串行有界修复 + 回归检查 + 最终质量门禁
```

每轮修复前都会创建不修改用户 index 的 Git tree 检查点。失败或不确定的修复只恢复本轮差异，保留 OptCode 启动前已经存在的修改。

<br/>

## 产物目录

运行时产物存储在目标项目的 `.optcode/` 下：

```
.optcode/{timestamp}/
├── state.json          # 工作流状态
├── audit-log.jsonl     # 审计日志
├── evidence-bundle.json # 带版本和完整性封印的审查快照
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
├── transactions/       # 每轮 mutation 检查点与恢复元数据
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
| 维度视角 | `dimensions/*.md` | 9 个维度的检查清单和专属规则 |
| 状态机 | `scripts/workflow-lib.js` | 原子写入、状态读写、审计日志、停滞检测 |
| 编排恢复点 | `scripts/orchestration-status.js` | 每轮判定下一步 action |
| 门检查 | `scripts/gate-check.js` | 产物后置条件验证 |
| 证据包 | `scripts/evidence-bundle.js` | 带版本的工作区快照与漂移验证唯一事实源 |
| 报告解析器 | `scripts/report-parser.js` | ISSUE 标题、区块边界、字段和限定 ID 的唯一事实源 |
| JSON 存储 | `scripts/safe-json-store.js` | 原子持久化、备份校验和 fail-closed 恢复 |
| 质量门禁 | `scripts/quality-gate.js` | 基于维度结果计算质量评分（PASS/WARN/FAIL） |
| 观测仪表盘 | `scripts/dashboard.js` | 质量评分+趋势+债务统一仪表盘 |
| 规则加载器 | `scripts/rules-loader.js` | 加载 `.optcode/rules/*.md` 自定义审查规则 |
| Mutation 检查点 | `scripts/mutation-checkpoint.js` | 保留修复前脏工作树，只回滚单轮修复 |

`scripts/context-freeze.js` 仅保留为弃用兼容门面。新快照统一写入 `evidence-bundle.json`；旧 v1 产物必须先通过完整性校验，才可迁移到 schema v2。

状态读取器只会使用有效备份恢复损坏的主文件。主文件和备份同时损坏时，面向 state 的 CLI 会 fail-closed，返回 `E_STATE_CORRUPT`、退出码 3，以及向后兼容的 `{ ok, code, message, ... }` JSON envelope。

跨运行 registry 遵循相同规则：文件缺失时可以初始化；文件损坏时只能从有效 `.backup` 恢复；主文件和备份同时损坏时返回 `E_STORE_CORRUPT`，且不得覆盖任何文件。Known issues、健康历史、去重、loop discovery、intervention 和 effectiveness history 已统一使用该存储层。

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
