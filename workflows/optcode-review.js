export const meta = {
  name: 'optcode-review',
  description: 'Govern AI-generated code with parallel review, adversarial verification, and regression-safe fixes.',
  whenToUse: 'When /optcode is invoked for a multi-dimension code review or AI code quality governance run.',
  phases: [
    { title: 'Activate', detail: 'resolve applicable review dimensions' },
    { title: 'CR', detail: 'parallel read-only coverage review' },
    { title: 'Verify', detail: 'parallel adversarial finding verification' },
    { title: 'RCA', detail: 'root cause clustering and principle-aligned strategy' },
    { title: 'Fix', detail: 'serial bounded fixes with evidence and re-review' },
  ],
}

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dimension: { type: 'string' },
    result: { type: 'string', enum: ['pass', 'needs_fix', 'failed'] },
    reportPath: { type: 'string' },
    issueIds: { type: 'array', items: { type: 'string' } },
  },
  required: ['dimension', 'result', 'reportPath', 'issueIds'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dimension: { type: 'string' },
    issueId: { type: 'string' },
    verdict: { type: 'string', enum: ['TRUE_POSITIVE', 'FALSE_POSITIVE', 'UNCERTAIN'] },
    confidence: { type: 'integer' },
  },
  required: ['dimension', 'issueId', 'verdict', 'confidence'],
}

const REGRESSION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['CLEAN', 'PARTIAL', 'REGRESSION_FOUND', 'UNCERTAIN'] },
    issues: { type: 'array', items: { type: 'string' } },
    fixedCount: { type: 'integer' },
    totalCount: { type: 'integer' },
  },
  required: ['verdict'],
}

const normalizedArgs = typeof args === 'string'
  ? (() => { try { return JSON.parse(args) } catch { throw new Error('args must be a JSON object') } })()
  : args
const {
  pluginRoot,
  workDir,
  baseCommit,
  targetPaths = [],
  dimensions = [],
  mode = 'light',
  fixEnabled = true,
  singleDimension,
  maxFindings,
  resumeFix = false,
} = normalizedArgs ?? {}

if (!pluginRoot || !workDir || !baseCommit) {
  throw new Error('args.pluginRoot, args.workDir, and args.baseCommit are required')
}
if (!['light', 'deep', 'auto'].includes(mode)) throw new Error(`unsupported mode: ${mode}`)

log(`optcode: starting ${mode}${resumeFix ? ' (resume-fix)' : ''} review in ${workDir}`)

// --- Resume Fix: skip Activate/CR, reconstruct findings from existing reports ---
const RESUME_FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    activeDimensions: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          issueId: { type: 'string' },
          dimension: { type: 'string' },
          reportPath: { type: 'string' },
        },
        required: ['issueId', 'dimension', 'reportPath'],
      },
    },
  },
  required: ['activeDimensions', 'findings'],
}

let activeDimensions
let findings
let validCr

