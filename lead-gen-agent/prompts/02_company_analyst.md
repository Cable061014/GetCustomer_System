# 任务提示词 — 公司分析器（图3 ⑤⑦）

> 节点：`LLM: Analyze Company` ｜ 版本：1.0.0
> 目标：从一家公司的公开网页文本中，提取结构化字段，供确定性评分算法消费。

---

## 输入（由 n8n 注入）

```json
{
  "companyName": "Northwind Outdoor Trading Ltd",
  "domain": "northwind-outdoor.co.uk",
  "country": "United Kingdom",
  "industry": "outdoor furniture",
  "pageText": "<官网首页/关于页的纯文本，已去除 HTML>"
}
```

## 任务

只依据 `pageText` 的内容，输出下列**固定字段**的判定结果。

## 字段定义（枚举封闭，不得自创值）

| 字段 | 类型 | 取值 | 判定标准 |
|---|---|---|---|
| `industryMatch` | enum | `exact` / `adjacent` / `broad` / `none` / `unknown` | 与目标行业的关系：完全对口 / 上下游相邻 / 泛相关 / 无关 / 无法判断 |
| `buyerType` | enum | 见下方「buyerType 枚举表」 | 该公司的业务身份（从枚举表里选最贴切的一个） |
| `employees` | number\|null | 正整数 | 仅当页面明确写出时填；估算值一律填 `null` |
| `revenueUsd` | number\|null | 正整数 | 仅当明确写出营收时填，否则 `null` |
| `sizeSignal` | enum | `large` / `medium` / `small` / `unknown` | **规模代理信号**（见下方判定口径；这是评规模的主要依据，比猜员工数可靠） |
| `importCapability` | boolean | true/false | 是否具备进口/国际采购能力（如提及 importer、自行进口、FOB、container） |
| `signalsText` | string | ≤400 字 | 摘录能证明采购意图的原文片段（拼成一段） |
| `email` | string\|null | 有效邮箱 | 优先企业邮箱；无则 `null`。注意从「contact us」「get in touch」等区域提取，勿只看字面 `@` |
| `phone` | string\|null | 电话 | 无则 `null` |
| `contactForm` | string\|boolean | 表单 URL 或 `true` | 有明确 URL 填 URL；检测到「联系表单入口」但拿不到 URL 时填 `true`；完全没有则 `null` |
| `websiteQuality` | number | 0–1 | 官网专业度：产品线完整度、更新频率、是否有 B2B/批发入口 |
| `evidence` | object | 字段→原文片段 | 关键判定的原文出处（≤120 字/条） |

## buyerType 枚举表（跨领域通用，选最贴切的一个）

**贸易/零售类（B2B 卖货）**
- `distributor` 经销商 ｜ `wholesaler` 批发商 ｜ `importer` 进口商 ｜ `trade_supplier` 贸易供货商 ｜ `retailer_with_trade` 带批发的零售商 ｜ `retailer` 零售商 ｜ `brand_owner` 品牌方

**渠道/旅行/数码类（eSIM、科技、服务类产品的渠道）**
- `reseller` 分销/转售商 ｜ `travel_agency` 旅行社 ｜ `ota` 在线旅游平台 ｜ `hotel` 酒店/住宿 ｜ `content_creator` 博主/创作者 ｜ `mobile_retailer` 数码/手机零售商

**应排除类**
- `manufacturer` 制造商 ｜ `competitor` 同行竞品 ｜ `marketplace` 电商平台 ｜ `dropshipper` 代发货 ｜ `consumer` 纯消费者 ｜ `telecom_carrier` 电信运营商 ｜ `unknown` 无法判断

## sizeSignal 判定口径（规模代理信号）

**不要猜员工数**——绝大多数官网不写。改判下列可观察信号：

- `large`：全国/多国连锁、多个仓储/物流中心、成规模的经销商网络、知名大品牌
- `medium`：单一但业务完整，有批发/B2B 入口、产品线较全、明显稳定经营
- `small`：单一页面/独立小店、产品线窄、无批发入口、疑似个体经营
- `unknown`：信息不足，无法判断（宁可 unknown 不误判）

## websiteQuality 打分口径

- `0.8–1.0`：有独立批发/B2B 入口、产品线完整、明显近年维护
- `0.5–0.79`：常规企业站，信息较全
- `0.2–0.49`：模板站或信息稀疏
- `0.0–0.19`：疑似空壳/停更/仅有占位页

## 输出格式（严格 JSON）

```json
{
  "industryMatch": "exact",
  "buyerType": "distributor",
  "employees": null,
  "revenueUsd": null,
  "sizeSignal": "medium",
  "importCapability": true,
  "signalsText": "We import and distribute outdoor furniture to trade customers across the UK.",
  "email": "sales@example.co.uk",
  "phone": "+44 20 7946 0000",
  "contactForm": "https://example.co.uk/contact",
  "websiteQuality": 0.82,
  "evidence": {
    "buyerType": "leading importer and distributor of outdoor furniture",
    "importCapability": "container loads and FOB terms available"
  }
}
```

## 守则

- **宁缺勿猜**：未明确写出的数字一律 `null`，不要用常识补全。
- `pageText` 为空或为错误页 → 全部字段取 `unknown`/`null`，`websiteQuality: 0`。
- 只输出 JSON，无任何额外文字。
