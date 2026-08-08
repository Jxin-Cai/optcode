<div align="center">

# OptCode

**Multi-dimension code review and auto-fix loop — a Claude Code plugin.**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Plugin-D97757.svg)](https://github.com/anthropics/claude-code)
[![Version](https://img.shields.io/badge/Version-0.23.0-green.svg)](./.claude-plugin/plugin.json)

[中文文档](./README_zh.md)&ensp;|&ensp;[License](./LICENSE)

</div>

<br/>

OptCode is a [Claude Code](https://github.com/anthropics/claude-code) plugin that orchestrates **multi-dimension code review** with an **automatic fix loop**. It treats code quality as a closed-loop system: review across 9 dimensions, adversarial finding verification, root-cause analysis, finding-bound repair, and regression checking — coordinated by Claude Code's Dynamic Workflow.

Three operating modes let you choose the right depth for the job:

| Mode | Behavior | Modifies Code |
|------|----------|:---:|
| `light` | Quick evidence lanes → CR → verification → bounded fixes. Ideal for local and low-risk changes | Yes |
| `deep` | Normal-depth evidence lanes plus a structural plan checkpoint, then verified bounded fixes | Yes |
| `auto` | A recorded read-only preflight selects `light` or `deep` before CR begins | Depends on findings |

<br/>

## Table of Contents

- [Review Dimensions](#review-dimensions)
- [Installation](#installation)
- [Usage](#usage)
- [Workflow](#workflow)
- [Artifacts](#artifacts)
- [Architecture](#architecture)
- [Team Rules](#team-rules)
- [Contributing](#contributing)
- [License](#license)

<br/>

## Review Dimensions

| Dimension | What it checks |
|-----------|---------------|
| dead-code | Unused variables, functions, imports, and dead code blocks |
| duplication | Copy-paste code, abstractable repeated logic |
| concurrency | Race conditions, deadlocks, atomicity violations |
| design | SRP, OCP, cohesion/coupling, layering boundaries |
| style | Naming conventions, formatting, comment consistency |
| maintainability | Readability, modularity, error handling |
| legacy-safety | Implicit business rules, high-risk core paths |
| ai-sdd-smells | Requirement drift, over-engineering, context pollution |
| security | Injection, authorization, secret handling, unsafe execution, and trust boundaries |

<br/>

## Installation

### From Plugin Marketplace

```bash
# Add the marketplace
claude plugin marketplace add git@github.com:Jxin-Cai/optcode.git

# Install the plugin
claude plugin install optcode@optcode
```

### Management Commands

```bash
claude plugin marketplace list          # List added marketplaces
claude plugin marketplace update        # Update marketplace index
claude plugin list                      # List installed plugins
claude plugin update optcode            # Update plugin
claude plugin uninstall optcode         # Uninstall plugin
claude plugin marketplace remove optcode  # Remove marketplace
```

<br/>

## Usage

```bash
# Review current directory (default: light mode)
/optcode

# Review specific path
/optcode src/

# Review multiple paths
/optcode src/core,src/utils,lib/

# Review specific files
/optcode src/main.go,src/handler.go

# Explicit light mode
/optcode --mode light src/

# Deep structural diagnosis (plan only, no code changes)
/optcode --mode deep src/

# Auto mode: preflight then pick light or deep
/optcode --mode auto src/

# Review and verify without modifying code
/optcode review src/

# Single-dimension check (at most 3 findings, no fix)
/optcode check security src/api/

# Resume a previously reviewed run
/optcode fix .optcode/20240720-143000

# Review only git-changed files
/optcode --diff
/optcode --diff main

# Skip specific dimensions
/optcode --skip style,design src/

# Combine options
/optcode --mode auto --diff main
```

### Script CLI

Maintainers and CI can discover and invoke every executable capability through one shell-free facade:

```bash
npm run cli -- help                 # Workflow-facing commands
npm run cli -- help --all           # Full maintainer inventory
npm run cli -- help --json          # Machine-readable schema
npm run cli -- quality-gate <work-dir> --no-history
npm run cli -- evidence-bundle migrate <work-dir>  # Verified v1 → v2 migration
```

The command inventory is validated against the executable scripts, so adding a capability without registering it fails the test suite. Help and unknown-command paths do not write project files.

<br/>

## Workflow

```
/optcode <paths>
    │
    ├─ Activate  → optional auto preflight + applicable dimension set
    ├─ CR        → parallel, read-only dimension reviews + evidence gates
    ├─ Verify    → independent adversarial verification of every finding
    ├─ RCA       → parallel root-cause clustering for confirmed findings
    └─ Fix       → serial finding-bound fixes + regression checks + quality gate
```

Every repair round captures a Git-tree checkpoint without modifying the user's index. Failed or uncertain repairs restore that exact pre-round working tree, preserving changes that existed before OptCode ran.

<br/>

## Artifacts

Runtime artifacts are stored under `.optcode/` in the target project:

```
.optcode/{timestamp}/
├── state.json          # Workflow state
├── audit-log.jsonl     # Audit log
├── evidence-bundle.json # Versioned, integrity-sealed review snapshot
├── dashboard.md        # Observation dashboard (re-openable)
├── file-inventory.md   # File inventory
├── preflight.md        # Auto mode preflight result
├── deep-plan.md        # Deep mode structural plan
├── cr/                 # CR reports
│   └── arch-diagram.mmd  # Architecture diagram (design dimension)
├── verification/       # Verification reports
├── rca/                # RCA root-cause analysis reports
├── fix/                # Fix reports
├── regression/         # Regression check reports
├── transactions/       # Per-round mutation checkpoints and verified recovery metadata
└── summary.md          # Final summary

.optcode/
├── health-history.json # Cross-run health score history
├── known-issues.json   # Cross-run known issues
└── rules/*.md          # Team custom review rules
```

<br/>

## Architecture

| Component | Path | Description |
|-----------|------|-------------|
| Orchestrator | `skills/optcode/SKILL.md` | `/optcode` entry point, dispatches CR and fix loop |
| CR Agent | `agents/agent-cr.md` | Review agent, reused per dimension perspective |
| RCA Agent | `agents/agent-rca.md` | Root-cause analysis, clusters issues into principle-aligned strategy |
| Fixer Agent | `agents/agent-fixer.md` | Fix agent, executes repairs based on RCA strategy or CR report |
| Verifier Agent | `agents/agent-verifier.md` | Verification agent, validates fix correctness |
| Regression Agent | `agents/agent-regression-check.md` | Regression check after fixes |
| Dimensions | `dimensions/*.md` | 9 dimension checklists and rules |
| State Machine | `scripts/workflow-lib.js` | Atomic writes, state R/W, audit log, stall detection |
| Orchestration | `scripts/orchestration-status.js` | Per-round action determination |
| Gate Check | `scripts/gate-check.js` | Artifact post-condition validation |
| Evidence Bundle | `scripts/evidence-bundle.js` | Canonical versioned workspace snapshot and drift validation |
| Report Parser | `scripts/report-parser.js` | Canonical ISSUE headings, block boundaries, fields, and qualified IDs |
| JSON Store | `scripts/safe-json-store.js` | Atomic persistent storage, validated backups, and fail-closed recovery |
| Quality Gate | `scripts/quality-gate.js` | Quality scoring (PASS/WARN/FAIL) |
| Dashboard | `scripts/dashboard.js` | Quality score + trend + debt unified dashboard |
| Rules Loader | `scripts/rules-loader.js` | Load `.optcode/rules/*.md` custom review rules |
| Mutation Checkpoint | `scripts/mutation-checkpoint.js` | Preserve the pre-fix dirty tree and roll back only one repair round |

`scripts/context-freeze.js` remains only as a deprecated compatibility facade. New captures always write `evidence-bundle.json`; valid v1 bundles can be migrated to schema v2 without trusting tampered input.

State readers recover a corrupt primary file only from a valid backup. If both are corrupt, state-facing CLIs fail closed with `E_STATE_CORRUPT`, exit code 3, and a backward-compatible `{ ok, code, message, ... }` JSON envelope.

Cross-run registries use the same rule: a missing file may initialize, a corrupt file may recover only from a valid `.backup`, and a corrupt primary plus corrupt backup returns `E_STORE_CORRUPT` without overwriting either file. Known issues, health history, deduplication, loop discovery, intervention, and effectiveness history all share this store.

<br/>

## Team Rules

OptCode supports project-level custom review rules. Place Markdown files in `.optcode/rules/` of your target project:

```
.optcode/rules/
├── naming.md           # Naming conventions
├── error-handling.md   # Error handling standards
└── api-design.md       # API design guidelines
```

Rules are automatically loaded and injected into the CR agent's review perspective.

<br/>

## Contributing

If you plan to contribute significant changes, **open an issue first** to discuss direction and scope. We welcome bug reports, feature requests, and pull requests.

<br/>

## License

Licensed under the [Apache License 2.0](./LICENSE).

Copyright 2026 jxin
