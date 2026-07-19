---
doc_type: feature-design
feature: 2026-07-04-web-platform-design
roadmap: character-arc-web
roadmap_item: web-p0-foundation
status: approved
summary: CharacterArc Web 平台级设计——PostgreSQL schema（自 SQLite 映射 + user_id）、SSE 流式协议、自动创作 Job 状态机
tags: [web, postgres, sse, worker, schema]
---

# Web Platform Design

> 本设计是 `character-arc-web` roadmap 第 4 节接口契约的展开版，后续子 feature 不得违反；变更需先 `cs-roadmap update`。

## 0. 术语

| 术语 | 定义 |
|------|------|
| **WorkspaceSnapshot** | 与桌面版 Pinia 持久化结构对齐的 JSON 快照 |
| **BYOK** | 用户自带 AI API Key，加密存 `user_ai_configs` |
| **Job** | `auto_creation_runs` 表一行，Worker 异步消费 |

## 1. 决策摘要（用户已拍板）

- 完整 Web、仅 Web、后台自动创作、邀请制、一次性导入、一用户多项目
- BYOK、DeepSeek + OpenAI-compatible、必须 SSE 逐字流式
- Node 后端、同机 nginx、磁盘存储、纯私有、无配额

## 2. PostgreSQL Schema

### 2.1 平台表（M1）

```sql
-- 用户
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('USER', 'ADMIN')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 邀请码
CREATE TABLE invite_codes (
  code        TEXT PRIMARY KEY,
  created_by  UUID REFERENCES users(id),
  max_uses    INT NOT NULL DEFAULT 1,
  used_count  INT NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE invite_code_redemptions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code       TEXT NOT NULL REFERENCES invite_codes(code),
  user_id    UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (code, user_id)
);

-- 用户 BYOK
CREATE TABLE user_ai_configs (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider       TEXT NOT NULL CHECK (provider IN ('deepseek', 'openai-compatible')),
  model          TEXT NOT NULL,
  base_url       TEXT NOT NULL,
  api_key_enc    TEXT NOT NULL DEFAULT '',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- AI 调用日志
CREATE TABLE ai_call_logs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id),
  project_id         TEXT,
  feature            TEXT NOT NULL,
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  prompt_tokens      INT NOT NULL DEFAULT 0,
  completion_tokens  INT NOT NULL DEFAULT 0,
  total_tokens       INT NOT NULL DEFAULT 0,
  latency_ms         INT NOT NULL DEFAULT 0,
  success            BOOLEAN NOT NULL,
  error_message      TEXT NOT NULL DEFAULT '',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ai_call_logs_user_created ON ai_call_logs (user_id, created_at DESC);
```

### 2.2 工作区表（M2）——自 SQLite 映射

所有原 `project_id` 表增加：

```sql
ALTER 语义（新建时直接包含）:
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
```

**projects**（原 SQLite `projects` + 归属）：

```sql
CREATE TABLE projects (
  id                            TEXT PRIMARY KEY,
  user_id                       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                         TEXT NOT NULL,
  genre                         TEXT NOT NULL,
  novel_length                  TEXT NOT NULL DEFAULT 'long',
  word_count                    TEXT NOT NULL,
  last_edited                   TIMESTAMPTZ NOT NULL,
  cover                         TEXT NOT NULL DEFAULT '',
  target_platform               TEXT NOT NULL DEFAULT '',
  cover_history_json            JSONB NOT NULL DEFAULT '[]',
  reference_works_json          JSONB NOT NULL DEFAULT '[]',
  writing_style_preset_id       TEXT NOT NULL DEFAULT 'cinematic-cool',
  writing_style_prompt          TEXT NOT NULL DEFAULT '',
  novel_workflow_stages_json    JSONB NOT NULL DEFAULT '[]',
  project_skills_json           JSONB NOT NULL DEFAULT '[]',
  chapter_assistant_templates_json JSONB NOT NULL DEFAULT '[]',
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX projects_user ON projects (user_id, updated_at DESC);
```

**子表**（结构同 `workspace-store.ts`，均含 `project_id` + FK CASCADE）：

- `worldview_entries`, `characters`, `organizations`, `character_relationships`
- `organization_memberships`, `inspiration_entries`
- `outline_volumes`, `outline_items`, `chapters`, `chapter_versions`
- `ai_messages`, `knowledge_documents`, `reference_works`, `ai_runs`
- `workflow_documents`, `plot_threads`, `assistant_sessions`, `cover_workbench_history`

**用户级设置**（原 `app_settings` 拆分）：

```sql
CREATE TABLE user_app_settings (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme                TEXT NOT NULL DEFAULT 'light',
  selected_project_id  TEXT,
  auto_save_interval   TEXT NOT NULL DEFAULT '3000',
  ui_scale             REAL NOT NULL DEFAULT 1,
  dark_mode            BOOLEAN NOT NULL DEFAULT false,
  dark_mode_style      TEXT NOT NULL DEFAULT 'standard',
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

> Provider/Model/Key 不再存 `app_settings`，统一走 `user_ai_configs`（BYOK）。

**story-state** 表（`story-state-store.ts`）在 `web-workspace-api` 阶段按同规则加 `project_id` FK 迁入。

### 2.3 文件索引（M3）

```sql
CREATE TABLE user_files (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('cover','reference-novel','project-skill','export')),
  file_name   TEXT NOT NULL,
  disk_path   TEXT NOT NULL,
  mime_type   TEXT NOT NULL DEFAULT '',
  size_bytes  BIGINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX user_files_project ON user_files (project_id);
