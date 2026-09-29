# AI 自动化获客系统 · V1

把「业务员手动找客户」变成「AI 按你的标准批量筛选 + 打分」。你只说一句
`帮我找英国户外家具的 B2B 批发商`，系统自动出关键词 → 搜公司 → 分析 → 打分 → 分层导出。

## 对应原始需求

| 需求图 | 本项目落地 |
|---|---|
| 图1 第一版获客流程 | ✅ V1（本仓库已实现）：输入条件 → 关键词 → 搜索 → 分析 → 评分 → 分层导出 |
| 图2 二期触达闭环 | 📋 V2（待建）：CRM → 自动开发信 → 回复监听 → 意向判断 → 人工接管（见 `docs/CODEX_TASK.md` 任务 C） |
| 图3 待建清单 10 项 | ✅ ①–⑨ 已实现，⑩ 测试任务见「快速开始」 |

## 架构一句话

**Codex 负责造工具，n8n 负责跑流程，LLM 负责思考，确定性算法负责打分，人负责成交。**

```
你的一句话
   │
   ▼
[n8n 编排中枢]
   ├─ LLM 生成搜索关键词        (prompts/01_keyword_generator.md)
   ├─ 搜索 API 抓公司            (SerpAPI)
   ├─ LLM 分析公司提取字段       (prompts/02_company_analyst.md)
   ├─ 确定性评分算法打分分层      (scripts/scoring.core.js + config/scoring_weights.json)
   └─ 导出 CSV / 入库            (db/schema.sql)
```

## 目录结构

```
lead-gen-agent/
├── config/          业务配置（改规则只改这里，不动代码）
│   ├── icp.json              理想客户画像：国家/行业/客户类型/规模/买卖信号
│   ├── scoring_weights.json  评分权重、硬过滤、风险标记、分层门槛
│   └── settings.json         运行参数：LLM、搜索、存储、限速、合规
├── prompts/         LLM 提示词
│   ├── system_prompt.md      全局人格（所有节点共用）
│   ├── 01_keyword_generator.md
│   ├── 02_company_analyst.md
│   └── 03_intent_judge.md    二期意向判断
├── scripts/
│   ├── scoring.core.js   ★ 评分真源（纯函数，Node 与 n8n 共用）
│   ├── normalize.js         清洗 / 去重 / 校验
│   ├── run_local.js         本地端到端干跑（不调外部 API）
│   ├── build_workflow.js    把配置+Prompt+引擎编译成 n8n 工作流
│   └── scoring.js           评分 CLI 外壳
├── n8n/workflow_01_leadgen.json   ★ 14 节点，可直接导入
├── db/schema.sql            数据模型（含审计表、抑制名单、合规视图）
├── tests/                   单测 + 样例数据
└── docs/                    部署指南 / 合规说明 / 运维手册 / Codex 任务书
```

## 快速开始

```bash
# 1. 本地验证整条链路（零依赖、不花钱、不需要 API Key）
node scripts/run_local.js

# 2. 跑单测
node --test tests/scoring.test.js

# 3. 改配置后重新生成 n8n 工作流
node scripts/build_workflow.js

# 4. 部署 n8n 并导入工作流 → 见 docs/n8n_setup.md
```

**这一步（图3 第⑩项「第一批测试客户」）**：先跑 `run_local.js` 看分层是否合理；再在 n8n 里用
`英国 + outdoor furniture` 跑 10~20 家，人工核对打分，然后按 `docs/runbook.md` 的「权重调整方法论」微调。

## 企业级特性（已内建）

| 维度 | 实现 |
|---|---|
| **配置与代码分离** | 所有业务规则在 `config/*.json`，改规则不改代码 |
| **确定性 + 可解释** | 每个分数带 `reason` 与 `breakdown`，形成审计轨迹；同输入必同输出（有单测保证） |
| **合规内建** | 抑制名单、退订、数据最小化、保留期、审计表、合规风险视图（`docs/compliance.md`） |
| **安全** | 密钥只走环境变量；`.env`/`logs`/`*.db` 已 gitignore |
| **数据质量** | 域名去重、字段归一化、校验分流（可入库 / 需复核） |
| **可观测** | 结构化日志、`runs`/`scores` 留痕、指标体系见 `docs/runbook.md` |
| **可靠性** | 速率限制、重试退避、幂等（按 domain 去重可安全重跑） |
| **可移植** | 零 npm 依赖（仅 Node 内置）；换 LLM 只改 `baseUrl`+`model` |
| **人机协同** | 高意向强制人工接管；发送前人工审批（`requireHumanApproval`） |
| **可测试** | 评分引擎有 11 条单测；`run_local.js` 离线干跑 |

## 路线图

- **V1（本仓库）**：筛选 + 打分 + 分层导出 ✅
- **V1.1**：接真实 CRM 写入（`docs/CODEX_TASK.md` 任务 B）
- **V2**：自动开发信 + 回复监听 + 意向判断 + 人工接管（任务 C）
- **V2.1**：可观测性看板与指标告警（任务 D）

## 关键设计决策（为什么这么做）

1. **评分用确定性算法，不让 LLM 直接打分** — LLM 只提取事实字段，加减分走固定规则。结果稳定、可回归、可解释、改权重即调优。LLM 打分是黑盒且每次结果飘。
2. **评分引擎单一真源** — `scoring.core.js` 同时被 Node CLI 和 n8n Code 节点使用，避免双份维护导致行为不一致。
3. **工作流由脚本生成** — 配置改了重跑 `build_workflow.js`，不在 n8n 里手改，避免配置与实现脱节。
4. **抑制名单独立且优先** — 合规第一，任何发送前必查。
