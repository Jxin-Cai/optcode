#!/usr/bin/env node
/**
 * optcode workspace topology detector.
 * Identifies workspace structure (monorepo, standalone, workspace-member)
 * and provides scope resolution for file ownership.
 *
 * Usage:
 *   node workspace-topology.js detect [--cwd <dir>] [--json]
 *   node workspace-topology.js owner <file-path> [--cwd <dir>] [--json]
 *   node workspace-topology.js scope <work-dir> [--json]
 */
const _fs = require('node:fs');
const _path = require('node:path');
const _cp = require('node:child_process');

const TOPOLOGY_KINDS = Object.freeze({
  STANDALONE: 'standalone',
  MONOREPO: 'monorepo',
  WORKSPACE_MEMBER: 'workspace-member',
});

const DEFAULT_DEPS = Object.freeze({
  existsSync: _fs.existsSync,
  readFileSync: _fs.readFileSync,
  readdirSync: _fs.readdirSync,
  join: _path.join,
  resolve: _path.resolve,
  relative: _path.relative,
  dirname: _path.dirname,
  basename: _path.basename,
  sep: _path.sep,
  execSync: (cmd, opts) => _cp.execSync(cmd, opts),
});

function resolveDeps(deps) {
  if (!deps || Object.keys(deps).length === 0) return DEFAULT_DEPS;
  return { ...DEFAULT_DEPS, ...deps };
}

/**
 * Expand glob-like workspace patterns (supports trailing * and **).
 * Returns array of matching directory routes relative to root.
 */
function expandPatterns(root, patterns, deps) {
  const d = resolveDeps(deps);
  const results = [];

  for (const pattern of patterns) {
    // Strip trailing slash if present
    const cleaned = pattern.replace(/\/+$/, '');

    if (cleaned.includes('*')) {
      // Split pattern into static prefix and glob part
      const parts = cleaned.split('/');
      let staticParts = [];
      let globIdx = -1;

      for (let i = 0; i < parts.length; i++) {
        if (parts[i].includes('*')) {
          globIdx = i;
          break;
        }
        staticParts.push(parts[i]);
      }

      const baseDir = staticParts.length > 0
        ? d.join(root, ...staticParts)
        : root;

      let entries;
      try {
        entries = d.readdirSync(baseDir);
      } catch {
        continue;
      }
      if (!entries || entries.length === 0) continue;

      for (const entry of entries) {
        const candidatePath = staticParts.length > 0
          ? [...staticParts, entry].join('/')
          : entry;
        const fullPath = d.join(root, candidatePath);
        // Check it has a manifest that makes it a package
        if (d.existsSync(d.join(fullPath, 'package.json')) ||
            d.existsSync(d.join(fullPath, 'Cargo.toml')) ||
            d.existsSync(d.join(fullPath, 'go.mod'))) {
          results.push(candidatePath);
        }
      }
    } else {
      // Literal path — add if directory contains a manifest or if path exists
      const fullPath = d.join(root, cleaned);
      if (d.existsSync(fullPath) ||
          d.existsSync(d.join(fullPath, 'package.json')) ||
          d.existsSync(d.join(fullPath, 'Cargo.toml')) ||
          d.existsSync(d.join(fullPath, 'go.mod'))) {
        results.push(cleaned);
      }
    }
  }

  return results;
}

/**
 * Read member name from package.json / Cargo.toml / go.mod in a directory.
 */
function readMemberName(root, route, deps) {
  const d = resolveDeps(deps);
  const memberDir = d.join(root, route);

  // Try package.json
  const pkgPath = d.join(memberDir, 'package.json');
  if (d.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(d.readFileSync(pkgPath, 'utf8'));
      return { name: pkg.name || d.basename(route), manifest: 'package.json' };
    } catch { /* fall through */ }
  }

  // Try Cargo.toml
  const cargoPath = d.join(memberDir, 'Cargo.toml');
  if (d.existsSync(cargoPath)) {
    try {
      const content = d.readFileSync(cargoPath, 'utf8');
      const nameMatch = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
      return { name: nameMatch ? nameMatch[1] : d.basename(route), manifest: 'Cargo.toml' };
    } catch { /* fall through */ }
  }

  // Try go.mod
  const goModPath = d.join(memberDir, 'go.mod');
  if (d.existsSync(goModPath)) {
    try {
      const content = d.readFileSync(goModPath, 'utf8');
      const modMatch = content.match(/^module\s+(\S+)/m);
      return { name: modMatch ? modMatch[1] : d.basename(route), manifest: 'go.mod' };
    } catch { /* fall through */ }
  }

  return { name: d.basename(route), manifest: null };
}

