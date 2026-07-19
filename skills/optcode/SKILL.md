---
description: "Multi-dimension code review with parallel CR, adversarial verification, and regression-safe auto-fix. Use this skill when the user invokes /optcode or asks for structured multi-dimension code review."
argument-hint: "[target paths] [--mode light|deep] [--dims dim1,dim2,...] [--skip dim1,dim2,...]"
allowed-tools: ["Bash", "Read", "Write", "Agent", "Workflow", "Grep", "Glob"]
---

# optcode — Dynamic Workflow Code Review

Run multi-dimension code review using Claude Code's Dynamic Workflow for deterministic parallel orchestration.

## Invocation

Parse user arguments:
- **target paths**: files or directories to review (default: git tracked files in cwd)
- **--mode**: `light` (default) or `deep` (adds deep-plan phase)
- **--dims**: comma-separated dimension list to force-activate
- **--skip**: comma-separated dimensions to skip

## Execution Steps

### 1. Initialize workspace

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/init-state.js <target-paths...> [--mode light|deep] [--skip dim1,dim2]
```

Capture the printed `work_dir` path (e.g. `.optcode/20250719-143022/`).

### 2. Build file inventory

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/file-inventory.js <work_dir>
```

### 3. Launch Dynamic Workflow

Call the Workflow tool:

```
Workflow({
  scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/optcode-review.js",
  args: {
    pluginRoot: "${CLAUDE_PLUGIN_ROOT}",
    workDir: "<work_dir from step 1>",
    targetPaths: [<parsed target paths>],
    dimensions: [<--dims values or empty for auto-detect>],
    mode: "<light or deep>"
  }
})
```

The workflow handles all orchestration:
- **Activate**: determines which dimensions apply to the target code
- **CR**: fans out parallel read-only review agents per dimension
- **Verify**: adversarial verification of each finding (skipped if budget is low)
- **Fix**: serial fixes with regression checks after each

### 4. Present results

After the workflow completes, summarize:
- Dimensions reviewed and their results
- Issues found, verified, and fixed
- Any regressions detected
- Overall quality assessment

If the workflow returns `blocked_by_regression`, inform the user which dimension's fix caused the regression and suggest next steps.

## Resumption

If a previous run was interrupted, check for existing state:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-status.js <work_dir>
```

This reports current phase and progress. Re-run the Workflow with the same `workDir` — agents will detect existing reports and skip completed work.

## CLI Utilities

These scripts are used by the workflow agents internally, but available for debugging:

| Script | Purpose |
|--------|---------|
| `gate-check.js <work_dir> <artifact>` | Validate CR/fix report postconditions |
| `dimension-status.js <work_dir> <action> [args]` | Transition dimension state |
| `quality-gate.js <work_dir>` | Compute overall quality score |
| `cr-activation-check.js <work_dir>` | Determine which dimensions to activate |
| `verification-check.js <work_dir>` | Extract findings for verification |
| `apply-verification.js <work_dir>` | Apply verification results to CR reports |

## Dimensions

8 review perspectives in `${CLAUDE_PLUGIN_ROOT}/dimensions/`:
dead-code, duplication, concurrency, design, style, maintainability, legacy-safety, ai-sdd-smells

## References

- `references/cr-report-template.md` — CR report format
- `references/fix-report-template.md` — Fix report format
- `references/hard-gate.md` — Gate check rules
- `references/dynamic-workflow.md` — Workflow architecture details
