/**
 * build_workflow.js — 把 config / prompts / scoring.core 编译成可导入的 n8n 工作流
 *
 * 为什么需要它：
 *   n8n 工作流 JSON 里内联了配置、Prompt 与评分引擎源码。手改 JSON 极易出错且会与真源脱节。
 *   本脚本从真源（config/*.json、prompts/*.md、scripts/scoring.core.js）生成工作流，
 *   改配置后 `node scripts/build_workflow.js` 重新生成即可。
 *
 * 用法：node scripts/build_workflow.js [--out n8n/workflow_01_leadgen.json]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BASE = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(BASE, p), 'utf8');
const readJson = (p) => JSON.parse(read(p));

/** 去掉 Markdown 脚手架（标题、引用块），保留可直接当 Prompt 的正文 */
function stripMarkdownScaffold(md) {
  return md
    .split('\n')
    .filter((line) => !/^\s*#{1,6}\s/.test(line) && !/^\s*>/.test(line) && !/^\s*---\s*$/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

function build() {
  const args = parseArgs(process.argv);
  // 支持指定 ICP 配置：--icp config/icp.esim.json（默认通用 config/icp.json）
  const icpPath = args.icp || 'config/icp.json';
  const icp = readJson(icpPath);
  const weights = readJson('config/scoring_weights.json');
  const settings = readJson('config/settings.json');

  const systemPrompt = stripMarkdownScaffold(read('prompts/system_prompt.md'));
  const keywordPrompt = stripMarkdownScaffold(read('prompts/01_keyword_generator.md'));
  const analystPrompt = stripMarkdownScaffold(read('prompts/02_company_analyst.md'));
  const coreSource = read('scripts/scoring.core.js');

  const llmUrl = `${settings.llm.baseUrl}/chat/completions`;
  const model = settings.llm.model;
  const temperature = settings.llm.temperature;
  const maxTokens = settings.llm.maxTokensPerCall;

  const P = (x, y) => [x, y];
  const nodes = [];
  const conn = {};

  const add = (name, type, typeVersion, parameters, pos, extra = {}) => {
    nodes.push({ parameters, id: name.replace(/[^a-zA-Z0-9]/g, '_'), name, type, typeVersion, position: pos, notes: '', ...extra });
    return name;
  };
  // 国际线路（中国→美国）存在间歇性连接重置，外呼节点统一加自动重试
  const RETRY = (tries, waitMs) => ({ retryOnFail: true, maxTries: tries, waitBetweenTries: waitMs });
  const RETRY_SOFT = (tries, waitMs) => ({ ...RETRY(tries, waitMs), onError: 'continueRegularOutput' });
  const link = (from, to) => { conn[from] = { main: [[{ node: to, type: 'main', index: 0 }]] }; };

  add('Manual Trigger', 'n8n-nodes-base.manualTrigger', 1, {}, P(-200, 300));

  // 默认国家/行业从 ICP 配置读取（通用化，换领域不用改这里）
  const defaultCountry = (icp.target.countries && icp.target.countries[0]) || '';
  const defaultIndustry = (icp.target.industries && icp.target.industries[0]) || '';

  add('Set 输入参数', 'n8n-nodes-base.set', 3.4, {
    assignments: {
      assignments: [
        { id: 'a1', name: 'country', value: defaultCountry, type: 'string' },
        { id: 'a2', name: 'industry', value: defaultIndustry, type: 'string' },
        { id: 'a3', name: 'maxLeads', value: settings.runtime.defaultMaxLeads, type: 'number' },
      ],
    },
    options: {},
  }, P(20, 300));

  add('Code 构建关键词提示词', 'n8n-nodes-base.code', 2, {
    jsCode: [
      `const p = $json;`,
      `const taskPrompt = ${JSON.stringify(keywordPrompt)};`,
      `const systemPrompt = ${JSON.stringify(systemPrompt)};`,
      `const userPayload = {`,
      `  country: p.country,`,
      `  industry: p.industry,`,
      `  buyerTypes: ${JSON.stringify(icp.target.buyerTypes.accept)},`,
      `  excludeTypes: ${JSON.stringify(icp.target.buyerTypes.reject)},`,
      `  maxKeywords: ${settings.search.maxKeywords}`,
      `};`,
      `return [{ json: { llmUrl: ${JSON.stringify(llmUrl)}, model: ${JSON.stringify(model)}, temperature: ${temperature}, maxTokens: ${maxTokens}, messages: [ { role: 'system', content: systemPrompt }, { role: 'user', content: taskPrompt + '\\n\\n输入:\\n' + JSON.stringify(userPayload) } ] } }];`,
    ].join('\n'),
  }, P(240, 300));

  add('HTTP LLM 生成关键词', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST',
    url: '={{ $json.llmUrl }}',
    authentication: 'none',
    sendHeaders: true,
    headerParameters: { parameters: [
      { name: 'Authorization', value: '=Bearer {{ $env.LLM_API_KEY }}' },
      { name: 'Content-Type', value: 'application/json' },
    ] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ model: $json.model, temperature: $json.temperature, max_tokens: $json.maxTokens, response_format: { type: "json_object" }, messages: $json.messages }) }}',
    options: { timeout: settings.llm.timeoutMs },
  }, P(460, 300), RETRY(3, 3000));

  add('Code 解析关键词', 'n8n-nodes-base.code', 2, {
    jsCode: [
      `const raw = $json.choices?.[0]?.message?.content ?? '{}';`,
      `let parsed = {};`,
      `try { parsed = JSON.parse(raw); } catch (e) { parsed = { keywords: [], rationale: 'parse_error' }; }`,
      `const keywords = (parsed.keywords || []).slice(0, ${settings.search.maxKeywords});`,
      `if (keywords.length === 0) { throw new Error('关键词生成失败：' + raw.slice(0, 200)); }`,
      `return keywords.map((kw, i) => ({ json: { keywordIndex: i, keyword: kw, country: $('Set 输入参数').first().json.country } }));`,
    ].join('\n'),
  }, P(680, 300));

  add('HTTP 搜索公司', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'GET',
    url: 'https://serpapi.com/search.json',
    authentication: 'none',
    sendQuery: true,
    queryParameters: { parameters: [
      { name: 'engine', value: 'google' },
      { name: 'q', value: '={{ $json.keyword }}' },
      { name: 'num', value: String(settings.search.resultsPerKeyword) },
      { name: 'api_key', value: '={{ $env.SERP_API_KEY }}' },
    ] },
    options: { timeout: 30000 },
  }, P(900, 300), RETRY_SOFT(4, 3000));

  add('Code 归一化候选', 'n8n-nodes-base.code', 2, {
    jsCode: [
      `// 展平搜索结果 -> 候选公司，并按域名去重`,
      `const seen = new Set();`,
      `const out = [];`,
      `for (const item of $input.all()) {`,
      `  const results = item.json.organic_results || [];`,
      `  for (const r of results) {`,
      `    const link = r.link || '';`,
      `    const domain = link.replace(/^https?:\\/\\//, '').replace(/^www\\./, '').split('/')[0].toLowerCase();`,
      `    if (!domain || seen.has(domain)) continue;`,
      `    seen.add(domain);`,
      `    out.push({ json: { name: r.title || domain, domain, sourceUrl: link, snippet: r.snippet || '' } });`,
      `  }`,
      `}`,
      `// 真正读取用户填的 maxLeads（缺省回退到硬上限）`,
      `const wanted = Number($('Set 输入参数').first().json.maxLeads) || ${settings.runtime.defaultMaxLeads};`,
      `const cap = Math.min(wanted, ${settings.runtime.maxLeadsHardLimit});`,
      `return out.slice(0, cap);`,
    ].join('\n'),
  }, P(1120, 300));

  add('HTTP 抓取公司页', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'GET',
    url: '=https://{{ $json.domain }}',
    authentication: 'none',
    options: {
      timeout: settings.enrichment.pageTimeoutMs,
      response: { response: { neverError: true, responseFormat: 'text' } },
      redirect: { redirect: { followRedirects: true, maxRedirects: 3 } },
    },
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'User-Agent', value: settings.search.userAgent }] },
  }, P(1340, 300), RETRY_SOFT(2, 2000));

  add('Code 提正文并建分析提示词', 'n8n-nodes-base.code', 2, {
    jsCode: [
      `const stripHtml = (html) => String(html || '')`,
      `  .replace(/<script[\\s\\S]*?<\\/script>/gi, ' ')`,
      `  .replace(/<style[\\s\\S]*?<\\/style>/gi, ' ')`,
      `  .replace(/<[^>]+>/g, ' ')`,
      `  .replace(/\\s+/g, ' ')`,
      `  .trim()`,
      `  .slice(0, ${settings.enrichment.maxPageBytes / 10});`,
      `const taskPrompt = ${JSON.stringify(analystPrompt)};`,
      `const systemPrompt = ${JSON.stringify(systemPrompt)};`,
      `// 公司元数据从「归一化候选」按索引取回（HTTP 节点丢失了 name/domain，靠索引对齐）`,
      `const candidates = $('Code 归一化候选').all();`,
      `const inputParams = $('Set 输入参数').first().json;`,
      `const out = [];`,
      `const responses = $input.all();`,
      `for (let i = 0; i < responses.length; i++) {`,
      `  const meta = (candidates[i] && candidates[i].json) || {};`,
      `  const resp = responses[i].json;`,
      `  // n8n HTTP 节点 responseFormat=text 时，正文在 data 或 body 字段`,
      `  const pageText = stripHtml(resp.data ?? resp.body ?? resp.text ?? resp.response ?? '');`,
      `  const userPayload = { companyName: meta.name, domain: meta.domain, country: inputParams.country, industry: inputParams.industry, pageText };`,
      `  out.push({ json: {`,
      `    domain: meta.domain, name: meta.name, sourceUrl: meta.sourceUrl,`,
      `    country: inputParams.country, industry: inputParams.industry,`,
      `    llmUrl: ${JSON.stringify(llmUrl)}, model: ${JSON.stringify(model)}, temperature: ${temperature}, maxTokens: ${maxTokens},`,
      `    messages: [ { role: 'system', content: systemPrompt }, { role: 'user', content: taskPrompt + '\\n\\n输入:\\n' + JSON.stringify(userPayload) } ]`,
      `  } });`,
      `}`,
      `return out;`,
    ].join('\n'),
  }, P(1560, 300));

  add('HTTP LLM 分析公司', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST',
    url: '={{ $json.llmUrl }}',
    authentication: 'none',
    sendHeaders: true,
    headerParameters: { parameters: [
      { name: 'Authorization', value: '=Bearer {{ $env.LLM_API_KEY }}' },
      { name: 'Content-Type', value: 'application/json' },
    ] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ model: $json.model, temperature: $json.temperature, max_tokens: $json.maxTokens, response_format: { type: "json_object" }, messages: $json.messages }) }}',
    options: { timeout: settings.llm.timeoutMs, response: { response: { neverError: true } } },
  }, P(1780, 300), RETRY_SOFT(3, 3000));

  // 评分节点：内联 scoring.core.js（真源）
  const scoringNodeCode = [
    `// ===== 内联评分引擎（由 scripts/build_workflow.js 生成，真源 scripts/scoring.core.js，请勿手改） =====`,
    coreSource,
    `// ===== 以下为节点逻辑 =====`,
    `const ICP = ${JSON.stringify(icp)};`,
    `const WEIGHTS = ${JSON.stringify(weights)};`,
    `const metaItems = $('Code 提正文并建分析提示词').all();`,
    `const inputParams = $('Set 输入参数').first().json;`,
    `const responses = $input.all();`,
    `const out = [];`,
    `for (let i = 0; i < responses.length; i++) {`,
    `  const meta = (metaItems[i] && metaItems[i].json) || {};`,
    `  const raw = responses[i].json.choices?.[0]?.message?.content;`,
    `  let analysis = {};`,
    `  try { analysis = JSON.parse(raw || '{}'); } catch (e) { analysis = {}; }`,
    `  const lead = Object.assign({`,
    `    id: 'lead_' + String(i + 1).padStart(4, '0'),`,
    `    name: meta.name || null,`,
    `    domain: meta.domain || null,`,
    `    country: meta.country || inputParams.country || null,`,
    `    industry: meta.industry || inputParams.industry || null,`,
    `    sourceUrl: meta.sourceUrl || null,`,
    `    extractedAt: new Date().toISOString(),`,
    `  }, analysis);`,
    `  const result = scoreLead(lead, ICP, WEIGHTS);`,
    `  out.push({ json: Object.assign({}, lead, { scoring: result }) });`,
    `}`,
    `return out.sort((a, b) => b.json.scoring.effectiveScore - a.json.scoring.effectiveScore);`,
  ].join('\n');

  add('Code 解析并评分', 'n8n-nodes-base.code', 2, { jsCode: scoringNodeCode }, P(2000, 300));

  add('Code 汇总', 'n8n-nodes-base.code', 2, {
    jsCode: [
      `const items = $input.all().map((it) => it.json);`,
      `const summary = { total: items.length, high: 0, medium: 0, low: 0, filtered: 0 };`,
      `for (const it of items) { summary[it.scoring.tier] = (summary[it.scoring.tier] || 0) + 1; }`,
      `console.log('[汇总] ' + JSON.stringify(summary));`,
      `// 每行一条 item，交给 Convert to File 节点自动生成带表头的 CSV`,
      `return items.map((it) => ({ json: {`,
      `  tier: it.scoring.tier, effectiveScore: it.scoring.effectiveScore, score: it.scoring.score,`,
      `  name: it.name || '', domain: it.domain || '', country: it.country || '', buyerType: it.buyerType || '',`,
      `  riskFlags: (it.scoring.riskFlags || []).map((f) => f.key).join('|'),`,
      `  topReason: (it.scoring.reasons || [])[0] || '',`,
      `  email: it.email || '', phone: it.phone || '', contactForm: it.contactForm || '',`,
      `  sourceUrl: it.sourceUrl || ''`,
      `} }));`,
    ].join('\n'),
  }, P(2220, 300));

  add('Convert to File 导出CSV', 'n8n-nodes-base.convertToFile', 1.1, {
    operation: 'csv',
    options: { fileName: 'leads_export.csv' },
  }, P(2440, 300));

  add('Read/Write File 落盘', 'n8n-nodes-base.readWriteFile', 1, {
    operation: 'write',
    fileName: '=/data/exports/leads_{{ $now.toFormat("yyyyLLdd_HHmmss") }}.csv',
    dataPropertyName: 'data',
    options: {},
  }, P(2660, 300));

  const chain = [
    'Manual Trigger', 'Set 输入参数', 'Code 构建关键词提示词', 'HTTP LLM 生成关键词',
    'Code 解析关键词', 'HTTP 搜索公司', 'Code 归一化候选', 'HTTP 抓取公司页',
    'Code 提正文并建分析提示词', 'HTTP LLM 分析公司', 'Code 解析并评分',
    'Code 汇总', 'Convert to File 导出CSV', 'Read/Write File 落盘',
  ];
  for (let i = 0; i < chain.length - 1; i += 1) link(chain[i], chain[i + 1]);

  // ===== 二期：开发信生成（作为 V1 主流程的后续，从「Code 汇总」分叉） =====
  // 只在评分完成后，对 high 层客户生成开发信草稿，导出供人工审核。
  // 发送环节（邮件服务商）未定，故此处只到「生成 + 导出」，发送节点留待后续补。
  const outreachPrompt = stripMarkdownScaffold(read('prompts/04_outreach_email.md'));
  const outreachCfg = (() => {
    const p = 'config/outreach.json';
    return fs.existsSync(path.join(BASE, p)) ? readJson(p) : {};
  })();

  add('Code 提取高潜客户', 'n8n-nodes-base.code', 2, {
    jsCode: [
      `// 从「Code 汇总」的扁平输出里筛出 high 层，准备开发信生成`,
      `const items = $input.all().map((it) => it.json);`,
      `const high = items.filter((it) => it.tier === 'high');`,
      `if (high.length === 0) { return [{ json: { note: '无 high 客户', skip: true } }]; }`,
      `return high.map((it, i) => ({ json: {`,
      `  idx: i,`,
      `  companyName: it.name || '',`,
      `  buyerType: it.buyerType || 'unknown',`,
      `  country: it.country || '',`,
      `  signalsText: it.topReason || '',`,
      `  contactEmail: it.email || '',`,
      `  productBrief: ${JSON.stringify(outreachCfg.productBrief || '[[PRODUCT_BRIEF]]')},`,
      `  valueProps: ${JSON.stringify(outreachCfg.valueProps || ['[[VALUE_PROP_1]]', '[[VALUE_PROP_2]]'])},`,
      `  companyInfo: ${JSON.stringify(outreachCfg.companyInfo || '[[YOUR_COMPANY]]')},`,
      `  cta: ${JSON.stringify(outreachCfg.cta || '[[CALL_TO_ACTION]]')},`,
      `} }));`,
    ].join('\n'),
  }, P(2440, 460));

  add('Code 构建开发信提示词', 'n8n-nodes-base.code', 2, {
    jsCode: [
      `const p = $json;`,
      `const taskPrompt = ${JSON.stringify(outreachPrompt)};`,
      `const userPayload = { companyName: p.companyName, buyerType: p.buyerType, country: p.country, signalsText: p.signalsText, contactName: null, contactEmail: p.contactEmail, productBrief: p.productBrief, valueProps: p.valueProps, companyInfo: p.companyInfo, cta: p.cta };`,
      `return [{ json: { domain: p.companyName, llmUrl: ${JSON.stringify(llmUrl)}, model: ${JSON.stringify(model)}, temperature: ${temperature}, maxTokens: ${maxTokens}, messages: [ { role: 'system', content: 'You are an expert B2B sales copywriter. Output strict JSON only.' }, { role: 'user', content: taskPrompt + '\\n\\n输入:\\n' + JSON.stringify(userPayload) } ] } }];`,
    ].join('\n'),
  }, P(2660, 460));

  add('HTTP LLM 生成开发信', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST',
    url: '={{ $json.llmUrl }}',
    authentication: 'none',
    sendHeaders: true,
    headerParameters: { parameters: [
      { name: 'Authorization', value: '=Bearer {{ $env.LLM_API_KEY }}' },
      { name: 'Content-Type', value: 'application/json' },
    ] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ model: $json.model, temperature: $json.temperature, max_tokens: $json.maxTokens, response_format: { type: "json_object" }, messages: $json.messages }) }}',
    options: { timeout: settings.llm.timeoutMs, response: { response: { neverError: true } } },
  }, P(2880, 460), RETRY_SOFT(3, 3000));

  add('Code 汇总开发信', 'n8n-nodes-base.code', 2, {
    jsCode: [
      `const metaItems = $('Code 提取高潜客户').all();`,
      `const responses = $input.all();`,
      `const rows = [];`,
      `for (let i = 0; i < responses.length; i++) {`,
      `  const meta = (metaItems[i] && metaItems[i].json) || {};`,
      `  const raw = responses[i].json.choices?.[0]?.message?.content;`,
      `  let email = {};`,
      `  try { email = JSON.parse(raw || '{}'); } catch (e) { email = { error: 'parse_fail' }; }`,
      `  rows.push({ json: {`,
      `    companyName: meta.companyName, buyerType: meta.buyerType, contactEmail: meta.contactEmail,`,
      `    subject: email.subject || '', body: email.body || '', salutation: email.salutation || '',`,
      `    cta: email.cta || '', tone: email.tone || '',`,
      `  } });`,
      `}`,
      `return rows;`,
    ].join('\n'),
  }, P(3100, 460));

  add('Convert to File 导出开发信', 'n8n-nodes-base.convertToFile', 1.1, {
    operation: 'csv',
    options: { fileName: 'outreach_drafts.csv' },
  }, P(3320, 460));

  add('Read/Write File 写开发信', 'n8n-nodes-base.readWriteFile', 1, {
    operation: 'write',
    fileName: '=/data/exports/outreach_{{ $now.toFormat("yyyyLLdd_HHmmss") }}.csv',
    dataPropertyName: 'data',
    options: {},
  }, P(3540, 460));

  // 二期链：从「Code 汇总」分叉出去
  const outreachChain = [
    'Code 提取高潜客户', 'Code 构建开发信提示词', 'HTTP LLM 生成开发信',
    'Code 汇总开发信', 'Convert to File 导出开发信', 'Read/Write File 写开发信',
  ];
  for (let i = 0; i < outreachChain.length - 1; i += 1) link(outreachChain[i], outreachChain[i + 1]);
  // 从「Code 汇总」分叉到「Code 提取高潜客户」——两个独立分支
  conn['Code 汇总'] = { main: [
    [{ node: 'Convert to File 导出CSV', type: 'main', index: 0 }],
    [{ node: 'Code 提取高潜客户', type: 'main', index: 0 }],
  ] };

  const workflow = {
    name: 'AI Lead Gen · 主流程（筛选 + 开发信）',
    nodes,
    connections: conn,
    active: false,
    settings: { executionOrder: 'v1', saveManualExecutions: true, callerPolicy: 'workflowsFromSameOwner' },
    versionId: 'v1',
    meta: {
      generatedBy: 'scripts/build_workflow.js',
      generatedAt: new Date().toISOString(),
      configVersion: { icp: icp.version, weights: weights.version, settings: settings.version },
      note: '请勿手改本文件；改配置后重跑 build_workflow.js。',
    },
    tags: [{ name: 'lead-gen' }],
  };

  const outPath = path.resolve(BASE, args.out || 'n8n/workflow_01_leadgen.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(workflow, null, 2), 'utf8');

  console.log(`已生成工作流: ${path.relative(BASE, outPath)}`);
  console.log(`节点数: ${nodes.length}`);
  console.log(`内联评分引擎: ${coreSource.split('\n').length} 行`);
  console.log(`ICP 版本: ${icp.version} | 权重版本: ${weights.version}`);
}

if (require.main === module) build();

module.exports = { build };
