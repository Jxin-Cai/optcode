# 启动流程参考

本文档为 SKILL.md Step 2 "Initialize a run" 的辅助参考。

## 参数解析

- `--mode light|deep|auto`：优化模式，默认 `light`
- `--diff [base_ref]`：增量审查模式，仅审查 git 变更文件；未指定 base ref 时默认 `HEAD`
- `--skip dim1,dim2`：跳过指定维度
- 其余参数解析为目标路径列表（逗号分隔），无参数且非 diff 时默认 `.`

## 执行步骤

```bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
WORK_DIR=".optcode/${TIMESTAMP}"
BASE_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "no-git")

# 初始化状态
node ${CLAUDE_PLUGIN_ROOT}/scripts/init-state.js ${WORK_DIR} ${BASE_COMMIT} <target_paths> --mode <mode> [--diff [base_ref]] [--skip dim1,dim2]

# 构建文件清单
node ${CLAUDE_PLUGIN_ROOT}/scripts/file-inventory.js <target_paths> > ${WORK_DIR}/file-inventory.md
# 或增量模式：
node ${CLAUDE_PLUGIN_ROOT}/scripts/file-inventory.js --diff [base_ref] > ${WORK_DIR}/file-inventory.md
```

初始化完成后，调用 Workflow 工具启动 Dynamic Workflow（见 SKILL.md Step 3）。
