export const meta = {
  name: 'optcode-verify-phase',
  description: 'Adversarial verification of CR findings and root cause analysis.',
  phases: [
    { title: 'Verify', detail: 'parallel adversarial finding verification' },
    { title: 'RCA', detail: 'root cause clustering and principle-aligned strategy' },
  ],
}

const {
  pluginRoot,
  workDir,
  baseCommit,
  mode,
  fixEnabled,
  activeDimensions,
  validCr,
  findings,
  schemas,
} = args

const VERDICT_SCHEMA = schemas.verdict
const RCA_SCHEMA = schemas.rca

if (mode === 'deep') {
  phase('Verify')
  await agent(
    `Create a deep plan only. Use the gated CR reports in ${workDir}/cr and write ${workDir}/deep-plan.md. Include ordered fixes, dependencies, risk, validation commands, and rollback points. Do not modify business code. Then run node ${pluginRoot}/scripts/dimension-status.js ${workDir} --deep-plan-done.`,
    { label: 'deep-plan', agentType: 'optcode:agent-cr', phase: 'Verify' },
  )
}

if (findings.length === 0) return { status: 'pass', dimensions: validCr, workDir }

phase('Verify')
const verification = (!budget.total || budget.remaining() > 80000)
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
const rcaByDimension = {}
const dimensionsNeedingRca = [...new Set(confirmed.map((f) => f.dimension))]

if (!budget.total || budget.remaining() > 60000) {
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

return { activeDimensions, validCr, findings, dismissed, confirmed, rcaByDimension }
