export const meta = {
  name: 'optcode-review',
  description: 'Multi-dimension code review with adversarial verification and regression-safe fixes',
  whenToUse: 'When /optcode is invoked to review code across multiple quality dimensions in parallel',
  phases: [
    { title: 'Activate', detail: 'determine which dimensions apply to the target code' },
    { title: 'CR', detail: 'parallel read-only code review per dimension' },
    { title: 'Verify', detail: 'adversarial verification of each finding' },
    { title: 'Fix', detail: 'serial fixes with regression checks' },
  ],
}

const FINDING_SCHEMA = {
  type: 'object',
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
  properties: {
    issueId: { type: 'string' },
    verdict: { type: 'string', enum: ['TRUE_POSITIVE', 'FALSE_POSITIVE', 'UNCERTAIN'] },
    confidence: { type: 'integer' },
    reasoning: { type: 'string' },
  },
  required: ['issueId', 'verdict', 'confidence'],
}

const REGRESSION_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['NO_REGRESSION', 'REGRESSION_FOUND', 'UNCERTAIN'] },
    issues: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict'],
}

// --- Args ---
const normalizedArgs = typeof args === 'string' ? (() => { try { return JSON.parse(args) } catch { return args } })() : args
const { pluginRoot, workDir, targetPaths = [], dimensions = [], mode = 'light' } = normalizedArgs ?? {}
if (!pluginRoot || !workDir) throw new Error('args.pluginRoot and args.workDir are required')

// --- Phase: Activate ---
log(`Starting optcode review: ${dimensions.length || 'auto'} dimensions, mode=${mode}`)

const activeDims = dimensions.length > 0
  ? dimensions
  : await agent(
      `Run: node ${pluginRoot}/scripts/cr-activation-check.js ${workDir}
       Parse the JSON output and return the "activated" array as a plain JSON array of dimension name strings.`,
      { label: 'activate', phase: 'Activate', schema: { type: 'array', items: { type: 'string' } } }
    )

if (!activeDims || activeDims.length === 0) {
  log('No dimensions activated — nothing to review')
  return { status: 'skipped', reason: 'no dimensions activated' }
}
log(`Activated ${activeDims.length} dimensions: ${activeDims.join(', ')}`)

// --- Phase: CR (parallel, read-only) ---
const crResults = await parallel(activeDims.map(dim => () => agent(
  `You are reviewing dimension "${dim}".
Read the dimension perspective: ${pluginRoot}/dimensions/${dim}.md
Read the file inventory: ${workDir}/file-inventory.md
Read each target file listed in the inventory.

Write exactly ONE report to: ${workDir}/cr/${dim}-round-1.md
Follow the CR report template format with YAML frontmatter (dimension, round, result, issues_count).
List each issue as ### ISSUE-001, ISSUE-002, etc.

Do NOT modify any business code, state.json, or audit-log.jsonl.
Target paths context: ${JSON.stringify(targetPaths)}

Return: dimension name, result (pass/needs_fix/failed), report path, and array of issue IDs found.`,
  { label: `cr:${dim}`, phase: 'CR', schema: FINDING_SCHEMA }
)))

const findings = crResults.filter(Boolean)
const needsFix = findings.filter(f => f.result === 'needs_fix')
const allIssueIds = needsFix.flatMap(f => f.issueIds ?? [])
log(`CR complete: ${findings.length} dimensions reviewed, ${allIssueIds.length} issues found across ${needsFix.length} dimensions`)

if (allIssueIds.length === 0) {
  log('All dimensions pass — no fixes needed')
  return { status: 'pass', dimensions: findings }
}

// --- Phase: Verify (parallel, read-only, adversarial) ---
let confirmedIssues = allIssueIds

if (budget.remaining() > 80000 && allIssueIds.length > 0) {
  const verdicts = await parallel(allIssueIds.map(issueId => () => agent(
    `Adversarially verify finding ${issueId}.
Read the CR report that contains this issue and the source code it references.
Your default stance is SKEPTICAL — actively search for evidence that REFUTES the claim.
Write your verdict report to: ${workDir}/verification/${issueId}.md

Check for: indirect references, framework conventions, public API usage, test coverage, dynamic calls.
Only mark TRUE_POSITIVE if you independently confirm the problem exists.
Mark FALSE_POSITIVE if you find refuting evidence.
Mark UNCERTAIN if you cannot determine either way (it will be conservatively kept).`,
    { label: `verify:${issueId}`, phase: 'Verify', schema: VERDICT_SCHEMA }
  )))

  const valid = verdicts.filter(Boolean)
  const falsePositives = valid.filter(v => v.verdict === 'FALSE_POSITIVE').map(v => v.issueId)
  confirmedIssues = allIssueIds.filter(id => !falsePositives.includes(id))
  log(`Verification: ${valid.length} checked, ${falsePositives.length} dismissed as false positives, ${confirmedIssues.length} confirmed`)
} else {
  log('Skipping verification (budget constraint or no issues) — all findings treated as confirmed')
}

if (confirmedIssues.length === 0) {
  log('All findings dismissed by verification')
  return { status: 'pass_after_verification', dimensions: findings, dismissed: allIssueIds }
}

// --- Phase: Fix (serial per dimension, with regression check) ---
const fixResults = []
for (const dimResult of needsFix) {
  const dim = dimResult.dimension
  const dimIssues = (dimResult.issueIds ?? []).filter(id => confirmedIssues.includes(id))
  if (dimIssues.length === 0) continue

  log(`Fixing ${dim}: ${dimIssues.length} confirmed issues`)

  await agent(
    `Fix the confirmed issues in dimension "${dim}".
Read the CR report: ${dimResult.reportPath}
Only fix issues: ${dimIssues.join(', ')}
Write your fix report to: ${workDir}/fix/${dim}-round-1.md

You MAY modify business code to fix the reported issues.
Do NOT modify state.json or audit-log.jsonl.
Do NOT fix issues that were not in your assigned list.`,
    { label: `fix:${dim}`, phase: 'Fix' }
  )

  const regression = await agent(
    `Check for regressions after fixing dimension "${dim}".
Read the fix report: ${workDir}/fix/${dim}-round-1.md
Inspect ONLY the files and symbols mentioned in that fix report.
Write your check to: ${workDir}/regression/${dim}-round-1.md

Check for: removed error handling, changed signatures, new dead code, control flow changes, cross-dimension regressions.
Report NO_REGRESSION if the fix is safe, REGRESSION_FOUND if you find problems.`,
    { label: `regress:${dim}`, phase: 'Fix', schema: REGRESSION_SCHEMA }
  )

  if (regression && regression.verdict !== 'NO_REGRESSION') {
    log(`REGRESSION detected in ${dim}: ${regression.verdict} — stopping fix loop`)
    fixResults.push({ dimension: dim, fixed: false, regression: regression.verdict })
    break
  }
  fixResults.push({ dimension: dim, fixed: true })
}

return {
  status: fixResults.some(r => !r.fixed) ? 'blocked_by_regression' : 'completed',
  dimensions: findings,
  confirmedIssues,
  fixResults,
}
