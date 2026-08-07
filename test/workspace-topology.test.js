'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { createDeps, seedFile } = require('./helpers.js');
const {
  detectTopology,
  ownerRouteFor,
  scopeForWorkDir,
  TOPOLOGY_KINDS,
  parsePnpmWorkspace,
  parseCargoWorkspaceMembers,
  parseGoWork,
  expandPatterns,
} = require('../scripts/workspace-topology.js');

function topologyDeps(overrides = {}) {
  const deps = createDeps(overrides);
  // Override resolve/relative/dirname/basename/sep for testability
  deps.resolve = (...args) => {
    if (args.length === 1) return args[0];
    return join(...args);
  };
  deps.relative = (from, to) => {
    if (to.startsWith(from + '/')) return to.slice(from.length + 1);
    if (to === from) return '';
    return to;
  };
  deps.dirname = (p) => {
    const idx = p.lastIndexOf('/');
    return idx > 0 ? p.slice(0, idx) : '/';
  };
  deps.basename = (p) => {
    const idx = p.lastIndexOf('/');
    return idx >= 0 ? p.slice(idx + 1) : p;
  };
  deps.sep = '/';
  deps.execSync = () => { throw new Error('no git'); };
  return deps;
}

describe('workspace-topology — parsePnpmWorkspace', () => {
  it('parses simple packages list', () => {
    const content = 'packages:\n  - packages/*\n  - apps/*\n';
    const result = parsePnpmWorkspace(content);
    assert.deepEqual(result, ['packages/*', 'apps/*']);
  });

  it('parses quoted entries', () => {
    const content = "packages:\n  - 'libs/*'\n  - \"tools/*\"\n";
    const result = parsePnpmWorkspace(content);
    assert.deepEqual(result, ['libs/*', 'tools/*']);
  });

  it('stops at next top-level key', () => {
    const content = 'packages:\n  - packages/*\ncatalog:\n  react: ^18\n';
    const result = parsePnpmWorkspace(content);
    assert.deepEqual(result, ['packages/*']);
  });

  it('returns empty for no packages key', () => {
    const content = 'shamefully-hoist: true\n';
    const result = parsePnpmWorkspace(content);
    assert.deepEqual(result, []);
  });
});

describe('workspace-topology — parseCargoWorkspaceMembers', () => {
  it('parses members list', () => {
    const content = '[workspace]\nmembers = [\n  "crates/core",\n  "crates/cli",\n]\n\n[profile.release]\n';
    const result = parseCargoWorkspaceMembers(content);
    assert.deepEqual(result, ['crates/core', 'crates/cli']);
  });

  it('returns empty if no [workspace] section', () => {
    const content = '[package]\nname = "my-crate"\n';
    const result = parseCargoWorkspaceMembers(content);
    assert.deepEqual(result, []);
  });

  it('returns empty if workspace has no members', () => {
    const content = '[workspace]\nresolver = "2"\n';
    const result = parseCargoWorkspaceMembers(content);
    assert.deepEqual(result, []);
  });
});

describe('workspace-topology — parseGoWork', () => {
  it('parses multi-line use block', () => {
    const content = 'go 1.21\n\nuse (\n  ./cmd/server\n  ./pkg/lib\n)\n';
    const result = parseGoWork(content);
    assert.deepEqual(result, ['./cmd/server', './pkg/lib']);
  });

  it('parses single-line use directives', () => {
    const content = 'go 1.21\n\nuse ./cmd/app\nuse ./internal/util\n';
    const result = parseGoWork(content);
    assert.deepEqual(result, ['./cmd/app', './internal/util']);
  });

  it('ignores comments inside use block', () => {
    const content = 'go 1.21\n\nuse (\n  // internal module\n  ./internal\n)\n';
    const result = parseGoWork(content);
    assert.deepEqual(result, ['./internal']);
  });
});

