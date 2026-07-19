---
doc_type: roadmap
slug: character-arc-web
status: active
created: 2026-07-04
last_reviewed: 2026-07-04
tags: [web, deployment, node, postgres, sse, worker]
related_requirements: []
related_architecture: []
---

# CharacterArc Web 平台 Roadmap

## 1. 背景

CharacterArc 当前是 Electron 本地桌面应用（Vue 3 渲染层 + Node 主进程 SQLite + IPC）。目标是将产品迁移为**仅 Web**、部署在与 language-learning 同机的 nginx 后，支持小范围邀请用户、用户自带 AI Key、逐字流式写作、后台自动创作（关浏览器仍继续），以及 `.carc` 一次性导入。

渲染层 `renderer/` 可大量复用；`electron/main/` 业务与 AI 逻辑迁入 Node 服务；数据从 SQLite 迁至 PostgreSQL（`character_arc` 库，与 `language_learning` 同实例）。

## 2. 范围与明确不做

### 本 roadmap 覆盖

- Node API + Worker 双进程架构
- PostgreSQL 多用户数据模型（一用户多项目，严格 userId 隔离）
- JWT 认证 + 邀请码注册 + Admin 发码
- 用户 BYOK（DeepSeek + OpenAI-compatible，与 language-learning 一致）
- REST 工作区 API（替代 IPC 持久化）
- SSE 逐字流式 AI（章节初稿、章节助手、全局助手等）
- WebSocket 自动创作进度 + 后台 Job 队列
- 服务器磁盘文件存储（封面、参考小说、project-skills）
- `.carc` / workspace 一次性导入
- nginx 同机部署（`/character-arc/`）
- `renderer/` 改造为 Web SPA（`window.characterArc` → HTTP 客户端）

### 明确不做

- **Electron 桌面版维护**——Web 上线后桌面停更
- **公开注册**——仅邀请码
- **Anthropic / Ollama 等桌面 Provider**——v1 仅 DeepSeek + OpenAI-compatible
- **平台统一 AI Key**——v1 仅 BYOK
- **分享链接 / 协作编辑**——纯私有
- **用量配额 / 计费**——v1 无限制
- **对象存储（S3/COS）**——v1 服务器磁盘
- **双端实时同步**——无 Electron↔Web 同步
- **离线 / PWA**——始终在线

## 3. 模块拆分（概设）

```
character-arc-web
├── M1  平台基建        — JWT、邀请、BYOK、PG、加密、健康检查
├── M2  工作区 API      — 项目/大纲/章节/角色等 CRUD + 快照读写
├── M3  文件与导入      — 磁盘 upload、.carc 导入、内置 skills 扫描
├── M4  AI 运行时       — 从 electron/main/ai 迁入，Provider 网关
├── M5  流式协议        — SSE token 流 + 错误/完成事件
├── M6  后台任务        — auto_creation_jobs + Worker + WS 进度
├── M7  Web 前端壳      — renderer 改造 + 最小 auth SPA（P0）
└── M8  部署与运维      — nginx、deploy 脚本、迁移工具
```

### M1 · 平台基建

- **职责**：用户表、邀请码、JWT 会话、BYOK 加密存储、DB 连接、Admin 角色
- **承载的子 feature**：`web-p0-foundation`
- **触碰的现有代码**：全新 `server/`

### M2 · 工作区 API

- **职责**：将 `workspace-store.ts` 读写改为 REST；所有 project 级表加 `user_id`；debounced save 改 PATCH
- **承载的子 feature**：`web-workspace-api`
- **触碰的现有代码**：`electron/main/workspace-store.ts`（逻辑参考）、`renderer/src/features/workspace/`

### M3 · 文件与导入

- **职责**：multipart 上传、路径 `{dataRoot}/users/{userId}/...`；`.carc` 解析复用 `project-archive.ts`
- **承载的子 feature**：`web-file-uploads`, `web-project-import`
- **触碰的现有代码**：`electron/main/archive/`

### M4 · AI 运行时

- **职责**：`runAiTask` / `streamAiTask` / agent loop / skills / tasks 注册表
- **承载的子 feature**：`web-ai-pipeline-port`
- **触碰的现有代码**：`electron/main/ai/**` 整包迁入 `server/src/ai/`

### M5 · 流式协议

- **职责**：SSE 端点、Event 格式、TipTap 接入层
- **承载的子 feature**：`web-ai-sse-streaming`
- **触碰的现有代码**：`renderer/src/features/ai/`、`chapterStreamClient.ts`

### M6 · 后台任务

- **职责**：Job 持久化、Worker 消费、断点续跑、WS 推送
- **承载的子 feature**：`web-auto-creation-worker`
- **触碰的现有代码**：`renderer/src/features/autoCreation/**`

### M7 · Web 前端壳

- **职责**：auth 路由、API 客户端、`renderer/` base path 与 IPC 替换
- **承载的子 feature**：`web-p0-foundation`（最小 SPA）、`web-renderer-migration`
- **触碰的现有代码**：`renderer/`、`web/`（P0 临时壳）

### M8 · 部署与运维

