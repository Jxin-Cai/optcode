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
  { name: 'context-freeze', script: 'context-freeze.js', description: 'Capture/verify workspace snapshots', audience: 'maintainer', args: ['command', 'work-dir'] },
  { name: 'rules-loader', script: 'rules-loader.js', description: 'Load team custom review rules', audience: 'maintainer', args: ['command', 'dimension?'] },
  { name: 'cr-activation-check', script: 'cr-activation-check.js', description: 'Determine which dimensions to activate', audience: 'maintainer', args: ['work-dir'] },
  { name: 'findings-catalog', script: 'findings-catalog.js', description: 'Look up canonical finding templates', audience: 'maintainer', args: ['command', '...'] },
  { name: 'file-inventory', script: 'file-inventory.js', description: 'Generate file inventory for target paths', audience: 'maintainer', args: ['target-paths...'] },
  { name: 'intervention-ledger', script: 'intervention-ledger.js', description: 'Cross-run intervention tracking', audience: 'maintainer', args: ['command', '...'] },
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
