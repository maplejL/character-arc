# web-workspace-api 验收

**状态：** accepted  
**日期：** 2026-07-04

## 范围

- 每用户 `data/users/{userId}/workspace.json` 持久化（复用 `workspace-types` normalize）
- PG `user_app_settings`（theme / selectedProjectId 等）
- REST：`GET/PUT /workspace`、`GET/POST /projects`、`GET/PUT /users/me/app-settings`
- Web 首页「我的作品」列表 + 创建

## 验收结果

| 项 | 结果 |
|---|---|
| `pnpm test:workspace` | PASS |
| `pnpm test:e2e` 含创建作品 | （见 CI / 本地跑数） |

## 已知限制（后续 feature）

- 未做 PG 全量 normalized schema（roadmap 原描述；当前 JSON 为过渡方案）
- 无 `.carc` 导入、无 renderer 写作台
- `PUT /workspace` 整包替换，无细粒度 CRUD

## 下一步

`web-renderer-migration` — IPC → HTTP 客户端，挂载完整写作 UI。