- **职责**：nginx 片段、deploy 脚本、env 模板、DB migrate
- **承载的子 feature**：`web-p0-foundation`, `web-e2e-deploy`
- **触碰的现有代码**：参考 `languageLearning/tools/deploy.ps1`

## 4. 模块间接口契约 / 共享协议

> 详细表结构、SSE 帧、Job 状态机见 `.codestable/features/2026-07-04-web-platform-design/web-platform-design.md`。

### 4.1 认证 API（M1 → M7）

**方向**：Web SPA → Node API  
**前缀**：`/api/character-arc/v1`

```
POST /auth/register
Request:  { email: string, password: string, inviteCode: string }
Response: { accessToken: string, refreshToken: string, user: UserRead }
错误：    400 validation_error, 403 invite_invalid, 409 email_taken

POST /auth/login
Request:  { email: string, password: string }
Response: { accessToken: string, refreshToken: string, user: UserRead }
错误：    401 invalid_credentials

POST /auth/refresh
Request:  { refreshToken: string }
Response: { accessToken: string, refreshToken: string }
错误：    401 token_invalid

GET /auth/me
Headers:  Authorization: Bearer {accessToken}
Response: UserRead
错误：    401 unauthorized

UserRead = { id: uuid, email: string, role: 'USER' | 'ADMIN', createdAt: ISO8601 }
```

**约束**：
- 无 `inviteCode` 或码无效 → 403，不创建用户
- Access token 15min，Refresh 7d（与 language-learning 对齐）
- 401 响应体：`{ code: string, message: string }`

### 4.2 Admin 邀请码（M1）

```
POST /admin/invite-codes
Headers:  Bearer + ROLE_ADMIN
Request:  { maxUses?: number, expiresAt?: ISO8601, note?: string }
Response: { code: string, maxUses: number, expiresAt: string | null }

GET /admin/invite-codes
Response: InviteCodeRead[]
```

### 4.3 用户 BYOK（M1 → M4）

```
GET /users/me/ai-config
Response: { provider: 'deepseek'|'openai-compatible', model: string, baseUrl: string, hasApiKey: boolean }

PUT /users/me/ai-config
Request:  { provider, model, baseUrl, apiKey?: string }
Response: 同上（apiKey 永不回明文）

POST /users/me/ai-config/test
Response: { ok: boolean, latencyMs: number, model: string }
错误：    503 ai_unavailable
```

**约束**：
- `apiKey` 存 `user_ai_configs.api_key_enc`（AES-256-GCM，密钥 `ENCRYPTION_KEY` env）
- M4 调用前必须解密；无 Key → 503 `ai_not_configured`
- 每次 AI 调用写 `ai_call_logs`（userId, feature, tokens, latency, success）

### 4.4 工作区快照（M2 → M7）

```
GET /projects
Response: ProjectSummary[]

POST /projects
Request:  { title, genre, ... }
Response: ProjectRead

GET /projects/{projectId}/workspace
Response: WorkspaceSnapshot（与 @shared 类型对齐 + server 校验）

PUT /projects/{projectId}/workspace
Request:  WorkspaceSnapshot
Response: { savedAt: ISO8601 }

PATCH /projects/{projectId}/workspace
Request:  PartialWorkspacePatch（debounced 字段级更新，v2 可细化）
```

**约束**：
- 所有 `{projectId}` 路由必须校验 `projects.user_id = auth.userId`
- 校验失败 → 404（不暴露存在性）

### 4.5 SSE 流式 AI（M4 + M5 → M7）

```
POST /projects/{projectId}/ai/stream
Headers:  Authorization, Accept: text/event-stream
Request:  AiStreamRequest {
  task: 'chapter-first-draft' | 'chapter-assistant' | 'chapter-memo' | 'chapter-audit' | 'global-assistant',
  chapterId?: string,
  input: Record<string, unknown>,
  signal?: never
}
Response: text/event-stream
```

**SSE 事件帧**（详见 platform design §3）：

```
event: meta
data: {"runId":"...","task":"chapter-first-draft","model":"..."}

event: token
data: {"delta":"文字片段"}

event: tool
data: {"name":"skill_load","status":"start"|"end"}

event: error
data: {"code":"ai_unavailable","message":"..."}

event: done
data: {"runId":"...","usage":{"promptTokens":0,"completionTokens":0}}
```

**约束**：
- 客户端断开 → server abort signal，停止 LLM
- nginx `proxy_read_timeout` ≥ 600s（API）、3600s（WS）
- 非流式任务走 `POST .../ai/run` 同步 JSON

### 4.6 自动创作 Job（M6 → M7）

```
POST /projects/{projectId}/auto-creation/runs
Request:  { volumeId: string, config: AutoCreationConfig }
Response: { runId: uuid, status: 'queued' }

GET /projects/{projectId}/auto-creation/runs/{runId}
Response: AutoCreationRunRead

POST .../runs/{runId}/pause
POST .../runs/{runId}/resume
POST .../runs/{runId}/cancel
```

**WebSocket**（M6 → M7）：

