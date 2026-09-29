/**
 * scoring.core.js — 评分引擎纯核心（无 I/O、无 CLI）
 *
 * 这是全项目唯一的评分真源。两个消费方：
 *   1. Node CLI      -> scripts/scoring.js 通过 require 引用
 *   2. n8n Code 节点 -> scripts/build_workflow.js 把本文件源码内联进工作流
 * 因此本文件禁止出现 require / fs / process 等运行时依赖，保持纯函数。
 */

'use strict';

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

function round(n, digits = 2) {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

function isFreeEmail(email, icp) {
  if (!email || typeof email !== 'string') return false;
  const domain = email.split('@')[1];
  if (!domain) return false;
  const block = (icp.contactRequirements && icp.contactRequirements.blockFreeEmailDomains) || [];
  return block.map((d) => d.toLowerCase()).includes(domain.toLowerCase());
}

function countSignals(text, terms) {
  if (!text || typeof text !== 'string') return 0;
  const lower = text.toLowerCase();
  return terms.reduce((acc, term) => (lower.includes(String(term).toLowerCase()) ? acc + 1 : acc), 0);
}

function ruleEnum(rule, lead) {
  const value = lead[rule.field];
  const scores = rule.scores || {};
  const raw = Object.prototype.hasOwnProperty.call(scores, value) ? scores[value] : (scores.unknown || 0);
  return { raw: clamp(raw, 0, 1), reason: `${rule.field}=${value == null ? 'null' : value}` };
}

function ruleIcpEnum(rule, lead, icp) {
  const value = lead[rule.field];
  const bt = icp.target.buyerTypes;
  let raw = 0.2;
  let tag = '未识别';
  if (bt.accept.includes(value)) { raw = rule.accept; tag = '符合'; }
  else if (bt.partial.includes(value)) { raw = rule.partial; tag = '部分符合'; }
  else if (bt.reject.includes(value)) { raw = rule.reject; tag = '排除'; }
  return { raw, reason: `${rule.field}=${value == null ? 'null' : value}（${tag}）` };
}

function ruleRange(rule, lead, icp) {
  let value = lead[rule.field];
  let usedField = rule.field;
  if ((value == null || value === '') && rule.fallbackField) {
    value = lead[rule.fallbackField];
    usedField = rule.fallbackField;
  }
  if (value == null || value === '' || Number.isNaN(Number(value))) {
    return { raw: rule.unknown, reason: `${usedField} 未知，取保守值` };
  }
  const sizeConf = icp.target.companySize || {};
  const bounds = sizeConf[usedField === 'employees' ? 'employees' : 'revenueUsd'];
  if (!bounds) return { raw: rule.unknown, reason: `${usedField} 无区间配置` };
  const v = Number(value);
  const inIdeal = (bounds.idealMin == null || v >= bounds.idealMin) && (bounds.idealMax == null || v <= bounds.idealMax);
  const inAcceptable =
    (bounds.acceptableMin == null || v >= bounds.acceptableMin) &&
    (bounds.acceptableMax == null || v <= bounds.acceptableMax);
  if (inIdeal) return { raw: rule.ideal, reason: `${usedField}=${v} 落在理想区间` };
  if (inAcceptable) return { raw: rule.acceptable, reason: `${usedField}=${v} 落在可接受区间` };
  return { raw: rule.outside, reason: `${usedField}=${v} 超出可接受区间` };
}

function ruleSignalCount(rule, lead, icp) {
  const text = lead[rule.textField] || '';
  const pos = countSignals(text, (icp.buyingSignals && icp.buyingSignals.positive) || []);
  const neg = countSignals(text, (icp.buyingSignals && icp.buyingSignals.negative) || []);
  const base = lead[rule.boolField] ? rule.boolBonus : 0;
  const gained = Math.min(rule.maxSignals, pos) * rule.perSignal;
  const score = clamp(base + gained - neg * rule.negativePenalty, 0, 1);
  return {
    raw: score,
    reason: `进口能力=${lead[rule.boolField] ? '是' : '否'}; 采购信号命中 ${pos} 条; 负面信号 ${neg} 条`,
  };
}

function rulePresenceWeighted(rule, lead, icp) {
  const w = rule.weights;
  const hits = [];
  let best = 0;
  if (lead.email) {
    if (isFreeEmail(lead.email, icp)) { best = Math.max(best, w.freeEmail); hits.push(`免费邮箱(${round(w.freeEmail, 2)})`); }
    else { best = Math.max(best, w.businessEmail); hits.push(`企业邮箱(${round(w.businessEmail, 2)})`); }
  }
  if (lead.contactForm) {
    // contactForm 可为 URL 字符串或布尔 true（检测到表单入口但无 URL）
    const cf = lead.contactForm === true ? w.contactForm : w.contactForm;
    best = Math.max(best, cf); hits.push(`联系表单(${round(w.contactForm, 2)})`);
  }
  if (lead.phone) { best = Math.max(best, w.phone); hits.push(`电话(${round(w.phone, 2)})`); }
  return { raw: clamp(best, 0, 1), reason: hits.length ? hits.join(' + ') : '无任何联系方式' };
}

function ruleScale(rule, lead) {
  const v = lead[rule.field];
  if (v == null || v === '' || Number.isNaN(Number(v))) {
    return { raw: rule.unknown, reason: `${rule.field} 未知，取保守值` };
  }
  return { raw: clamp(Number(v), 0, 1), reason: `${rule.field}=${round(Number(v), 2)}` };
}

const RULE_IMPL = {
  enum: ruleEnum,
  icpEnum: ruleIcpEnum,
  range: ruleRange,
  signalCount: ruleSignalCount,
  presenceWeighted: rulePresenceWeighted,
  scale: ruleScale,
};

function runHardFilters(lead, dimBreakdown, icp, weights) {
  const hits = [];
  const contactability = dimBreakdown.find((d) => d.key === 'contactability');
  for (const f of weights.hardFilters || []) {
    if (f.op === 'countryNotInIcp') {
      const mode = icp.target.countryMatchMode || 'strict';
      const list = icp.target.countries || [];
      if (mode === 'strict' && list.length > 0 && !list.includes(lead.country)) hits.push(f);
    } else if (f.op === 'buyerTypeInRejectList') {
      if ((icp.target.buyerTypes.reject || []).includes(lead.buyerType)) hits.push(f);
    } else if (f.op === 'contactabilityZero') {
      if (contactability && contactability.raw === 0) hits.push(f);
    }
  }
  return hits;
}
function scoreLead(lead, icp, weights, options) {
  const opts = options || {};
  const dimensions = weights.dimensions || [];
  const weightSum = dimensions.reduce((a, d) => a + (d.weight || 0), 0);
  const scale = weights.totalScale || 100;

  const breakdown = [];
  const reasons = [];

  for (const dim of dimensions) {
    const impl = RULE_IMPL[dim.rule && dim.rule.type];
    if (!impl) {
      breakdown.push({ key: dim.key, label: dim.label, weight: dim.weight, raw: 0, points: 0, reason: `未知规则类型 ${dim.rule && dim.rule.type}` });
      continue;
    }
    const r = impl(dim.rule, lead, icp);
    const normalizedWeight = (dim.weight / weightSum) * scale;
    const points = round(r.raw * normalizedWeight, 2);
    breakdown.push({ key: dim.key, label: dim.label, weight: dim.weight, raw: round(r.raw, 3), points, reason: r.reason });
    reasons.push(`${dim.label}: ${r.reason} → ${points}分`);
  }

  const total = round(breakdown.reduce((a, b) => a + b.points, 0), 2);
  const filtered = runHardFilters(lead, breakdown, icp, weights);

  let tier = 'low';
  if (filtered.length === 0) {
    if (total >= weights.tiers.high) tier = 'high';
    else if (total >= weights.tiers.medium) tier = 'medium';
  } else {
    tier = 'filtered';
  }

  const riskFlags = (weights.riskFlags || [])
    .filter((rf) => {
      if (rf.key === 'free_email_only') return !!lead.email && isFreeEmail(lead.email, icp);
      if (rf.key === 'size_unknown') {
        return (lead.sizeSignal == null || lead.sizeSignal === '' || lead.sizeSignal === 'unknown');
      }
      return false;
    })
    .map((rf) => ({ key: rf.key, reason: rf.reason }));

  return {
    id: lead.id || null,
    name: lead.name || null,
    domain: lead.domain || null,
    country: lead.country || null,
    buyerType: lead.buyerType || null,
    score: total,
    effectiveScore: filtered.length ? 0 : total,
    tier,
    filtered,
    filteredReasons: filtered.map((f) => f.reason),
    breakdown,
    reasons,
    riskFlags,
    audit: {
      configVersion: weights.version || 'unknown',
      icpVersion: icp.version || 'unknown',
      scoredAt: opts.scoredAt || new Date().toISOString(),
      engine: 'scoring.core.js/1.0.0',
    },
  };
}

/* 双运行时导出守卫：Node 用 module.exports；n8n Code 节点内联时该块被跳过 */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { scoreLead, isFreeEmail, countSignals, clamp, round };
}