/**
 * Find git root from a given directory.
 */
function findGitRoot(cwd, deps) {
  const d = resolveDeps(deps);
  try {
    const result = d.execSync('git rev-parse --show-toplevel', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Parse pnpm-workspace.yaml for packages patterns.
 * Minimal YAML parser — handles the common `packages:` list.
 */
function parsePnpmWorkspace(content) {
  const lines = content.split('\n');
  const patterns = [];
  let inPackages = false;

  for (const line of lines) {
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      if (/^\s*-\s+/.test(line) || /^\s*-\s*'[^']*'/.test(line) || /^\s*-\s*"[^"]*"/.test(line)) {
        const match = line.match(/^\s*-\s+['"]?([^'"#\n]+?)['"]?\s*$/);
        if (match) patterns.push(match[1].trim());
      } else if (/^\S/.test(line) && line.trim() !== '') {
        break; // Next top-level key
      }
    }
  }

  return patterns;
}

/**
 * Parse Cargo.toml [workspace] members.
 */
function parseCargoWorkspaceMembers(content) {
  const patterns = [];
  const wsMatch = content.match(/\[workspace\][\s\S]*?(?=\n\[(?!workspace)|$)/);
  if (!wsMatch) return patterns;

  const wsBlock = wsMatch[0];
  const membersMatch = wsBlock.match(/members\s*=\s*\[([\s\S]*?)\]/);
  if (!membersMatch) return patterns;

  const membersStr = membersMatch[1];
  const items = membersStr.match(/"([^"]+)"/g);
  if (items) {
    for (const item of items) {
      patterns.push(item.replace(/"/g, ''));
    }
  }
  return patterns;
}

/**
 * Parse go.work for use directives.
 */
function parseGoWork(content) {
  const routes = [];
  const useBlock = content.match(/use\s*\(([\s\S]*?)\)/);
  if (useBlock) {
    const lines = useBlock[1].split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('//')) {
        routes.push(trimmed);
      }
    }
  } else {
    // Single-line use directives
    const singleUse = content.matchAll(/^use\s+(\S+)/gm);
    for (const match of singleUse) {
      routes.push(match[1]);
    }
  }
  return routes;
}

/**
 * Detect workspace topology from a given root directory.
 * Returns a frozen topology object.
 */
function detectTopology(cwd, deps) {
  const d = resolveDeps(deps);
  const root = d.resolve(cwd);
  const gitRoot = findGitRoot(root, deps);

  // 1. pnpm-workspace.yaml
  const pnpmPath = d.join(root, 'pnpm-workspace.yaml');
  if (d.existsSync(pnpmPath)) {
    const content = d.readFileSync(pnpmPath, 'utf8');
    const patterns = parsePnpmWorkspace(content);
    const routes = expandPatterns(root, patterns, deps);
    const members = routes.map(route => {
      const info = readMemberName(root, route, deps);
      return Object.freeze({ route, name: info.name, manifest: info.manifest });
    });
    return Object.freeze({
      kind: TOPOLOGY_KINDS.MONOREPO,
      root,
      members,
      gitRoot: gitRoot || root,
      detected_via: 'pnpm-workspace.yaml',
    });
  }

  // 2. package.json with workspaces field
  const pkgPath = d.join(root, 'package.json');
  if (d.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(d.readFileSync(pkgPath, 'utf8'));
      const workspaces = Array.isArray(pkg.workspaces)
        ? pkg.workspaces
        : (pkg.workspaces && Array.isArray(pkg.workspaces.packages))
          ? pkg.workspaces.packages
          : null;

      if (workspaces) {
        const routes = expandPatterns(root, workspaces, deps);
        const members = routes.map(route => {
          const info = readMemberName(root, route, deps);
          return Object.freeze({ route, name: info.name, manifest: info.manifest });
        });
        return Object.freeze({
          kind: TOPOLOGY_KINDS.MONOREPO,
          root,
          members,
          gitRoot: gitRoot || root,
          detected_via: 'package.json workspaces',
        });
      }
    } catch { /* malformed package.json — skip */ }
  }

  // 3. lerna.json
  const lernaPath = d.join(root, 'lerna.json');
  if (d.existsSync(lernaPath)) {
    try {
      const lerna = JSON.parse(d.readFileSync(lernaPath, 'utf8'));
      const patterns = lerna.packages || ['packages/*'];
      const routes = expandPatterns(root, patterns, deps);
      const members = routes.map(route => {
        const info = readMemberName(root, route, deps);
        return Object.freeze({ route, name: info.name, manifest: info.manifest });
      });
      return Object.freeze({
        kind: TOPOLOGY_KINDS.MONOREPO,
        root,
        members,
        gitRoot: gitRoot || root,
        detected_via: 'lerna.json',
      });
    } catch { /* fall through */ }
  }

  // 4. Cargo.toml with [workspace]
  const cargoPath = d.join(root, 'Cargo.toml');
  if (d.existsSync(cargoPath)) {
    const content = d.readFileSync(cargoPath, 'utf8');
    if (content.includes('[workspace]')) {
      const patterns = parseCargoWorkspaceMembers(content);
      const routes = expandPatterns(root, patterns, deps);
      const members = routes.map(route => {
        const info = readMemberName(root, route, deps);
        return Object.freeze({ route, name: info.name, manifest: info.manifest });
      });
      return Object.freeze({
        kind: TOPOLOGY_KINDS.MONOREPO,
        root,
        members,
        gitRoot: gitRoot || root,
        detected_via: 'Cargo.toml workspace',
      });
    }
  }

  // 5. go.work
  const goWorkPath = d.join(root, 'go.work');
  if (d.existsSync(goWorkPath)) {
    const content = d.readFileSync(goWorkPath, 'utf8');
    const routes = parseGoWork(content);
    const members = routes.map(route => {
      const info = readMemberName(root, route, deps);
      return Object.freeze({ route, name: info.name, manifest: info.manifest });
    });
    return Object.freeze({
      kind: TOPOLOGY_KINDS.MONOREPO,
      root,
      members,
      gitRoot: gitRoot || root,
      detected_via: 'go.work',
    });
  }

  // 6. Standalone: git root == cwd and no workspace indicators
  if (gitRoot && d.resolve(gitRoot) === root) {
    return Object.freeze({
      kind: TOPOLOGY_KINDS.STANDALONE,
      root,
      members: [],
      gitRoot: root,
      detected_via: 'git root (no workspace indicators)',
    });
  }

  // 7. workspace-member: find nearest parent with workspace config
  if (gitRoot) {
    const parentTopology = detectTopology(gitRoot, deps);
    if (parentTopology.kind === TOPOLOGY_KINDS.MONOREPO) {
      return Object.freeze({
        kind: TOPOLOGY_KINDS.WORKSPACE_MEMBER,
        root,
        members: parentTopology.members,
        gitRoot,
        detected_via: `member of ${parentTopology.detected_via}`,
      });
    }
  }

  // Fallback: standalone
  return Object.freeze({
    kind: TOPOLOGY_KINDS.STANDALONE,
    root,
    members: [],
    gitRoot: gitRoot || root,
    detected_via: 'fallback (no git root or workspace indicators)',
  });
}