```
WS /ws/character-arc/auto-creation?token={accessToken}
Client → { type: 'subscribe', runId: string }
Server → AutoCreationWsEvent（见 platform design §4）
```

**约束**：
- Worker 与 API 共享 PG job 表；仅 Worker 写 `status` 推进
- `paused` + `pauseReason=api_error` 可 resume
- 浏览器关闭不影响 Worker

### 4.7 文件上传（M3）

```
POST /projects/{projectId}/files/upload
Content-Type: multipart/form-data
Fields:   file, purpose: 'cover'|'reference-novel'|'project-skill'
Response: { fileId: uuid, path: string, url: string }
```

**磁盘布局**：

```
/opt/character-arc/data/
├── builtin/skills/          # 打包内置，只读
└── users/{userId}/
    ├── projects/{projectId}/covers/
    ├── reference-novels/
    └── project-skills/
```

### 4.8 项目导入（M3）

```
POST /projects/import
Content-Type: multipart/form-data
Fields:   file (.carc), mode: 'create'|'merge'
Response: { projectId: string, importedCounts: {...} }
```

### 4.9 nginx 路由（M8）

```
location /character-arc/ {
  alias /opt/character-arc/dist/;
  try_files $uri $uri/ /character-arc/index.html;
}
location /api/character-arc/ {
  proxy_pass http://127.0.0.1:8010/api/character-arc/;
  proxy_read_timeout 600s;
}
location /ws/character-arc/ {
  proxy_pass http://127.0.0.1:8010/ws/character-arc/;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_read_timeout 3600s;
}
```

## 5. 子 feature 清单

1. **web-p0-foundation** — Node API 骨架、PG 用户/邀请/BYOK 表、JWT、最小 Web SPA 登录注册、nginx 片段、本地 dev 可跑
   - 模块：M1, M7, M8
   - 依赖：无
   - 状态：in-progress
   - feature：`2026-07-04-web-p0-foundation`
   - **最小闭环**：邀请注册 → 登录 → 配置 BYOK → 测试连接

2. **web-workspace-api** — 工作区 REST + PG schema 迁移（projects 及以下表 + user_id）
   - 模块：M2
   - 依赖：web-p0-foundation
   - 状态：planned

3. **web-renderer-migration** — `lib/characterArcClient.ts` 替换 IPC；Vite base `/character-arc/`；Pinia 持久化改 API
   - 模块：M7
   - 依赖：web-workspace-api
   - 状态：planned

4. **web-ai-pipeline-port** — `electron/main/ai` → `server/src/ai`，BYOK 注入
   - 模块：M4
   - 依赖：web-p0-foundation, web-workspace-api
   - 状态：planned

5. **web-ai-sse-streaming** — SSE 端点 + TipTap/助手流式接入
   - 模块：M5, M4
   - 依赖：web-ai-pipeline-port
   - 状态：planned

6. **web-auto-creation-worker** — Job 表 + Worker + WS 进度，迁入 pipeline
   - 模块：M6
   - 依赖：web-ai-sse-streaming, web-workspace-api
   - 状态：planned

7. **web-file-uploads** — 封面/参考小说/Skill 包上传
   - 模块：M3
   - 依赖：web-workspace-api
   - 状态：planned

8. **web-project-import** — `.carc` 导入 API + CLI
   - 模块：M3
   - 依赖：web-workspace-api
   - 状态：planned

9. **web-remaining-modules** — 封面工作台、拆书库、全局助手 UI、Skills 页等 IPC 剩余面
   - 模块：M2, M7
   - 依赖：web-ai-sse-streaming, web-file-uploads
   - 状态：planned

10. **web-e2e-deploy** — Playwright 冒烟 + `deploy-character-arc.ps1` 生产发布
    - 模块：M8
    - 依赖：web-remaining-modules, web-auto-creation-worker
    - 状态：planned

**最小闭环**：第 1 条 `web-p0-foundation` 完成后可演示「邀请注册 → 登录 → 配 Key → 测试 AI 连接」。

## 6. 排期思路

- **P0（2–3 周）**：条目 1 — 基建与空壳可登录
- **P1（2–3 周）**：条目 2–3 — 能打开项目、编辑并保存
- **P2（2–3 周）**：条目 4–5 — 流式写作可用
- **P3（1–2 周）**：条目 6 — 后台自动创作
- **P4（3–4 周）**：条目 7–9 — 全功能补齐
- **P5（1 周）**：条目 10 — 上线

卡点：SSE 与 Agent loop 在 DeepSeek 上的 tool-use 支持需 spike；Worker 需 Redis 或 pg-boss 选型（v1 建议 **pg-boss**，少依赖）。

## 7. 观察项

- 桌面 `story-state-store.ts` 表需在 PG 迁移中一并纳入（web-workspace-api 阶段确认）
- `assistant_sessions` runtime-v2 表与 Web 全局助手是否合并 — 实现时对照 `electron/main/ai/runtime-v2/`
- language-learning 同机 PostgreSQL  credentials 与 `character_arc` 建库权限需运维确认

## 8. 变更日志

- 2026-07-04：初版；用户拍板 14 项决策归档
