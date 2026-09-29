# 合规说明（企业级必读）

> 面向英国/欧盟市场。**B2B 冷启动获客合法，但必须满足以下前提**，否则面临罚款（UK GDPR 最高 £17.5M 或全球营收 4%）。

## 1. 法律依据框架

| 法规 | 适用范围 | 关键要求 |
|---|---|---|
| **UK GDPR / EU GDPR** | 处理欧盟/英国境内个人数据 | 合法基础、目的限制、数据最小化、存储期限、数据主体权利 |
| **PECR**（英国）/ ePrivacy | 电子营销（邮件/短信/电话） | 企业邮箱冷邮件需满足「soft opt-in」或「合法利益 + 显著退订」 |
| **CAN-SPAM**（美国） | 发给美国主体 | 真实发件人、清晰退订、10 日内处理退订 |
| **LinkedIn ToS** | 平台自动化 | **禁止**自动加好友/群发，违者封号 |

## 2. 本项目的合规设计（已内建）

| 措施 | 落地位置 |
|---|---|
| **合法利益基础** | `config/settings.json → compliance.lawfulBasis` |
| **数据最小化** | 只存业务联系信息；不存个人隐私（私人手机、住址等）；`storeRawHtml=false` 不留原始网页 |
| **退订机制** | 二期发送必带退订链接；退订写入 `suppression_list` |
| **抑制名单优先** | 任何发送前查 `suppression_list`；`db/schema.sql` 有 `v_compliance_risk` 视图监控违规发送 |
| **同意记录** | `send_log` 记录发送人、审批人、时间、模板（取证用） |
| **保留期限** | `compliance.retentionDays = 365`，到期清理 |
| **LinkedIn 自动化关闭** | `compliance.linkedInAutomation = false`（默认） |
| **人工审批** | `icp.json → outreach.requireHumanApproval = true`，发送前必须人工放行 |
| **审计留痕** | `audit_log` 表 + 每次打分的 `breakdown_json` |

## 3. 数据主体权利（收到请求时怎么办）

| 请求 | 动作 |
|---|---|
| 访问（SAR） | 从 `companies` + `contacts` + `scores` 导出该邮箱/域名的全部记录 |
| 删除 | 删除 `contacts` 记录 + 将域名/邮箱加入 `suppression_list`（理由 `legal`） |
| 反对处理 | 同删除，加入抑制名单 |
| 退订 | 加入 `suppression_list`，理由 `unsubscribe`，立即生效 |

**响应期限**：UK GDPR 要求 1 个月内。

## 4. 抓取（爬虫）合规

- 遵守目标站 `robots.txt`（`settings.json → search.respectRobotsTxt = true`）
- 请求带明确 `User-Agent` 与联系方式（`settings.search.userAgent`）
- 限速：`rateLimit.requestsPerMinute = 20`
- 只抓公开页面，不绕过登录/付费墙

## 5. 发送合规清单（二期上线前逐项确认）

- [ ] 每封邮件含真实发件人（公司名 + 实体地址）
- [ ] 含清晰、可用的退订方式
- [ ] 退订请求 10 日内生效（本项目为即时）
- [ ] 未向 `suppression_list` 中的地址发送
- [ ] 每日发送量 ≤ `outreach.dailySendCap`
- [ ] 邮件通过正规 ESP（带 SPF/DKIM/DMARC），非个人邮箱群发
- [ ] 人工审批开关处于开启状态
- [ ] LinkedIn 未启用自动化

## 6. 免责

本文档为工程实现参考，不构成法律意见。正式对外发送前，建议由法务或合规顾问确认目标市场的具体要求。
