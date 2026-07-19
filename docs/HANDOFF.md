# CharacterArc 写作工具交接文档

> 交接日期：2026-07-19
> 交接人：上一轮 coding agent
> 适用对象：下一个接手自动创作（auto-creation）与章节生产流水线的 agent

---

## 1. 双仓库布局（关键）

本次工作跨了两个仓库，**同一批逻辑在两边都改了**，不要漏同步：

| 仓库 | 路径 | 角色 |
|------|------|------|
| **主仓库（有历史提交）** | `E:\ai\小说\character-arc-web` | 已提交 226 项，含 Electron + Web 全量代码 |
| **工作副本（有大量未提交改动）** | `C:\Users\maple\character-arc` | 62 个未提交文件（+1706/-257），是实际干活的地方 |

- 核心共享逻辑（收敛循环、preflight、convergence）放在 **`electron/shared/auto-creation/`**，server 与 renderer 都从它 import。
- **部署到生产服务器前，必须把 `C:\Users\maple\character-arc` 的改动同步到 `E:\ai\小说\character-arc-web` 并提交**，否则生产会跑旧代码。
- 本仓库（`E:\ai\小说\character-arc-web`）的 `CLAUDE.md` 是主入口；`C:\Users\maple\character-arc\CLAUDE.md` 与它同构。

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

- **静态门禁**：`cd C:\Users\maple\character-arc; npx vue-tsc --noEmit`
- ⚠️ **已知盲区**（2026-07-19 部署事故确认）：根目录 `vue-tsc` 不覆盖 `server/` 的所有模块解析路径（如 `server/src/auto-creation/chapter-pipeline.ts` 的 `serverStreamTask` 缺 `export` 就没被它抓到）。**部署前务必额外跑一次 `cd server && npx tsc --noEmit` 或至少对 server 改动文件做语法检查**。
- 不能用 `pnpm run build` 里的 `set ELECTRON_RUN_AS_NODE=`（那是 cmd/PowerShell 语法，在 bash 里会挂）。
- `server/tsconfig.json` 的 `rootDir` 只包 `server/src`，直接 `tsc -p server` 会因 import `electron/` 报 TS6059——**用根目录的 `vue-tsc --noEmit` 做全量检查**。

## 5. 生产部署

- 生产服务器：`124.222.218.97`
- 部署脚本：`deploy.ps1` / `deploy.bat`（本仓库根目录）
- **部署前必须同步双仓库**：`C:\Users\maple\character-arc` → `E:\ai\小说\character-arc-web`，提交后再跑部署。
- 模型配置在数据库 `user_ai_configs.production_models_json`，可用 `server/scripts/prod-patch-audit-model.mjs` 类脚本远程改。

## 6. 已知遗留事项（未做）

按优先级排序，供下一个 agent 参考：

1. ~~**"从某一章手动重跑"的 UI/接口**~~ ✅（2026-07-19 完成）：API 已支持 `startFromIndex` / `startFromChapterId`（`server/src/routes/auto-creation.ts`）；UI 在 `AutoCreationConfigDialog` 新增「起始章节」选择，经 `useAutoCreationRunner.startVolumeAutoCreation(volumeId, config, options)` 透传，web/server 与本地模式均生效。注意：内容已合格的章仍会被 acceptance-check 跳过，重跑失败章无需额外清理。
2. **批次间的大纲张力检查**：跨章一致性检查只看单章 risks，没对照后续大纲节点看"是否提前消耗关键节拍"。
3. **写作日志结构化聚合**：把 audit/repair 的 issue 按 category 聚合进 `knowledgeDocuments`，memo 生成时把"高频坑"作为硬约束前置。
4. **批次结束时的整卷复盘**：run 完成后对整批章节做一次"阶段摘要 + 批次级 risks"，写进项目 memory。
5. **失败章隔离区**：失败章内容已写进 workspace，可能污染后续章的 `relatedChapters` / `volumeChapterSummaries`，建议 `status: 'quarantine'` 并在 `buildMemoBaseContext` 里排除。

## 7. 容易踩的坑

- **双仓库不同步**：改了一边忘另一边，生产会跑旧代码。改完先同步再部署。
- **`normalize` 接口已变**：新增任务时记得 `normalize(raw, input?)` 第二个参数，否则会拿不到上下文。
- **`chapter_versions` 表已存在**：`electron/main/workspace-store.ts` 有 schema，server 侧用 `chapter-json.ts` 的 `commitChapterEditJson` 写入，别自己再造一套版本逻辑。
- **PowerShell 里 `&&` 不能用**：用 `;` 分隔命令。
- **vue-tsc 有盲区**（2026-07-19 事故）：根目录 `vue-tsc --noEmit` 不覆盖 `server/` 的所有模块解析路径，server 改动部署前必须额外 `cd server && npx tsc --noEmit`。
- **nginx 站点文件已变**：生产 nginx 从 `language-learning` 重构为 `main.conf`，旧补丁脚本会重复插 gzip 指令导致配置损坏；`deploy.ps1` 已改为自动探测站点文件，**不要手动改 nginx 配置**。

---

## 8. 当前 git 状态快照（2026-07-19 部署后更新）

- `E:\ai\小说\character-arc-web`：HEAD = `ce35abb`（全量同步 C: 的 62 项改动 + 缺失源码，234 文件 +29013）→ 后续热修 `78ac650`（serverStreamTask 缺 export）、`2f69d07`（deploy.ps1 自动探测站点文件）、`78b2971`（遗留事项 #1 从指定章手动重跑 UI）。
- `C:\Users\maple\character-arc`：与 E: 已双向同步，剩 7 处未提交改动（热修 + deploy.ps1 + 重跑 UI 4 个文件）。
- 生产服务器 `124.222.218.97` 当前运行的是新代码，`https://124.222.218.97/character-arc/` 正常，API 健康检查通过。

**下一步动作建议**：剩余 4 件遗留事项（批次张力检查、日志聚合、整卷复盘、失败章隔离区）任选其一；部署前记得先跑 `cd server && npx tsc --noEmit` 补 vue-tsc 的盲区。
