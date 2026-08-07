# Dynamic Workflow Architecture

optcode uses Claude Code's native **Dynamic Workflow** engine for orchestration, with nested sub-workflows for maintainability.

## Structure

```
workflows/
├── optcode-review.js          # Orchestrator: args parsing, schema definitions, phase routing
└── phases/
    ├── cr-phase.js            # Activate + CR (parallel fan-out + quality gates + dedup)
    ├── verify-phase.js        # Verify (adversarial) + RCA (root cause clustering)
    └── fix-phase.js           # Fix (serial loop + regression + rollback + escalation)
```

The orchestrator defines all JSON schemas and passes them to sub-workflows via `args.schemas`. Each sub-workflow returns a structured result that feeds into the next phase.

## Data Flow

```
optcode-review.js
  │
  ├─ resumeFix? ──→ fix-phase.js (directly)
  │
  └─ normal flow:
       cr-phase.js → { activeDimensions, validCr, findings }
         │
       verify-phase.js → { confirmed, dismissed, rcaByDimension }
         │
       fix-phase.js → { status, fixResults, loopCandidates }
```

## Why Sub-workflows

- **Readable**: each file is ~120-200 lines instead of one 600-line monolith
- **Testable**: phases can be invoked independently (e.g., `resumeFix` skips directly to fix-phase)
- **Budget-aware**: each sub-workflow inherits and respects the shared token budget

## Workflow Phases

### 1. Activate (cr-phase.js)
Runs `cr-activation-check.js` to determine which dimensions are relevant to the target code.

### 2. CR (cr-phase.js, parallel, read-only)
Fans out one CR agent per activated dimension. Includes quality gates, synthetic evidence detection, lane validation, and score-finding consistency checks.

### 3. Verify (verify-phase.js, parallel, adversarial)
For each finding, spawns an independent verifier agent. FALSE_POSITIVE findings are dismissed. Skipped if budget is insufficient.

### 4. RCA (verify-phase.js)
Clusters confirmed findings by root cause, produces principle-aligned fix strategies. Skipped if budget is low.

### 5. Fix (fix-phase.js, serial)
For each dimension with confirmed findings:
1. Validates evidence bundle integrity
2. Estimates blast radius
3. Fixer agent modifies code (up to 3 rounds)
4. Regression-check agent inspects the diff
5. Auto-rollback on regression, escalation on stagnation

## Resumption

The workflow is stateless between invocations. `state.json` persists progress. On re-invocation:
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
├── rca/{dim}-round-{n}.md  # RCA reports
└── regression/{dim}-round-{n}.md  # Regression checks
```
