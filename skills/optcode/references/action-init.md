# 启动流程（action=init）

1. 解析 `$ARGUMENTS` 为目标路径列表（逗号分隔），无参数默认 `.`
2. `TIMESTAMP=$(date +%Y%m%d-%H%M%S)`，设 `WORK_DIR=.optcode/${TIMESTAMP}`
3. `BASE_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "no-git")`
4. 初始化：
   ```bash
   mkdir -p ${WORK_DIR}/cr ${WORK_DIR}/fix
   ```
   通过 workflow-lib 的 initState 写入 `${WORK_DIR}/state.json`
5. 构建文件清单：
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/file-inventory.mjs <target_paths> > ${WORK_DIR}/file-inventory.md
   ```
6. 验证 gate：`node ${CLAUDE_PLUGIN_ROOT}/scripts/gate-check.mjs ${WORK_DIR} state-initialized`
7. 进入维度执行循环
