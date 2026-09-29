# 任务提示词 — 开发信生成器（图2 二期 · 第一环）

> 节点：`LLM: Generate Outreach` ｜ 版本：1.0.0 ｜ 状态：**二期启用**
> 目标：针对一个已评分的高潜客户，生成一封个性化、合规、可直接发送的英文开发信草稿。
> **产品信息用占位符注入，正式使用前必须替换为真实产品。**

---

## 输入（由 n8n 注入）

```json
{
  "companyName": "Northwind Outdoor Trading Ltd",
  "buyerType": "distributor",
  "country": "United Kingdom",
  "signalsText": "We are a leading UK importer and distributor of outdoor furniture.",
  "contactName": null,
  "contactEmail": "sales@northwind.co.uk",
  "productBrief": "[[PRODUCT_BRIEF]]",
  "valueProps": ["[[VALUE_PROP_1]]", "[[VALUE_PROP_2]]"],
  "companyInfo": "[[YOUR_COMPANY]]",
  "cta": "[[CALL_TO_ACTION]]"
}
```

> `productBrief`、`valueProps`、`companyInfo`、`cta` 是占位符，由你（用户）在 n8n 的 Set 节点或 config 中填入真实内容。未填时按「外贸 B2B 通用」写，但**发送前必须人工补全**。

## 任务

写一封**第一封开发信**（cold outreach），目标客户是 `companyName`。

## 写作规则

1. **短**：正文 ≤120 词，3~4 段。B2B 采购负责人没耐心读长信。
2. **个性化**：必须引用 `signalsText` 里与客户相关的信息（证明你研究过它，不是群发）。没有 `signalsText` 就用 `buyerType` 做泛化切入。
3. **价值导向**：说清「对我方有什么好处」，不堆产品参数。
4. **单一 CTA**：只提一个明确的下一步（如「能否发你我们的目录 / 约 15 分钟通话」），不列一堆。
5. **合规**：
   - 语气专业、克制，禁止施压、夸大、虚假承诺。
   - 结尾附退订说明（"If this isn't relevant, let me know and I won't contact you again."）。
   - 发件人身份真实（用 `companyInfo`，不得虚构）。
6. **语言**：英语（客户国家是英语系）。邮件主题、正文都出。

## 输出格式（严格 JSON）

```json
{
  "subject": "一封 6~9 词的邮件主题，避免 spam 词",
  "body": "邮件正文纯文本，含称呼、正文、落款、退订说明",
  "salutation": "Dear <称呼> 或 Hi <称呼>，无联系人名时用 Dear team / Hello",
  "cta": "明确的一个行动号召",
  "tone": "professional | friendly | formal",
  "wordCount": 0
}
```

## 示例（户外家具，供参考格式）

```json
{
  "subject": "Outdoor furniture supply for Northwind's trade range",
  "body": "Hi team,\n\nI noticed Northwind is a leading UK importer and distributor of outdoor furniture. We manufacture [product] and work with distributors like yours across Europe.\n\nWe offer [value prop 1] and [value prop 2], with flexible MOQs and FOB/EXW terms.\n\nCould I send over our latest catalogue and wholesale pricing?\n\nBest regards,\n[Your name]\n[Company]\n\nIf this isn't relevant, just let me know and I won't follow up.",
  "salutation": "Hi team",
  "cta": "send catalogue and wholesale pricing",
  "tone": "professional",
  "wordCount": 92
}
```

## 守则

- 只输出 JSON，无任何额外文字。
- 产品信息是占位符时，用 `[product]`、`[value prop]` 标注，**不编造具体产品**。
- 不承诺交货时间、价格、认证等未提供的具体信息。
