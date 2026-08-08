---
description: "Use when the user types /optcode. Do not trigger on general 'code review' or 'fix' requests unless /optcode is explicitly mentioned."
argument-hint: "[review|fix|check|status] [target paths] [--mode light|deep|auto] [--dims dim1,dim2,...] [--skip dim1,dim2,...]"
allowed-tools: ["Bash", "Read", "Write", "Agent", "Workflow", "Grep", "Glob"]
---

# optcode

Use Claude Code's native Dynamic Workflow as the only orchestration layer. Do not manually dispatch review or fixer agents from this skill and do not recreate a `next_steps` state machine.

## 0. Sub-command routing

Parse the first argument. If it matches a known sub-command, route accordingly. Otherwise treat it as a target path (backward-compatible).

| Sub-command | Behavior |
|-------------|----------|
| (none) | Full CR + Fix flow (default, backward-compatible) |
| `review` | CR + Verify only, no fixes. Pass `fixEnabled: false` to the Workflow. |
| `fix [work-dir]` | Resume fixing from existing CR reports. Pass `resumeFix: true`. Auto-detect most recent work-dir with unresolved findings if omitted. |
| `check <dim> [paths]` | Single-dimension quick check (budget=3 findings). Pass `singleDimension` and `maxFindings: 3`. |
| `status [work-dir]` | Show run status. Run `orchestration-status.js` directly without launching a Workflow. |
| `dashboard [work-dir]` | Open observation dashboard. Generate if not exists, or re-open existing. |

For `status`: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-status.js" <work_dir>` and present the output. If no work-dir is given, use the most recent `.optcode/` directory. Do not start a Workflow.

For `dashboard`: If work-dir has an existing `dashboard.md`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/dashboard.js" open <work_dir>` and present the content. Otherwise run `node "${CLAUDE_PLUGIN_ROOT}/scripts/dashboard.js" generate <work_dir>` to create it first. If no work-dir is given, use the most recent `.optcode/` directory. Do not start a Workflow. Present the dashboard content directly to the user using Read.

For `check`: skip full init-state if only one dimension is requested. Still create a work directory and file inventory, but pass `singleDimension` and `maxFindings` to the Workflow args.

See `references/subcommands.md` for detailed semantics.

## Reference Loading Rules

Only Read the references listed for the current sub-command. Do not preload all references.

| Sub-command | Required References |
|-------------|-------------------|
| (default/review) | `action-init.md`, `hard-gate.md` |
| fix | `hard-gate.md` |
| check | (none — skip references) |
| status / dashboard | (none — no workflow) |

Templates (`cr-report-template.md`, `fix-report-template.md`, `rca-report-template.md`, `arch-diagram-guide.md`, `engineering-principles.md`) are loaded by agents themselves via their system prompts — do NOT read them from this skill.

## 1. Parse and validate input

Parse target paths, `--mode` (`light`, `deep`, or `auto`), `--dims`, and `--skip`. Reject paths outside the current project. When no paths are provided, use the repository's tracked files.

## 2. Initialize a run

Choose a unique work directory and capture the immutable starting revision:

```bash
work_dir=".optcode/$(date +%Y%m%d-%H%M%S)"
base_commit="$(git rev-parse HEAD)"
node "${CLAUDE_PLUGIN_ROOT}/scripts/init-state.js" "$work_dir" "$base_commit" <target-paths...> [--mode light|deep|auto] [--skip dim1,dim2]
node "${CLAUDE_PLUGIN_ROOT}/scripts/file-inventory.js" <target-paths...> > "$work_dir/file-inventory.md"
```

Stop if either command fails or the inventory is empty. Do not start agents with an unrecorded baseline.

## 3. Run the Dynamic Workflow

Call the native `Workflow` tool. Do not execute the workflow file with Node.

```text
Workflow({
  scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/optcode-review.js",
  args: {
    pluginRoot: "${CLAUDE_PLUGIN_ROOT}",
    workDir: "<work_dir>",
    baseCommit: "<base_commit>",
    targetPaths: [<target paths>],
    dimensions: [<--dims values or empty>],
    mode: "<light|deep|auto>"
  }
})
```

The Workflow performs:

- activation and optional preflight;
- parallel, read-only CR with `agent-cr`;
- stable finding normalization and adversarial verification with `agent-verifier`;
- a risk gate before any write;
- serial fixes with `agent-fixer` in light, deep, and auto modes after all required gates pass;
- test/typecheck/build evidence, regression review, and same-dimension re-review after each fix;
- atomic state and audit updates at phase barriers.

Parallel agents must write only unique reports. They must not write `state.json`, `audit-log.jsonl`, or business code. Fixers are never dispatched through `parallel()`.

## 4. Interpret the result

Present the structured Workflow result and the artifact paths. Treat these as blocking outcomes:

- `deep_plan`: record the plan checkpoint and continue the same autonomous run; do not wait for a second invocation.
- `verification_required`: report findings for review and stop only when the configured budget cannot safely continue.
- `blocked_by_gate` or `blocked_by_regression`: show the failing evidence and stop.
- `completed`: include changed files, tests, residual findings, and quality-gate result.

## 5. Resume safely

For an interrupted run, inspect the persisted state:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-status.js" <work_dir>
```

Resume with the same `workDir` and `baseCommit`. The Workflow must verify existing artifact hashes and skip only completed barriers. Never infer completion from a text report alone.

## Utilities

- `workflow-lib.js`: atomic state, audit log, report lookup, resume state
- `init-state.js`: run manifest and initial state
- `file-inventory.js`: deterministic target inventory
- `gate-check.js`: report postconditions
- `dimension-status.js`: atomic dimension transitions
- `quality-gate.js`: aggregate quality result
- `evidence-bundle.js`: canonical versioned evidence snapshot and drift validation
- `report-parser.js`: canonical ISSUE block and field parsing used by gates and analytics
- `safe-json-store.js`: fail-closed persistent JSON storage with validated backup recovery
- `cr-activation-check.js`: activation hints only; it cannot override explicit user dimensions
- `dashboard.js`: observation dashboard (trend + debt + quality card)
- `rules-loader.js`: team custom rules loader

See `references/dynamic-workflow.md`, `references/cr-report-template.md`, `references/fix-report-template.md`, and `references/hard-gate.md` for artifact contracts.
