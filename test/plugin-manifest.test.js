const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');

test('plugin and marketplace versions stay synchronized', () => {
  const plugin = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  const marketplace = JSON.parse(readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const entry = marketplace.plugins.find(candidate => candidate.name === plugin.name);
  assert.ok(entry, `marketplace entry missing for ${plugin.name}`);
  assert.equal(entry.version, plugin.version);
  for (const readme of ['README.md', 'README_zh.md']) {
    const content = readFileSync(join(root, readme), 'utf8');
    assert.match(content, new RegExp(`Version-${plugin.version.replaceAll('.', '\\.')}-green`), `${readme} version badge drifted`);
  }
});

test('every explicitly declared plugin component exists', () => {
  const plugin = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  for (const agent of plugin.agents || []) {
    assert.equal(existsSync(join(root, agent)), true, `missing agent: ${agent}`);
  }
  for (const skillRoot of plugin.skills || []) {
    assert.equal(existsSync(join(root, skillRoot)), true, `missing skill root: ${skillRoot}`);
  }
});
