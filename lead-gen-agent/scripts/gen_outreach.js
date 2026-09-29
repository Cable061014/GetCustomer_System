/**
 * gen_outreach.js — 本地开发信生成器（二期 · 第一环）
 *
 * 作用：读已有的 leads CSV（高潜客户），对每一家调 DeepSeek 生成个性化开发信草稿，
 *       输出 Markdown 文件，供人工审核后发送。
 *
 * 为什么先做本地版：
 *   - 不碰 n8n、不烧 SerpAPI 额度（数据已经在 CSV 里了）
 *   - 先验证「开发信生成」的 Prompt 质量，再决定要不要搬进 n8n 工作流
 *
 * 用法：
 *   node scripts/gen_outreach.js --csv <leads.csv> --out <输出目录> [--tier high] [--limit 5]
 *
 * 依赖：
 *   - .env 里的 LLM_API_KEY（DeepSeek）
 *   - config/settings.json 的 llm 配置
 *   - prompts/04_outreach_email.md（开发信 Prompt）
 *   - config/outreach.json（产品信息占位符，可选，未建则用通用占位）
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

// 简单 CSV 解析（本项目的 CSV 字段已知，含引号转义）
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = [];
    let cur = '';
    let inQ = false;
    for (const ch of lines[i]) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { cols.push(cur); cur = ''; continue; }
      cur += ch;
    }
    cols.push(cur);
    const row = {};
    header.forEach((h, idx) => { row[h.trim()] = (cols[idx] || '').trim(); });
    rows.push(row);
  }
  return rows;
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
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM 调用失败 HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content;
}

function buildUserPayload(lead, outreach) {
  return {
    companyName: lead.name,
    buyerType: lead.buyerType || 'unknown',
    country: lead.country || '',
    signalsText: lead.topReason || '',
    contactName: null,
    contactEmail: lead.email || '',
    productBrief: outreach.productBrief || '[[PRODUCT_BRIEF]]',
    valueProps: outreach.valueProps || ['[[VALUE_PROP_1]]', '[[VALUE_PROP_2]]'],
    companyInfo: outreach.companyInfo || '[[YOUR_COMPANY]]',
    cta: outreach.cta || '[[CALL_TO_ACTION]]',
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const settings = readJson(path.join(BASE, 'config', 'settings.json'));
  const outreachPrompt = stripMarkdownScaffold(fs.readFileSync(path.join(BASE, 'prompts', '04_outreach_email.md'), 'utf8'));

  // 可选：config/outreach.json 存产品信息
  let outreach = {};
  const outreachCfgPath = path.join(BASE, 'config', 'outreach.json');
  if (fs.existsSync(outreachCfgPath)) outreach = readJson(outreachCfgPath);

  const env = loadEnv();
  const apiKey = env[settings.llm.apiKeyEnv] || process.env[settings.llm.apiKeyEnv];
  if (!apiKey) {
    console.error(`缺少 API Key（环境变量 ${settings.llm.apiKeyEnv}），请在 .env 填写`);
    process.exit(1);
  }
  const llmUrl = `${settings.llm.baseUrl}/chat/completions`;
  const model = settings.llm.model;

  const csvPath = args.csv;
  if (!csvPath) { console.error('用法: node scripts/gen_outreach.js --csv <leads.csv> [--out <dir>] [--tier high] [--limit 5]'); process.exit(1); }

  const rows = parseCsv(fs.readFileSync(path.resolve(csvPath), 'utf8'));
  const tier = args.tier || 'high';
  const limit = Number(args.limit) || 5;
  const targets = rows.filter((r) => r.tier === tier).slice(0, limit);

  if (targets.length === 0) {
    console.error(`CSV 中没有 tier=${tier} 的客户`);
    process.exit(1);
  }

  const outDir = path.resolve(args.out || path.join(BASE, 'logs', 'outreach'));
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`目标客户 ${targets.length} 家（tier=${tier}），开始生成开发信...\n`);

  const results = [];
  for (let i = 0; i < targets.length; i += 1) {
    const lead = targets[i];
    const userPayload = buildUserPayload(lead, outreach);
    const messages = [
      { role: 'system', content: 'You are an expert B2B sales copywriter. Output strict JSON only.' },
      { role: 'user', content: `${outreachPrompt}\n\n输入:\n${JSON.stringify(userPayload)}` },
    ];
    process.stdout.write(`[${i + 1}/${targets.length}] ${lead.name} ... `);
    try {
      const raw = await callLlm(llmUrl, model, apiKey, settings.llm.temperature, settings.llm.maxTokensPerCall, messages);
      let email;
      try { email = JSON.parse(raw); } catch (e) { email = { error: 'parse_fail', raw: raw.slice(0, 200) }; }
      results.push({ lead, email });
      console.log('OK');
    } catch (e) {
      results.push({ lead, email: { error: e.message } });
      console.log(`FAIL: ${e.message.slice(0, 80)}`);
    }
  }

  // 输出 Markdown
  const mdLines = [];
  mdLines.push(`# 开发信草稿（${new Date().toLocaleString('zh-CN')}）\n`);
  mdLines.push(`> 共 ${results.length} 封，tier=${tier}，由 DeepSeek 生成，**发送前必须人工审核**\n`);
  for (const r of results) {
    const { lead, email } = r;
    mdLines.push(`---\n`);
    mdLines.push(`## ${lead.name}`);
    mdLines.push(`- 域名: ${lead.domain} | 类型: ${lead.buyerType} | 分数: ${lead.effectiveScore}`);
    if (lead.email) mdLines.push(`- 邮箱: ${lead.email}`);
    if (lead.sourceUrl) mdLines.push(`- 来源: ${lead.sourceUrl}`);
    mdLines.push('');
    if (email.error) {
      mdLines.push(`**生成失败**：${email.error}\n`);
      continue;
    }
    mdLines.push(`**主题**：${email.subject || ''}\n`);
    mdLines.push(`**称呼**：${email.salutation || ''}\n`);
    mdLines.push(`**正文**：\n`);
    mdLines.push('```');
    mdLines.push(email.body || '');
    mdLines.push('```\n');
    if (email.cta) mdLines.push(`**行动号召**：${email.cta}`);
    if (email.tone) mdLines.push(`**语气**：${email.tone}`);
    mdLines.push('');
  }

  const outFile = path.join(outDir, `outreach_${tier}_${Date.now()}.md`);
  fs.writeFileSync(outFile, mdLines.join('\n'), 'utf8');
  console.log(`\n完成，已写入: ${path.relative(BASE, outFile)}`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { parseCsv, buildUserPayload };
