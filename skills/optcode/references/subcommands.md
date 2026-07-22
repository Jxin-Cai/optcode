# 子命令参考

## `/optcode review [paths] [--mode] [--dims] [--skip]`

只执行 CR + Verify 阶段，不进行自动修复。适合在提交 PR 前快速了解当前代码存在的问题。

**Workflow args**: `fixEnabled: false`

**产出**: CR 报告 + 验证报告，不会修改任何业务代码。

**示例**:
```
/optcode review src/auth/
/optcode review --dims security,design
```

---

## `/optcode fix [work-dir]`

从已有的 CR 报告恢复修复流程。当之前的 `/optcode review` 发现了问题，现在决定修复时使用。

**Workflow args**: `resumeFix: true, existingWorkDir: <work-dir>`

如果未指定 work-dir，自动使用最近一个有 `needs_fix` findings 的运行目录。

**示例**:
```
/optcode fix
/optcode fix .optcode/20240720-143000
```

---

## `/optcode check <dimension> [paths]`

单维度快速检查，最多报告 3 个问题。适合在编辑过程中快速验证特定方面的代码质量。

**Workflow args**: `singleDimension: <dim>, maxFindings: 3`

跳过完整的 activation 流程，直接对指定维度执行 CR。不执行验证和修复。

**支持的维度**: `dead-code`, `duplication`, `concurrency`, `design`, `style`, `maintainability`, `legacy-safety`, `ai-sdd-smells`, `security`

**示例**:
```
/optcode check security src/api/
/optcode check design src/services/auth.ts
```

---

## `/optcode status [work-dir]`

查看当前或指定运行的状态。不启动 Workflow，直接运行 `orchestration-status.js` 并展示结果。

如果未指定 work-dir，自动使用最近的运行目录。

**示例**:
```
/optcode status
/optcode status .optcode/20240720-143000
```

---

## 向后兼容

当第一个参数不是已知子命令（`review`、`fix`、`check`、`status`）时，视为目标路径，执行完整的 CR + Fix 流程（与之前版本行为一致）。

```
/optcode src/            # 完整流程（向后兼容）
/optcode --dims security # 完整流程，仅限安全维度
```
