/**
 * normalize.js — 数据清洗、去重、校验（零依赖）
 *
 * 企业级数据质量的三个关口：
 *   1. normalizeLead  统一格式（空格、大小写、空值、URL）
 *   2. dedupeLeads    去重（按域名，其次 名称+国家）
 *   3. validateLead   必填字段校验，产出可入库/需人工复核分流
 */

'use strict';

const trimOrNull = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/** 把各种 URL/域名写法统一成裸域名：https://www.Example.com/path -> example.com */
function normalizeDomain(input) {
  const s = trimOrNull(input);
  if (!s) return null;
  return s
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

const BUYER_TYPES = new Set([
  'distributor', 'wholesaler', 'importer', 'trade_supplier', 'retailer_with_trade',
  'retailer', 'brand_owner', 'manufacturer', 'competitor', 'marketplace',
  'dropshipper', 'consumer', 'unknown',
]);

const INDUSTRY_MATCHES = new Set(['exact', 'adjacent', 'broad', 'none', 'unknown']);

function normalizeLead(raw) {
  const employees = raw.employees == null || raw.employees === '' ? null : Number(raw.employees);
  const revenueUsd = raw.revenueUsd == null || raw.revenueUsd === '' ? null : Number(raw.revenueUsd);
  const websiteQuality = raw.websiteQuality == null || raw.websiteQuality === '' ? null : Number(raw.websiteQuality);
  const email = trimOrNull(raw.email);

  return {
    id: trimOrNull(raw.id),
    name: trimOrNull(raw.name),
    domain: normalizeDomain(raw.domain || raw.sourceUrl),
    country: trimOrNull(raw.country),
    industry: trimOrNull(raw.industry),
    industryMatch: INDUSTRY_MATCHES.has(raw.industryMatch) ? raw.industryMatch : 'unknown',
    buyerType: BUYER_TYPES.has(raw.buyerType) ? raw.buyerType : 'unknown',
    employees: Number.isFinite(employees) ? employees : null,
    revenueUsd: Number.isFinite(revenueUsd) ? revenueUsd : null,
    importCapability: raw.importCapability === true,
    signalsText: trimOrNull(raw.signalsText) || '',
    email: email ? email.toLowerCase() : null,
    phone: trimOrNull(raw.phone),
    contactForm: trimOrNull(raw.contactForm),
    websiteQuality: Number.isFinite(websiteQuality) ? Math.min(1, Math.max(0, websiteQuality)) : null,
    sourceUrl: trimOrNull(raw.sourceUrl),
    extractedAt: trimOrNull(raw.extractedAt) || new Date().toISOString(),
    evidence: raw.evidence && typeof raw.evidence === 'object' ? raw.evidence : {},
  };
}

/** 去重：优先域名；无域名则用 名称+国家 的小写组合作为键 */
function dedupeLeads(leads) {
  const seen = new Map();
  const duplicates = [];
  for (const lead of leads) {
    const key = lead.domain
      ? `d:${lead.domain}`
      : `n:${(lead.name || '').toLowerCase()}|${(lead.country || '').toLowerCase()}`;
    if (seen.has(key)) {
      duplicates.push({ key, kept: seen.get(key).id || seen.get(key).name, dropped: lead.id || lead.name });
      continue;
    }
    seen.set(key, lead);
  }
  return { unique: Array.from(seen.values()), duplicates };
}

/** 校验：区分“可入库”与“需人工复核” */
function validateLead(lead) {
  const issues = [];
  if (!lead.name) issues.push('missing_name');
  if (!lead.domain) issues.push('missing_domain');
  if (!lead.email && !lead.contactForm && !lead.phone) issues.push('no_contact_route');
  if (!lead.country) issues.push('missing_country');
  const blocking = issues.filter((i) => i !== 'missing_country');
  return { ok: blocking.length === 0, issues, needsReview: issues.length > 0 };
}

/** 批量处理：清洗 → 去重 → 校验 → 分流 */
function processBatch(rawLeads) {
  const normalized = rawLeads.map(normalizeLead);
  const { unique, duplicates } = dedupeLeads(normalized);
  const accepted = [];
  const review = [];
  for (const lead of unique) {
    const v = validateLead(lead);
    if (v.ok) accepted.push({ ...lead, validation: v });
    else review.push({ ...lead, validation: v });
  }
  return { accepted, review, duplicates, stats: { input: rawLeads.length, unique: unique.length, accepted: accepted.length, review: review.length, duplicates: duplicates.length } };
}

module.exports = { normalizeLead, normalizeDomain, dedupeLeads, validateLead, processBatch };

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const input = process.argv[2];
  if (!input) {
    console.error('用法: node scripts/normalize.js <leads.json>');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.leads || [];
  const out = processBatch(list);
  console.log(JSON.stringify(out.stats, null, 2));
}
