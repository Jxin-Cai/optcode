#!/usr/bin/env node
/**
 * Thin, shell-free command facade for optcode's executable capabilities.
 * The registry in cli-schema.js is the single source of command discovery.
 */
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { COMMANDS, buildSchema } = require('./cli-schema.js');
const { CLI_EXIT_CODES } = require('./error-codes.js');

const EXIT_USAGE = CLI_EXIT_CODES.USAGE;

function requestedAudience(args) {
  if (args.includes('--all')) return 'maintainer';
  const index = args.indexOf('--audience');
  return index >= 0 ? args[index + 1] : 'workflow';
}

function printHelp(args = []) {
  let schema;
  try {
    schema = buildSchema(requestedAudience(args));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return EXIT_USAGE;
  }

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
    return 0;
  }

  process.stdout.write('Usage: optcode <command> [args]\n\n');
  process.stdout.write(`Commands (${schema.audience}):\n`);
  const width = Math.max(...schema.commands.map(command => command.name.length), 0);
  for (const command of schema.commands) {
    process.stdout.write(`  ${command.name.padEnd(width)}  ${command.description}\n`);
  }
  process.stdout.write('\nUse "optcode help --all" for maintainer commands or "optcode help --json" for machine-readable output.\n');
  return 0;
}

function dispatch(commandName, args) {
  const command = COMMANDS.find(candidate => candidate.name === commandName);
  if (!command) {
    process.stderr.write(`Unknown command: ${commandName}\nRun "optcode help" to list commands.\n`);
    return EXIT_USAGE;
  }

  const result = spawnSync(process.execPath, [join(__dirname, command.script), ...args], {
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) {
    process.stderr.write(`Failed to run ${commandName}: ${result.error.message}\n`);
    return 1;
  }
  if (result.signal) {
    process.stderr.write(`${commandName} terminated by signal ${result.signal}\n`);
    return 1;
  }
  return result.status ?? 1;
}

function main(args = process.argv.slice(2)) {
  const [commandName, ...rest] = args;
  if (!commandName || commandName === 'help' || commandName === '--help' || commandName === '-h') {
    return printHelp(commandName === 'help' ? rest : args.slice(1));
  }
  return dispatch(commandName, rest);
}

if (require.main === module) process.exitCode = main();

module.exports = { EXIT_USAGE, requestedAudience, printHelp, dispatch, main };
