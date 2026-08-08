# 团队自定义规则指南

## 目录结构

```
.optcode/rules/
├── naming-conventions.md
├── no-any-type.md
└── error-handling.md
```

将规则文件放在项目根目录的 `.optcode/rules/` 中。每个 `.md` 文件是一条独立规则。

## 文件格式

```markdown
---
scope: design,maintainability   # 适用维度（逗号分隔），* 表示全部维度
severity: medium                # 建议严重度（可选）：high / medium / low
---

# 规则标题

规则正文：用自然语言描述团队审查偏好、禁止的模式、或必须遵循的规范。
```

### Frontmatter 字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `scope` | 是 | 适用维度列表。`*` = 所有维度；或指定维度 ID（如 `design,security`） |
| `severity` | 否 | 触发此规则时的建议严重度。CR agent 可根据实际情况调整 |

### 可用的 scope 值

`dead-code`, `duplication`, `concurrency`, `design`, `style`, `maintainability`, `legacy-safety`, `ai-sdd-smells`, `security`, `*`

## 规则正文编写建议

1. **具体而非抽象** — "禁止使用 `any` 类型" 优于 "注意类型安全"
2. **说明原因** — 让 CR agent 理解为什么这条规则存在
3. **给出例外** — 明确什么情况下可以不遵守
4. **可验证** — agent 能通过 Read/Grep 确认是否违反

## 示例

### 示例 1：禁止直接数据库查询

```markdown
---
scope: design
severity: high
---

# 业务层禁止直接数据库查询

所有数据库访问必须通过 Repository 层。Service 层的文件中不应出现：
- 直接的 SQL 查询字符串
- ORM 的 find/save/delete 直接调用
- 数据库连接对象的引用

原因：我们曾因 Service 层散落数据库调用导致事务管理混乱（2024-Q2 事故）。
```

### 示例 2：API 返回格式规范

```markdown
---
scope: style,design
severity: medium
---

# API 响应统一包装

所有 REST API 响应必须使用统一的包装格式：
- 成功：`{ code: 0, data: ..., message: "ok" }`
- 失败：`{ code: <error_code>, data: null, message: "..." }`

不允许直接返回裸数据或非标准格式。
```

### 示例 3：测试相关

```markdown
---
scope: maintainability
severity: low
---

# 测试文件与源文件同目录

测试文件应放在被测文件的同目录下，命名为 `<filename>.test.ts`。
不使用独立的 `__tests__/` 目录。
```

## 与 known-issues 联动

当 CR 发现被 defer 且标注原因为误报时，系统会分析高频误报模式并建议新规则。运行：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/known-issues.js" suggest-rules
```

可查看基于历史误报的规则建议。

## 快速开始

```bash
# 初始化示例规则
node "${CLAUDE_PLUGIN_ROOT}/scripts/rules-loader.js" init

# 查看已有规则
node "${CLAUDE_PLUGIN_ROOT}/scripts/rules-loader.js" list

# 预览某维度会加载哪些规则
node "${CLAUDE_PLUGIN_ROOT}/scripts/rules-loader.js" context design
```
