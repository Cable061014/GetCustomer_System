/**
 * run_local.js — 本地端到端干跑（Dry Run）
 *
 * 作用：在配置任何外部 API Key 之前，验证「清洗 → 去重 → 校验 → 评分 → 导出」整条链路。
 * 输入用 tests/fixtures 的样例数据（模拟搜索+AI 分析已完成的结果）。
 *
 * 用法：
 *   node scripts/run_local.js
 *   node scripts/run_local.js --input tests/fixtures/sample_companies.json --out logs/exports
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { processBatch } = require('./normalize.js');
const { scoreLead } = require('./scoring.js');

const BASE = path.resolve(__dirname, '..');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

const CSV_COLUMNS = [
  'rank', 'tier', 'score', 'effectiveScore', 'name', 'domain', 'country', 'buyerType',
  'industryMatch', 'employees', 'riskFlags', 'topReason', 'email', 'phone', 'contactForm', 'sourceUrl',
];

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  const head = CSV_COLUMNS.join(',');
  const body = rows.map((r) => CSV_COLUMNS.map((c) => csvEscape(r[c])).join(',')).join('\n');
  return `${head}\n${body}\n`;
}

function main() {
  const args = parseArgs(process.argv);
  const icp = readJson(path.join(BASE, 'config', 'icp.json'));
  const weights = readJson(path.join(BASE, 'config', 'scoring_weights.json'));
  const settings = readJson(path.join(BASE, 'config', 'settings.json'));

  const inputPath = path.resolve(BASE, args.input || 'tests/fixtures/sample_companies.json');
  const outDir = path.resolve(BASE, args.out || settings.storage.exportCsvPath);
  fs.mkdirSync(outDir, { recursive: true });

  const raw = readJson(inputPath);
  const rawList = Array.isArray(raw) ? raw : raw.leads || [];

  const startedAt = Date.now();
  const { accepted, review, duplicates, stats } = processBatch(rawList);
  const pairs = accepted
    .concat(review)
    .map((lead) => ({ lead, result: scoreLead(lead, icp, weights) }));

  const ranked = pairs
    .sort((a, b) => b.result.effectiveScore - a.result.effectiveScore)
    .map((p, i) => ({ ...p.result, rank: i + 1, lead: p.lead }));

  const rows = ranked.map((s) => ({
    rank: s.rank,
    tier: s.tier,
    score: s.score,
    effectiveScore: s.effectiveScore,
    name: s.name,
    domain: s.domain,
    country: s.country,
    buyerType: s.buyerType,
    industryMatch: (s.breakdown.find((b) => b.key === 'industryFit') || {}).reason,
    employees: s.lead.employees,
    riskFlags: s.riskFlags.map((f) => f.key).join('|'),
    topReason: s.reasons[0] || '',
    email: s.lead.email,
    phone: s.lead.phone,
    contactForm: s.lead.contactForm,
    sourceUrl: s.lead.sourceUrl,
  }));

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(outDir, `dryrun_${stamp}.json`);
  const csvPath = path.join(outDir, `dryrun_${stamp}.csv`);
  fs.writeFileSync(jsonPath, JSON.stringify({ stats, ranked }, null, 2), 'utf8');
  fs.writeFileSync(csvPath, toCsv(rows), 'utf8');

  const tierCount = ranked.reduce((acc, s) => { acc[s.tier] = (acc[s.tier] || 0) + 1; return acc; }, {});
  const durationMs = Date.now() - startedAt;

  console.log('=== Dry Run 完成 ===');
  console.log(`环境: ${settings.runtime.environment} | dryRun=${settings.runtime.dryRun}`);
  console.log(`输入: ${inputPath}`);
  console.log(`清洗统计: ${JSON.stringify(stats)}`);
  console.log(`去重明细: ${duplicates.length ? JSON.stringify(duplicates) : '无重复'}`);
  console.log(`分层结果: ${JSON.stringify(tierCount)}`);
  console.log(`耗时: ${durationMs}ms`);
  console.log('--- 排序结果（按 effectiveScore 降序）---');
  for (const s of ranked) {
    const note = s.filtered.length ? `过滤:${s.filteredReasons[0]}` : s.riskFlags.map((f) => f.key).join(',') || 'ok';
    console.log(`#${s.rank} ${String(s.effectiveScore).padStart(6)} | ${s.tier.padEnd(8)} | ${s.name || '-'} | ${note}`);
  }
  console.log('--- 产出 ---');
  console.log(`JSON: ${path.relative(BASE, jsonPath)}`);
  console.log(`CSV : ${path.relative(BASE, csvPath)}`);
}

if (require.main === module) main();
