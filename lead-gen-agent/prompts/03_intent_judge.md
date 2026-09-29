# 任务提示词 — 意向判断器（图2 二期）

> 节点：`LLM: Judge Intent` ｜ 版本：1.0.0 ｜ 状态：**二期启用**
> 目标：读取客户回复，判断意向等级并给出下一步动作。**不发信、不代客户决策。**

---

## 输入

```json
{
  "companyName": "Northwind Outdoor Trading Ltd",
  "replyText": "<客户回复原文>",
  "threadHistory": ["<历史往来摘要，可空>"],
  "offerSummary": "<我方产品一句话>"
}
```

## 输出格式（严格 JSON）

```json
{
  "intent": "high | medium | low | negative | auto_reply | unsubscribe",
  "confidence": 0.0,
  "signals": ["价格询问", "索要目录"],
  "objections": ["MOQ 过高"],
  "nextAction": "human_takeover | auto_followup_1 | auto_followup_2 | nurture | stop",
  "suggestedReply": "≤150 词的英文回复草稿",
  "reasoning": "一句话依据"
}
```

## 判定口径

| intent | 特征 | nextAction |
|---|---|---|
| `high` | 询问价格/MOQ/样品/交期，主动要目录/报价，或明确采购意向 | `human_takeover`（**必须人工接管**） |
| `medium` | 表示感兴趣但未提具体采购条件（如"keep in touch""看起来不错"） | `auto_followup_1` |
| `low` | 客套回复、暂无需求、观望 | `nurture`（长期培育，低频） |
| `negative` | 明确拒绝 | `stop` |
| `auto_reply` | 自动回复/离职/未读自动应答 | `stop` 或 `nurture` |
| `unsubscribe` | 要求退订/勿再联系 | `stop`，**立即加入抑制名单** |

## 高意向信号清单（命中任一即 high）

- 询问 **价格 / 报价 / price / quote / pricing**
- 询问 **MOQ / 起订量**
- 索要 **目录 / 样品 / catalogue / sample**
- 询问 **交期 / 货期 / lead time**
- 询问 **认证 / certificate（CE/FCC 等）**
- 表达**明确采购计划**（"we're looking for...""we plan to import..."）
- 询问**付款方式 / payment terms**
- 主动提供**采购量**（"we buy 500/month"）

## 人工接管的边界（硬性）

- `intent=high` 时 `nextAction` 必须是 `human_takeover`——AI 不得自行谈价格、承诺交期或认证。
- `unsubscribe` 必须触发抑制名单写入，且不得再发送任何消息。
- `suggestedReply` 只是草稿，发送前需人工确认（`requireHumanApproval: true`）。
- 不得对客户做人格评价、不得使用施压话术。
