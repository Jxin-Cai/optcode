const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { validate } = require('../scripts/population-binding.js');

function report(dimension, uniqueFile) {
  return `---\nresult: needs_fix\nissues_count: 2\n---\n### ${dimension}:ISSUE-001: Shared\n\n- **文件**: \`src/shared.js\`\n\n### ${dimension}:ISSUE-002: Unique\n\n- **文件**: \`${uniqueFile}\`\n`;
}

test('cross-lane overlap binds each finding only to its own file', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'optcode-population-parser-'));
  const dimensions = ['design', 'style', 'security'];
  try {
    mkdirSync(join(workDir, 'cr'));
    const stateDimensions = {};
    dimensions.forEach((dimension, index) => {
      stateDimensions[dimension] = { status: 'needs_fix', issues_found: 2 };
      writeFileSync(join(workDir, 'cr', `${dimension}-round-1.md`), report(dimension, `src/unique-${index}.js`));
    });
    writeFileSync(join(workDir, 'state.json'), JSON.stringify({ dimensions: stateDimensions }));
    const result = validate(workDir);
    const overlaps = result.violations.filter(violation => violation.type === 'cross_lane_overlap');
    assert.equal(overlaps.length, 1);
    assert.equal(overlaps[0].file, 'src/shared.js');
    assert.equal(overlaps[0].finding_count, 3);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
