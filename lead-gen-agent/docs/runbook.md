# 运维手册（Runbook）

## 日常操作

| 场景 | 命令 / 操作 |
|---|---|
| 本地验证链路（不花钱、不调 API） | `node scripts/run_local.js` |
| 跑单测 | `node --test tests/scoring.test.js` |
| 改配置后重新生成 n8n 工作流 | `node scripts/build_workflow.js` |
| 单文件打分 | `node scripts/scoring.js --input leads.json --out scored.json` |
| 启动 n8n | `docker start n8n` / 首次见 `docs/n8n_setup.md` |

## 我要调「业务规则」，改哪里？

**永远不要改代码，改 `config/` 下的 JSON。**

| 想做的事 | 改哪个字段 |
|---|---|
| 换目标国家 | `icp.json → target.countries` |
| 换目标行业 | `icp.json → target.industries` |
| 换要抓的客户类型 | `icp.json → target.buyerTypes.accept / partial / reject` |
| 调整客户规模区间 | `icp.json → target.companySize.employees` |
| 调整各维度权重 | `scoring_weights.json → dimensions[].weight`（**改完确保总和仍为 100**） |
| 调整高潜门槛 | `scoring_weights.json → tiers.high`（默认 75） |
| 增删硬过滤规则 | `scoring_weights.json → hardFilters` |
| 增删风险标记 | `scoring_weights.json → riskFlags` |
| 换 LLM / 模型 | `settings.json → llm.baseUrl / llm.model` |
| 控成本（token 预算） | `settings.json → llm.tokenBudgetPerRun` |
| 控并发与限速 | `settings.json → runtime.concurrency / search.rateLimit` |
| 调保留期 | `settings.json → compliance.retentionDays` |

改完**必须**执行：

```bash
node --test tests/scoring.test.js     # 1. 先确认没把引擎改坏
node scripts/build_workflow.js        # 2. 重新生成工作流
# 3. n8n 里重新导入 workflow_01_leadgen.json
```

## 权重调整方法论（重要）

不要凭感觉调。步骤：

1. 用 `node scripts/run_local.js` 跑一批**你已人工判定过**的样例公司
2. 对比算法分层 vs 你的判定，找出偏差
3. 只调偏差对应的那一两个维度权重
4. 重跑测试 + dry run 验证，直到误差可接受
5. 锁定 `scoring_weights.json` 的 `version`（如 `1.1.0`），记录改动原因

> 评分是**确定性**的：同样的输入永远得到同样的分数。所以任何权重改动的影响都可精确回归——这是它比「让 LLM 直接打分」可靠的根本原因。

## 监控指标（`logs/metrics.jsonl`）

| 指标 | 健康区间 | 异常处理 |
|---|---|---|
| `filtered_rate` | 30%–70% | 过低=过滤失效（垃圾进）；过高=关键词太窄或 ICP 太严 |
| `high_rate` | 5%–25% | 过高=门槛太低；过低=门槛太高或市场不匹配 |
| `llm_error_rate` | < 2% | 升高=Key 失效/限流/模型降级 |
| `token_cost_per_run` | 按预算 | 超预算=减少 `maxLeads` 或缩短 `pageText` |
| `duplicate_rate` | < 10% | 升高=去重键需调整 |

## 事故处理

| 情况 | 处理 |
|---|---|
| 工作流中途失败 | n8n → Executions 看失败节点；修复后重跑（幂等：按 domain 去重，可安全重跑） |
| LLM 返回脏 JSON | 检查该节点输出；Prompt 已要求严格 JSON，若某模型不遵守则换模型 |
| 搜索额度耗尽 | 暂停工作流，换 Key 或降低 `maxKeywords` |
| 误报高分客户 | 不是 bug，是 ICP 待调：把该案例加入样例集，按上节方法论调权重 |
| 收到退订 | 立即写入 `suppression_list`；确认后续发送节点会查该表 |

## 发布与回滚

- 所有产出（工作流 JSON、配置）建议纳入 Git；`logs/`、`.env`、`*.db` 已在 `.gitignore` 中排除
- 回滚：`git revert` 配置改动 → 重跑 `build_workflow.js` → 重新导入
- 每次改配置在 `audit_log` 记一条（谁、何时、改了什么、为什么）
