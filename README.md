# OptCode

多维度代码审查与自动修复循环 —— Claude Code 插件。

通过 7 个维度依次审查代码，发现问题后自动修复，形成 **CR → 修复 → diff 复核** 的闭环。

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

## 安装

```bash
claude plugin add git@github.com:Jxin-Cai/optcode.git
```

## 使用

```bash
# 审查当前目录
/optcode

# 审查指定路径
/optcode src/

# 审查多个路径
/optcode src/core,src/utils,lib/

# 审查指定文件
/optcode src/main.go,src/handler.go
```

## 工作流程

```
/optcode <paths>
    │
    ▼
orchestration-status.mjs（每轮调用，确定 action）
    │
    ├─ init          → 初始化状态 + 文件清单
    ├─ start_dimension → 切入下一个维度
    ├─ cr            → agent-cr(opus) 审查，输出 CR 报告
    ├─ fix           → agent-fixer(sonnet) 修复，输出 fix 报告
    ├─ escalate      → 停滞检测后升级修复策略
    ├─ exceed        → 超出轮次上限，跳过维度
    └─ summary       → 所有维度完成，输出总结报告
```

每轮通过 `gate-check.mjs` 验证产物合规性，通过 `dimension-status.mjs` 推进状态机。

## 产物目录

运行时产物存储在目标项目的 `.optcode/` 下：

```
.optcode/{timestamp}/
├── state.json          # 工作流状态
├── audit-log.jsonl     # 审计日志
├── file-inventory.md   # 文件清单
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
| 状态机 | `scripts/workflow-lib.mjs` | 原子写入、审计日志、停滞检测 |
| 恢复点 | `scripts/orchestration-status.mjs` | 每轮判定 action |
| 门检查 | `scripts/gate-check.mjs` | 产物后置条件验证 |
| 质量门禁 | `scripts/quality-gate.mjs` | 质量评分（PASS/WARN/FAIL） |

## License

MIT
