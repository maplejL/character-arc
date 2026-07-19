# CharacterArc 写作工具交接文档

> 交接日期：2026-07-19
> 交接人：上一轮 coding agent
> 适用对象：下一个接手自动创作（auto-creation）与章节生产流水线的 agent

---

## 1. 单一主目录（2026-07-19 收拢完成）

唯一工作目录：**`E:\ai\小说\character-arc-web`**（GitHub `maplejL/character-arc`，分支 `feature/auto_mode_develop`）。

- 原 `C:\Users\maple\character-arc` 已删除；其 10 个本地提交的内容经树级比对确认全量在 E: 中（`87eaa44` 全量同步 + `459f17c` 收拢收尾），无需再同步。
- 核心共享逻辑（收敛循环、preflight、convergence）放在 **`electron/shared/auto-creation/`**，server 与 renderer 都从它 import。
- 运维脚本（`tools/prod-*`、`tools/startup.sh`、`server/scripts/prod-*` 等含硬编码密钥）**保留在本地 untracked**，不进 git——`git status` 里看到它们属正常。
- `web/.env.e2e`、`server/.env` 被 `.gitignore` 的 `.env.*` 规则保护，勿提交真实密钥（GitHub push protection 会拦截）。
- 本仓库的 `CLAUDE.md` 是主入口。

## 2. 已完成的迭代（自动创作三层防御）

按轮次记录，每轮都通过了 `vue-tsc --noEmit`。

### 第 1 轮：收敛循环确定性兜底
- **伪收敛修复**：`audit` / `repair` 模型不返回时，区分 `abortReason: 'audit-error' | 'repair-error'`，不再静默当作"质量不达标"。
- **确定性硬规则兜底**：新增 `evaluateDeterministicHardRules()`（`server/src/auto-creation/shared/preflight.ts`），字数越界 / 破折号 / 章内分隔符 / 日式引号 / 高疲劳词，与 preflight 合并进 gate。

### 第 2 轮：审查证据可校验
- `TaskHandler.normalize(raw, input?)` 增加可选上下文参数（`electron/main/ai/tasks/base.ts`）。
- `chapter-audit` 的 `normalize` 校验 ref 是否真实存在于 `draftText`，**编造的幻觉 issue 自动降级为 hint**，不进返修。
- 所有 `normalize` 调用点（`orchestrator.ts`、`convergence-stream.ts`、server pipeline）透传 `input` / `promptInput`。

### 第 3 轮：修复护栏
- `chapter-repair` prompt 增加"修 A 不得破坏 B"红线 + 输出前修复自检清单。
- 收敛循环增加**修复输出护栏**：输出过短 / 正文异常 / 修复引入的 critical 比修复前多 2 条以上 → 直接丢弃本轮，保留上一版。

### 第 4 轮：初稿前置自检
- `chapter-first-draft` system prompt 增加"输出前自检清单"，把确定性约束从"事后纠"前移到"写时避"。

### 第 5 轮：memo 硬契约收紧
- `chapter-memo` 的 `doNotDo` 改为**必填非空**（`validate` + `describeValidationErrors`），它是"禁止写穿大纲 / 禁止 OOC"的唯一章节级载体。

### 第 6 轮：自动创作必要环节补齐
- **版本快照**：章节写成功后自动 `commitChapterEditJson`，旧正文进 `chapterVersions`，可追溯/可回滚。
- **跨章一致性检查**：每写完 N 章（`consistencyCheckInterval`）对批次做一次 `chapter-analysis`，发现 risk 时自动 `paused` + `run-warning` 事件。

## 3. 关键文件速查

| 关注点 | 文件 |
|--------|------|
| 收敛循环主逻辑 | `server/src/auto-creation/shared/convergence-loop.ts` |
| 确定性硬规则 | `server/src/auto-creation/shared/preflight.ts` |
| 审查 handler | `electron/main/ai/tasks/chapter-audit.ts` |
| 初稿 handler | `electron/main/ai/tasks/chapter-first-draft.ts` |
| 修复 handler | `electron/main/ai/tasks/chapter-repair.ts` |
| memo handler | `electron/main/ai/tasks/chapter-memo.ts` |
| 编排/调度 | `electron/main/ai/runtime/orchestrator.ts` |
| 自动创作 worker | `server/src/auto-creation/worker.ts` |
| 跨章一致性配置 | `server/src/services/auto-creation-runs.ts` |
| WS 事件 | `server/src/auto-creation/ws-hub.ts` |
| 版本快照 | `server/src/workspace/chapter-json.ts` |

## 4. 类型与构建

- **静态门禁（双门禁，均已验证零错误）**：
  1. `cd E:\ai\小说\character-arc-web; npx vue-tsc --noEmit`（全量：electron + renderer + server）
  2. `cd E:\ai\小说\character-arc-web\server; npx tsc --noEmit`（server 专项，补 vue-tsc 盲区）
- server tsc 门禁于 2026-07-19 修复：`server/tsconfig.json` 已去掉 `rootDir`（emit 用 `tsconfig.build.json` 保留 `rootDir: src`）、增加 `@shared/*` paths（含 `.ts` 回退解决 ESM 扩展名问题）；此前的 138 个 TS6059 / 19 个 TS2307 均为结构噪声，已随配置消除，剩余 14 个真实类型错误已修复。
- ⚠️ 教训（2026-07-19 部署事故）：`chapter-pipeline.ts` 的 `serverStreamTask` 缺 `export` 曾逃过根 vue-tsc 直达生产——**server 改动必须过 server tsc 再部署**。
- 不能用 `pnpm run build` 里的 `set ELECTRON_RUN_AS_NODE=`（那是 cmd/PowerShell 语法，在 bash 里会挂）。

