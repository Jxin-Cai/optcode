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

// Budget-based timeout: if total budget set, ensure we don't exceed it
// Each fix round must have at least 30k tokens remaining to proceed
const MIN_TOKENS_PER_FIX_ROUND = 30000
const MIN_TOKENS_PER_CR = 50000

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

  // --- Quality gates: report-quality (8 gates) + evidence-strength ceiling ---
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
    // Downgrade rejected dimensions: remove their findings from the pipeline
    const rejectedDims = new Set(qualityFailed.map(r => r.dimension))
    findings = findings.filter(f => !rejectedDims.has(f.dimension))
    validCr = validCr.map(cr => rejectedDims.has(cr.dimension) ? { ...cr, result: 'failed', failReason: 'quality_gate_rejected' } : cr)
  }

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

// --- Pre-fix blast radius estimation ---
const blastRadius = await agent(
  `Run node ${pluginRoot}/scripts/blast-radius.js ${baseCommit} --json. Return the JSON result as-is.`,
  { label: 'blast-radius', phase: 'Fix', schema: { type: 'object', properties: { score: { type: 'integer' }, severity: { type: 'string' }, shouldBlock: { type: 'boolean' }, directFanIn: { type: 'integer' } }, required: ['score', 'severity'] } },
)
if (blastRadius && blastRadius.shouldBlock) {
  log(`⛔ blast radius ${blastRadius.score}/100 (${blastRadius.severity}) exceeds threshold — blocking auto-fix`)
  return { status: 'blocked_by_blast_radius', blastRadius, dimensions: validCr, findings, confirmed, workDir }
}
if (blastRadius) log(`blast radius: ${blastRadius.score}/100 (${blastRadius.severity}), fan-in=${blastRadius.directFanIn}`)

