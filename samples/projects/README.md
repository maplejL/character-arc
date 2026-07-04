# 样例项目

本目录存放可随仓库同步的 CharacterArc **项目归档**（`.carc`），便于在另一台电脑上 `git pull` 后继续写作。

## 包含内容

| 文件 | 说明 |
|---|---|
| `国家以为我在吹牛直到我造出恒星引擎.carc` | 科幻长篇样例：7 章正文、6 角色、30 大纲节点、14 条世界观设定 |

归档格式与 App 内「项目设置 → 导出项目归档」一致，**不含** API Key 等应用设置。

## 在另一台电脑恢复

1. `git clone` / `git pull` 本仓库
2. 安装并启动 CharacterArc（`pnpm install && pnpm run dev`，或安装发行版）
3. 在项目中心点击 **导入项目归档**，选择本目录下的 `.carc` 文件
4. 导入模式选 **新建项目**（推荐；避免覆盖本机已有同名项目）

## 更新样例（维护者）

从本机 `workspace.db` 重新导出：

```powershell
pnpm install
pnpm run export:project -- --project-id project-1782991235670-99 --output samples/projects/国家以为我在吹牛直到我造出恒星引擎.carc
```

列出本机所有项目 ID：

```powershell
pnpm run export:project -- --list
```

默认读取 `%APPDATA%\CharacterArc\data\workspace.db`；可用环境变量 `CHARACTERARC_USER_DATA` 覆盖。
