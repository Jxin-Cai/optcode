#!/usr/bin/env node
/**
 * cli-schema.js — Self-describing command registry for optcode.
 * Produces OpenCLI-compatible schema output.
 *
 * Usage:
 *   node cli-schema.js                      # Full schema (maintainer)
 *   node cli-schema.js --audience workflow   # Filter to workflow commands only
 */

const AUDIENCE_LEVELS = Object.freeze({
  workflow: 1,
  advanced: 2,
  maintainer: 3,
});

const COMMANDS = Object.freeze([
  { name: 'init-state', script: 'init-state.js', description: 'Initialize workflow state for a review run', audience: 'workflow', args: ['work-dir', 'base-commit', 'target-paths...'] },
  { name: 'orchestration-status', script: 'orchestration-status.js', description: 'Show current workflow status', audience: 'workflow', args: ['work-dir'] },
  { name: 'quality-gate', script: 'quality-gate.js', description: 'Compute quality score and verdict', audience: 'workflow', args: ['work-dir'] },
  { name: 'dashboard', script: 'dashboard.js', description: 'Generate or view observation dashboard', audience: 'workflow', args: ['command', 'work-dir'] },
  { name: 'known-issues', script: 'known-issues.js', description: 'Cross-run issue tracking', audience: 'workflow', args: ['command', '...'] },
  { name: 'gate-check', script: 'gate-check.js', description: 'Validate postconditions for workflow gates', audience: 'advanced', args: ['work-dir', 'gate-id'] },
  { name: 'dimension-status', script: 'dimension-status.js', description: 'Manage dimension state transitions', audience: 'advanced', args: ['work-dir', 'command', '...'] },
  { name: 'blast-radius', script: 'blast-radius.js', description: 'Estimate impact scope of code changes', audience: 'advanced', args: ['base-commit'] },
  { name: 'evidence-strength', script: 'evidence-strength.js', description: 'Classify and validate evidence levels', audience: 'advanced', args: ['command', 'arg'] },
  { name: 'cross-dimension-dedup', script: 'cross-dimension-dedup.js', description: 'Deduplicate findings across dimensions', audience: 'advanced', args: ['work-dir'] },
  { name: 'report-quality', script: 'report-quality.js', description: 'Validate CR report quality', audience: 'advanced', args: ['report-path'] },
  { name: 'privacy-scan', script: 'privacy-scan.js', description: 'Scan text for secrets and PII', audience: 'advanced', args: ['command', 'arg'] },
  { name: 'change-drift', script: 'change-drift.js', description: 'Detect drift between review and repair changes', audience: 'advanced', args: ['command', 'work-dir', '...'] },
  { name: 'effectiveness-tracker', script: 'effectiveness-tracker.js', description: 'Track repair effectiveness and plateau signals', audience: 'advanced', args: ['command', 'work-dir', '...'] },
  { name: 'evidence-bundle', script: 'evidence-bundle.js', description: 'Freeze, read, and validate review evidence', audience: 'advanced', args: ['command', 'work-dir'] },
  { name: 'evidence-lanes', script: 'evidence-lanes.js', description: 'Create and validate independent evidence lanes', audience: 'advanced', args: ['command', 'work-dir', '...'] },
  { name: 'finding-contract', script: 'finding-contract.js', description: 'Manage finding-level repair contracts', audience: 'advanced', args: ['command', 'work-dir', '...'] },
  { name: 'findings-recommend', script: 'findings-recommend.js', description: 'Route findings and generate repair plans', audience: 'advanced', args: ['command', '...'] },
  { name: 'fix-record', script: 'fix-record.js', description: 'Read and write revisioned repair records', audience: 'advanced', args: ['command', 'work-dir', 'dimension', 'round', '...'] },
  { name: 'population-binding', script: 'population-binding.js', description: 'Validate findings against the reviewed population', audience: 'advanced', args: ['work-dir', '--json'] },
  { name: 'score-finding-consistency', script: 'score-finding-consistency.js', description: 'Check score-to-finding consistency', audience: 'advanced', args: ['work-dir', '--json'] },
  { name: 'synthetic-evidence', script: 'synthetic-evidence.js', description: 'Detect synthetic or unverifiable report evidence', audience: 'advanced', args: ['report-path', '--base-dir', 'dir', '--json'] },
  { name: 'context-freeze', script: 'context-freeze.js', description: 'Deprecated compatibility facade for evidence-bundle', audience: 'maintainer', args: ['command', 'work-dir'] },
  { name: 'mutation-checkpoint', script: 'mutation-checkpoint.js', description: 'Capture, inspect, or restore a finding-bound working-tree checkpoint', audience: 'advanced', args: ['command', 'work-dir', 'dimension', 'round'] },
  { name: 'rules-loader', script: 'rules-loader.js', description: 'Load team custom review rules', audience: 'maintainer', args: ['command', 'dimension?'] },
  { name: 'cr-activation-check', script: 'cr-activation-check.js', description: 'Determine which dimensions to activate', audience: 'maintainer', args: ['work-dir'] },
  { name: 'findings-catalog', script: 'findings-catalog.js', description: 'Look up canonical finding templates', audience: 'maintainer', args: ['command', '...'] },
  { name: 'file-inventory', script: 'file-inventory.js', description: 'Generate file inventory for target paths', audience: 'maintainer', args: ['target-paths...'] },
  { name: 'intervention-ledger', script: 'intervention-ledger.js', description: 'Cross-run intervention tracking', audience: 'maintainer', args: ['command', '...'] },
  { name: 'git-history-profile', script: 'git-history-profile.js', description: 'Profile repository history for review context', audience: 'maintainer', args: ['command', '...'] },
  { name: 'loop-discovery', script: 'loop-discovery.js', description: 'Discover and promote recurring repair loops', audience: 'maintainer', args: ['command', '...'] },
  { name: 'workspace-topology', script: 'workspace-topology.js', description: 'Resolve workspace ownership and target scope', audience: 'maintainer', args: ['command', '...'] },
  { name: 'cli-schema', script: 'cli-schema.js', description: 'Self-describe available commands', audience: 'maintainer', args: ['--audience'] },
]);

function audienceIncludes(commandAudience, requestedAudience) {
  return AUDIENCE_LEVELS[commandAudience] <= AUDIENCE_LEVELS[requestedAudience];
}

function buildSchema(audience = 'maintainer') {
  if (!AUDIENCE_LEVELS[audience]) throw new Error(`Invalid audience: ${audience}. Use: workflow, advanced, maintainer`);
  const filtered = COMMANDS.filter(cmd => audienceIncludes(cmd.audience, audience));
  return {
    schema: 'opencli',
    version: 1,
    plugin: 'optcode',
    audience,
    command_count: filtered.length,
    commands: filtered.map(cmd => ({
      name: cmd.name,
      script: cmd.script,
      description: cmd.description,
      audience: cmd.audience,
      args: cmd.args || [],
    })),
  };
}

function main() {
  const args = process.argv.slice(2);
  const audienceIdx = args.indexOf('--audience');
  const audience = audienceIdx !== -1 ? args[audienceIdx + 1] : 'maintainer';
  try {
    const schema = buildSchema(audience);
    console.log(JSON.stringify(schema, null, 2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { COMMANDS, AUDIENCE_LEVELS, audienceIncludes, buildSchema };
