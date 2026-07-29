<div align="center">

# OptCode

**Multi-dimension code review and auto-fix loop — a Claude Code plugin.**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Plugin-D97757.svg)](https://github.com/anthropics/claude-code)
[![Version](https://img.shields.io/badge/Version-0.11.0-green.svg)](./.claude-plugin/plugin.json)

[中文文档](./README_zh.md)&ensp;|&ensp;[License](./LICENSE)

</div>

<br/>

OptCode is a [Claude Code](https://github.com/anthropics/claude-code) plugin that orchestrates **multi-dimension code review** with an **automatic fix loop**. It treats code quality as a closed-loop system: review across 8 dimensions, root-cause analysis, principled fix, verification, and regression check — all driven by a lightweight state machine.

Three operating modes let you choose the right depth for the job:

| Mode | Behavior | Modifies Code |
|------|----------|:---:|
| `light` | 8-dimension CR → fix → diff verification loop. Ideal for local cleanups and low-risk fixes | Yes |
| `deep` | Structural diagnosis, risk layering, and phased refactoring plan. Ideal for large-scale decomposition | No |
| `auto` | Preflight inspection, then conservatively picks `light` or `deep` plan-only | Depends |

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

# Review only git-changed files
/optcode --diff
/optcode --diff main

# Skip specific dimensions
/optcode --skip style,design src/

# Combine options
/optcode --mode auto --diff main
```

<br/>

## Workflow

```
/optcode <paths>
    │
    ▼
orchestration-status.js (determine action each round)
    │
    ├─ init             → Initialize state + file inventory
    ├─ preflight        → Auto mode inspection, pick light/deep
    ├─ deep_plan        → Deep mode structural diagnosis & plan
    ├─ start_dimension  → Light mode: enter next dimension
    ├─ cr               → agent-cr (opus) reviews, outputs CR report
    ├─ rca              → agent-rca clusters issues, outputs principle-aligned strategy
    ├─ fix              → agent-fixer (sonnet) fixes based on RCA strategy
    ├─ verify           → Verification pass on fix results
    ├─ escalate         → Stall detection, escalate fix strategy
    ├─ exceed           → Round limit exceeded, skip dimension
    └─ summary          → All dimensions complete, output summary + dashboard
```

Each round validates artifacts via `gate-check.js` and advances the state machine via `dimension-status.js`.

<br/>

## Artifacts

Runtime artifacts are stored under `.optcode/` in the target project:

```
.optcode/{timestamp}/
├── state.json          # Workflow state
├── audit-log.jsonl     # Audit log
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
| Dimensions | `dimensions/*.md` | 8 dimension checklists and rules |
| State Machine | `scripts/workflow-lib.js` | Atomic writes, state R/W, audit log, stall detection |
| Orchestration | `scripts/orchestration-status.js` | Per-round action determination |
| Gate Check | `scripts/gate-check.js` | Artifact post-condition validation |
| Quality Gate | `scripts/quality-gate.js` | Quality scoring (PASS/WARN/FAIL) |
| Dashboard | `scripts/dashboard.js` | Quality score + trend + debt unified dashboard |
| Rules Loader | `scripts/rules-loader.js` | Load `.optcode/rules/*.md` custom review rules |

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
