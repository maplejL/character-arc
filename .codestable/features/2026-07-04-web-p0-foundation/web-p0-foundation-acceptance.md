---
doc_type: feature-acceptance
feature: 2026-07-04-web-p0-foundation
roadmap: character-arc-web
roadmap_item: web-p0-foundation
status: accepted
summary: P0 基建验收通过——邀请注册、BYOK、DeepSeek 测试连接、Admin 发码；API + Playwright E2E 全绿
tags: [web, p0, e2e]
---

# web-p0-foundation Acceptance

## 验收日期

2026-07-04

## 范围核对（design checks）

| 检查项 | 结果 |
|--------|------|
| 无公开注册（必须 inviteCode） | ✅ Playwright `无邀请码不能注册` |
| apiKey 响应 never 含明文 | ✅ API + UI 测试断言 `hasApiKey` 且无 `apiKey` 字段 |
| 401 格式 `{ code, message }` | ✅ API E2E 断言 |
| P0 不含工作区/SSE/Worker | ✅ 未实现，符合边界 |

## 自动化验证

### API E2E（`pnpm --dir server test:p0`）

```
[p0-api-e2e] DeepSeek OK 131ms
[p0-api-e2e] ALL PASSED
```

覆盖：401 格式、无效邀请 403、注册、BYOK 保存、DeepSeek `config-test` 真实调用。

### UI E2E（`pnpm --dir web test:e2e`）

```
3 passed (19.6s)
- 无邀请码不能注册
- 邀请注册 → BYOK → DeepSeek 测试连接
- Admin 登录可生成邀请码
```

## 本地运行

```powershell
# API 层验收（含 DeepSeek，需 web/.env.e2e）
pnpm --dir server test:p0

# 浏览器 E2E（自动起 PGlite API + Vite）
pnpm --dir web test:e2e
```

开发默认使用 **PGlite**（`USE_PGLITE=1`），无需本机 PostgreSQL。生产部署改用 `DATABASE_URL` 指向 PostgreSQL。

## 已知限制

- Playwright 使用 Edge 通道（`channel: msedge`），未下载 Chromium 包
- `deploy-character-arc.ps1` 仍为骨架，未做生产 upload
- 工作区 / SSE / Worker 留给 roadmap 后续条目

## 结论

**P0 验收通过**，可进入 `web-workspace-api`。
