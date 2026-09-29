/**
 * judge_intent.js — 客户回复意向判断（二期 · 最后一环）
 *
 * 作用：读取客户回复，调 DeepSeek 判断意向等级，输出「待人工接管」的高意向客户清单。
 *
 * 设计原则：
 *   - 只判断意向，不自动回复、不代客户决策（AI 边界）
 *   - 高意向 → human_takeover，标记为「需人工跟进」
 *   - 退订 → 写入抑制名单
 *
 * 用法：
 *   node scripts/judge_intent.js --input <replies.json> [--out <dir>]
 *
 * 输入格式（replies.json）：
 *   [
 *     { "companyName": "The Router Store", "replyText": "Please send your pricing and MOQ" },
 *     { "companyName": "TP-Link UK", "replyText": "Not interested, thanks" }
 *   ]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BASE = path.resolve(__dirname, '..');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

function loadEnv() {
  const env = {};
  const envPath = path.join(BASE, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
  }
  return env;
}

function stripMarkdownScaffold(md) {
  return md.split('\n')
    .filter((l) => !/^\s*#{1,6}\s/.test(l) && !/^\s*>/.test(l) && !/^\s*---\s*$/.test(l))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function callLlm(llmUrl, model, apiKey, temperature, maxTokens, messages) {
  const res = await fetch(llmUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature, max_tokens: maxTokens, response_format: { type: 'json_object' }, messages }),
  });
  if (!res.ok) { const b = await res.text(); throw new Error(`LLM HTTP ${res.status}: ${b.slice(0, 200)}`); }
  const d = await res.json();
  return d.choices?.[0]?.message?.content;
}

async function main() {
  const args = parseArgs(process.argv);
  const settings = readJson(path.join(BASE, 'config', 'settings.json'));
  const intentPrompt = stripMarkdownScaffold(fs.readFileSync(path.join(BASE, 'prompts', '03_intent_judge.md'), 'utf8'));
  const outreach = (() => { const p = path.join(BASE, 'config', 'outreach.json'); return fs.existsSync(p) ? readJson(p) : {}; })();

  const env = loadEnv();
  const apiKey = env[settings.llm.apiKeyEnv] || process.env[settings.llm.apiKeyEnv];
  if (!apiKey) { console.error('缺少 LLM_API_KEY'); process.exit(1); }
  const llmUrl = `${settings.llm.baseUrl}/chat/completions`;
  const model = settings.llm.model;

  const inputPath = args.input;
  if (!inputPath) { console.error('用法: node scripts/judge_intent.js --input <replies.json> [--out <dir>]'); process.exit(1); }
  const replies = readJson(path.resolve(inputPath));
  const list = Array.isArray(replies) ? replies : replies.replies || [];

  const outDir = path.resolve(args.out || path.join(BASE, 'logs', 'intent'));
  fs.mkdirSync(outDir, { recursive: true });

  const results = [];
  for (let i = 0; i < list.length; i += 1) {
    const r = list[i];
    const userPayload = {
      companyName: r.companyName || '',
      replyText: r.replyText || '',
      threadHistory: r.threadHistory || [],
      offerSummary: outreach.productBrief || 'routers and networking equipment',
    };
    const messages = [
      { role: 'system', content: 'You are an AI assistant that classifies B2B customer intent. Output strict JSON only.' },
      { role: 'user', content: `${intentPrompt}\n\n输入:\n${JSON.stringify(userPayload)}` },
    ];
    process.stdout.write(`[${i + 1}/${list.length}] ${r.companyName} ... `);
    try {
      const raw = await callLlm(llmUrl, model, apiKey, settings.llm.temperature, settings.llm.maxTokensPerCall, messages);
      let j; try { j = JSON.parse(raw); } catch (e) { j = { intent: 'unknown', reasoning: 'parse_fail', raw: raw.slice(0, 100) }; }
      results.push({ companyName: r.companyName, replyText: r.replyText, ...j });
      console.log(j.intent || '?');
    } catch (e) {
      results.push({ companyName: r.companyName, replyText: r.replyText, intent: 'error', reasoning: e.message });
      console.log('FAIL: ' + e.message.slice(0, 60));
    }
  }

  // 分类汇总
  const high = results.filter((x) => x.intent === 'high');
  const medium = results.filter((x) => x.intent === 'medium');
  const unsub = results.filter((x) => x.intent === 'unsubscribe');
  const others = results.filter((x) => !['high', 'medium', 'unsubscribe'].includes(x.intent));

  // 输出结果
  const outFile = path.join(outDir, `intent_${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    summary: { total: results.length, high: high.length, medium: medium.length, unsubscribe: unsub.length, other: others.length },
    highPriority: high,
    medium: medium,
    unsubscribe: unsub,
    others: others,
  }, null, 2), 'utf8');

  console.log('\n=== 意向判断完成 ===');
  console.log(`高意向(待人工接管): ${high.length} | 中意向: ${medium.length} | 退订: ${unsub.length} | 其他: ${others.length}`);
  if (high.length > 0) {
    console.log('\n【待人工接管的高意向客户】');
    for (const h of high) {
      console.log(`  ★ ${h.companyName} — ${(h.signals || []).join('、') || h.reasoning || ''}`);
      if (h.suggestedReply) console.log(`    建议回复: ${h.suggestedReply.slice(0, 80)}...`);
    }
  }
  if (unsub.length > 0) {
    console.log('\n【需加入抑制名单】');
    for (const u of unsub) console.log(`  ⊘ ${u.companyName}`);
  }
  console.log(`\n结果已写入: ${path.relative(BASE, outFile)}`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { main };
