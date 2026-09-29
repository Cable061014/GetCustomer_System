# Codex CLI 任务书

> 用途：让 OpenAI Codex CLI 在本仓库内继续开发 / 扩展本项目。
> 用法：在项目根目录 `lead-gen-agent/` 启动 Codex CLI，把下面「任务」段整段贴给它。

---

## 给 Codex 的项目上下文（每次对话先贴这段）

```
这是一个企业级 AI 自动化获客项目（B2B lead generation），技术栈：Node.js(零依赖) + n8n + LLM。

架构铁律（必须遵守）：
1. 业务规则全部外置到 config/*.json，禁止硬编码到代码或 Prompt 里。
2. 评分引擎的唯一真源是 scripts/scoring.core.js。该文件必须是纯函数、零依赖（禁止 require/fs/process），
   因为它会被 scripts/build_workflow.js 内联进 n8n Code 节点。
3. n8n 工作流 JSON 由 scripts/build_workflow.js 生成，禁止手改 n8n/workflow_01_leadgen.json。
4. 任何改动后必须通过：node --test tests/scoring.test.js
5. 计分必须确定性、可解释（每个维度产出 reason），保留审计字段。
6. 合规红线：不得绕过 suppression_list 发送；LinkedIn 自动化保持关闭；不得存储个人隐私数据。

目录职责：
  config/     业务配置（ICP、权重、运行参数）——改规则改这里
  prompts/    LLM 提示词（系统人格 + 各任务）
  scripts/    scoring.core.js(评分真源) / normalize.js(清洗去重) / build_workflow.js / scoring.js(CLI) / run_local.js(干跑)
  n8n/        生成的工作流（勿手改）
  db/         schema.sql 数据模型
  tests/      单测 + 样例数据
  docs/       部署、合规、运维手册

常用命令：
  node --test tests/scoring.test.js     # 测试
  node scripts/run_local.js             # 本地干跑全链路
  node scripts/build_workflow.js        # 重新生成 n8n 工作流
  node scripts/scoring.js --input x.json --out y.json
```

---

## 任务 A：新增一个评分维度（示例：合规风险维度）

```text
在 scripts/scoring.core.js 的 RULE_IMPL 中新增一种规则类型，并在 config/scoring_weights.json 增加维度。
要求：
- 新维度能识别「疑似同行/竞品」并给 0 分
- 权重总和仍为 100（从其他维度按比例让出）
- 在 tests/scoring.test.js 增加至少 2 条用例覆盖正反两面
- 跑通测试与 node scripts/run_local.js
```

## 任务 B：接入真实 CRM（二期）

```text
目标：把评分后的高潜客户写入 CRM，并遵守 db/schema.sql 的数据模型。
要求：
- 凭据只从环境变量读（CRM_BASE_URL / CRM_TOKEN），禁止写入 config
- 写入前先查 suppression_list
- 写失败要重试（指数退避）且幂等（按 domain 去重）
- 在 scripts/ 下新增 crm_sync.js，并在 docs/runbook.md 补充用法
```

## 任务 C：二期触达工作流

```text
目标：新增 n8n/workflow_02_outreach.json（同样由 build_workflow.js 生成）。
链路：读 high 客户 → 生成开发信 → 人工审批关卡 → 发送 → 监听回复 → 意向判断 → 通知人工接管
要求：
- 复用 prompts/03_intent_judge.md
- 发送前强制查 suppression_list，命中即跳过
- 每日发送量受 config/icp.json 的 outreach.dailySendCap 约束
- 退订回复必须自动写入 suppression_list
```

## 任务 D：可观测性

```text
目标：把 docs/runbook.md 里的指标真正落地。
要求：
- 新增 scripts/metrics.js，从 logs/ 汇总 filtered_rate / high_rate / llm_error_rate / duplicate_rate
- 输出人类可读报表 + metrics.jsonl 追加写
```

---

## 验收标准（任何任务都适用）

- [ ] `node --test tests/scoring.test.js` 全绿
- [ ] `node scripts/run_local.js` 正常运行并产出一致结果
- [ ] `node scripts/build_workflow.js` 生成的工作流无断链
- [ ] 无硬编码业务规则（都在 config/）
- [ ] 未新增第三方 npm 依赖（除非明确批准）
- [ ] 相关 docs 已同步更新