```

### 2.4 自动创作 Job（M6）

```sql
CREATE TABLE auto_creation_runs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  volume_id             TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN (
                          'queued','running','paused','completed','failed','cancelled'
                        )),
  pause_reason          TEXT CHECK (pause_reason IN ('user','api_error','config_error','quality_limit')),
  pause_message         TEXT NOT NULL DEFAULT '',
  config_json           JSONB NOT NULL,
  chapter_queue_json    JSONB NOT NULL DEFAULT '[]',
  current_index         INT NOT NULL DEFAULT 0,
  current_step          TEXT,
  completed_chapter_ids JSONB NOT NULL DEFAULT '[]',
  skipped_chapter_ids   JSONB NOT NULL DEFAULT '[]',
  failed_chapter_id     TEXT,
  worker_id             TEXT,
  started_at            TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at           TIMESTAMPTZ
);
CREATE INDEX auto_creation_runs_active ON auto_creation_runs (status) WHERE status IN ('queued','running','paused');
```

## 3. SSE 流式协议（M5）

### 3.1 请求

```
POST /api/character-arc/v1/projects/{projectId}/ai/stream
Content-Type: application/json
Accept: text/event-stream
Authorization: Bearer {accessToken}

{
  "task": "chapter-first-draft",
  "chapterId": "chapter-xxx",
  "input": { /* task-specific，与桌面 AiTask payload 对齐 */ }
}
```

### 3.2 响应

`Content-Type: text/event-stream; charset=utf-8`  
`Cache-Control: no-cache`  
`Connection: keep-alive`

每条 SSE 消息：

```
event: {eventName}
data: {json}\n\n
```

### 3.3 事件类型

| event | data 字段 | 说明 |
|-------|-----------|------|
| `meta` | `{ runId, task, provider, model }` | 流开始 |
| `token` | `{ delta: string }` | 正文增量，TipTap 追加 |
| `json` | `{ partial: object }` | JSON 任务中间态（audit 等） |
| `tool` | `{ name, status: 'start'\|'end', detail? }` | Agent tool 调用 |
| `warning` | `{ code, message }` | 非致命（如 post-generation） |
| `error` | `{ code, message }` | 致命；随后发 `done` 或断流 |
| `done` | `{ runId, usage?, output? }` | 正常结束 |

**错误码**：`ai_not_configured` | `ai_unavailable` | `task_invalid` | `project_forbidden` | `rate_limited`（预留）

### 3.4 客户端约定

- 使用 `fetch` + `ReadableStream` 或 `@microsoft/fetch-event-source`（需自定义 headers）
- 收到 `error` 后停止读取；用户取消 → `AbortController.abort()` → server 终止 LLM
- TipTap：仅 `token.delta` 追加到编辑器；`done.output` 可含最终结构化结果

## 4. 自动创作 Job 状态机（M6）

### 4.1 状态

```
queued → running → completed
              � ↘ failed
              paused → running (resume)
              ↘ cancelled
```

| status | 含义 |
|--------|------|
| `queued` | API 已入库，Worker 未认领 |
| `running` | Worker 执行中 |
| `paused` | 用户暂停或 api_error/config_error/quality_limit |
| `completed` | 队列全部处理完 |
| `failed` | 不可恢复错误 |
| `cancelled` | 用户取消 |

### 4.2 步骤（current_step）

与桌面 `AutoCreationChapterStep` 一致：

`ensure-chapter` → `acceptance-check` → `load-advice` → `memo` → `first-draft` → `audit` → `repair` → `final-gate` → `session-note` → `persist`

### 4.3 Worker 行为

1. `SELECT ... FOR UPDATE SKIP LOCKED` 认领 `queued` 或 `paused`+`api_error`
2. 每步完成更新 `current_step`、`updated_at`
3. `api_error` → `paused` + `pause_reason=api_error`，写 `pause_message`
4. 用户 `resume` → `status=queued`（或 `running` 若 Worker 立即认领）
5. 章节完成后追加 `completed_chapter_ids`；跳过追加 `skipped_chapter_ids`

### 4.4 WebSocket 事件

```typescript
type AutoCreationWsEvent =
  | { type: 'run-status'; runId: string; status: AutoCreationRunStatus; pauseReason?: string; message?: string }
  | { type: 'chapter-start'; runId: string; chapterId: string; index: number; total: number }
  | { type: 'step-progress'; runId: string; chapterId: string; step: AutoCreationChapterStep; message?: string }
  | { type: 'chapter-complete'; runId: string; chapterId: string; skipped?: boolean }
  | { type: 'run-complete'; runId: string; completedCount: number; skippedCount: number }
  | { type: 'run-error'; runId: string; chapterId?: string; code: string; message: string }
```

连接：`WS /ws/character-arc/auto-creation?token={accessToken}`  
订阅：`{ type: 'subscribe', runId: string }`

### 4.5 队列选型

v1 使用 **pg-boss**（PostgreSQL 队列，与主库同实例，无 Redis 依赖）。Job name: `auto-creation.run`，payload: `{ runId }`。

## 5. 加密与密钥

| 用途 | 机制 |
|------|------|
| 密码 | bcrypt cost=10 |
| BYOK apiKey | AES-256-GCM，密钥 `ENCRYPTION_KEY`（32 byte base64 env） |
| JWT | HS256，`JWT_SECRET` env |

## 6. 明确不做（设计层）

- 桌面 IPC 兼容层
- 多 Provider 超出 deepseek / openai-compatible
- 对象存储
- 实时协作

## 7. P0 范围边界

P0 **仅实现** §2.1 平台表 + §1 认证 API + §2.3 不含 + 最小 SPA。  
§2.2 工作区表、`§3 SSE`、`§4 Job` 在后续 feature 实现。
