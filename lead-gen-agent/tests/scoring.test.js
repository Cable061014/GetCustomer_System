/**
 * 评分引擎单元测试（Node 内置测试器，零依赖）
 * 运行：node --test tests/
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { scoreLead } = require('../scripts/scoring.js');

const base = path.resolve(__dirname, '..');
const icp = JSON.parse(fs.readFileSync(path.join(base, 'config', 'icp.json'), 'utf8'));
const weights = JSON.parse(fs.readFileSync(path.join(base, 'config', 'scoring_weights.json'), 'utf8'));
const leads = JSON.parse(fs.readFileSync(path.join(base, 'tests', 'fixtures', 'sample_companies.json'), 'utf8'));

const byId = (id) => leads.find((l) => l.id === id);
const score = (id) => scoreLead(byId(id), icp, weights);

/* ---------- 配置健全性 ---------- */

test('权重总和为 100，总分刻度可对齐', () => {
  const sum = weights.dimensions.reduce((a, d) => a + d.weight, 0);
  assert.strictEqual(sum, 100, '维度权重必须合计 100');
});

test('每个维度都声明了规则类型', () => {
  for (const d of weights.dimensions) {
    assert.ok(d.rule && d.rule.type, `维度 ${d.key} 缺少 rule.type`);
    assert.ok(typeof d.weight === 'number' && d.weight > 0, `维度 ${d.key} 权重非法`);
  }
});

/* ---------- 分层与过滤行为 ---------- */

test('理想经销商 → high 且不被过滤', () => {
  const r = score('lead_001_ideal_distributor');
  assert.strictEqual(r.tier, 'high');
  assert.strictEqual(r.filtered.length, 0);
  assert.ok(r.score >= weights.tiers.high, `期望 >= ${weights.tiers.high}，实得 ${r.score}`);
});

test('制造商 → 命中 buyer_type_rejected 硬过滤', () => {
  const r = score('lead_002_manufacturer_should_filter');
  assert.strictEqual(r.tier, 'filtered');
  assert.ok(r.filtered.some((f) => f.key === 'buyer_type_rejected'));
  assert.strictEqual(r.effectiveScore, 0, '被过滤的 lead 排序分必须归零');
  assert.ok(r.score > 0, '原始分应保留，便于复盘差距');
});

test('非目标国家 → 命中 country_mismatch 硬过滤', () => {
  const r = score('lead_003_wrong_country_should_filter');
  assert.strictEqual(r.tier, 'filtered');
  assert.ok(r.filtered.some((f) => f.key === 'country_mismatch'));
});

test('无任何联系方式 → 命中 no_contact_route 硬过滤', () => {
  const r = score('lead_004_no_contact_should_filter');
  assert.strictEqual(r.tier, 'filtered');
  assert.ok(r.filtered.some((f) => f.key === 'no_contact_route'));
});

/* ---------- 风险标记 ---------- */

test('仅免费邮箱 → 打 free_email_only 风险标', () => {
  const r = score('lead_005_medium_free_email');
  assert.ok(r.riskFlags.some((f) => f.key === 'free_email_only'), '应标记免费邮箱风险');
});

test('规模数据缺失 → 打 size_unknown 风险标', () => {
  const r = score('lead_006_unknown_size_risk_flag');
  assert.ok(r.riskFlags.some((f) => f.key === 'size_unknown'), '应标记规模缺失风险');
});

/* ---------- 可审计性与确定性 ---------- */

test('每个维度都产出可读 reason（审计轨迹）', () => {
  const r = score('lead_001_ideal_distributor');
  assert.strictEqual(r.breakdown.length, weights.dimensions.length);
  for (const b of r.breakdown) {
    assert.ok(typeof b.reason === 'string' && b.reason.length > 0, `维度 ${b.key} 缺少 reason`);
  }
  assert.ok(r.audit.configVersion && r.audit.engine, 'audit 元数据缺失');
});

test('确定性：同输入重复打分结果完全一致（忽略时间戳）', () => {
  const a = score('lead_001_ideal_distributor');
  const b = score('lead_001_ideal_distributor');
  assert.strictEqual(a.score, b.score);
  assert.deepStrictEqual(a.breakdown, b.breakdown);
});

test('分数恒在 0-100 区间内', () => {
  for (const l of leads) {
    const r = scoreLead(l, icp, weights);
    assert.ok(r.score >= 0 && r.score <= 100, `${l.id} 分数越界: ${r.score}`);
  }
});

/* ---------- 新增：sizeSignal 规模信号 + 布尔 contactForm ---------- */

test('sizeSignal 驱动规模维度（不再依赖 employees）', () => {
  // lead_001 有 employees=45，但也有 sizeSignal=medium；验证 reason 引用 sizeSignal
  const r = score('lead_001_ideal_distributor');
  const dim = r.breakdown.find((b) => b.key === 'sizeFit');
  assert.ok(dim.raw > 0, `规模维度应得分，实得 ${dim.raw}`);
  assert.ok(dim.reason.includes('sizeSignal'), `reason 应引用 sizeSignal，实际：${dim.reason}`);
});

test('布尔 contactForm=true 不算「无联系途径」，不被误过滤', () => {
  const r = score('lead_007_boolean_contactform');
  assert.notStrictEqual(r.tier, 'filtered', `有联系表单入口不应被过滤，实际 tier=${r.tier}`);
  const dim = r.breakdown.find((b) => b.key === 'contactability');
  assert.ok(dim.raw > 0, `contactability 应得分，实得 ${dim.raw}`);
});
