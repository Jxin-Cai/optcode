# OptCode

多维度代码审查与自动修复循环 —— Claude Code 插件。

通过轻量/重度/自动三种模式按需治理代码质量：轻量模式执行 7 个维度的 **CR → 修复 → diff 复核** 闭环；重度模式先输出结构诊断与分阶段重构计划；自动模式先预检再选择合适路径。

## 模式

| 模式 | 行为 | 是否修改代码 |
|------|------|--------------|
| `light` | 现有 7 维 CR/fix 循环，适合局部清理和低风险修复 | 是 |
| `deep` | 结构诊断、风险分层、分阶段实施计划，适合大类拆分、领域沉淀、公共复用规划 | 否 |
| `auto` | 先 preflight，再保守选择 `light` 或 `deep` plan-only | 视决策而定 |

不传 `--mode` 时默认 `light`，行为与旧版本一致。

## 审查维度

| 维度 | 说明 |
|------|------|
| dead-code | 无效代码残料（未使用变量/函数/import、死代码块） |
| duplication | 重复代码（复制粘贴、可抽象的重复逻辑） |
| concurrency | 并发安全（竞态条件、死锁、原子性违反） |
| design | 设计原则（SRP、OCP、高内聚低耦合、分层边界） |
| style | 代码风格一致性（命名规范、格式、注释） |
| maintainability | 可维护性（可读性、模块化、错误处理） |
| legacy-safety | 遗留系统安全性（隐式业务规则、高风险核心路径） |
| ai-sdd-smells | AI/SDD 坏味道（需求漂移、过度工程、上下文污染） |

## 安装

### 1. 添加插件市场

```bash
claude plugin marketplace add git@github.com:Jxin-Cai/optcode.git
```

### 2. 安装插件

```bash
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

## 使用

```bash
# 审查当前目录（默认 light）
/optcode

# 审查指定路径
/optcode src/

# 审查多个路径
/optcode src/core,src/utils,lib/

# 审查指定文件
/optcode src/main.go,src/handler.go

# 显式轻量模式
/optcode --mode light src/

# 重度结构诊断，只生成 deep-plan.md，不修改代码
/optcode --mode deep src/

# 自动预检后选择 light 或 deep plan-only
/optcode --mode auto src/

# 也可以使用 --profile 作为 --mode 的别名
/optcode --profile auto src/

# 仅审查 git 变更文件
/optcode --diff
/optcode --diff main

# 跳过指定轻量维度
/optcode --skip style,design src/

# 组合使用
/optcode --mode auto --diff main
```

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
    ├─ fix              → agent-fixer(sonnet) 修复，输出 fix 报告
    ├─ escalate         → 停滞检测后升级修复策略
    ├─ exceed           → 超出轮次上限，跳过维度
    └─ summary          → 所有维度完成，输出总结报告
```

每轮通过 `gate-check.js` 验证产物合规性，通过 `dimension-status.js` 推进状态机。

## 产物目录

运行时产物存储在目标项目的 `.optcode/` 下：

```
.optcode/{timestamp}/
├── state.json          # 工作流状态
├── audit-log.jsonl     # 审计日志
├── file-inventory.md   # 文件清单
├── preflight.md        # auto 模式预检结果
├── deep-plan.md        # deep 模式结构诊断计划
├── cr/                 # CR 报告
├── fix/                # 修复报告
└── summary.md          # 最终总结
```

## 架构

| 组件 | 路径 | 说明 |
|------|------|------|
| 主编排器 | `skills/optcode/SKILL.md` | `/optcode` 入口 |
| CR agent | `agents/agent-cr.md` | 审查 agent（opus） |
| Fixer agent | `agents/agent-fixer.md` | 修复 agent（sonnet） |
| 维度视角 | `dimensions/*.md` | 7 个维度的检查清单 |
| 状态机 | `scripts/workflow-lib.js` | 原子写入、审计日志、停滞检测 |
| 恢复点 | `scripts/orchestration-status.js` | 每轮判定 action |
| 门检查 | `scripts/gate-check.js` | 产物后置条件验证 |
| 质量门禁 | `scripts/quality-gate.js` | 质量评分（PASS/WARN/FAIL） |

## License

MIT
