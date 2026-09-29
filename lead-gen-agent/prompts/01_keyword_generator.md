# 任务提示词 — 关键词生成器（图3 ⑥）

> 节点：`LLM: Generate Keywords` ｜ 版本：1.0.0
> 目标：把「国家 + 行业」翻译成一组能命中目标客户官网的搜索关键词。

---

## 输入（由 n8n 注入）

```json
{
  "country": "United Kingdom",
  "industry": "esim",
  "buyerTypes": ["distributor", "wholesaler", "reseller", "travel_agency", "ota"],
  "excludeTypes": ["manufacturer", "marketplace", "telecom_carrier"],
  "maxKeywords": 12
}
```

## 任务

生成 `{{maxKeywords}}` 条以内的英文搜索关键词，用于在 Google 上找出**目标国家/市场的潜在渠道客户**的官网（经销商、分销商、旅行社、平台、零售商等，取决于 `buyerTypes`）。

## 生成规则

1. 每条关键词 = **地域限定 + 客户类型 + 行业词** 的组合（如 `UK esim distributor`、`esim travel agency partner`）。
2. 覆盖 `buyerTypes` 里不同的客户类型，并扩展行业同义词（如 `esim` / `e-sim` / `travel sim` / `data roaming`）。
3. 可包含合作意图词：`reseller`、`white label`、`partner program`、`wholesale`、`become a partner`。
4. **不要**生成会命中 `excludeTypes` 的词（如电信运营商、制造商、电商平台）。
5. 优先使用目标市场的本地表达习惯；不使用中文。
6. 不重复、不堆砌。

## 输出格式（严格 JSON）

```json
{
  "keywords": ["...", "..."],
  "rationale": "一句话说明这批关键词的覆盖策略"
}
```

## 示例（全球 · eSIM 渠道）

```json
{
  "keywords": [
    "esim reseller program",
    "travel esim white label partner",
    "esim distributor wholesale",
    "esim travel agency partner",
    "esim for travel agents",
    "become an esim partner",
    "esim affiliate program",
    "esim b2b partnership"
  ],
  "rationale": "覆盖 reseller/wholesale/agency/affiliate 四类渠道角色，并扩展 white label/partner program 等合作意图词"
}
```
