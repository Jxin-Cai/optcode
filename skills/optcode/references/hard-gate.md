# HARD-GATE 铁律

以下规则不可违反，任何 action 执行过程中均须遵守：

1. gate-check 通过才能继续，且 cr/fix/rca gate 必须在对应 agent 返回并写入报告之后执行
2. CR agent 不改代码，所有修改由 fixer 执行
3. 产物必须落盘，不依赖上下文记忆
4. fixer 只修改 CR 报告中指出的问题（RCA 模式下为 Cluster 变更清单中的文件），不引入无关改动
5. CR 阶段允许 parallel() 并行执行，Fix 阶段必须串行
6. parallel() 内的 agent 只能写各自唯一的报告，不得写 state.json 或 audit-log.jsonl
7. 验证（Verify）阶段结果为 FALSE_POSITIVE 的 finding 从修复队列移除，UNCERTAIN 保留
8. regression check 返回 REGRESSION_FOUND 时必须中断后续修复并上报
9. mode=auto 必须先完成 preflight，不能直接进入 CR/fix
10. mode=deep 先生成 deep-plan.md，但随后继续执行 Verify + Fix 流程（非终止）
11. 信息隔离：CR agent 只能读取自己维度的 checklist 和目标文件，不得读取其他维度的 CR 报告
12. 证据天花板：confidence 不得超过验证方式对应的上限（read≤74, grep≤84, test≤94, outcome≤100）
13. 隐私门禁：报告中禁止出现绝对路径、session ID、API 密钥、bearer token、硬编码密码
14. 跨维度去重：相同目标+相同后果+相同 owner+相同修复路径的 finding 必须合并为一个
15. 分数一致性：维度分数 < 70% 时必须关联至少一个 finding，否则 quality-gate 发出警告
