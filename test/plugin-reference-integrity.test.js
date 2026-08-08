const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync, readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

test('every CLAUDE_PLUGIN_ROOT file reference resolves inside the plugin', () => {
  const sources = ['agents', 'hooks', 'skills', 'workflows']
    .flatMap(directory => walk(join(root, directory)))
    .filter(file => /\.(?:md|json|js)$/.test(file));
  const missing = [];
  const pattern = /\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9_./-]+)/g;
  for (const source of sources) {
    const content = readFileSync(source, 'utf8');
    for (const match of content.matchAll(pattern)) {
      const referenced = match[1].replace(/[.,;:)]+$/, '');
      if (!existsSync(join(root, referenced))) missing.push({ source, referenced });
    }
  }
  assert.deepEqual(missing, []);
});

test('hook commands quote portable plugin-root paths', () => {
  const hooks = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8'));
  const commands = Object.values(hooks.hooks)
    .flat()
    .flatMap(registration => registration.hooks)
    .map(hook => hook.command);
  assert.ok(commands.length > 0);
  for (const command of commands) {
    assert.match(command, /"\$\{CLAUDE_PLUGIN_ROOT\}\/[^"]+"/);
  }
});

test('skill-local reference links resolve relative to the skill directory', () => {
  const skillRoot = join(root, 'skills', 'optcode');
  const skill = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8');
  const references = [...skill.matchAll(/`(references\/[A-Za-z0-9_.-]+)`/g)].map(match => match[1]);
  assert.ok(references.length > 0);
  for (const reference of references) {
    assert.equal(existsSync(join(skillRoot, reference)), true, `missing ${reference}`);
  }
});
