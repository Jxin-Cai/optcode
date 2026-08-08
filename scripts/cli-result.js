const { CLI_EXIT_CODES, classify } = require('./error-codes.js');

function success(payload = {}) {
  return { ok: true, ...payload };
}

function failure(error, fallbackCode = 'E_COMMAND_FAILED', payload = {}) {
  const classified = classify(error);
  const code = classified.code === 'UNKNOWN' ? fallbackCode : classified.code;
  const message = error?.message || classified.message || String(error || 'command failed');
  return { ok: false, code, message, ...payload };
}

function exitCodeFor(result) {
  if (result?.ok) return CLI_EXIT_CODES.OK;
  if (result?.code === 'E_USAGE') return CLI_EXIT_CODES.USAGE;
  if (['E_STATE_MISSING', 'E_STATE_CORRUPT', 'E_STORE_CORRUPT', 'E_BUNDLE_MISSING', 'E_BUNDLE_INVALID', 'E_BUNDLE_TAMPERED', 'E_BUNDLE_VERSION_UNSUPPORTED'].includes(result?.code)) {
    return CLI_EXIT_CODES.INVALID_STATE;
  }
  if (result?.code === 'E_BUNDLE_DRIFTED') return CLI_EXIT_CODES.DRIFT;
  return CLI_EXIT_CODES.FAILURE;
}

function writeJsonResult(result, stream = result?.ok ? process.stdout : process.stderr) {
  stream.write(`${JSON.stringify(result, null, 2)}\n`);
  return exitCodeFor(result);
}

function guardCli(callback, options = {}) {
  try {
    return callback();
  } catch (error) {
    const result = failure(error, options.fallbackCode);
    process.exitCode = writeJsonResult(result, options.stream || process.stderr);
    return result;
  }
}

module.exports = { success, failure, exitCodeFor, writeJsonResult, guardCli };
