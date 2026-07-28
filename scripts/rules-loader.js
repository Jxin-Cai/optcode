#!/usr/bin/env node
/**
 * rules-loader.js — Team custom rules for optcode.
 * Scans .optcode/rules/*.md and formats them for injection into CR agent prompts.
 *
 * Usage:
 *   node rules-loader.js context [dimension]  # Output rules text for prompt injection
 *   node rules-loader.js list                 # List all rule files
 *   node rules-loader.js init                 # Create example rules in .optcode/rules/
 */
const { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

function rulesDir(projectRoot) {
  return join(projectRoot, '.optcode', 'rules');
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content.trim() };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) meta[key.trim()] = rest.join(':').trim();
  }
  return { meta, body: match[2].trim() };
}

function loadRules(projectRoot) {
  const dir = rulesDir(projectRoot);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(f => f.endsWith('.md')).sort();
  return files.map(f => {
    const content = readFileSync(join(dir, f), 'utf8');
    const { meta, body } = parseFrontmatter(content);
    return {
      file: f,
      scope: (meta.scope || '*').split(',').map(s => s.trim()),
      severity: meta.severity || null,
      body
    };
  });
}

function getContext(projectRoot, dimension) {
  const rules = loadRules(projectRoot);
  if (rules.length === 0) return '';

  const matched = rules.filter(r =>
    r.scope.includes('*') || (dimension && r.scope.includes(dimension))
  );

  if (matched.length === 0) return '';

  const lines = ['## 团队自定义规则\n', '以下规则由团队定义，优先级高于维度默认规则。存在冲突时，遵循团队规则。\n'];
  for (const rule of matched) {
    lines.push(`### ${rule.file.replace('.md', '')}`);
    if (rule.severity) lines.push(`建议严重度: ${rule.severity}`);
    lines.push(rule.body);
    lines.push('');
  }
  return lines.join('\n');
}

function listRules(projectRoot) {
  const rules = loadRules(projectRoot);
  if (rules.length === 0) {
    console.log('No custom rules found. Run `node rules-loader.js init` to create examples.');
    return;
  }
  console.log(`Found ${rules.length} rule(s) in ${rulesDir(projectRoot)}:\n`);
  for (const rule of rules) {
    const title = rule.body.split('\n')[0].replace(/^#+ /, '');
    console.log(`  ${rule.file} — scope: [${rule.scope.join(', ')}] ${rule.severity ? `severity: ${rule.severity}` : ''}`);
    console.log(`    ${title}`);
  }
}

function initRules(projectRoot) {
  const dir = rulesDir(projectRoot);
  mkdirSync(dir, { recursive: true });

  const examples = [
    {
      name: 'naming-conventions.md',
      content: `---
scope: style,maintainability
severity: low
---

# 命名规范

- 所有 React 组件使用 PascalCase
- 工具函数使用 camelCase
- 常量使用 UPPER_SNAKE_CASE
- 文件名与默认导出保持一致
`
    },
    {
      name: 'no-any-type.md',
      content: `---
scope: maintainability,design
severity: medium
---

# 禁止使用 any 类型

TypeScript 代码中禁止使用 \`any\` 类型。应使用 \`unknown\` 配合类型守卫，或定义具体的类型/接口。

例外：第三方库类型定义不完整时，可使用 \`// eslint-disable-next-line\` 并附注释说明原因。
`
    },
    {
      name: 'error-handling.md',
      content: `---
scope: *
severity: medium
---

# 错误处理规范

- 禁止空 catch 块（至少记录日志）
- 异步函数必须有错误边界
- 用户可见的错误信息必须国际化
- 内部错误日志包含上下文（函数名、参数摘要）
`
    }
  ];

  let created = 0;
  for (const ex of examples) {
    const path = join(dir, ex.name);
    if (!existsSync(path)) {
      writeFileSync(path, ex.content, 'utf8');
      created++;
    }
  }
  console.log(`Initialized ${created} example rule(s) in ${dir}`);
}

// Library exports
module.exports = { loadRules, getContext, rulesDir };

// CLI
if (require.main === module) {
  const [,, command, ...rest] = process.argv;
  const projectRoot = process.cwd();

  switch (command) {
    case 'context': {
      const dimension = rest[0] || null;
      const ctx = getContext(projectRoot, dimension);
      console.log(ctx || '(no matching rules)');
      break;
    }
    case 'list': {
      listRules(projectRoot);
      break;
    }
    case 'init': {
      initRules(projectRoot);
      break;
    }
    default:
      process.stderr.write('Usage: rules-loader.js <context|list|init> [dimension]\n');
      process.exit(1);
  }
}
