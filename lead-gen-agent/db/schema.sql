-- ============================================================
-- AI Lead Gen · 数据模型 (SQLite / 可移植至 Postgres)
-- 设计要点：
--   1. 拆分「公司」「评分」「联系人」「触达」「抑制名单」——各司其职
--   2. 每次运行留痕 (runs)，每次打分留痕 (scores)，满足审计要求
--   3. 抑制名单独立且优先，合规第一
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------- 运行批次：每次工作流执行一条 ----------
CREATE TABLE IF NOT EXISTS runs (
  run_id          TEXT PRIMARY KEY,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  country         TEXT,
  industry        TEXT,
  params_json     TEXT,
  stats_json      TEXT,
  status          TEXT NOT NULL DEFAULT 'running',  -- running|success|failed
  error           TEXT
);

-- ---------- 公司主表：去重键是 domain ----------
CREATE TABLE IF NOT EXISTS companies (
  company_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  domain          TEXT NOT NULL UNIQUE,             -- 去重键
  name            TEXT,
  country         TEXT,
  industry        TEXT,
  buyer_type      TEXT,
  industry_match  TEXT,
  employees       INTEGER,
  revenue_usd     INTEGER,
  import_capable  INTEGER,                          -- 0/1
  signals_text    TEXT,
  website_quality REAL,
  source_url      TEXT,
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  run_id          TEXT REFERENCES runs(run_id)
);

CREATE INDEX IF NOT EXISTS idx_companies_country   ON companies(country);
CREATE INDEX IF NOT EXISTS idx_companies_buyer     ON companies(buyer_type);
CREATE INDEX IF NOT EXISTS idx_companies_seen      ON companies(last_seen_at DESC);

-- ---------- 评分历史：同一公司多次打分保留全部记录 ----------
CREATE TABLE IF NOT EXISTS scores (
  score_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  domain          TEXT NOT NULL REFERENCES companies(domain) ON DELETE CASCADE,
  run_id          TEXT REFERENCES runs(run_id),
  score           REAL NOT NULL,                    -- 原始分
  effective_score REAL NOT NULL,                    -- 排序分（被过滤为 0）
  tier            TEXT NOT NULL,                    -- high|medium|low|filtered
  filtered_keys   TEXT,                             -- 命中过滤器 key，逗号分隔
  risk_flags      TEXT,                             -- 风险标 key，逗号分隔
  breakdown_json  TEXT,                             -- 各维度明细（审计）
  reasons_json    TEXT,                             -- 可读理由（审计）
  weights_version TEXT NOT NULL,
  icp_version     TEXT NOT NULL,
  scored_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scores_tier       ON scores(tier, effective_score DESC);
CREATE INDEX IF NOT EXISTS idx_scores_domain     ON scores(domain, scored_at DESC);

-- ---------- 联系人：一个公司可多条路线 ----------
CREATE TABLE IF NOT EXISTS contacts (
  contact_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  domain          TEXT NOT NULL REFERENCES companies(domain) ON DELETE CASCADE,
  email           TEXT,
  email_type      TEXT,                             -- business|free
  phone           TEXT,
  contact_form    TEXT,
  is_primary      INTEGER NOT NULL DEFAULT 0,
  verified        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  UNIQUE(domain, email)
);

CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);

-- ---------- 抑制名单：退订/投诉/勿扰，任何发送前必须查 ----------
CREATE TABLE IF NOT EXISTS suppression_list (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT UNIQUE,
  domain          TEXT,
  reason          TEXT NOT NULL,                    -- unsubscribe|bounce|complaint|manual|legal
  added_at        TEXT NOT NULL,
  note            TEXT
);

-- ---------- 触达日志：每次外发留痕（合规取证） ----------
CREATE TABLE IF NOT EXISTS send_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT REFERENCES runs(run_id),
  domain          TEXT,
  email           TEXT NOT NULL,
  channel         TEXT NOT NULL,                    -- email|linkedin|whatsapp
  template_id     TEXT,
  subject         TEXT,
  sent_at         TEXT NOT NULL,
  status          TEXT NOT NULL,                    -- queued|sent|failed|bounced|replied
  provider_msg_id TEXT,
  approved_by     TEXT,                             -- 人工审批人（requireHumanApproval）
  error           TEXT
);

CREATE INDEX IF NOT EXISTS idx_send_email ON send_log(email, sent_at DESC);

-- ---------- 审计日志：谁在何时改了什么 ----------
CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  at              TEXT NOT NULL,
  actor           TEXT,
  action          TEXT NOT NULL,                    -- config_change|manual_export|approve_send|...
  entity          TEXT,
  entity_id       TEXT,
  detail_json     TEXT
);

-- ---------- 视图：可直接消费的「高潜客户」 ----------
CREATE VIEW IF NOT EXISTS v_high_potential AS
SELECT
  c.domain, c.name, c.country, c.buyer_type, c.employees,
  s.score, s.effective_score, s.tier, s.risk_flags,
  (SELECT email FROM contacts t WHERE t.domain = c.domain AND t.email_type = 'business' LIMIT 1) AS best_email,
  (SELECT phone FROM contacts t WHERE t.domain = c.domain AND t.phone IS NOT NULL LIMIT 1) AS phone,
  ROW_NUMBER() OVER (ORDER BY s.effective_score DESC) AS rank
FROM companies c
JOIN scores s ON s.domain = c.domain
WHERE s.tier = 'high'
  AND s.scored_at = (SELECT MAX(scored_at) FROM scores x WHERE x.domain = c.domain)
  AND c.domain NOT IN (SELECT domain FROM suppression_list WHERE domain IS NOT NULL);

-- ---------- 视图：合规检查——即将发送但已在抑制名单里的（应为空） ----------
CREATE VIEW IF NOT EXISTS v_compliance_risk AS
SELECT sl.email, sl.domain, sl.sent_at, sup.reason
FROM send_log sl
JOIN suppression_list sup ON sup.email = sl.email
WHERE sl.sent_at >= sup.added_at;