## 5. 生产部署

- 生产服务器：`124.222.218.97`
- 部署脚本：`deploy.ps1` / `deploy.bat`（本仓库根目录，参数已内置）
- deploy.ps1 流程：web build → `tools/emit-electron-ai.mjs`（electron TS 就地 emit 供 server 运行时 import）→ server build 占位跳过（生产用 tsx 跑 `server/src`）→ 上传 → startup.sh 重启 → 健康检查 → nginx 补丁（已含 character-arc 路由时自动跳过）。
- 模型配置在数据库 `user_ai_configs.production_models_json`，可用 `server/scripts/prod-patch-audit-model.mjs` 类脚本远程改。

## 6. 已知遗留事项（未做）

按优先级排序，供下一个 agent 参考：

1. ~~**"从某一章手动重跑"的 UI/接口**~~ ✅（2026-07-19 完成）：API 已支持 `startFromIndex` / `startFromChapterId`（`server/src/routes/auto-creation.ts`）；UI 在 `AutoCreationConfigDialog` 新增「起始章节」选择，经 `useAutoCreationRunner.startVolumeAutoCreation(volumeId, config, options)` 透传，web/server 与本地模式均生效。注意：内容已合格的章仍会被 acceptance-check 跳过，重跑失败章无需额外清理。
2. ~~**批次间的大纲张力检查**~~ ✅（2026-07-19 完成）：新增 `outline-tension-check` 任务（`electron/main/ai/tasks/outline-tension-check.ts`），worker 在 `consistencyCheckInterval` 批次检查中追加一次边界核对——对照当前进度之后至多 5 个未写大纲节点（标题+摘要+冲突），检查批次正文是否提前消耗关键节拍（身世/底牌提前揭晓、反转泄底、关系越级、冲突提前解决），只报高置信问题；命中以「大纲张力」前缀并入批次 risks，走既有暂停 + run-warning 流程；核对失败不阻断批次。
3. **写作日志结构化聚合**：把 audit/repair 的 issue 按 category 聚合进 `knowledgeDocuments`，memo 生成时把"高频坑"作为硬约束前置。
4. **批次结束时的整卷复盘**：run 完成后对整批章节做一次"阶段摘要 + 批次级 risks"，写进项目 memory。
5. ~~**失败章隔离区**~~ ✅（2026-07-19 完成）：`ChapterDraft.status` 新增 `'quarantine'`。worker 在 pipeline 失败 / `auditPass` / `finalGatePass` 为 false 时把该章置为 quarantine（正文保留供追溯与重写）；两侧 `evaluateChapterAcceptanceSync` 对隔离章一律 not satisfied（重跑自动重新处理）；`buildMemoBaseContext`（server `chapter-pipeline.ts` + renderer `chapterProductionPipeline.ts`）与 `buildChapterProductionContext`（server/electron 两副本 `chapter-context.ts`）的 relatedChapters / volumeChapterSummaries / previousChapterHandoff / recentEndingsTrail / referenceOpenings / outlineChapterSplit.previousParts 全部排除隔离章，当前章自身隔离时仍保留位置；UI 三处 status 分支补「需重写」显示。

## 7. 容易踩的坑

- **`normalize` 接口已变**：新增任务时记得 `normalize(raw, input?)` 第二个参数，否则会拿不到上下文。
- **`chapter_versions` 表已存在**：`electron/main/workspace-store.ts` 有 schema，server 侧用 `chapter-json.ts` 的 `commitChapterEditJson` 写入，别自己再造一套版本逻辑。
- **PowerShell 里 `&&` 不能用**：用 `;` 分隔命令。
- **vue-tsc 有盲区**（2026-07-19 事故）：根目录 `vue-tsc --noEmit` 不覆盖 `server/` 的所有模块解析路径，server 改动部署前必须额外 `cd server && npx tsc --noEmit`。
- **nginx 站点文件已变**：生产 nginx 从 `language-learning` 重构为 `main.conf`，旧补丁脚本会重复插 gzip 指令导致配置损坏；`deploy.ps1` 已改为自动探测站点文件，**不要手动改 nginx 配置**。
- **GitHub push protection 会拦密钥**：`web/src/lib/defaults.ts` 的 DeepSeek key 曾致 push 被拒，已通过 amend `87eaa44` 清除；真实密钥只放 `.env*`（已忽略），勿写进源码。

---

## 8. 当前 git 状态快照（2026-07-19 收拢后更新）

- `E:\ai\小说\character-arc-web`：HEAD 已推送 origin/feature/auto_mode_develop，本地不领先。收拢后提交线：`87eaa44`（全量同步，已 scrub defaults.ts 密钥）→ `270b260`（serverStreamTask 热修）→ `5e14988`（deploy.ps1 自动探测）→ `8a14b1b`（遗留事项 #1 重跑 UI）→ `1284ea2`（HANDOFF 更新）→ `459f17c`（收拢：server tsc 门禁修复 + codestable 入库）。
- 原 `C:\Users\maple\character-arc` 已删除（内容经树级比对确认全覆盖；`.codestable`、`data/users` 已迁入 E:）。
- 生产服务器 `124.222.218.97` 运行正常，`https://124.222.218.97/character-arc/` 可访问，API 健康检查通过。

**下一步动作建议**：剩余 4 件遗留事项（批次张力检查、日志聚合、整卷复盘、失败章隔离区）任选其一；改动后跑双门禁（§4），提交推送后按需 deploy.ps1。
