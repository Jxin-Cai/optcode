#!/usr/bin/env node
/**
 * optcode CR activation check — determines which dimensions to activate
 * based on target code content analysis.
 *
 * Usage: node cr-activation-check.js <work-dir>
 * Output: JSON with activated dimensions, skipped dimensions, and reasons.
 *
 * Dimensions with `always: true` are always activated.
 * Dimensions with keyword conditions are activated only if any keyword
 * appears in the file inventory content.
 */
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { DIMENSIONS, DIMENSION_ACTIVATION, readState } = require('./workflow-lib.js');

const workDir = process.argv[2];

if (!workDir) {
  process.stderr.write('用法: node cr-activation-check.js <work-dir>\n');
  process.exit(1);
}

function loadFileContents(workDir) {
  const state = readState(workDir);
  if (!state || !state.target_paths) return '';

  // Read file-inventory to get file list
  const inventoryPath = join(workDir, 'file-inventory.md');
  if (!existsSync(inventoryPath)) return '';

  const inventory = readFileSync(inventoryPath, 'utf8');
  // Extract file paths from the markdown table
  const files = [];
  for (const match of inventory.matchAll(/\|\s*\d+\s*\|\s*([^\s|]+)\s*\|/g)) {
    files.push(match[1]);
  }

  // Sample content from files (read first 200 lines of each, up to 50 files)
  const sampled = files.slice(0, 50);
  const contents = [];
  for (const file of sampled) {
    try {
      if (existsSync(file)) {
        const text = readFileSync(file, 'utf8');
        // Take first 200 lines to avoid reading huge files
        contents.push(text.split('\n').slice(0, 200).join('\n'));
      }
    } catch {
      // Skip unreadable files
    }
  }
  return contents.join('\n');
}

function checkActivation(dimension, content) {
  const config = DIMENSION_ACTIVATION[dimension];
  if (!config) return { activated: true, reason: 'no activation config (default active)' };
  if (config.always) return { activated: true, reason: 'always active' };

  if (config.keywords && config.keywords.length > 0) {
    const found = config.keywords.filter(kw => content.includes(kw));
    if (found.length > 0) {
      return { activated: true, reason: `keywords found: ${found.slice(0, 5).join(', ')}` };
    }
    return { activated: false, reason: `no activation keywords found (checked: ${config.keywords.slice(0, 5).join(', ')}...)` };
  }

  return { activated: true, reason: 'no conditions to check' };
}

function main() {
  const state = readState(workDir);
  if (!state) {
    process.stderr.write('state.json not found\n');
    process.exit(1);
  }

  const content = loadFileContents(workDir);
  const results = {
    activated: [],
    skipped: [],
    skip_reasons: {},
    activation_details: {}
  };

  for (const dim of DIMENSIONS) {
    // Respect already-skipped dimensions
    if (state.dimensions[dim] && state.dimensions[dim].status === 'skipped') {
      results.skipped.push(dim);
      results.skip_reasons[dim] = 'explicitly skipped by user';
      results.activation_details[dim] = { activated: false, reason: 'explicitly skipped by user' };
      continue;
    }

    const check = checkActivation(dim, content);
    results.activation_details[dim] = check;

    if (check.activated) {
      results.activated.push(dim);
    } else {
      results.skipped.push(dim);
      results.skip_reasons[dim] = check.reason;
    }
  }

  console.log(JSON.stringify(results, null, 2));
}

main();
