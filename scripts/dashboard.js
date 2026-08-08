#!/usr/bin/env node
/**
 * dashboard.js — Unified observation dashboard for optcode.
 * Combines health score trends + tech debt assessment into a single artifact.
 *
 * Usage:
 *   node dashboard.js generate <work-dir>   # Generate dashboard after a run
 *   node dashboard.js open <work-dir>       # Print existing dashboard to stdout
 *   node dashboard.js history               # Show cross-run trend summary
 */
const { existsSync, readFileSync, writeFileSync, renameSync, readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { readState } = require('./workflow-lib.js');
const { parseCrFindings } = require('./report-parser.js');
const { readJsonFile, writeJsonFile } = require('./safe-json-store.js');
const { guardCli } = require('./cli-result.js');

// ─── Health History (cross-run) ───────────────────────────────────────────────

function historyFile(projectRoot) {
  return join(projectRoot, '.optcode', 'health-history.json');
}

function loadHistory(projectRoot) {
  return readJsonFile(historyFile(projectRoot), { defaultValue: [], validate: Array.isArray });
}

function saveHistory(projectRoot, history) {
  writeJsonFile(historyFile(projectRoot), history, { validate: Array.isArray });
}

function recordHistory(projectRoot, workDir, gateOutput, state) {
  const history = loadHistory(projectRoot);
  const runKey = resolve(projectRoot, workDir);
  const existingIndex = history.findIndex(item =>
    item && typeof item.run_dir === 'string' && resolve(projectRoot, item.run_dir) === runKey
  );
  const entry = {
    timestamp: existingIndex >= 0 ? history[existingIndex].timestamp : new Date().toISOString(),
    run_dir: workDir,
    score: gateOutput.score,
    verdict: gateOutput.verdict,
    active_dimensions: gateOutput.active_dimensions,
    breakdown: {},
    target_paths: state.target_paths || [],
    mode: state.mode || 'light'
  };
  for (const [dim, info] of Object.entries(gateOutput.breakdown)) {
    entry.breakdown[dim] = { score: info.score, status: info.status };
  }
  if (existingIndex >= 0) history[existingIndex] = entry;
  else history.push(entry);
  saveHistory(projectRoot, history);
  return entry;
}

// ─── Tech Debt Analysis (per-run) ────────────────────────────────────────────

const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1 };
const RISK_ORDER = ['safe', 'local', 'structural', 'behavior-risk'];

function parseCrReports(workDir) {
  const crDir = join(workDir, 'cr');
  if (!existsSync(crDir)) return [];
  const reports = readdirSync(crDir).filter(f => f.endsWith('.md') && !f.endsWith('.mmd'));
  const issues = [];

  for (const report of reports) {
    const content = readFileSync(join(crDir, report), 'utf8');
    const dimMatch = content.match(/^dimension:\s*(.+)$/m);
    const dimension = dimMatch ? dimMatch[1].trim() : 'unknown';
    for (const finding of parseCrFindings(content, { dimension, sourceReport: report })) {
      const decayRisk = (finding.fields['衰变风险'] || '').match(/^(low|medium|high)\s*[—-]\s*(.+)/);
      issues.push({
        title: finding.title,
        dimension: finding.dimension,
        severity: finding.severity || 'medium',
        risk: finding.fields['修复风险'] || 'local',
        file: finding.file || 'unknown',
        location: finding.location || '',
        weight: SEVERITY_WEIGHT[finding.severity || 'medium'] || 1,
        decay_risk: decayRisk?.[1] || null,
        decay_reason: decayRisk?.[2] || null
      });
    }
  }
  return issues;
}

