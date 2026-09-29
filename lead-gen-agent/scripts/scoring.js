/**
 * scoring.js — 评分引擎 CLI 外壳（逻辑在 scoring.core.js）
 *
 * 用法：
 *   node scripts/scoring.js --input <leads.json> [--out <scored.json>]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { scoreLead } = require('./scoring.core.js');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  const base = path.resolve(__dirname, '..');
  const icpPath = args.icp || path.join(base, 'config', 'icp.json');
  const weightsPath = args.weights || path.join(base, 'config', 'scoring_weights.json');
  const inputPath = args.input;
  if (!inputPath) {
    console.error('用法: node scripts/scoring.js --input <leads.json> [--out <scored.json>]');
    process.exit(1);
  }
  const icp = JSON.parse(fs.readFileSync(icpPath, 'utf8'));
  const weights = JSON.parse(fs.readFileSync(weightsPath, 'utf8'));
  const payload = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
  const leads = Array.isArray(payload) ? payload : payload.leads || [];

  const scored = leads.map((l) => scoreLead(l, icp, weights));
  const summary = {
    total: scored.length,
    high: scored.filter((s) => s.tier === 'high').length,
    medium: scored.filter((s) => s.tier === 'medium').length,
    low: scored.filter((s) => s.tier === 'low').length,
    filtered: scored.filter((s) => s.tier === 'filtered').length,
  };
  const result = { summary, scored, generatedAt: new Date().toISOString() };

  if (args.out) {
    fs.writeFileSync(path.resolve(args.out), JSON.stringify(result, null, 2), 'utf8');
    console.log(`已写入 ${args.out}`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  console.error(`[summary] total=${summary.total} high=${summary.high} medium=${summary.medium} low=${summary.low} filtered=${summary.filtered}`);
}

if (require.main === module) main();

module.exports = { scoreLead };
