---
doc_type: feature-design
feature: 2026-07-04-web-p0-foundation
roadmap: character-arc-web
roadmap_item: web-p0-foundation
status: approved
summary: Web P0 基建——Fastify API、PostgreSQL 用户/邀请/BYOK、JWT、最小 Vue SPA 登录注册、nginx 与本地 dev
tags: [web, p0, fastify, jwt, invite]
---

# web-p0-foundation Design

## 1. 需求摘要

**做什么**：搭建 CharacterArc Web 的 P0 基建，使「邀请注册 → 登录 → 配置 BYOK → 测试 AI 连接」在本地可跑，并准备好同机 nginx 部署片段。

**为谁做**：开发者与首批邀请用户。

**成功标准**：
- `pnpm dev:web` + `pnpm dev:server` 本地联调
- 无邀请码不能注册
- Admin 可创建邀请码
- BYOK 保存后 `POST .../ai-config/test` 返回延迟
- `GET /health` 返回 ok

**明确不做**：工作区 CRUD、SSE、Worker、renderer 迁移。

**硬约束**：遵循 `web-platform-design.md` §2.1、§4.1–4.3（认证/BYOK API）。

## 2. 目录结构

```
server/           Node Fastify API (:8010)
web/              最小 Vue 3 SPA (:5174, base /character-arc/)
tools/
  nginx-character-arc.conf
  deploy-character-arc.ps1   # 骨架
```

## 3. 技术选型

| 层 | 选型 |
|---|---|
| API | Fastify 5 + @fastify/cors + @fastify/jwt + @fastify/multipart（预留） |
| DB | pg + 原生 SQL migrate |
| 前端 | Vue 3 + Vite + Vue Router + Pinia + ky |
| 加密 | Node crypto AES-256-GCM |

## 4. API 清单（P0）

| Method | Path | Auth |
|--------|------|------|
| GET | `/health` | 无 |
| POST | `/api/character-arc/v1/auth/register` | 无 |
| POST | `/api/character-arc/v1/auth/login` | 无 |
| POST | `/api/character-arc/v1/auth/refresh` | 无 |
| GET | `/api/character-arc/v1/auth/me` | JWT |
| GET | `/api/character-arc/v1/users/me/ai-config` | JWT |
| PUT | `/api/character-arc/v1/users/me/ai-config` | JWT |
| POST | `/api/character-arc/v1/users/me/ai-config/test` | JWT |
| POST | `/api/character-arc/v1/admin/invite-codes` | Admin |
| GET | `/api/character-arc/v1/admin/invite-codes` | Admin |

## 5. 环境变量

```
PORT=8010
DATABASE_URL=postgresql://user:pass@localhost:5432/character_arc
JWT_SECRET=...
JWT_ACCESS_EXPIRES=15m
JWT_REFRESH_EXPIRES=7d
ENCRYPTION_KEY=base64-32-bytes
CORS_ORIGINS=http://localhost:5174,https://124.222.218.97
DEEPSEEK_BASE_URL=https://api.deepseek.com
OPENAI_COMPATIBLE_BASE_URL=https://opencode.ai/zen/go
SEED_ADMIN_EMAIL=admin@local
SEED_ADMIN_PASSWORD=...
SEED_INVITE_CODE=CHARARC-BETA
```

## 6. 前端页面

- `/login` — 登录
- `/register` — 注册（邀请码必填）
- `/` — 登录后首页（显示用户邮箱 + AI 配置表单 + 测试连接按钮）
- Admin 用户额外显示「生成邀请码」

## 7. 挂载点

| 位置 | 动作 |
|------|------|
| `package.json` | 增加 `dev:server`, `dev:web`, `build:web` scripts |
| `tools/nginx-character-arc.conf` | 新增 |
| `.codestable/attention.md` | 追加本地起服务说明 |
