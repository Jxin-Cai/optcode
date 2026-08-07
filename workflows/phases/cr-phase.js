export const meta = {
  name: 'optcode-cr-phase',
  description: 'Activate dimensions and run parallel read-only code review with quality gates.',
  phases: [
    { title: 'Activate', detail: 'resolve applicable review dimensions' },
    { title: 'CR', detail: 'parallel read-only coverage review' },
  ],
}

const {
  pluginRoot,
  workDir,
  baseCommit,
  targetPaths,
  dimensions,
  mode,
  singleDimension,
  maxFindings,
  schemas,
} = args

const FINDING_SCHEMA = schemas.finding

phase('Activate')

let activeDimensions
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

phase('CR')

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

let validCr = crResults.filter(Boolean)
const needsFix = validCr.filter((result) => result.result === 'needs_fix')
let findings = needsFix.flatMap((result) => (result.issueIds ?? []).map((issueId) => ({
  issueId,
  dimension: result.dimension,
  reportPath: result.reportPath,
})))

if (findings.length > 1) {
  const dedup = await agent(
    `Run node ${pluginRoot}/scripts/cross-dimension-dedup.js ${workDir}. Return the deduplicated_ids array and removed_count.`,
    { label: 'dedup', phase: 'CR', schema: { type: 'object', properties: { deduplicated_ids: { type: 'array', items: { type: 'string' } }, removed_count: { type: 'integer' } }, required: ['deduplicated_ids', 'removed_count'] } },
  )
  if (dedup && dedup.removed_count > 0) {
    const kept = new Set(dedup.deduplicated_ids)
    findings = findings.filter((f) => kept.has(f.issueId))
    log(`dedup: removed ${dedup.removed_count} cross-dimension duplicates`)
  }
}
log(`CR barrier complete: ${validCr.length} reports, ${findings.length} findings`)

await agent(
  `Run node ${pluginRoot}/scripts/known-issues.js sync ${workDir}. This persists new findings to .optcode/known-issues.json.`,
  { label: 'sync-issues', phase: 'CR' },
)

await agent(
  `Run node ${pluginRoot}/scripts/evidence-bundle.js freeze ${workDir}. This creates an immutable evidence bundle capturing workspace state (file hashes, git HEAD, active dimensions) before any fixes. Return the JSON output.`,
  { label: 'evidence-bundle-freeze', phase: 'CR' },
)

const qualityResults = await parallel(validCr.filter(r => r.result === 'needs_fix').map((cr) => () => agent(
  `Run both quality validators on ${cr.reportPath}:
1. node ${pluginRoot}/scripts/report-quality.js ${cr.reportPath} --json
2. node ${pluginRoot}/scripts/evidence-strength.js validate ${cr.reportPath}

Return a JSON object with:
- dimension: "${cr.dimension}"
- reportPath: "${cr.reportPath}"
- quality: the report-quality.js result (pass, total_violations, violations array)
- evidence: the evidence-strength.js result (valid, violations array)
- overallPass: true only if quality.pass AND evidence.valid`,
  {
    label: `quality-gate:${cr.dimension}`,
    phase: 'CR',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dimension: { type: 'string' },
        reportPath: { type: 'string' },
        overallPass: { type: 'boolean' },
        qualityViolations: { type: 'integer' },
        evidenceViolations: { type: 'integer' },
      },
      required: ['dimension', 'reportPath', 'overallPass'],
    },
  },
)))

const qualityFailed = (qualityResults || []).filter(Boolean).filter(r => !r.overallPass)
if (qualityFailed.length > 0) {
  log(`quality gates rejected ${qualityFailed.length} report(s): ${qualityFailed.map(r => `${r.dimension}(q:${r.qualityViolations || 0},e:${r.evidenceViolations || 0})`).join(', ')}`)
  const rejectedDims = new Set(qualityFailed.map(r => r.dimension))
  findings = findings.filter(f => !rejectedDims.has(f.dimension))
  validCr = validCr.map(cr => rejectedDims.has(cr.dimension) ? { ...cr, result: 'failed', failReason: 'quality_gate_rejected' } : cr)
}

