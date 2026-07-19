# Dynamic Workflow Architecture

optcode uses Claude Code's native **Dynamic Workflow** engine for orchestration, replacing the previous hand-written state machine approach.

## Why Dynamic Workflow

- **Deterministic control flow**: JavaScript-driven loops, conditionals, and fan-out — not prompt-following
- **Parallel execution**: Read-only CR agents run concurrently with `parallel()`
- **Structured results**: JSON schemas enforce agent output format
- **Budget awareness**: Skips verification when token budget is low
- **Progress visibility**: `log()` messages stream to the user

## Workflow Phases

```
Activate → CR (parallel) → Verify (parallel) → Fix (serial + regression check)
```

### 1. Activate
Runs `cr-activation-check.js` to determine which dimensions are relevant to the target code based on keyword detection.

### 2. CR (parallel, read-only)
Fans out one CR agent per activated dimension. Each agent reads the dimension perspective, reads target files, and writes a structured report. No code modifications.

### 3. Verify (parallel, adversarial)
For each finding, spawns an independent verifier agent with a skeptical stance. FALSE_POSITIVE findings are dismissed. Skipped if budget is insufficient.

### 4. Fix (serial)
For each dimension with confirmed findings:
1. Fixer agent modifies code
2. Regression-check agent inspects the diff
3. If REGRESSION_FOUND → stop and report

## Resumption

The workflow is stateless between invocations. State.json persists progress. On re-invocation:
- Agents detect existing reports and skip completed work
- `orchestration-status.js` reports current phase for debugging

## File Layout

```
.optcode/{timestamp}/
├── state.json              # Workflow state
├── audit-log.jsonl         # All state transitions
├── file-inventory.md       # Target file list
├── cr/{dim}-round-{n}.md   # CR reports
├── fix/{dim}-round-{n}.md  # Fix reports
├── verification/{id}.md    # Verification verdicts
└── regression/{dim}-round-{n}.md  # Regression checks
```