// --- Fix Phase (multi-round: re-review → re-fix, max 3 rounds per dimension) ---
phase('Fix')
const MAX_FIX_ROUNDS = 3
const fixResults = []
for (const dimension of activeDimensions) {
  let dimensionFindings = confirmed.filter((finding) => finding.dimension === dimension)
  if (dimensionFindings.length === 0) continue

  const rcaInfo = rcaByDimension[dimension]
  const rcaContext = rcaInfo
    ? `\nRead the RCA report at ${rcaInfo.report_path} FIRST. Fix according to the principle-aligned strategies and acceptance criteria defined there, not just the symptom-level CR proposals.`
    : ''

  let finalStatus = null
  for (let round = 1; round <= MAX_FIX_ROUNDS; round++) {
    if (budget.total && budget.remaining() < MIN_TOKENS_PER_FIX_ROUND) {
      log(`budget exhausted before fix round ${round} for ${dimension} (remaining: ${budget.remaining()})`)
      finalStatus = { dimension, status: 'partial', regression: 'budget_exhausted', round: round - 1 }
      break
    }
    const issueIds = dimensionFindings.map((finding) => finding.issueId)
    log(`fix round ${round}/${MAX_FIX_ROUNDS}: ${dimension} (${issueIds.length} findings)`)

    const fix = await agent(
      `Fix only ${issueIds.join(', ')} for dimension ${dimension} (round ${round}).
Read the matching CR report(s).${rcaContext}${round > 1 ? `\nThis is re-fix round ${round}. Previous round was PARTIAL — focus on the remaining unfixed issues only. Read ${workDir}/fix/${dimension}-round-${round - 1}.md for prior attempt context.` : ''}
Before editing, record the current git diff for this run against ${baseCommit}.
Modify only files and symbols justified by these findings. Do not change public APIs or unrelated files.
Write ${workDir}/fix/${dimension}-round-${round}.md with changed files, diff summary, tests run, exit codes, and unresolved concerns.`,
      { label: `fix:${dimension}:r${round}`, agentType: 'optcode:agent-fixer', phase: 'Fix' },
    )

    const regression = await agent(
      `Check the serial fix for ${dimension} (round ${round}).
Read ${workDir}/fix/${dimension}-round-${round}.md and inspect the actual diff against the pre-fix snapshot recorded in that report.
Run the exact tests/typecheck/build commands listed there. Write ${workDir}/regression/${dimension}-round-${round}.md.
Return CLEAN only when the diff is in scope, commands pass, and no behavioral regression is found.`,
      { label: `regression:${dimension}:r${round}`, agentType: 'optcode:agent-regression-check', phase: 'Fix', schema: REGRESSION_SCHEMA },
    )

    if (!regression || regression.verdict === 'REGRESSION_FOUND') {
      // Auto-rollback: revert fix changes to restore pre-fix state
      await agent(
        `REGRESSION detected in ${dimension} round ${round}. Rollback the fix changes:
1. Run: git diff --name-only ${baseCommit} to see all currently changed files
2. Run: git checkout ${baseCommit} -- <files that were changed by the fix in this round>
   To identify which files the fix changed, read ${workDir}/fix/${dimension}-round-${round}.md and extract the file list from its diff summary.
3. Verify the rollback succeeded by checking git status.
Do NOT rollback files changed by other dimensions' fixes — only rollback files from THIS dimension's round ${round} fix.`,
        { label: `rollback:${dimension}:r${round}`, phase: 'Fix' },
      )
      log(`⚠ rolled back ${dimension} round ${round} fix due to regression`)
      finalStatus = { dimension, status: 'blocked', regression: regression?.verdict ?? 'UNCERTAIN', round, rolledBack: true }
      break
    }
    if (regression.verdict === 'CLEAN') {
      finalStatus = { dimension, status: 'fixed', round, fix: Boolean(fix) }
      break
    }
    if (regression.verdict === 'UNCERTAIN') {
      finalStatus = { dimension, status: 'needs_review', regression: 'UNCERTAIN', round }
      break
    }
    // Stagnation detection: if this is round 2+ and same issues keep recurring, escalate
    if (round >= 2 && regression.fixedCount === 0) {
      log(`⚠ stagnation detected: ${dimension} round ${round} fixed 0 issues — escalating strategy`)
      const escalatedFix = await agent(
        `ESCALATION: Previous ${round} fix attempts for ${dimension} failed to reduce issue count.
The straightforward approach is not working. Try a fundamentally different strategy:
1. Read ALL previous fix reports: ${Array.from({length: round}, (_, i) => `${workDir}/fix/${dimension}-round-${i+1}.md`).join(', ')}
2. Identify WHY previous fixes failed (wrong root cause? incomplete understanding? conflicting constraints?)
3. Try one of these alternative approaches:
   - If the issue is structural: propose a larger refactoring that addresses the root cause
   - If the issue is a false positive: write a skip justification explaining why the finding should be dismissed
   - If the fix conflicts with other code: fix the constraint first, then the original issue
4. Write ${workDir}/fix/${dimension}-round-${round + 1}.md with the escalated approach.
Mark issues you cannot fix as SKIPPED with clear justification.`,
        { label: `escalate:${dimension}`, agentType: 'optcode:agent-fixer', phase: 'Fix' },
      )
      const escRegression = await agent(
        `Check the escalated fix for ${dimension} (round ${round + 1}).
Read ${workDir}/fix/${dimension}-round-${round + 1}.md. Run tests. Write ${workDir}/regression/${dimension}-round-${round + 1}.md.`,
        { label: `regression:${dimension}:escalated`, agentType: 'optcode:agent-regression-check', phase: 'Fix', schema: REGRESSION_SCHEMA },
      )
      if (!escRegression || escRegression.verdict === 'REGRESSION_FOUND') {
        await agent(
          `Rollback escalated fix for ${dimension}. Read ${workDir}/fix/${dimension}-round-${round + 1}.md, extract changed files, run git checkout ${baseCommit} -- <those files>.`,
          { label: `rollback:${dimension}:escalated`, phase: 'Fix' },
        )
        finalStatus = { dimension, status: 'blocked', regression: 'escalation_failed', round }
      } else {
        finalStatus = { dimension, status: escRegression.verdict === 'CLEAN' ? 'fixed' : 'partial', round: round + 1, escalated: true }
      }
      break
    }

    // PARTIAL: re-review remaining issues if more rounds available
    if (round < MAX_FIX_ROUNDS && budget.remaining() > 40000) {
      const reReview = await agent(
        `Re-review dimension ${dimension} after fix round ${round}.
Only check the ${regression.totalCount - (regression.fixedCount || 0)} remaining unfixed issues from the original CR.
Read ${workDir}/fix/${dimension}-round-${round}.md and the original CR report at ${workDir}/cr/${dimension}-round-1.md.
List only issue IDs that are still unresolved. Return them as issueIds array.`,
        {
          label: `re-review:${dimension}:r${round}`,
          phase: 'Fix',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { issueIds: { type: 'array', items: { type: 'string' } } },
            required: ['issueIds'],
          },
        },
      )
      if (reReview && reReview.issueIds && reReview.issueIds.length > 0) {
        dimensionFindings = reReview.issueIds.map(id => ({ issueId: id, dimension, reportPath: `${workDir}/cr/${dimension}-round-1.md` }))
        log(`re-review: ${reReview.issueIds.length} issues remain for ${dimension}, entering round ${round + 1}`)
      } else {
        finalStatus = { dimension, status: 'fixed', round, fix: Boolean(fix) }
        break
      }
    } else {
      finalStatus = { dimension, status: 'partial', regression: 'PARTIAL', round, fixedCount: regression.fixedCount, totalCount: regression.totalCount }
      break
    }
  }
  fixResults.push(finalStatus || { dimension, status: 'partial', regression: 'max_rounds_exhausted', round: MAX_FIX_ROUNDS })
  if (finalStatus?.status === 'blocked') break
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