const syntheticChecks = await parallel(validCr.filter(r => r.result === 'needs_fix').map((cr) => () => agent(
  `Run node ${pluginRoot}/scripts/synthetic-evidence.js ${cr.reportPath} --base-dir ${targetPaths[0] || '.'} --json. Return the JSON output.`,
  {
    label: `synthetic-check:${cr.dimension}`,
    phase: 'CR',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dimension: { type: 'string' },
        valid: { type: 'boolean' },
        violation_count: { type: 'integer' },
        violations: { type: 'array', items: { type: 'object' } },
      },
      required: ['valid'],
    },
  },
)))
const syntheticFailed = (syntheticChecks || []).filter(Boolean).filter(r => !r.valid)
if (syntheticFailed.length > 0) {
  log(`⚠ synthetic evidence detected in ${syntheticFailed.length} report(s) — flagging fabricated references`)
}

await agent(
  `Act as the sole CR barrier coordinator. In ${workDir}, verify every report exists, run gate-check.js for each report, and record each result with dimension-status.js --cr-done. Do these shared-state writes serially. Do not modify business code. Base commit: ${baseCommit}. Results: ${JSON.stringify(validCr)}`,
  { label: 'cr-barrier', agentType: 'general-purpose', phase: 'CR' },
)

const laneDepth = mode === 'deep' ? 'normal' : 'quick'
const laneValidation = await agent(
  `Run node ${pluginRoot}/scripts/evidence-lanes.js validate ${workDir} --depth ${laneDepth}. Return the JSON output as-is.`,
  { label: 'lane-validate', phase: 'CR', schema: { type: 'object', properties: { valid: { type: 'boolean' }, confidence: { type: 'string' }, unavailable: { type: 'integer' }, degraded_lanes: { type: 'array', items: { type: 'string' } }, blocking_lanes: { type: 'array', items: { type: 'string' } } }, required: ['valid'] } },
)
if (laneValidation && !laneValidation.valid) {
  if (mode === 'deep') {
    log(`⛔ lane validation failed in deep mode: blocking lanes = ${(laneValidation.blocking_lanes || []).join(', ')}`)
    return { status: 'blocked_by_gate', reason: 'lane_validation_failed', blocking_lanes: laneValidation.blocking_lanes, workDir }
  }
  log(`⚠ lane validation: ${laneValidation.unavailable || 0} unavailable lane(s) — confidence degraded to ${laneValidation.confidence || 'low'}`)
}

const [consistency, popBinding] = await parallel([
  () => agent(
    `Run node ${pluginRoot}/scripts/score-finding-consistency.js ${workDir} --json. Return the JSON output as-is.`,
    { label: 'score-finding-consistency', phase: 'CR', schema: { type: 'object', properties: { valid: { type: 'boolean' }, violation_count: { type: 'integer' }, violations: { type: 'array' } }, required: ['valid'] } },
  ),
  () => agent(
    `Run node ${pluginRoot}/scripts/population-binding.js ${workDir} --json. Return the JSON output as-is.`,
    { label: 'population-binding', phase: 'CR', schema: { type: 'object', properties: { valid: { type: 'boolean' }, violation_count: { type: 'integer' }, violations: { type: 'array' } }, required: ['valid'] } },
  ),
])
if (consistency && !consistency.valid) {
  log(`⚠ score-finding consistency: ${consistency.violation_count} violation(s) — ${(consistency.violations || []).map(v => v.message).slice(0, 3).join('; ')}`)
}
if (popBinding && !popBinding.valid) {
  log(`⚠ population binding: ${popBinding.violation_count} violation(s) — ${(popBinding.violations || []).map(v => v.message).slice(0, 3).join('; ')}`)
}

return { activeDimensions, validCr, findings }
