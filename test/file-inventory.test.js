const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

const script = join(__dirname, '..', 'scripts', 'file-inventory.js');

test('scans paths with shell metacharacters without executing them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optcode-inventory-'));
  const target = join(dir, 'src;touch injected');
  mkdirSync(target);
  writeFileSync(join(target, 'main.js'), 'const value = 1;\n');

  const injected = join(process.cwd(), 'injected');
  const result = spawnSync(process.execPath, [script, target], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# File Inventory/);
  assert.match(result.stdout, /main\.js/);
  assert.equal(existsSync(injected), false);
});

test('rejects diff base refs that look like options', () => {
  const result = spawnSync(process.execPath, [script, '--diff', '--output=/tmp/bad'], { encoding: 'utf8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid base ref/);
});