/**
 * For a given file path, determine which workspace member "owns" it.
 * Returns the most specific member route that contains the file path.
 * If none match, returns the repo root route (empty string).
 */
function ownerRouteFor(filePath, topology, deps) {
  const d = resolveDeps(deps);

  if (!topology || topology.members.length === 0) {
    return { route: '', name: d.basename(topology ? topology.root : ''), root: topology ? topology.root : '' };
  }

  const absFile = d.resolve(filePath);
  const relFile = d.relative(topology.root, absFile);

  // Normalize separators to forward slashes for comparison
  const normalizedRel = relFile.split(d.sep).join('/');

  let bestMatch = null;
  let bestLength = -1;

  for (const member of topology.members) {
    const normalizedRoute = member.route.split(d.sep).join('/');
    if (normalizedRel === normalizedRoute || normalizedRel.startsWith(normalizedRoute + '/')) {
      if (normalizedRoute.length > bestLength) {
        bestMatch = member;
        bestLength = normalizedRoute.length;
      }
    }
  }

  if (bestMatch) {
    return {
      route: bestMatch.route,
      name: bestMatch.name,
      root: d.join(topology.root, bestMatch.route),
    };
  }

  // File lives at repo root, not in any member
  return { route: '', name: d.basename(topology.root), root: topology.root };
}

/**
 * Read state.json target_paths and combine with topology to produce
 * per-dimension scope constraints.
 */
