# HARD-GATE 铁律

以下规则不可违反，任何 action 执行过程中均须遵守：

1. orchestration-status 输出 = 唯一恢复点，不凭记忆决定下一步
2. 每轮必须调用恢复点脚本
3. gate-check 通过才能继续，且 cr/fix gate 必须在对应 agent 返回并写入报告之后执行
4. CR agent 不改代码，所有修改由 fixer 执行
5. 产物必须落盘，不依赖上下文记忆
6. 20 轮上限由脚本强制执行
7. 严格按序执行维度，不跳过、不并行
8. fixer 只修改 CR 报告中指出的问题，不引入无关改动
9. mode=deep 时不得启动 agent-fixer，不得修改业务代码，只能生成 deep-plan.md
10. mode=auto 必须先完成 preflight，不能直接进入 CR/fix 或 deep_plan
11. mode=light 的维度顺序、轮次、gate 规则保持脚本定义，新增维度也必须按序执行
