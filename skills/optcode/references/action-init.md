# 启动流程（action=init）

1. 解析 `$ARGUMENTS`：
   - `--mode light|deep|auto`：优化模式，默认 `light`
   - `--profile light|deep|auto`：等价于 `--mode`
   - `--diff [base_ref]`：增量审查模式，仅审查 git 变更文件；未指定 base ref 时默认 `HEAD`
   - `--skip dim1,dim2`：跳过指定轻量维度
   - 其余参数解析为目标路径列表（逗号分隔），无参数且非 diff 时默认 `.`
2. `TIMESTAMP=$(date +%Y%m%d-%H%M%S)`，设 `WORK_DIR=.optcode/${TIMESTAMP}`
3. `BASE_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "no-git")`
4. 初始化状态：
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/init-state.js ${WORK_DIR} ${BASE_COMMIT} <target_path1> [target_path2 ...] --mode <light|deep|auto> [--diff [base_ref]] [--skip dim1,dim2]
   ```
5. 构建文件清单：
   - 增量模式：`node ${CLAUDE_PLUGIN_ROOT}/scripts/file-inventory.js --diff [base_ref] > ${WORK_DIR}/file-inventory.md`
   - 全量模式：`node ${CLAUDE_PLUGIN_ROOT}/scripts/file-inventory.js <target_paths> > ${WORK_DIR}/file-inventory.md`
6. 验证 gate：`node ${CLAUDE_PLUGIN_ROOT}/scripts/gate-check.js ${WORK_DIR} state-initialized`
7. 进入维度执行循环
