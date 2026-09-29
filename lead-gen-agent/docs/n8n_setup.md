# n8n 部署与导入指南

> 目标：从零把 n8n 跑起来并导入本项目的 V1 工作流。

## 1. 前置条件

- Docker Desktop（Windows/macOS）或一台 Linux 服务器
- 一个 LLM API Key（OpenAI / DeepSeek / 通义 / 本地 Ollama 均可）
- 一个搜索 API Key（SerpAPI，注册后有免费额度）

## 2. 启动 n8n（Docker）

在项目根目录 `lead-gen-agent/` 下执行：

```bash
docker run -d --name n8n -p 5678:5678 \
  --env-file .env \
  -e N8N_SECURE_COOKIE=false \
  -e N8N_BLOCK_ENV_ACCESS_IN_NODE=false \
  -e N8N_RESTRICT_FILE_ACCESS_TO=/data/exports \
  -v n8n_data:/home/node/.n8n \
  -v "$(pwd)/n8n:/data/workflows" \
  -v "$(pwd)/logs/exports:/data/exports" \
  n8nio/n8n
```

Windows PowerShell 版（路径写法不同）：

```powershell
docker run -d --name n8n -p 5678:5678 `
  --env-file .env `
  -e N8N_SECURE_COOKIE=false `
  -e N8N_BLOCK_ENV_ACCESS_IN_NODE=false `
  -e N8N_RESTRICT_FILE_ACCESS_TO=/data/exports `
  -v n8n_data:/home/node/.n8n `
  -v "${PWD}/n8n:/data/workflows" `
  -v "${PWD}/logs/exports:/data/exports" `
  n8nio/n8n
```

Windows CMD 版（单行，续行符和 $(pwd) 都不认）：

```cmd
docker run -d --name n8n -p 5678:5678 --env-file .env -e N8N_SECURE_COOKIE=false -e N8N_BLOCK_ENV_ACCESS_IN_NODE=false -e N8N_RESTRICT_FILE_ACCESS_TO=/data/exports -v n8n_data:/home/node/.n8n -v "%CD%\n8n:/data/workflows" -v "%CD%\logs\exports:/data/exports" n8nio/n8n
```

**关键点**
- `--env-file .env`：把 `LLM_API_KEY`、`SERP_API_KEY` 注入容器，工作流用 `$env.LLM_API_KEY` 读取。
- `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`：允许节点访问环境变量（否则取不到 Key）。
- `N8N_RESTRICT_FILE_ACCESS_TO=/data/exports`：**必须**。新版 n8n 默认禁止文件节点访问任意路径，不加这个，最后的写盘节点会报「不允许访问该文件」。
- `-v .../logs/exports:/data/exports`：工作流最后一步把 CSV 写到容器内 `/data/exports`，即宿主机 `logs/exports/`。

## 3. 初始化账号

浏览器打开 http://localhost:5678 → 创建 owner 账号（本地实例，邮箱可随便填，但**务必记住密码**）。

## 4. 导入工作流

1. 左侧 **Workflows → Add workflow → Import from File**
2. 选择 `n8n/workflow_01_leadgen.json`
3. 导入后应看到 14 个节点，从 `Manual Trigger` 一路连到 `Read/Write File 落盘`

## 5. 首次运行

1. 打开 `Set 输入参数` 节点，改成你的目标，例如：
   - `country`: `United Kingdom`
   - `industry`: `outdoor furniture`
   - `maxLeads`: `20`
2. 点击底部 **Execute Workflow**
3. 观察每个节点的输出；结束后在 `logs/exports/` 下拿到 CSV 与 JSON

## 6. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `401 Unauthorized` | Key 未注入或写错 | 检查 `.env`，重启容器；确认 `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` |
| `$env` 取不到值 | 容器没带 `--env-file` | 用 `docker exec n8n env \| grep LLM` 验证 |
| 搜索返回空 | SerpAPI 额度用完或关键词太窄 | 查 SerpAPI 后台用量；放宽行业词 |
| LLM 返回非 JSON | 模型不支持 `response_format` | 换支持 JSON 模式的模型，或在 Prompt 里强化“只输出 JSON” |
| `Read/Write File` 报权限 | 挂载目录不可写 | 确认宿主机 `logs/exports` 存在且可写 |
| 节点报 typeVersion 警告 | n8n 版本差异 | 导入时选“Update”，或按提示升级节点版本 |

## 7. 版本与更新

- 配置改了（`config/*.json`）→ 重跑 `node scripts/build_workflow.js` → 重新导入 JSON 覆盖旧工作流。
- **不要**在 n8n 编辑器里手改 Code 节点，会被下次生成覆盖（工作流 meta 里已标注）。
