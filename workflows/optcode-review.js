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

const schemas = { finding: FINDING_SCHEMA, verdict: VERDICT_SCHEMA, regression: REGRESSION_SCHEMA, rca: RCA_SCHEMA }

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

// --- Resume Fix: skip CR, reconstruct findings from existing reports ---
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

  const activeDimensions = resumed.activeDimensions
  const findings = resumed.findings
  const validCr = activeDimensions.map((d) => ({ dimension: d, result: 'needs_fix', reportPath: `${workDir}/cr/${d}-round-1.md`, issueIds: findings.filter((f) => f.dimension === d).map((f) => f.issueId) }))
  log(`resume-fix: reconstructed ${findings.length} findings from ${activeDimensions.length} dimensions`)

  const fixResult = await workflow(
    { scriptPath: `${pluginRoot}/workflows/phases/fix-phase.js` },
    { pluginRoot, workDir, baseCommit, activeDimensions, validCr, findings, dismissed: [], confirmed: findings, rcaByDimension: {}, schemas },
  )
  return fixResult
}

// --- Normal flow: CR → Verify → Fix ---
const crResult = await workflow(
  { scriptPath: `${pluginRoot}/workflows/phases/cr-phase.js` },
  { pluginRoot, workDir, baseCommit, targetPaths, dimensions, mode, singleDimension, maxFindings, schemas },
)

if (crResult.status === 'skipped' || crResult.status === 'blocked_by_gate') return crResult

const verifyResult = await workflow(
  { scriptPath: `${pluginRoot}/workflows/phases/verify-phase.js` },
  { pluginRoot, workDir, baseCommit, mode, fixEnabled, activeDimensions: crResult.activeDimensions, validCr: crResult.validCr, findings: crResult.findings, schemas },
)

if (verifyResult.status === 'pass' || verifyResult.status === 'verification_required' || verifyResult.status === 'all_dismissed' || verifyResult.status === 'review_only') {
  return verifyResult
}

const fixResult = await workflow(
  { scriptPath: `${pluginRoot}/workflows/phases/fix-phase.js` },
  { pluginRoot, workDir, baseCommit, activeDimensions: verifyResult.activeDimensions, validCr: verifyResult.validCr, findings: verifyResult.findings, dismissed: verifyResult.dismissed, confirmed: verifyResult.confirmed, rcaByDimension: verifyResult.rcaByDimension, schemas },
)
return fixResult
