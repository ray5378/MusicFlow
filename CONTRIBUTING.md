# Contributing to MusicFlow

欢迎贡献。项目由四个仓库组成，本指南针对**主项目 MusicFlow**（服务端 + 前端）；插件相关贡献见
[MusicFlow-plugins](https://github.com/ray5378/MusicFlow-plugins) 的 README。

## 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 20（推荐 22 LTS） | `backend` 与 `frontend` 均需要 |
| npm | ≥ 10 | — |
| Python（可选） | — | 仅个别测试/脚本用 |

> SQLite 由 `better-sqlite3` 提供，安装时需本地编译（提供预编译二进制，通常无需工具链）。

## 快速跑起来

```bash
# 1. 后端（API :46400）
cd backend
npm install
npm run dev

# 2. 前端（UI :46399，Vite dev server 代理 /rest /api 到后端）
cd frontend
npm install
npm run dev
```

首次启动自动创建管理员 `admin / admin`（登录后强制改密）。
数据默认落在 `backend/data/`（可用 `DATA_DIR` 环境变量覆盖）。

### 生产同款单端口（后端托管前端构建产物）

```bash
cd frontend && npm run build
cd ../backend && rm -rf public && cp -r ../frontend/dist public/
DATA_DIR=<data目录> node dist/index.js   # 先 npm run build 出 dist
```

## 测试与检查（提交前必跑）

```bash
cd backend
npx tsc --noEmit          # 后端类型检查，必须 0 错
npx vitest run            # 全量测试（当前 218 用例，含 OpenSubsonic 路由级、插件沙箱专项）

cd frontend
npx vue-tsc --noEmit      # 前端类型检查，必须 0 错
```

**新增/修改功能必须带测试**：后端路由改动补 `tests/rest/`、插件沙箱改动补 `tests/plugins/`。
测试环境约定：测试文件第一个 import 必须是 `../plugins/_env.js`（把 `DATA_DIR` 指到临时目录，避免污染本地数据）。

## 代码规范

- **TypeScript strict**：新增代码必须类型完整（禁 `any` 滥用，确需时加注释说明）。
- **路由分层**：`routes/` 只做参数解析/鉴权/响应；业务逻辑在 `services/`。
- **插件化铁律**：核心代码**禁止写死任何 providerId / 平台字符串**。加平台 = 写插件（见 `docs/PLUGIN_DEV.md`）。CI 强制校验：`backend/scripts/check-core.mts`（核心不越界，新增越界零容忍）+ `check-builtins.mts`（内置插件 manifest 规范）。
- **DB 变更**：改 `db/schema.ts`（drizzle）时，同步改 `db/index.ts` 的 `CREATE TABLE IF NOT EXISTS`（无迁移框架，旧库靠 IF NOT EXISTS 自动补齐）；两者必须一致。
- **错误处理**：`/rest`（OpenSubsonic）失败体用 `status:"failed"` + 错误码（40/50/70/10/0）；原生 `/v1` 失败体返回 `{ error }` 字符串或 `{ success:false, error }`，不抛 500。

## 提交规范

- 提交信息：`<type>(<scope>): <subject>`，如 `feat(plugins): ...` / `fix(rest): ...` / `docs: ...` / `ci: ...`。
- 消息含 `${...}` 时用**单引号**包住，避免 bash 展开。
- 发版：改完推 `master` → 本地 `git tag v<版本>` 并推送 → CI 构建镜像 `ghcr.io/ray5378/musicflow:<版本>`（仅 amd64）→ 建 GitHub Release → **同步 addon**（`hassio-addons/musicflow` 的 `build.yaml` build_from + `config.yaml` version）。详细见 `~/.workbuddy/skills/musicflow-release/SKILL.md`。

## 文档规范

- 改代码/发版后，**同步更新** `README.md`（版本配套表、镜像、能力说明）与 `docs/` 下相关文档——版本号、测试数、端点清单最易脱节，提交前 grep 一遍旧版本号。
- 插件相关改动同步更新 `docs/PLUGIN_DEV.md`（host.* 表、权限白名单、示例）与插件仓库。
- 新增能力时在 README 补一句，并保持 README 与插件仓库 README 的跳转链接闭环。

## PR 流程

1. fork 主仓库，切 `feature/<描述>` 分支；
2. 本地通过全部检查（tsc / vitest / vue-tsc）；
3. 提交并推送到 fork，开 PR 到 `master`；
4. PR 描述写明：改动内容、验证方式、是否涉及 DB/文档/发版联动。

## 其他

- 架构总览与数据流：`docs/DEVELOPER.md`
- API 参考（鉴权、端点、WS）：`docs/API.md`
- 插件化架构（能力模型、耦合点、里程碑）：`docs/PLUGIN_ARCHITECTURE.md`
- 插件开发（沙箱契约、host.*、示例）：`docs/PLUGIN_DEV.md`
