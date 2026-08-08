const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const fixPhase = readFileSync(join(root, 'workflows', 'phases', 'fix-phase.js'), 'utf8');
const crPhase = readFileSync(join(root, 'workflows', 'phases', 'cr-phase.js'), 'utf8');
const workflow = readFileSync(join(root, 'workflows', 'optcode-review.js'), 'utf8');

test('all Dynamic Workflow scripts are syntactically valid async bodies', () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const relativePath of [
    ['workflows', 'optcode-review.js'],
    ['workflows', 'phases', 'cr-phase.js'],
    ['workflows', 'phases', 'verify-phase.js'],
    ['workflows', 'phases', 'fix-phase.js'],
  ]) {
    const source = readFileSync(join(root, ...relativePath), 'utf8').replace('export const meta', 'const meta');
    assert.doesNotThrow(() => new AsyncFunction(source), relativePath.join('/'));
  }
});

test('fix workflow uses exact per-round checkpoints and never base-commit checkout rollback', () => {
  assert.match(fixPhase, /mutation-checkpoint\.js capture/);
  assert.match(fixPhase, /mutation-checkpoint\.js rollback/);
  assert.doesNotMatch(fixPhase, /git\s+(?:checkout|reset)\s+\$\{baseCommit\}/);
});

test('fix workflow rejects unavailable or stale evidence before mutation', () => {
  assert.match(fixPhase, /evidence_bundle_invalid/);
  assert.match(fixPhase, /evidence_bundle_unavailable/);
  assert.match(fixPhase, /blast_radius_unavailable/);
});

test('CR workflow blocks invalid evidence and persists only gated findings', () => {
  assert.match(crPhase, /cr_evidence_contract_failed/);
  assert.match(crPhase, /synthetic_evidence/);
  assert.match(crPhase, /report_quality_unavailable/);
  assert.match(crPhase, /synthetic_evidence_unavailable/);
  assert.match(crPhase, /cr_barrier_incomplete/);
  assert.match(crPhase, /--dimensions \$\{acceptedDimensions\.join/);
  assert.ok(crPhase.indexOf('cr_evidence_contract_failed') < crPhase.indexOf('known-issues.js sync'));
});

test('auto mode has a recorded preflight and check mode cannot enter verification or fix', () => {
  assert.match(workflow, /mode === 'auto'/);
  assert.match(workflow, /--preflight-done/);
  assert.match(workflow, /if \(singleDimension\).*check_complete/s);
});

test('workflow and fixer agree on the canonical fix report filename', () => {
  assert.match(fixPhase, /round-\$\{round\}-fix\.md/);
  assert.doesNotMatch(fixPhase, /fix\/\$\{dimension\}-round-\$\{round\}\.md/);
});
