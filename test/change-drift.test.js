const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

const {
  analyzeDiffImpact,
  identifyCoreCandidates,
  analyzeFullDrift,
  classifyFileRole,
} = require('../scripts/change-drift.js');

const script = join(__dirname, '..', 'scripts', 'change-drift.js');

function mockExecFileSync(handler) {
  return (_bin, args, _opts) => handler(args.join(' '));
}

// --- classifyFileRole tests ---

test('classifyFileRole identifies source files', () => {
  assert.equal(classifyFileRole('src/main.js'), 'source');
  assert.equal(classifyFileRole('lib/utils.ts'), 'source');
  assert.equal(classifyFileRole('app/server.go'), 'source');
  assert.equal(classifyFileRole('core/handler.py'), 'source');
  assert.equal(classifyFileRole('src/component.tsx'), 'source');
  assert.equal(classifyFileRole('src/index.mjs'), 'source');
});

test('classifyFileRole identifies test files', () => {
  assert.equal(classifyFileRole('src/main.test.js'), 'test');
  assert.equal(classifyFileRole('lib/utils.spec.ts'), 'test');
  assert.equal(classifyFileRole('__tests__/foo.js'), 'test');
  assert.equal(classifyFileRole('test/helper.js'), 'test');
  assert.equal(classifyFileRole('tests/integration/api.ts'), 'test');
});

test('classifyFileRole identifies config files', () => {
  assert.equal(classifyFileRole('jest.config.js'), 'config');
  assert.equal(classifyFileRole('.eslintrc'), 'config');
  assert.equal(classifyFileRole('package.json'), 'config');
  assert.equal(classifyFileRole('tsconfig.json'), 'config');
  assert.equal(classifyFileRole('webpack.config.ts'), 'config');
  assert.equal(classifyFileRole('vite.config.ts'), 'config');
});

test('classifyFileRole identifies doc files', () => {
  assert.equal(classifyFileRole('README.md'), 'docs');
  assert.equal(classifyFileRole('docs/guide.txt'), 'docs');
  assert.equal(classifyFileRole('CHANGELOG.rst'), 'docs');
  assert.equal(classifyFileRole('api.adoc'), 'docs');
});

test('classifyFileRole identifies generated/lock files', () => {
  assert.equal(classifyFileRole('package-lock.json'), 'generated');
  assert.equal(classifyFileRole('yarn.lock'), 'generated');
});

// --- analyzeDiffImpact tests with mocked deps ---

test('analyzeDiffImpact parses numstat and computes weighted impact', () => {
  const deps = {
    execFileSync: mockExecFileSync((cmd) => {
      if (cmd.includes('--numstat')) {
        return '10\t2\tsrc/main.js\n5\t1\tsrc/main.test.js\n3\t0\tpackage.json\n8\t0\tREADME.md\n';
      }
      return '';
    }),
  };

  const result = analyzeDiffImpact('abc123', deps);

  assert.equal(result.baseCommit, 'abc123');
  assert.equal(result.files.length, 4);
  assert.equal(result.summary.totalFiles, 4);

  // src/main.js: 12 lines delta, role=source
  const mainFile = result.files.find(f => f.path === 'src/main.js');
  assert.equal(mainFile.linesAdded, 10);
  assert.equal(mainFile.linesRemoved, 2);
  assert.equal(mainFile.role, 'source');

  // src/main.test.js: 6 lines delta, role=test
  const testFile = result.files.find(f => f.path === 'src/main.test.js');
  assert.equal(testFile.role, 'test');

  // package.json: 3 lines delta, role=config
  const configFile = result.files.find(f => f.path === 'package.json');
  assert.equal(configFile.role, 'config');

  // README.md: 8 lines delta, role=docs
  const docFile = result.files.find(f => f.path === 'README.md');
  assert.equal(docFile.role, 'docs');

  // weighted = source(12)*3 + test(6)*1 + config(3)*2 + docs(8)*0.5 = 36 + 6 + 6 + 4 = 52
  assert.equal(result.weightedImpact, 52);
  assert.equal(result.summary.source, 12);
  assert.equal(result.summary.test, 6);
  assert.equal(result.summary.config, 3);
  assert.equal(result.summary.docs, 8);
});

test('analyzeDiffImpact handles empty diff', () => {
  const deps = {
    execFileSync: mockExecFileSync(() => '\n'),
  };

  const result = analyzeDiffImpact('abc123', deps);

  assert.equal(result.files.length, 0);
  assert.equal(result.summary.totalFiles, 0);
  assert.equal(result.weightedImpact, 0);
});

test('analyzeDiffImpact handles binary files (- - notation)', () => {
  const deps = {
    execFileSync: mockExecFileSync(() => '-\t-\tassets/logo.png\n5\t2\tsrc/app.js\n'),
  };

  const result = analyzeDiffImpact('abc123', deps);

  assert.equal(result.files.length, 2);
  const binary = result.files.find(f => f.path === 'assets/logo.png');
  assert.equal(binary.linesAdded, 0);
  assert.equal(binary.linesRemoved, 0);
});

test('analyzeDiffImpact returns error on git failure', () => {
  const deps = {
    execFileSync: mockExecFileSync(() => { throw new Error('fatal: bad revision'); }),
  };

  const result = analyzeDiffImpact('nonexistent', deps);

  assert.ok(result.error);
  assert.equal(result.files.length, 0);
  assert.equal(result.weightedImpact, 0);
});

// --- identifyCoreCandidates tests with mocked deps ---

