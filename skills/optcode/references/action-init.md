# 启动流程（action=init）

1. 解析 `$ARGUMENTS` 为目标路径列表（逗号分隔），无参数默认 `.`
   - 如果参数包含 `--diff`，标记为增量审查模式（仅审查 git 变更文件）
   - `--diff` 后可跟可选的 base ref（如 `--diff main`），默认为 HEAD
2. `TIMESTAMP=$(date +%Y%m%d-%H%M%S)`，设 `WORK_DIR=.optcode/${TIMESTAMP}`
3. `BASE_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "no-git")`
4. 初始化状态：
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/init-state.js ${WORK_DIR} ${BASE_COMMIT} <target_path1> [target_path2 ...] [--skip dim1,dim2]
   ```
5. 构建文件清单：
   - 增量模式：`node ${CLAUDE_PLUGIN_ROOT}/scripts/file-inventory.js --diff [base_ref] > ${WORK_DIR}/file-inventory.md`
   - 全量模式：`node ${CLAUDE_PLUGIN_ROOT}/scripts/file-inventory.js <target_paths> > ${WORK_DIR}/file-inventory.md`
6. 验证 gate：`node ${CLAUDE_PLUGIN_ROOT}/scripts/gate-check.js ${WORK_DIR} state-initialized`
7. 进入维度执行循环
