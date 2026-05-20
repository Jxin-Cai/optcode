# 启动流程（action=init）

1. 解析 `$ARGUMENTS` 为目标路径列表（逗号分隔），无参数默认 `.`
2. `TIMESTAMP=$(date +%Y%m%d-%H%M%S)`，设 `WORK_DIR=.optcode/${TIMESTAMP}`
3. `BASE_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "no-git")`
4. 初始化状态：
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/init-state.js ${WORK_DIR} ${BASE_COMMIT} <target_path1> [target_path2 ...]
   ```
5. 构建文件清单：
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/file-inventory.js <target_paths> > ${WORK_DIR}/file-inventory.md
   ```
6. 验证 gate：`node ${CLAUDE_PLUGIN_ROOT}/scripts/gate-check.js ${WORK_DIR} state-initialized`
7. 进入维度执行循环