if (resumeFix) {
  phase('Activate')
  const resumed = await agent(
    `Resume from existing CR reports in ${workDir}/cr/.
List all CR report files (*.md) in ${workDir}/cr/. For each report with result=needs_fix:
- Extract the dimension from the filename (e.g., "design-round-1.md" → "design")
- Extract all issue IDs (format: dimension:ISSUE-NNN from ### headings)
- Record the report path
Return the activeDimensions (list of dimensions that had needs_fix reports) and findings array.
If no CR reports exist or none have needs_fix, return empty arrays.`,
    { label: 'resume-scan', agentType: 'general-purpose', phase: 'Activate', schema: RESUME_FINDINGS_SCHEMA },
  )

  if (!resumed || resumed.findings.length === 0) {
    return { status: 'skipped', reason: 'resumeFix: no existing CR reports with needs_fix findings' }
  }

  activeDimensions = resumed.activeDimensions
  findings = resumed.findings
  validCr = activeDimensions.map((d) => ({ dimension: d, result: 'needs_fix', reportPath: `${workDir}/cr/${d}-round-1.md`, issueIds: findings.filter((f) => f.dimension === d).map((f) => f.issueId) }))
  log(`resume-fix: reconstructed ${findings.length} findings from ${activeDimensions.length} dimensions`)
} else {
  // --- Normal flow: Activate + CR ---
  if (singleDimension) {
    activeDimensions = [singleDimension]
  } else if (dimensions.length > 0) {
    activeDimensions = dimensions
  } else {
    const activation = await agent(
      `Run node ${pluginRoot}/scripts/cr-activation-check.js ${workDir}. Return the activated dimension names. Explicitly include design, maintainability, and dead-code unless the user skipped them.`,
      {
        label: 'activate',
        agentType: 'general-purpose',
        phase: 'Activate',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            dimensions: { type: 'array', items: { type: 'string' } },
          },
          required: ['dimensions'],
        },
      },
    )
    activeDimensions = activation?.dimensions ?? []
  }
  if (activeDimensions.length === 0) return { status: 'skipped', reason: 'no active dimensions' }

  const knownCtx = await agent(
    `Run node ${pluginRoot}/scripts/known-issues.js context. Return only the stdout output as-is.`,
    { label: 'known-issues-ctx', phase: 'Activate' },
  )

  const crResults = await parallel(activeDimensions.map((dimension) => () => agent(
    `Run coverage-first read-only CR for dimension ${dimension}.

## Information boundary (STRICT)
- CAN read: ${pluginRoot}/dimensions/${dimension}.md, ${workDir}/file-inventory.md, target files listed below
- CANNOT read: other dimension files (${activeDimensions.filter(d => d !== dimension).join(', ')}), other CR reports, state.json, audit-log.jsonl
- CANNOT write: anything outside ${workDir}/cr/${dimension}-round-1.md

## Evidence strength ceiling
- verification=read → max confidence 74
- verification=grep/static-analysis → max confidence 84
- verification=test/typecheck/build → max confidence 94
- verification=runtime/reproduction → max confidence 100

## Task
Read ${pluginRoot}/dimensions/${dimension}.md and ${workDir}/file-inventory.md, then inspect every applicable target file.
Write exactly one report to ${workDir}/cr/${dimension}-round-1.md using the repository CR template.
Every issue ID MUST be globally unique and use ${dimension}:ISSUE-001, ${dimension}:ISSUE-002, etc.
Each issue must contain file, symbol/line, concrete failure scenario, evidence, severity, confidence (capped by evidence ceiling), and fix risk.
Do not modify business code, state.json, or audit-log.jsonl.
Targets: ${JSON.stringify(targetPaths)}
Known issues (do not re-report deferred items): ${knownCtx || 'none'}${maxFindings ? `\nReport at most ${maxFindings} findings.` : ''}`,
    { label: `cr:${dimension}`, agentType: 'optcode:agent-cr', phase: 'CR', schema: FINDING_SCHEMA },
  )))

  validCr = crResults.filter(Boolean)
  const needsFix = validCr.filter((result) => result.result === 'needs_fix')
  let rawFindings = needsFix.flatMap((result) => (result.issueIds ?? []).map((issueId) => ({
    issueId,
    dimension: result.dimension,
    reportPath: result.reportPath,
  })))

  // Cross-dimension deduplication: same target + same consequence + same repair → merge
  if (rawFindings.length > 1) {
    const dedup = await agent(
      `Run node ${pluginRoot}/scripts/cross-dimension-dedup.js ${workDir}. Return the deduplicated_ids array and removed_count.`,
      { label: 'dedup', phase: 'CR', schema: { type: 'object', properties: { deduplicated_ids: { type: 'array', items: { type: 'string' } }, removed_count: { type: 'integer' } }, required: ['deduplicated_ids', 'removed_count'] } },
    )
    if (dedup && dedup.removed_count > 0) {
      const kept = new Set(dedup.deduplicated_ids)
      rawFindings = rawFindings.filter((f) => kept.has(f.issueId))
      log(`dedup: removed ${dedup.removed_count} cross-dimension duplicates`)
    }
  }
  findings = rawFindings
  log(`CR barrier complete: ${validCr.length} reports, ${findings.length} findings`)

  await agent(
    `Run node ${pluginRoot}/scripts/known-issues.js sync ${workDir}. This persists new findings to .optcode/known-issues.json.`,
    { label: 'sync-issues', phase: 'CR' },
  )

  // Capture context freeze after CR for drift detection before Fix
  await agent(
    `Run node ${pluginRoot}/scripts/context-freeze.js capture ${workDir}. This snapshots target file hashes for pre-fix drift detection.`,
    { label: 'context-freeze', phase: 'CR' },
  )

  await agent(
    `Act as the sole CR barrier coordinator. In ${workDir}, verify every report exists, run gate-check.js for each report, and record each result with dimension-status.js --cr-done. Do these shared-state writes serially. Do not modify business code. Base commit: ${baseCommit}. Results: ${JSON.stringify(validCr)}`,
    { label: 'cr-barrier', agentType: 'general-purpose', phase: 'CR' },
  )
}

