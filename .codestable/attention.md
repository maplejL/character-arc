# Attention

本文件是 CodeStable 技能启动必读的项目注意事项入口。所有 CodeStable 子技能开始工作前必须读取它。

## 项目碎片知识

<!-- cs-note managed: 用 cs-note 维护，新条目按下面分节追加 -->

### 编译与构建

### 运行与本地起服务

- Web P0：`cd server && cp .env.example .env`，默认 `USE_PGLITE=1` 无需 PostgreSQL；`pnpm dev:server`（:8010）
- Web SPA：`pnpm dev:web`（:5174，base `/character-arc/`）
- 种子 Admin：`admin@characterarc.local` / `123456`；邀请码 `CHARARC-BETA`
- E2E API：`pnpm --dir server test:p0`（DeepSeek Key 写在 `web/.env.e2e`，已 gitignore）
- E2E UI：`pnpm --dir web test:e2e`
### 测试

### 命令与脚本陷阱

### 路径与目录约定

### 环境变量与凭证

### 其他