describe('workspace-topology — expandPatterns', () => {
  it('expands glob patterns matching dirs with manifests', () => {
    const deps = topologyDeps();
    seedFile(deps, '/repo/packages/foo/package.json', '{"name":"@scope/foo"}');
    seedFile(deps, '/repo/packages/bar/package.json', '{"name":"@scope/bar"}');
    seedFile(deps, '/repo/packages/no-manifest/readme.md', '# hi');

    const result = expandPatterns('/repo', ['packages/*'], deps);
    assert.ok(result.includes('packages/foo'));
    assert.ok(result.includes('packages/bar'));
    assert.ok(!result.includes('packages/no-manifest'));
  });

  it('handles literal paths', () => {
    const deps = topologyDeps();
    seedFile(deps, '/repo/tools/cli/package.json', '{}');

    const result = expandPatterns('/repo', ['tools/cli'], deps);
    assert.deepEqual(result, ['tools/cli']);
  });

  it('returns empty for non-existent base directory', () => {
    const deps = topologyDeps();
    const result = expandPatterns('/repo', ['missing/*'], deps);
    assert.deepEqual(result, []);
  });
});

describe('workspace-topology — detectTopology', () => {
  it('detects monorepo via pnpm-workspace.yaml', () => {
    const deps = topologyDeps();
    seedFile(deps, '/repo/pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
    seedFile(deps, '/repo/packages/core/package.json', '{"name":"@my/core"}');

    const topo = detectTopology('/repo', deps);
    assert.equal(topo.kind, TOPOLOGY_KINDS.MONOREPO);
    assert.equal(topo.root, '/repo');
    assert.equal(topo.detected_via, 'pnpm-workspace.yaml');
    assert.equal(topo.members.length, 1);
    assert.equal(topo.members[0].name, '@my/core');
    assert.equal(topo.members[0].route, 'packages/core');
    assert.equal(topo.members[0].manifest, 'package.json');
  });

  it('detects monorepo via package.json workspaces (array form)', () => {
    const deps = topologyDeps();
    seedFile(deps, '/repo/package.json', JSON.stringify({ workspaces: ['packages/*'] }));
    seedFile(deps, '/repo/packages/ui/package.json', '{"name":"@my/ui"}');

    const topo = detectTopology('/repo', deps);
    assert.equal(topo.kind, TOPOLOGY_KINDS.MONOREPO);
    assert.equal(topo.detected_via, 'package.json workspaces');
    assert.equal(topo.members[0].name, '@my/ui');
  });

  it('detects monorepo via package.json workspaces (object form)', () => {
    const deps = topologyDeps();
    seedFile(deps, '/repo/package.json', JSON.stringify({ workspaces: { packages: ['libs/*'] } }));
    seedFile(deps, '/repo/libs/auth/package.json', '{"name":"@my/auth"}');

    const topo = detectTopology('/repo', deps);
    assert.equal(topo.kind, TOPOLOGY_KINDS.MONOREPO);
    assert.equal(topo.members[0].name, '@my/auth');
  });

  it('detects monorepo via lerna.json', () => {
    const deps = topologyDeps();
    seedFile(deps, '/repo/lerna.json', JSON.stringify({ packages: ['modules/*'] }));
    seedFile(deps, '/repo/modules/api/package.json', '{"name":"api-service"}');

    const topo = detectTopology('/repo', deps);
    assert.equal(topo.kind, TOPOLOGY_KINDS.MONOREPO);
    assert.equal(topo.detected_via, 'lerna.json');
    assert.equal(topo.members[0].name, 'api-service');
  });

  it('detects monorepo via Cargo.toml workspace', () => {
    const deps = topologyDeps();
    seedFile(deps, '/repo/Cargo.toml', '[workspace]\nmembers = [\n  "crates/engine",\n]\n');
    seedFile(deps, '/repo/crates/engine/Cargo.toml', '[package]\nname = "my-engine"\nversion = "0.1.0"\n');

    const topo = detectTopology('/repo', deps);
    assert.equal(topo.kind, TOPOLOGY_KINDS.MONOREPO);
    assert.equal(topo.detected_via, 'Cargo.toml workspace');
    assert.equal(topo.members[0].name, 'my-engine');
    assert.equal(topo.members[0].manifest, 'Cargo.toml');
  });

  it('detects monorepo via go.work', () => {
    const deps = topologyDeps();
    seedFile(deps, '/repo/go.work', 'go 1.21\n\nuse (\n  ./cmd/server\n)\n');
    seedFile(deps, '/repo/cmd/server/go.mod', 'module example.com/cmd/server\n');

    // cmd/server needs to exist for expandPatterns literal path
    const topo = detectTopology('/repo', deps);
    assert.equal(topo.kind, TOPOLOGY_KINDS.MONOREPO);
    assert.equal(topo.detected_via, 'go.work');
    assert.equal(topo.members[0].name, 'example.com/cmd/server');
    assert.equal(topo.members[0].manifest, 'go.mod');
  });

  it('detects standalone when git root matches and no workspace indicators', () => {
    const deps = topologyDeps();
    deps.execSync = () => '/repo';
    seedFile(deps, '/repo/src/main.js', 'console.log("hi")');

    const topo = detectTopology('/repo', deps);
    assert.equal(topo.kind, TOPOLOGY_KINDS.STANDALONE);
    assert.equal(topo.members.length, 0);
    assert.equal(topo.detected_via, 'git root (no workspace indicators)');
  });

  it('detects workspace-member when cwd is inside a monorepo', () => {
    const deps = topologyDeps();
    deps.execSync = (cmd, opts) => {
      // Always return the repo root
      return '/repo';
    };
    // Monorepo workspace at root level
    seedFile(deps, '/repo/pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
    seedFile(deps, '/repo/packages/web/package.json', '{"name":"@my/web"}');

    const topo = detectTopology('/repo/packages/web', deps);
    assert.equal(topo.kind, TOPOLOGY_KINDS.WORKSPACE_MEMBER);
    assert.equal(topo.root, '/repo/packages/web');
    assert.equal(topo.gitRoot, '/repo');
    assert.equal(topo.members.length, 1);
  });

  it('returns frozen object', () => {
    const deps = topologyDeps();
    deps.execSync = () => '/repo';
    const topo = detectTopology('/repo', deps);
    assert.throws(() => { topo.kind = 'something'; }, TypeError);
  });

  it('priority: pnpm-workspace.yaml wins over package.json workspaces', () => {
    const deps = topologyDeps();
    seedFile(deps, '/repo/pnpm-workspace.yaml', 'packages:\n  - apps/*\n');
    seedFile(deps, '/repo/package.json', JSON.stringify({ workspaces: ['packages/*'] }));
    seedFile(deps, '/repo/apps/web/package.json', '{"name":"web"}');
    seedFile(deps, '/repo/packages/lib/package.json', '{"name":"lib"}');

    const topo = detectTopology('/repo', deps);
    assert.equal(topo.detected_via, 'pnpm-workspace.yaml');
    assert.equal(topo.members[0].route, 'apps/web');
  });
});

describe('workspace-topology — ownerRouteFor', () => {
  it('returns most specific member that contains the file', () => {
    const deps = topologyDeps();
    const topology = Object.freeze({
      kind: TOPOLOGY_KINDS.MONOREPO,
      root: '/repo',
      members: [
        Object.freeze({ route: 'packages/core', name: '@my/core', manifest: 'package.json' }),
        Object.freeze({ route: 'packages/core/sub', name: '@my/core-sub', manifest: 'package.json' }),
        Object.freeze({ route: 'packages/ui', name: '@my/ui', manifest: 'package.json' }),
      ],
      gitRoot: '/repo',
      detected_via: 'test',
    });

    const owner = ownerRouteFor('/repo/packages/core/sub/index.ts', topology, deps);
    assert.equal(owner.route, 'packages/core/sub');
    assert.equal(owner.name, '@my/core-sub');
  });

  it('returns root when file is not in any member', () => {
    const deps = topologyDeps();
    const topology = Object.freeze({
      kind: TOPOLOGY_KINDS.MONOREPO,
      root: '/repo',
      members: [
        Object.freeze({ route: 'packages/core', name: '@my/core', manifest: 'package.json' }),
      ],
      gitRoot: '/repo',
      detected_via: 'test',
    });

    const owner = ownerRouteFor('/repo/scripts/build.js', topology, deps);
    assert.equal(owner.route, '');
    assert.equal(owner.name, 'repo');
  });

  it('handles empty members list', () => {
    const deps = topologyDeps();
    const topology = Object.freeze({
      kind: TOPOLOGY_KINDS.STANDALONE,
      root: '/repo',
      members: [],
      gitRoot: '/repo',
      detected_via: 'test',
    });

    const owner = ownerRouteFor('/repo/src/index.ts', topology, deps);
    assert.equal(owner.route, '');
    assert.equal(owner.name, 'repo');
  });

  it('matches exact member route', () => {
    const deps = topologyDeps();
    const topology = Object.freeze({
      kind: TOPOLOGY_KINDS.MONOREPO,
      root: '/repo',
      members: [
        Object.freeze({ route: 'apps/web', name: 'web', manifest: 'package.json' }),
      ],
      gitRoot: '/repo',
      detected_via: 'test',
    });

    // File is exactly at the route level (e.g. package.json of the member)
    const owner = ownerRouteFor('/repo/apps/web', topology, deps);
    assert.equal(owner.route, 'apps/web');
    assert.equal(owner.name, 'web');
  });
});

describe('workspace-topology — scopeForWorkDir', () => {
  it('returns scoped:false when state.json is missing', () => {
    const deps = topologyDeps();
    const result = scopeForWorkDir('/work', deps);
    assert.equal(result.scoped, false);
    assert.match(result.reason, /not found/);
  });

  it('returns scoped:false when target_paths is empty', () => {
    const deps = topologyDeps();
    seedFile(deps, '/work/state.json', JSON.stringify({ target_paths: [] }));
    const result = scopeForWorkDir('/work', deps);
    assert.equal(result.scoped, false);
    assert.match(result.reason, /no target_paths/);
  });

  it('returns scoped:false for standalone workspace', () => {
    const deps = topologyDeps();
    deps.execSync = () => '/repo';
    seedFile(deps, '/repo/.optcode/run1/state.json', JSON.stringify({ target_paths: ['src/'] }));

    const result = scopeForWorkDir('/repo/.optcode/run1', deps);
    assert.equal(result.scoped, false);
    assert.match(result.reason, /standalone/);
  });

  it('returns scoped:true with constraints for monorepo', () => {
    const deps = topologyDeps();
    deps.execSync = () => '/repo';
    seedFile(deps, '/repo/pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
    seedFile(deps, '/repo/packages/core/package.json', '{"name":"@my/core"}');
    seedFile(deps, '/repo/packages/ui/package.json', '{"name":"@my/ui"}');
    seedFile(deps, '/repo/.optcode/run1/state.json', JSON.stringify({
      target_paths: ['/repo/packages/core/src/index.ts', '/repo/packages/ui/Button.tsx']
    }));

    const result = scopeForWorkDir('/repo/.optcode/run1', deps);
    assert.equal(result.scoped, true);
    assert.equal(result.constraints.length, 2);

    const coreScope = result.constraints.find(c => c.route === 'packages/core');
    assert.ok(coreScope);
    assert.deepEqual(coreScope.target_paths, ['/repo/packages/core/src/index.ts']);

    const uiScope = result.constraints.find(c => c.route === 'packages/ui');
    assert.ok(uiScope);
    assert.deepEqual(uiScope.target_paths, ['/repo/packages/ui/Button.tsx']);
  });

  it('groups multiple files under same member', () => {
    const deps = topologyDeps();
    deps.execSync = () => '/repo';
    seedFile(deps, '/repo/pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
    seedFile(deps, '/repo/packages/core/package.json', '{"name":"@my/core"}');
    seedFile(deps, '/repo/.optcode/run1/state.json', JSON.stringify({
      target_paths: ['/repo/packages/core/src/a.ts', '/repo/packages/core/src/b.ts']
    }));

    const result = scopeForWorkDir('/repo/.optcode/run1', deps);
    assert.equal(result.scoped, true);
    assert.equal(result.constraints.length, 1);
    assert.equal(result.constraints[0].target_paths.length, 2);
  });
});

describe('workspace-topology — TOPOLOGY_KINDS', () => {
  it('exports all three kinds', () => {
    assert.equal(TOPOLOGY_KINDS.STANDALONE, 'standalone');
    assert.equal(TOPOLOGY_KINDS.MONOREPO, 'monorepo');
    assert.equal(TOPOLOGY_KINDS.WORKSPACE_MEMBER, 'workspace-member');
  });

  it('is frozen', () => {
    assert.throws(() => { TOPOLOGY_KINDS.NEW = 'x'; }, TypeError);
  });
});
