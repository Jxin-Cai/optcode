export const meta = {
  name: 'optcode-fix-phase',
  description: 'Serial bounded fixes with evidence validation, regression checks, and rollback.',
  phases: [
    { title: 'Fix', detail: 'serial bounded fixes with evidence and re-review' },
  ],
}

const {
  pluginRoot,
  workDir,
  baseCommit,
  activeDimensions,
  validCr,
  findings,
  dismissed,
  confirmed,
  rcaByDimension,
  schemas,
} = args

const REGRESSION_SCHEMA = schemas.regression
const MIN_TOKENS_PER_FIX_ROUND = 30000

// Pre-fix: validate evidence bundle integrity
const bundleCheck = await agent(
  `Run node ${pluginRoot}/scripts/evidence-bundle.js validate ${workDir}. Return the JSON output. If valid=false, list the violations.`,
  { label: 'bundle-validate', phase: 'Fix', schema: { type: 'object', properties: { valid: { type: 'boolean' }, violation_count: { type: 'integer' }, violations: { type: 'array', items: { type: 'object' } } }, required: ['valid'] } },
)
if (bundleCheck && !bundleCheck.valid) {
  log(`WARNING: evidence bundle integrity violated (${bundleCheck.violation_count} issues) — fixes may be based on stale context`)
}

// Pre-fix blast radius estimation
const blastRadius = await agent(
  `Run node ${pluginRoot}/scripts/blast-radius.js ${baseCommit} --json. Return the JSON result as-is.`,
  { label: 'blast-radius', phase: 'Fix', schema: { type: 'object', properties: { score: { type: 'integer' }, severity: { type: 'string' }, shouldBlock: { type: 'boolean' }, directFanIn: { type: 'integer' } }, required: ['score', 'severity'] } },
)
if (blastRadius && blastRadius.shouldBlock) {
  log(`⛔ blast radius ${blastRadius.score}/100 (${blastRadius.severity}) exceeds threshold — blocking auto-fix`)
  return { status: 'blocked_by_blast_radius', blastRadius, dimensions: validCr, findings, confirmed, workDir }
}
if (blastRadius) log(`blast radius: ${blastRadius.score}/100 (${blastRadius.severity}), fan-in=${blastRadius.directFanIn}`)

// Initialize per-finding contracts
await agent(
  `Run node ${pluginRoot}/scripts/finding-contract.js init ${workDir}. This creates per-finding repair contracts from confirmed findings.`,
  { label: 'init-contracts', phase: 'Fix' },
)

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
    // Stagnation detection
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

// Post-fix: loop discovery analysis
const loopAnalysis = await agent(
  `Run node ${pluginRoot}/scripts/loop-discovery.js analyze --json. Return the JSON output. If candidates > 0, list them.`,
  { label: 'loop-discovery', phase: 'Fix', schema: { type: 'object', properties: { analyzed: { type: 'integer' }, candidates: { type: 'integer' }, recommendations: { type: 'array' } }, required: ['candidates'] } },
)
if (loopAnalysis && loopAnalysis.candidates > 0) {
  log(`🔄 loop discovery: ${loopAnalysis.candidates} issue(s) qualify for automation promotion`)
}

return {
  status: fixResults.some((result) => result.status === 'blocked') ? 'blocked_by_regression' : 'completed',
  dimensions: validCr,
  findings,
  dismissed,
  confirmed,
  fixResults,
  loopCandidates: loopAnalysis?.candidates || 0,
  workDir,
}