test('identifyCoreCandidates identifies high-score files as core', () => {
  const handler = (cmd) => {
    if (cmd.includes('--numstat')) {
      return '10\t2\tsrc/database.js\n3\t1\tsrc/helper.js\n';
    }
    if (cmd.includes('ls-files')) {
      return 'src/database.js\nsrc/helper.js\nsrc/app.js\nsrc/routes.js\n';
    }
    // fan-in grep for database: 4 files import it
    if (cmd.includes('grep') && cmd.includes('database')) {
      return 'a.js\nb.js\nc.js\nd.js\n';
    }
    // fan-in grep for helper: 1 file imports it
    if (cmd.includes('grep') && cmd.includes('helper')) {
      return 'a.js\n';
    }
    // churn for database: high churn
    if (cmd.includes('log') && cmd.includes('database')) {
      if (cmd.includes('30 days')) return Array(8).fill('x').join('\n') + '\n';
      if (cmd.includes('90 days')) return Array(15).fill('x').join('\n') + '\n';
      if (cmd.includes('180 days')) return Array(25).fill('x').join('\n') + '\n';
    }
    // churn for helper: low churn
    if (cmd.includes('log') && cmd.includes('helper')) {
      if (cmd.includes('30 days')) return 'x\n';
      if (cmd.includes('90 days')) return 'x\nx\n';
      if (cmd.includes('180 days')) return 'x\nx\nx\n';
    }
    return '';
  };
  const deps = { execFileSync: mockExecFileSync(handler) };

  const result = identifyCoreCandidates('abc123', {}, deps);

  assert.equal(result.sourceFileCount, 2);
  assert.equal(result.threshold, 15);

  // database: fanIn=3 (4-1 self), churn30=8, churn90=15 => score = 3*5 + 8*3 + 15*1 = 15+24+15 = 54
  const db = result.candidates.find(c => c.path === 'src/database.js');
  assert.ok(db);
  assert.equal(db.fanIn, 3);
  assert.equal(db.churn30, 8);
  assert.equal(db.churn90, 15);
  assert.equal(db.score, 54);
  assert.equal(db.isCore, true);

  // helper: fanIn=0 (1-1 self), churn30=1, churn90=2 => score = 0*5 + 1*3 + 2*1 = 5
  const helper = result.candidates.find(c => c.path === 'src/helper.js');
  assert.ok(helper);
  assert.equal(helper.fanIn, 0);
  assert.equal(helper.score, 5);
  assert.equal(helper.isCore, false);

  assert.equal(result.coreCount, 1);
});

test('identifyCoreCandidates returns empty for non-source changes', () => {
  const deps = {
    execFileSync: mockExecFileSync((cmd) => {
      if (cmd.includes('--numstat')) {
        return '5\t0\tREADME.md\n2\t1\tpackage.json\n';
      }
      return '';
    }),
  };

  const result = identifyCoreCandidates('abc123', {}, deps);

  assert.equal(result.sourceFileCount, 0);
  assert.equal(result.candidates.length, 0);
});

test('identifyCoreCandidates respects custom threshold', () => {
  const deps = {
    execFileSync: mockExecFileSync((cmd) => {
      if (cmd.includes('--numstat')) return '5\t0\tsrc/utils.js\n';
      if (cmd.includes('ls-files')) return 'src/utils.js\n';
      if (cmd.includes('grep')) return 'a.js\nb.js\n';
      if (cmd.includes('log')) return 'x\n';
      return '';
    }),
  };

  // score = (2-1)*5 + 1*3 + 1*1 = 5+3+1 = 9
  const low = identifyCoreCandidates('abc123', { threshold: 100 }, deps);
  assert.equal(low.candidates[0].isCore, false);

  const high = identifyCoreCandidates('abc123', { threshold: 5 }, deps);
  assert.equal(high.candidates[0].isCore, true);
});

test('identifyCoreCandidates handles git failure gracefully', () => {
  const deps = {
    execFileSync: mockExecFileSync(() => { throw new Error('fatal: bad revision'); }),
  };

  const result = identifyCoreCandidates('bad-ref', {}, deps);
  assert.ok(result.error);
  assert.equal(result.candidates.length, 0);
});

// --- analyzeFullDrift tests ---

test('analyzeFullDrift merges impact and core results', () => {
  const deps = {
    execFileSync: mockExecFileSync((cmd) => {
      if (cmd.includes('--numstat')) return '10\t0\tsrc/core.js\n2\t0\tREADME.md\n';
      if (cmd.includes('ls-files')) return 'src/core.js\nsrc/other.js\n';
      if (cmd.includes('grep')) return 'a.js\nb.js\nc.js\n';
      if (cmd.includes('log')) return Array(5).fill('x').join('\n') + '\n';
      return '';
    }),
  };

  const result = analyzeFullDrift('abc123', {}, deps);

  assert.equal(result.baseCommit, 'abc123');
  assert.ok(result.impact);
  assert.ok(result.core);
  assert.ok(result.summary);
  assert.equal(result.summary.totalFiles, 2);
  assert.equal(result.summary.sourceFileCount, 1);
});

// --- CLI tests ---

test('CLI prints usage on missing command', () => {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /用法/);
});

test('CLI rejects missing base-commit', () => {
  const result = spawnSync(process.execPath, [script, 'diff-impact'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /base-commit/);
});

test('CLI rejects refs with shell metacharacters', () => {
  const result = spawnSync(process.execPath, [script, 'diff-impact', 'abc;rm -rf /'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid base ref/);
});

test('CLI rejects unknown subcommand', () => {
  const result = spawnSync(process.execPath, [script, 'unknown', 'abc123'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /未知命令/);
});
