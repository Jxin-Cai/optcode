/**
 * optcode typed error codes — machine-parseable error classification.
 *
 * Every error carries a code for automated retry/escalation decisions:
 *   - E_* prefix: errors (non-recoverable without intervention)
 *   - W_* prefix: warnings (recoverable, may degrade quality)
 *   - R_* prefix: retryable (transient failures, safe to retry)
 */

const ERROR_CODES = Object.freeze({
  // State errors
  E_STATE_MISSING: { retryable: false, category: 'state', message: 'state.json not found or uninitialized' },
  E_STATE_CORRUPT: { retryable: false, category: 'state', message: 'state.json is corrupt and no valid backup exists' },
  E_OCC_CONFLICT: { retryable: true, category: 'state', message: 'optimistic concurrency conflict on state write' },

  // Evidence bundle errors
  E_BUNDLE_MISSING: { retryable: false, category: 'evidence', message: 'evidence bundle not found' },
  E_BUNDLE_TAMPERED: { retryable: false, category: 'evidence', message: 'evidence bundle integrity hash mismatch' },
  E_BUNDLE_DRIFTED: { retryable: false, category: 'evidence', message: 'workspace drifted since evidence bundle was frozen' },

  // Fix errors
  E_FIX_LOCK_TIMEOUT: { retryable: true, category: 'fix', message: 'could not acquire fix report lock within timeout' },
  E_FIX_REVISION_CONFLICT: { retryable: true, category: 'fix', message: 'fix report revision mismatch (stale agent)' },
  E_FIX_REGRESSION: { retryable: false, category: 'fix', message: 'fix introduced a regression' },
  E_FIX_BLOCKED: { retryable: false, category: 'fix', message: 'fix is blocked and cannot proceed' },

  // Gate errors
  E_GATE_FAILED: { retryable: false, category: 'gate', message: 'postcondition gate check failed' },
  E_QUALITY_REJECTED: { retryable: false, category: 'gate', message: 'report quality gate rejected the output' },
  E_PRIVACY_VIOLATION: { retryable: false, category: 'gate', message: 'privacy-sensitive content detected in output' },

  // Validation errors
  E_SYNTHETIC_EVIDENCE: { retryable: false, category: 'validation', message: 'fabricated file/symbol references detected' },
  E_POPULATION_MISMATCH: { retryable: false, category: 'validation', message: 'claimed finding count does not match actual' },
  E_CONSISTENCY_VIOLATION: { retryable: false, category: 'validation', message: 'score-finding bidirectional consistency violated' },

  // Resource errors
  E_FILE_MISSING: { retryable: false, category: 'resource', message: 'required file not found' },
  E_DIR_MISSING: { retryable: false, category: 'resource', message: 'required directory not found' },
  R_GIT_FAILED: { retryable: true, category: 'resource', message: 'git command failed (possibly transient)' },

  // Budget errors
  E_BUDGET_EXHAUSTED: { retryable: false, category: 'budget', message: 'token budget exhausted' },
  W_BUDGET_LOW: { retryable: false, category: 'budget', message: 'token budget running low, reducing scope' },

  // Workflow errors
  E_DIMENSION_EXCEEDED: { retryable: false, category: 'workflow', message: 'dimension exceeded maximum round count' },
  E_STAGNATION: { retryable: false, category: 'workflow', message: 'fix loop stagnation detected' },
  E_BLAST_RADIUS: { retryable: false, category: 'workflow', message: 'blast radius exceeds auto-fix threshold' },
});

function createError(code, details = {}) {
  const spec = ERROR_CODES[code];
  if (!spec) throw new Error(`unknown error code: ${code}`);
  const err = new Error(details.message || spec.message);
  err.code = code;
  err.category = spec.category;
  err.retryable = spec.retryable;
  Object.assign(err, details);
  return err;
}

function isRetryable(err) {
  if (!err || !err.code) return false;
  const spec = ERROR_CODES[err.code];
  return spec ? spec.retryable : false;
}

function classify(err) {
  if (!err) return { code: 'UNKNOWN', category: 'unknown', retryable: false };
  if (err.code && ERROR_CODES[err.code]) {
    const spec = ERROR_CODES[err.code];
    return { code: err.code, ...spec };
  }
  if (err.message?.includes('OCC conflict')) return { code: 'E_OCC_CONFLICT', ...ERROR_CODES.E_OCC_CONFLICT };
  if (err.message?.includes('ENOENT')) return { code: 'E_FILE_MISSING', ...ERROR_CODES.E_FILE_MISSING };
  if (err.message?.includes('acquireLock timeout')) return { code: 'E_FIX_LOCK_TIMEOUT', ...ERROR_CODES.E_FIX_LOCK_TIMEOUT };
  return { code: 'UNKNOWN', category: 'unknown', retryable: false, message: err.message };
}

module.exports = { ERROR_CODES, createError, isRetryable, classify };
