#!/usr/bin/env node
/**
 * Findings catalog lookup — resolves finding IDs/aliases to canonical templates.
 *
 * Usage:
 *   node findings-catalog.js lookup <id-or-alias>
 *   node findings-catalog.js list [dimension]
 *   node findings-catalog.js enrich <id> <severity-override>
 */
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const CATALOG_PATH = join(__dirname, 'findings-catalog.json');

function loadCatalog() {
  const raw = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  const aliasIndex = {};
  for (const [id, entry] of Object.entries(raw.findings)) {
    aliasIndex[id] = id;
    for (const alias of entry.aliases || []) {
      aliasIndex[alias] = id;
    }
  }
  return { findings: raw.findings, aliasIndex };
}

function lookup(idOrAlias) {
  const { findings, aliasIndex } = loadCatalog();
  const canonicalId = aliasIndex[idOrAlias] || aliasIndex[idOrAlias.toLowerCase()];
  if (!canonicalId) return null;
  return findings[canonicalId] || null;
}

function list(dimension) {
  const { findings } = loadCatalog();
  const entries = Object.values(findings);
  if (dimension) return entries.filter(e => e.id.startsWith(`${dimension}:`));
  return entries;
}

function enrich(id, overrides = {}) {
  const template = lookup(id);
  if (!template) return null;
  return { ...template, ...overrides };
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) {
    process.stderr.write('用法: node findings-catalog.js <lookup|list|enrich> [...args]\n');
    process.exit(1);
  }
  switch (cmd) {
    case 'lookup': {
      const result = lookup(rest[0]);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'list': {
      const result = list(rest[0]);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'enrich': {
      const result = enrich(rest[0], rest[1] ? { severity: rest[1] } : {});
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { loadCatalog, lookup, list, enrich };