function scopeForWorkDir(workDir, deps) {
  const d = resolveDeps(deps);
  const statePath = d.join(workDir, 'state.json');

  if (!d.existsSync(statePath)) {
    return { scoped: false, reason: 'state.json not found', constraints: [] };
  }

  let state;
  try {
    state = JSON.parse(d.readFileSync(statePath, 'utf8'));
  } catch {
    return { scoped: false, reason: 'state.json parse error', constraints: [] };
  }

  const targetPaths = state.target_paths || [];
  if (targetPaths.length === 0) {
    return { scoped: false, reason: 'no target_paths in state', constraints: [] };
  }

  // Detect topology from git root or project root
  const gitRoot = findGitRoot(workDir, deps);
  const topologyRoot = gitRoot || d.dirname(d.dirname(workDir));
  let topology;
  try {
    topology = detectTopology(topologyRoot, deps);
  } catch {
    return { scoped: false, reason: 'topology detection failed', constraints: [] };
  }

  if (topology.kind === TOPOLOGY_KINDS.STANDALONE) {
    return {
      scoped: false,
      reason: 'standalone workspace — scope is entire repo',
      constraints: [{ route: '', root: topology.root, target_paths: targetPaths }],
    };
  }

  // Group target paths by owning member
  const groups = new Map();
  for (const tp of targetPaths) {
    const owner = ownerRouteFor(tp, topology, deps);
    const key = owner.route;
    if (!groups.has(key)) {
      groups.set(key, { route: owner.route, name: owner.name, root: owner.root, target_paths: [] });
    }
    groups.get(key).target_paths.push(tp);
  }

  const constraints = [...groups.values()].map(g => Object.freeze(g));

  return Object.freeze({
    scoped: true,
    reason: `${constraints.length} workspace scope(s) identified`,
    constraints,
  });
}

// --- CLI ---
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  function parseFlags(args) {
    const flags = { json: false, cwd: process.cwd() };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--json') flags.json = true;
      if (args[i] === '--cwd' && args[i + 1]) { flags.cwd = args[++i]; }
    }
    return flags;
  }

  function output(data, json) {
    if (json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      const lines = [];
      lines.push(`kind: ${data.kind}`);
      lines.push(`root: ${data.root}`);
      if (data.gitRoot) lines.push(`git root: ${data.gitRoot}`);
      if (data.detected_via) lines.push(`detected via: ${data.detected_via}`);
      if (data.members && data.members.length > 0) {
        lines.push(`members (${data.members.length}):`);
        for (const m of data.members) {
          lines.push(`  - ${m.route} (${m.name})`);
        }
      }
      if (data.route !== undefined) {
        lines.push(`owner route: ${data.route || '(root)'}`);
        lines.push(`owner name: ${data.name}`);
        lines.push(`owner root: ${data.root}`);
      }
      if (data.scoped !== undefined) {
        lines.push(`scoped: ${data.scoped}`);
        lines.push(`reason: ${data.reason}`);
        if (data.constraints) {
          for (const c of data.constraints) {
            lines.push(`  scope: ${c.route || '(root)'} → ${c.target_paths.join(', ')}`);
          }
        }
      }
      console.log(lines.join('\n'));
    }
  }

  if (command === 'detect') {
    const flags = parseFlags(args.slice(1));
    const topology = detectTopology(flags.cwd);
    output(topology, flags.json);
  } else if (command === 'owner') {
    const filePath = args[1];
    if (!filePath) {
      process.stderr.write('Usage: node workspace-topology.js owner <file-path> [--cwd <dir>] [--json]\n');
      process.exit(1);
    }
    const flags = parseFlags(args.slice(2));
    const topology = detectTopology(flags.cwd);
    const owner = ownerRouteFor(filePath, topology);
    output(owner, flags.json);
  } else if (command === 'scope') {
    const workDirArg = args[1];
    if (!workDirArg) {
      process.stderr.write('Usage: node workspace-topology.js scope <work-dir> [--json]\n');
      process.exit(1);
    }
    const flags = parseFlags(args.slice(2));
    const result = scopeForWorkDir(workDirArg);
    output(result, flags.json);
  } else {
    process.stderr.write(
      'Usage:\n' +
      '  node workspace-topology.js detect [--cwd <dir>] [--json]\n' +
      '  node workspace-topology.js owner <file-path> [--cwd <dir>] [--json]\n' +
      '  node workspace-topology.js scope <work-dir> [--json]\n'
    );
    process.exit(1);
  }
}

module.exports = {
  detectTopology,
  ownerRouteFor,
  scopeForWorkDir,
  TOPOLOGY_KINDS,
  DEFAULT_DEPS,
  resolveDeps,
  // Exported for testing
  parsePnpmWorkspace,
  parseCargoWorkspaceMembers,
  parseGoWork,
  expandPatterns,
};