function computeHotspots(issues) {
  const byFile = {};
  for (const issue of issues) {
    if (!byFile[issue.file]) byFile[issue.file] = { count: 0, weight: 0, types: new Set() };
    byFile[issue.file].count++;
    byFile[issue.file].weight += issue.weight;
    byFile[issue.file].types.add(issue.dimension);
  }
  return Object.entries(byFile)
    .map(([file, data]) => ({ file, count: data.count, weight: data.weight, types: [...data.types] }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 10);
}

function computeDimensionHealth(issues) {
  const byDim = {};
  for (const issue of issues) {
    if (!byDim[issue.dimension]) byDim[issue.dimension] = { count: 0, weight: 0 };
    byDim[issue.dimension].count++;
    byDim[issue.dimension].weight += issue.weight;
  }
  return Object.entries(byDim)
    .map(([dim, data]) => ({ dimension: dim, count: data.count, weight: data.weight }))
    .sort((a, b) => b.weight - a.weight);
}

// ─── Dashboard Generation ────────────────────────────────────────────────────

function renderTrendSection(projectRoot, currentRunDir) {
  const history = loadHistory(projectRoot);
  if (history.length === 0) return '';

  const n = Math.min(10, history.length);
  const recent = history.slice(-n);
  const bars = '▁▂▃▄▅▆▇█';
  const scores = recent.map(r => r.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || 1;
  const sparkline = scores.map(s => {
    const idx = Math.round(((s - min) / range) * (bars.length - 1));
    return bars[idx];
  }).join('');

  let md = `## 健康分趋势\n\n`;
  md += `\`${sparkline}\` [${Math.round(min)}..${Math.round(max)}]\n\n`;

  // Trend detection
  if (recent.length >= 3) {
    const last3 = scores.slice(-3);
    const slope = (last3[2] - last3[0]) / 2;
    let trend;
    if (slope > 2) trend = 'improving';
    else if (slope < -2) trend = 'declining';
    else trend = 'stable';
    md += `**趋势**: ${trend} (delta=${slope > 0 ? '+' : ''}${slope.toFixed(1)})\n\n`;
  }

  // History table
  md += `| 时间 | 得分 | 判定 | 模式 | 目标 |\n`;
  md += `|------|------|------|------|------|\n`;
  for (const r of recent) {
    const date = r.timestamp.slice(0, 16).replace('T', ' ');
    const isCurrent = r.run_dir === currentRunDir ? ' **←**' : '';
    const target = (r.target_paths || []).join(', ').slice(0, 30) || '-';
    md += `| ${date} | ${r.score} | ${r.verdict}${isCurrent} | ${r.mode} | ${target} |\n`;
  }
  md += `\n`;

  // Dimension status changes (last vs prev)
  if (recent.length >= 2) {
    const prev = recent[recent.length - 2];
    const curr = recent[recent.length - 1];
    const changes = [];
    for (const dim of Object.keys(curr.breakdown || {})) {
      const prevStatus = prev.breakdown?.[dim]?.status;
      const currStatus = curr.breakdown?.[dim]?.status;
      if (prevStatus && currStatus && prevStatus !== currStatus) {
        changes.push(`| ${dim} | ${prevStatus} | ${currStatus} |`);
      }
    }
    if (changes.length > 0) {
      md += `### 维度状态变化（vs 上次）\n\n`;
      md += `| 维度 | 上次 | 本次 |\n`;
      md += `|------|------|------|\n`;
      md += changes.join('\n') + '\n\n';
    }
  }

  return md;
}

function renderDebtSection(issues) {
  if (issues.length === 0) return `## 技术债务\n\n无问题发现。\n\n`;

  const hotspots = computeHotspots(issues);
  const dimHealth = computeDimensionHealth(issues);
  const sevDist = { high: 0, medium: 0, low: 0 };
  const riskDist = { safe: 0, local: 0, structural: 0, 'behavior-risk': 0 };
  for (const i of issues) {
    sevDist[i.severity]++;
    riskDist[i.risk] = (riskDist[i.risk] || 0) + 1;
  }

  let md = `## 技术债务\n\n`;
  md += `| 指标 | 值 |\n`;
  md += `|------|----|\n`;
  md += `| 总问题数 | ${issues.length} |\n`;
  md += `| 加权总分 | ${issues.reduce((s, i) => s + i.weight, 0)} |\n`;
  md += `| 严重度 | high=${sevDist.high} medium=${sevDist.medium} low=${sevDist.low} |\n`;
  md += `| 修复风险 | safe=${riskDist.safe} local=${riskDist.local} structural=${riskDist.structural} behavior-risk=${riskDist['behavior-risk']} |\n\n`;

  // Hotspots
  if (hotspots.length > 0) {
    md += `### 热区文件\n\n`;
    md += `| # | 文件 | 问题数 | 加权 | 维度 |\n`;
    md += `|---|------|--------|------|------|\n`;
    for (let i = 0; i < Math.min(5, hotspots.length); i++) {
      const h = hotspots[i];
      md += `| ${i + 1} | \`${h.file}\` | ${h.count} | ${h.weight} | ${h.types.join(', ')} |\n`;
    }
    md += `\n`;
  }

  // Dimension health
  md += `### 维度健康\n\n`;
  md += `| 维度 | 问题数 | 加权 |\n`;
  md += `|------|--------|------|\n`;
  for (const d of dimHealth) {
    md += `| ${d.dimension} | ${d.count} | ${d.weight} |\n`;
  }
  md += `\n`;

  // Roadmap
  md += `### 偿还路线图\n\n`;
  const phases = {
    safe: { label: 'Phase 1: Quick Wins', effort: '低', risk_level: '极低', items: [] },
    local: { label: 'Phase 2: Local Refactoring', effort: '中', risk_level: '低', items: [] },
    structural: { label: 'Phase 3: Structural', effort: '高', risk_level: '中', items: [] },
    'behavior-risk': { label: 'Deferred: High Risk', effort: '高', risk_level: '高', items: [] }
  };
  for (const issue of issues) {
    (phases[issue.risk] || phases['local']).items.push(issue);
  }
  for (const phase of Object.values(phases)) {
    phase.items.sort((a, b) => b.weight - a.weight);
  }

  for (const key of RISK_ORDER) {
    const phase = phases[key];
    if (phase.items.length === 0) continue;
    md += `#### ${phase.label}\n\n`;
    md += `投入: ${phase.effort} | 风险: ${phase.risk_level}\n\n`;
    for (const item of phase.items) {
      md += `- [ ] **[${item.severity}]** ${item.title} — \`${item.file}\` (${item.dimension})\n`;
    }
    md += `\n`;
  }

  // Decay highlights
  const decaying = issues.filter(i => i.decay_risk === 'high');
  if (decaying.length > 0) {
    md += `### 高衰变风险\n\n`;
    for (const d of decaying) {
      md += `- **${d.title}** (\`${d.file}\`) — ${d.decay_reason || '指数级恶化风险'}\n`;
    }
    md += `\n`;
  }

  return md;
}

function generateDashboard(projectRoot, workDir) {
  const state = readState(workDir);
  if (!state) {
    process.stderr.write('state.json not found\n');
    process.exit(1);
  }

  // Run quality gate to get current scores
  const { execFileSync } = require('node:child_process');
  let gateOutput;
  try {
    const raw = execFileSync(process.execPath, [join(__dirname, 'quality-gate.js'), workDir, '--no-history'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    gateOutput = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`Failed to run quality-gate: ${e.message}\n`);
    process.exit(1);
  }

  const issues = parseCrReports(workDir);
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');

  // ─── Render Dashboard ───
  let md = `# OptCode 观测仪表盘\n\n`;
  md += `> 生成时间: ${timestamp}  \n`;
  md += `> 运行目录: \`${workDir}\`  \n`;
  md += `> 目标路径: ${(state.target_paths || []).join(', ')}  \n`;
  md += `> 模式: ${state.mode || 'light'}\n\n`;

  // Current score card
  md += `## 质量评分\n\n`;
  md += `| 判定 | 得分 | 活跃维度 | 阈值 |\n`;
  md += `|------|------|----------|------|\n`;
  md += `| **${gateOutput.verdict}** | **${gateOutput.score}** / 100 | ${gateOutput.active_dimensions} | PASS≥80, WARN≥50 |\n\n`;

  // Per-dimension breakdown
  md += `### 维度明细\n\n`;
  md += `| 维度 | 得分 | 状态 | 发现 | 修复 | 修复率 |\n`;
  md += `|------|------|------|------|------|--------|\n`;
  for (const [dim, info] of Object.entries(gateOutput.breakdown)) {
    if (info.status === 'skipped') continue;
    md += `| ${dim} | ${info.score} | ${info.status} | ${info.issues_found} | ${info.issues_fixed} | ${info.fix_rate} |\n`;
  }
  md += `\n`;

  // Trend section (cross-run)
  md += renderTrendSection(projectRoot, workDir);

  // Debt section (this run)
  md += renderDebtSection(issues);

  // Architecture diagram reference
  const archDiagram = join(workDir, 'cr', 'arch-diagram.mmd');
  if (existsSync(archDiagram)) {
    md += `## 架构图\n\n`;
    md += '```mermaid\n';
    md += readFileSync(archDiagram, 'utf8').trim();
    md += '\n```\n\n';
  }

  return { md, gateOutput };
}

function generate(projectRoot, workDir) {
  const { md } = generateDashboard(projectRoot, workDir);

  const outputPath = join(workDir, 'dashboard.md');
  const tmp = outputPath + '.tmp.' + process.pid;
  writeFileSync(tmp, md, 'utf8');
  renameSync(tmp, outputPath);

  console.log(outputPath);
}

function open(workDir) {
  const dashPath = join(workDir, 'dashboard.md');
  if (!existsSync(dashPath)) {
    process.stderr.write(`Dashboard not found: ${dashPath}\nRun 'dashboard.js generate <work-dir>' first.\n`);
    process.exit(1);
  }
  console.log(readFileSync(dashPath, 'utf8'));
}

function showHistory(projectRoot) {
  const history = loadHistory(projectRoot);
  if (history.length === 0) {
    console.log('No history records. Run a full optcode review first.');
    return;
  }

  const n = Math.min(10, history.length);
  const recent = history.slice(-n);
  const bars = '▁▂▃▄▅▆▇█';
  const scores = recent.map(r => r.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || 1;
  const sparkline = scores.map(s => {
    const idx = Math.round(((s - min) / range) * (bars.length - 1));
    return bars[idx];
  }).join('');

  console.log(`\n  走势: ${sparkline}  [${Math.round(min)}..${Math.round(max)}]`);
  console.log(`  最新: ${scores[scores.length - 1]} (${recent[recent.length - 1].verdict})\n`);

  if (recent.length >= 3) {
    const last3 = scores.slice(-3);
    const slope = (last3[2] - last3[0]) / 2;
    let trend;
    if (slope > 2) trend = 'improving';
    else if (slope < -2) trend = 'declining';
    else trend = 'stable';
    console.log(`  趋势: ${trend} (delta=${slope > 0 ? '+' : ''}${slope.toFixed(1)})\n`);
  }

  for (const r of recent) {
    const date = r.timestamp.slice(0, 16).replace('T', ' ');
    const bar = '█'.repeat(Math.round(r.score / 5));
    console.log(`  ${date} | ${String(r.score).padStart(5)} | ${r.verdict.padEnd(4)} | ${bar}`);
  }
  console.log('');
}

// Library exports
module.exports = { loadHistory, saveHistory, recordHistory, parseCrReports, computeHotspots, generateDashboard, historyFile };

// CLI
if (require.main === module) {
  guardCli(() => {
  const [,, command, ...rest] = process.argv;
  const projectRoot = process.cwd();

  switch (command) {
    case 'generate': {
      const workDir = rest[0];
      if (!workDir) { process.stderr.write('Usage: dashboard.js generate <work-dir>\n'); process.exit(1); }
      generate(projectRoot, workDir);
      break;
    }
    case 'open': {
      const workDir = rest[0];
      if (!workDir) { process.stderr.write('Usage: dashboard.js open <work-dir>\n'); process.exit(1); }
      open(workDir);
      break;
    }
    case 'history': {
      showHistory(projectRoot);
      break;
    }
    default:
      process.stderr.write('Usage: dashboard.js <generate|open|history> [work-dir]\n');
      process.exit(1);
  }
  });
}
