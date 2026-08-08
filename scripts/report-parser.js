/**
 * Canonical parser for OptCode report findings.
 * Keeps ISSUE heading, block-boundary, field, and qualified-id semantics in
 * one place so gates and downstream analytics cannot disagree.
 */

function parseIssueHeading(headingText) {
  const match = String(headingText || '').trim().match(/^(?:([A-Za-z][\w-]*):)?(ISSUE-\d+)(?::\s*(.*))?$/);
  if (!match) return null;
  return { dimension: match[1] || null, issue_id: match[2], title: (match[3] || '').trim() };
}

function parseIssueField(block, label) {
  const escaped = String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(block || '').match(new RegExp(`^(?:[-*]\\s*)?\\*\\*${escaped}\\*\\*:\\s*(.*?)\\s*$`, 'm'));
  if (!match) return null;
  const value = match[1].trim();
  return value.startsWith('`') && value.endsWith('`') ? value.slice(1, -1) : value;
}

function parseFields(block) {
  const fields = {};
  const pattern = /^(?:[-*]\s*)?\*\*([^*]+)\*\*:\s*(.*?)\s*$/gm;
  for (const match of String(block || '').matchAll(pattern)) {
    const value = match[2].trim();
    fields[match[1].trim()] = value.startsWith('`') && value.endsWith('`') ? value.slice(1, -1) : value;
  }
  return fields;
}

function splitIssueBlocks(text) {
  const source = String(text || '');
  const headings = [...source.matchAll(/^(#{1,6})[ \t]+(.+?)\s*$/gm)].map(match => ({
    index: match.index,
    level: match[1].length,
    heading: match[2],
    issue: parseIssueHeading(match[2]),
  }));
  const blocks = [];
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index];
    if (!heading.issue) continue;
    const nextBoundary = headings.slice(index + 1).find(candidate => candidate.level <= heading.level);
    const end = nextBoundary ? nextBoundary.index : source.length;
    const block = source.slice(heading.index, end);
    blocks.push({
      ...heading.issue,
      heading_level: heading.level,
      qualified_id: heading.issue.dimension
        ? `${heading.issue.dimension}:${heading.issue.issue_id}`
        : heading.issue.issue_id,
      block,
      fields: parseFields(block),
      start: heading.index,
      end,
    });
  }
  return blocks;
}

function parseCrFindings(text, options = {}) {
  const fallbackDimension = options.dimension || 'unknown';
  return splitIssueBlocks(text).map(issue => {
    const dimension = issue.dimension || fallbackDimension;
    return {
      ...issue,
      dimension,
      id: `${dimension}:${issue.issue_id}`,
      source_report: options.sourceReport || null,
      file: issue.fields['文件'] || null,
      location: issue.fields['位置'] || null,
      description: issue.fields['问题描述'] || null,
      fix_proposal: issue.fields['修复方案'] || null,
      severity: issue.fields['严重程度'] || null,
      confidence: issue.fields['置信度'] || null,
    };
  });
}

function countIssueRows(text) {
  return [...String(text || '').matchAll(/^\|\s*(?:[A-Za-z][\w-]*:)?ISSUE-\d+\s*\|/gm)].length;
}

module.exports = { parseIssueHeading, parseIssueField, parseFields, splitIssueBlocks, parseCrFindings, countIssueRows };
