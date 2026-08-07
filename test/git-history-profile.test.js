const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeChurn, analyzeContributors, identifyHotspots, buildProfile } = require('../scripts/git-history-profile.js');

function mockExecSync(responses = {}) {
  return (command, _opts) => {
    for (const [pattern, response] of Object.entries(responses)) {
      if (command.includes(pattern)) {
        if (typeof response === 'function') return response(command);
        return response;
      }
    }
    return '';
  };
}

test('analyzeChurn counts file modifications across windows', () => {
  const deps = {
    execSync: mockExecSync({
      '--since="30 days ago"': 'src/index.js\nsrc/index.js\nsrc/utils.js\n',
      '--since="90 days ago"': 'src/index.js\nsrc/index.js\nsrc/index.js\nsrc/utils.js\n',
      '--since="180 days ago"': 'src/index.js\nsrc/utils.js\nsrc/utils.js\nlib/old.js\n',
    }),
  };

  const result = analyzeChurn({ top: 10 }, deps);

  assert.ok(result.length > 0);
  const indexEntry = result.find(r => r.file === 'src/index.js');
  assert.ok(indexEntry);
  assert.equal(indexEntry.churn30, 2);
  assert.equal(indexEntry.churn90, 3);
  assert.equal(indexEntry.churn180, 1);
  assert.equal(indexEntry.totalChurn, 6);
});

test('analyzeChurn ignores node_modules and vendor paths', () => {
  const deps = {
    execSync: mockExecSync({
      '--since="30 days ago"': 'node_modules/pkg/index.js\nvendor/lib.js\nsrc/app.js\n',
      '--since="90 days ago"': 'node_modules/pkg/index.js\nsrc/app.js\n',
      '--since="180 days ago"': 'dist/bundle.js\nsrc/app.js\n',
    }),
  };

  const result = analyzeChurn({ top: 10 }, deps);

  assert.equal(result.length, 1);
  assert.equal(result[0].file, 'src/app.js');
});

test('analyzeChurn respects top limit', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `src/file${i}.js`).join('\n');
  const deps = {
    execSync: mockExecSync({
      '--since="30 days ago"': lines,
      '--since="90 days ago"': '',
      '--since="180 days ago"': '',
    }),
  };

  const result = analyzeChurn({ top: 5 }, deps);

  assert.equal(result.length, 5);
});

test('analyzeContributors returns author counts and bus factor risk', () => {
  const deps = {
    execSync: (command, _opts) => {
      if (command.includes('--name-only')) {
        return 'src/solo.js\nsrc/team.js\n';
      }
      if (command.includes('-- "src/solo.js"')) {
        return 'alice@example.com\n';
      }
      if (command.includes('-- "src/team.js"')) {
        return 'alice@example.com\nbob@example.com\ncharlie@example.com\n';
      }
      return '';
    },
  };

  const result = analyzeContributors({ days: 90 }, deps);

  const solo = result.find(r => r.file === 'src/solo.js');
  const team = result.find(r => r.file === 'src/team.js');
  assert.ok(solo);
  assert.ok(team);
  assert.equal(solo.authorCount, 1);
  assert.equal(solo.busFactorRisk, true);
  assert.equal(team.authorCount, 3);
  assert.equal(team.busFactorRisk, false);
});

test('analyzeContributors deduplicates authors', () => {
  const deps = {
    execSync: (command, _opts) => {
      if (command.includes('--name-only')) {
        return 'src/dup.js\n';
      }
      if (command.includes('-- "src/dup.js"')) {
        return 'alice@example.com\nalice@example.com\nalice@example.com\nbob@example.com\n';
      }
      return '';
    },
  };

  const result = analyzeContributors({ days: 90 }, deps);

  assert.equal(result[0].authorCount, 2);
});

test('identifyHotspots calculates score and classifies correctly', () => {
  const deps = {
    execSync: (command, _opts) => {
      if (command.includes('--since="30 days ago"') && command.includes('--name-only')) {
        // churn30 = 10 for critical.js
        return Array(10).fill('src/critical.js').join('\n') + '\nsrc/low.js\n';
      }
      if (command.includes('--name-only')) {
        // churn90 = 5 for critical.js
        return Array(5).fill('src/critical.js').join('\n') + '\nsrc/low.js\n';
      }
      if (command.includes('%ae') && command.includes('critical.js')) {
        return 'a@x.com\nb@x.com\nc@x.com\nd@x.com\n';
      }
      if (command.includes('%ae') && command.includes('low.js')) {
        return 'a@x.com\n';
      }
      if (command.includes('wc -l') && command.includes('critical.js')) {
        return '600\n'; // sizeRisk = true
      }
      if (command.includes('wc -l')) {
        return '50\n';
      }
      return '';
    },
  };

  const result = identifyHotspots({ top: 10 }, deps);

  const critical = result.find(r => r.file === 'src/critical.js');
  assert.ok(critical);
  // score = 10*3 + 5*1 + 4*2 + 5 = 30 + 5 + 8 + 5 = 48
  assert.equal(critical.score, 48);
  assert.equal(critical.classification, 'high');
  assert.equal(critical.sizeRisk, true);

  const low = result.find(r => r.file === 'src/low.js');
  assert.ok(low);
  // score = 1*3 + 1*1 + 1*2 + 0 = 6
  assert.equal(low.score, 6);
  assert.equal(low.classification, 'low');
});