if (mode === 'deep') {
  await agent(
    `Create a deep plan only. Use the gated CR reports in ${workDir}/cr and write ${workDir}/deep-plan.md. Include ordered fixes, dependencies, risk, validation commands, and rollback points. Do not modify business code. Then run node ${pluginRoot}/scripts/dimension-status.js ${workDir} --deep-plan-done.`,
    { label: 'deep-plan', agentType: 'optcode:agent-cr', phase: 'Verify' },
  )
  // A deep plan is an execution checkpoint, not a terminal outcome. Continue
  // through verification and fixing so auto mode completes in one invocation.
}

if (findings.length === 0) return { status: 'pass', dimensions: validCr, workDir }

const verification = budget.remaining() > 80000
  ? await parallel(findings.map((finding) => () => agent(
      `Independently verify only ${finding.issueId} in ${finding.reportPath}.

## Information boundary (STRICT)
- CAN read: ${finding.reportPath} (only the ${finding.issueId} section), target source files referenced by the finding
- CANNOT read: other CR reports, other findings, state.json, audit-log.jsonl, fix reports
- CANNOT write: anything outside ${workDir}/verification/${finding.dimension}-${finding.issueId.replace(/[^A-Za-z0-9-]/g, '_')}.md

## Task
Read the referenced source and search for refuting evidence: indirect calls, framework conventions, public API use, tests, and configuration-driven behavior.
Write one report to ${workDir}/verification/${finding.dimension}-${finding.issueId.replace(/[^A-Za-z0-9-]/g, '_')}.md.
Do not modify business code or shared state. UNCERTAIN is conservative and must be retained.`,
      { label: `verify:${finding.issueId}`, agentType: 'optcode:agent-verifier', phase: 'Verify', schema: VERDICT_SCHEMA },
    )))
  : null

if (!verification) {
  log('budget below verification threshold; refusing automatic fixes')
  return { status: 'verification_required', dimensions: validCr, findings, workDir }
}

const validVerification = verification.filter(Boolean)
const dismissed = validVerification.filter((result) => result.verdict === 'FALSE_POSITIVE').map((result) => result.issueId)
const confirmed = findings.filter((finding) => !dismissed.includes(finding.issueId))

await agent(
  `Act as the sole verification barrier coordinator. Import valid verifier reports from ${workDir}/verification into the persistent audit/state using workflow-lib.js. Apply FALSE_POSITIVE only when the report is valid; retain TRUE_POSITIVE and UNCERTAIN. Record malformed or missing reports as blocked. Do not modify business code.`,
  { label: 'verification-barrier', agentType: 'general-purpose', phase: 'Verify' },
)

if (confirmed.length === 0) {
  return { status: 'all_dismissed', dimensions: validCr, findings, dismissed, confirmed: [], workDir }
}

if (!fixEnabled) {
  return { status: 'review_only', dimensions: validCr, findings, dismissed, confirmed, workDir }
}

// --- RCA Phase ---
const RCA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dimension: { type: 'string' },
    cluster_count: { type: 'integer' },
    report_path: { type: 'string' },
    mode: { type: 'string', enum: ['full', 'light'] },
  },
  required: ['dimension', 'cluster_count', 'report_path'],
}

const rcaByDimension = {}
const dimensionsNeedingRca = [...new Set(confirmed.map((f) => f.dimension))]