test('identifyHotspots classification thresholds', () => {
  // Directly test classification boundary via a high-churn file
  const deps = {
    execSync: (command, _opts) => {
      if (command.includes('--since="30 days ago"') && command.includes('--name-only')) {
        return Array(15).fill('src/mega.js').join('\n') + '\n' +
               Array(8).fill('src/mid.js').join('\n') + '\n' +
               Array(4).fill('src/mod.js').join('\n') + '\n';
      }
      if (command.includes('--name-only')) {
        return Array(10).fill('src/mega.js').join('\n') + '\n' +
               Array(5).fill('src/mid.js').join('\n') + '\n' +
               Array(2).fill('src/mod.js').join('\n') + '\n';
      }
      if (command.includes('%ae') && command.includes('mega.js')) {
        return 'a@x.com\nb@x.com\nc@x.com\n';
      }
      if (command.includes('%ae')) {
        return 'a@x.com\nb@x.com\n';
      }
      if (command.includes('wc -l')) {
        return '100\n';
      }
      return '';
    },
  };

  const result = identifyHotspots({ top: 10 }, deps);

  const mega = result.find(r => r.file === 'src/mega.js');
  // score = 15*3 + 10*1 + 3*2 + 0 = 45+10+6 = 61 → critical (>50)
  assert.equal(mega.classification, 'critical');

  const mid = result.find(r => r.file === 'src/mid.js');
  // score = 8*3 + 5*1 + 2*2 + 0 = 24+5+4 = 33 → high (>30)
  assert.equal(mid.classification, 'high');

  const mod = result.find(r => r.file === 'src/mod.js');
  // score = 4*3 + 2*1 + 2*2 + 0 = 12+2+4 = 18 → moderate (>15)
  assert.equal(mod.classification, 'moderate');
});

test('buildProfile returns combined summary', () => {
  const deps = {
    execSync: (command, _opts) => {
      if (command.includes('rev-list --count')) return '142\n';
      if (command.includes('sort -u')) return 'alice@x.com\nbob@x.com\n';
      if (command.includes('--reverse')) return '2022-01-15 10:00:00 +0800\n';
      if (command.includes('ls-files') && command.includes('uniq -c')) return '  50 .js\n  20 .ts\n  5 .json\n';
      if (command.includes('--since="30 days ago"') && command.includes('--name-only')) return 'src/a.js\n';
      if (command.includes('--name-only')) return 'src/a.js\n';
      if (command.includes('%ae')) return 'alice@x.com\n';
      if (command.includes('wc -l')) return '100\n';
      return '';
    },
  };

  const result = buildProfile({}, deps);

  assert.equal(result.summary.totalCommits, 142);
  assert.equal(result.summary.activeContributors, 2);
  assert.match(result.summary.repoAge, /2022/);
  assert.ok(Array.isArray(result.summary.languages));
  assert.ok(Array.isArray(result.churnTop20));
  assert.ok(Array.isArray(result.hotspots));
  assert.ok(Array.isArray(result.contributorStats));
});

test('handles git command failures gracefully', () => {
  const deps = {
    execSync: () => { throw new Error('git not found'); },
  };

  const result = analyzeChurn({}, deps);

  assert.ok(Array.isArray(result));
  assert.equal(result.length, 0);
});

test('analyzeContributors ignores generated file paths', () => {
  const deps = {
    execSync: (command, _opts) => {
      if (command.includes('--name-only')) {
        return 'build/output.js\ndist/app.min.js\nsrc/real.js\n';
      }
      if (command.includes('-- "src/real.js"')) {
        return 'dev@x.com\n';
      }
      return '';
    },
  };

  const result = analyzeContributors({ days: 30 }, deps);

  assert.equal(result.length, 1);
  assert.equal(result[0].file, 'src/real.js');
});