if (budget.remaining() > 60000) {
  phase('RCA')
  const rcaResults = await parallel(dimensionsNeedingRca.map((dimension) => () => {
    const dimFindings = confirmed.filter((f) => f.dimension === dimension)
    const issueIds = dimFindings.map((f) => f.issueId).join(', ')
    const crReport = dimFindings[0]?.reportPath || `${workDir}/cr/${dimension}-round-1.md`
    return agent(
      `Perform root cause analysis for dimension ${dimension}.
Read the CR report at ${crReport} and verification reports in ${workDir}/verification/.
Confirmed issue IDs: ${issueIds}.
Cluster these confirmed findings by shared root cause, identify violated design principles, and produce principle-aligned fix strategies.
Write the RCA report to ${workDir}/rca/${dimension}-round-1.md using the RCA template at ${pluginRoot}/skills/optcode/references/rca-report-template.md.
If there are only 1-2 issues with severity=low and fix_risk=safe, use mode=light (minimal single-cluster analysis).
Do not modify business code.`,
      { label: `rca:${dimension}`, agentType: 'optcode:agent-rca', phase: 'RCA', schema: RCA_SCHEMA },
    )
  }))

  const rcaValidated = []
  const rcaSkipped = []
  for (const rcaResult of rcaResults.filter(Boolean)) {
    const gateResult = await agent(
      `Run node ${pluginRoot}/scripts/gate-check.js ${workDir} rca-complete:${rcaResult.dimension}:1. Return the JSON output as-is.`,
      { label: `rca-gate:${rcaResult.dimension}`, phase: 'RCA', schema: { type: 'object', properties: { pass: { type: 'boolean' }, reason: { type: 'string' } }, required: ['pass'] } },
    )
    if (gateResult && gateResult.pass) {
      rcaByDimension[rcaResult.dimension] = rcaResult
      rcaValidated.push(rcaResult.dimension)
    } else {
      rcaSkipped.push(`${rcaResult.dimension}: ${gateResult?.reason || 'gate check failed'}`)
    }
  }
  if (rcaSkipped.length > 0) log(`RCA gate rejected: ${rcaSkipped.join('; ')} — fixer will use CR directly`)
  log(`RCA complete: ${rcaValidated.length} validated, ${rcaSkipped.length} rejected`)
} else {
  log('budget below RCA threshold; fixer will use CR reports directly')
}

// --- Pre-fix drift check ---
const drift = await agent(
  `Run node ${pluginRoot}/scripts/context-freeze.js verify ${workDir}. Return the JSON output. If drifted=true, list the changed files.`,
  { label: 'drift-check', phase: 'Fix', schema: { type: 'object', properties: { drifted: { type: 'boolean' }, drift_count: { type: 'integer' } }, required: ['drifted'] } },
)
if (drift && drift.drifted) {
  log(`WARNING: ${drift.drift_count} file(s) drifted since CR — fixes may be based on stale context`)
}

// --- Fix Phase ---
phase('Fix')
const fixResults = []
for (const dimension of activeDimensions) {
  const dimensionFindings = confirmed.filter((finding) => finding.dimension === dimension)
  if (dimensionFindings.length === 0) continue

  const issueIds = dimensionFindings.map((finding) => finding.issueId)
  const rcaInfo = rcaByDimension[dimension]
  const rcaContext = rcaInfo
    ? `\nRead the RCA report at ${rcaInfo.report_path} FIRST. Fix according to the principle-aligned strategies and acceptance criteria defined there, not just the symptom-level CR proposals.`
    : ''

  log(`serial fix: ${dimension} (${issueIds.length} findings)`)
  const fix = await agent(
    `Fix only ${issueIds.join(', ')} for dimension ${dimension}.
Read the matching CR report(s).${rcaContext}
Before editing, record the current git diff for this run against ${baseCommit}.
Modify only files and symbols justified by these findings. Do not change public APIs or unrelated files.
Write ${workDir}/fix/${dimension}-round-1.md with changed files, diff summary, tests run, exit codes, and unresolved concerns.`,
    { label: `fix:${dimension}`, agentType: 'optcode:agent-fixer', phase: 'Fix' },
  )

  const regression = await agent(
    `Check the serial fix for ${dimension}.
Read ${workDir}/fix/${dimension}-round-1.md and inspect the actual diff against the pre-fix snapshot recorded in that report.
Run the exact tests/typecheck/build commands listed there. Write ${workDir}/regression/${dimension}-round-1.md.
Return CLEAN only when the diff is in scope, commands pass, and no behavioral regression is found.`,
    { label: `regression:${dimension}`, agentType: 'optcode:agent-regression-check', phase: 'Fix', schema: REGRESSION_SCHEMA },
  )
  if (!regression || regression.verdict === 'REGRESSION_FOUND') {
    fixResults.push({ dimension, status: 'blocked', regression: regression?.verdict ?? 'UNCERTAIN' })
    break
  }
  if (regression.verdict === 'PARTIAL') {
    fixResults.push({ dimension, status: 'partial', regression: 'PARTIAL', fixedCount: regression.fixedCount, totalCount: regression.totalCount })
  } else if (regression.verdict === 'UNCERTAIN') {
    fixResults.push({ dimension, status: 'needs_review', regression: 'UNCERTAIN' })
  } else {
    fixResults.push({ dimension, status: 'fixed', fix: Boolean(fix) })
  }
}

return {
  status: fixResults.some((result) => result.status === 'blocked') ? 'blocked_by_regression' : 'completed',
  dimensions: validCr,
  findings,
  dismissed,
  confirmed,
  fixResults,
  workDir,
}
