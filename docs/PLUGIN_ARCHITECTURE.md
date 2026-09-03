# MusicFlow 插件化架构与开发文档

> 版本：基于 MusicFlow 复制基线（v1.1.29）重构
> 目标：把内置的 `go-music-dl` 从「深度耦合」改造成「真正的插件」，核心代码不再写死任何具体在线源实现；并搭建一套可扩展的统一插件框架，为后续把「歌单导入 / 每日推荐 / 歌单同步」也插件化预留接口。

> **定位（2026-08-12 明确）**：**MusicFlow 完整实现音乐服务器的功能与逻辑，并以插件化解耦**。
> 即：核心不再写死任何具体在线源 / 平台实现，而是作为 HA
> 加载项（addon）+ 集成（hass-musicflow）+ 卡片（hass-musicflow-card）这条主链路的内核。
> 已核实的兼容性基线：
>
> - 原生 `/v1` API：在 OpenSubsonic 兼容之上额外提供 8 个插件端点
>
> - OpenSubsonic `/rest`：46 端点完整兼容（品牌、失败体、getAvatar/setRating/savePlayQueue 等均合规）
>
> - HA 链路：addon 构建自 `ghcr.io/ray5378/musicflow`；集成/卡片契约逐项 e2e 通过

***

## 0. 范围说明（本次交付）

本版（Phase 0 + 1）聚焦 **在线音乐源（Source）的插件化**，这是用户原始诉求「go-music-dl 不再和项目深度耦合」的完整答案：

- Phase 0：统一插件注册表 + 统一 Manifest 类型 + DB 种子改由 manifest 驱动；go-music-dl 改为通过 registry 注册，删除编译期硬 import。

- Phase 1：核心调度 / 歌词 / 流兜底 / 推荐前缀全部改为「遍历有能力的启用插件」，不再出现字符串 `"go-music-dl"`。

**后续进度**：

- Phase 2（把 `playlistImport` / `dailyRecommend` / `playlistSync` 注册成 plugin 类型，并彻底去掉 `getConfiguredProvider("go-music-dl")` 与 `gmdl://` 写死）已在 §7.2 全部完成；`localRecommend` 已注册为 `recommender`（`localPlaylist` 能力），不再保持为孤立内置模块。

- Phase 3（社区外置 drop-in 插件）已在 §7.3 全部完成。

- **Phase 4/5/6（songloft 调研启发落地）**：在 §7.4 全部完成——`host.*` 受控上下文 + 权限模型、`lyricProvider`/`coverProvider` first-match-wins 注册表、go-music-dl 歌词/封面拆为独立 provider、DLNA `renderer` 插件化、`scrobbler` 播放上报、通用 KV `storage`、插件间 `comm`、健康追踪、`registryCatalog` 分发注册表 + 插件市场、外置插件热重载。

- 2026-08-14：新增内置 `daily-roam`「今日漫游」组合歌单插件（`comboPlaylist` 能力，合并「每日推荐 + 本地推荐」去重重建）；调度顺序 `dailyPlaylist → localPlaylist → comboPlaylist`；`POST /v1/recommend/refresh` 手动刷新（force + 随机 seedSalt 重新触发随机生成）。

- 2026-08-14（v1.7.22）：首页固定卡改为**插件自治**——推荐插件 manifest 声明 `homePlaylistId` + configSchema 声明 `showOnHome`/`homePosition`；核心经 `GET /v1/recommend/home-cards` 按位次聚合，保存/启用插件时位次冲突 → 400 拒绝（`homePositionConflictForSave`）。Web 首页与 HA 卡片均改读该接口。

- 2026-09-03（v1.13.40）：新增**歌单定时能力**统一注入机制——新建 `schedules` manifest 字段 + `SCHEDULED_CAPS` 能力清单（`dailyPlaylist`/`localPlaylist`/`recommendPlaylist`/`localPlatformRecommend`/`comboPlaylist`/`playlistCleanup`/`recommend`/`webRotation`/`playlistSync`/`playlistImport`/`playlistFile`/`artistInfo`）+ `withScheduleFields()`；注入发生在注册唯一漏斗 `registerPlugin()`（`backend/src/plugins/registry.ts`），**内置与外置沙箱插件统一走这一条路，不靠逐个插件手写**。凡是声明了上述任一歌单能力的插件，配置页自动出现归入「定时同步」分组的两个开关：`scheduleEnabled`（参与每日定时同步，默认 true）与 `runOnBoot`（容器启动补拉一次，默认 false）；调度器在每日定点按 `scheduleEnabled`、启动后按 `runOnBoot` 门控（`backend/src/batch/jobs.ts` 的 `runSyncPipeline(gate)` / `maintenanceGated(gate)`，后者自 v1.13.40 覆盖 `playlistSync`/`artistInfo` 等维护类）。外置插件可在 `plugin.json` 显式声明 `schedules`（true / `{scheduleEnabled,runOnBoot}` / false）。开发约定见 `docs/PLUGIN_DEV.md` §3.2。

***

## 1. 现状调研结论（耦合点清单）

| #  | 位置                                                  | 耦合表现                                                                                                     | 类型            |
| -- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------- |
| C1 | `services/source/online/index.ts:13`                | `initOnlineProviders()` 在模块加载时直接 `import goMusicDl.ts` 并 `register`                                      | 编译期硬注册        |
| C2 | `routes/api/online.ts` / `index.ts:15`              | 导出常量 `GO_MUSIC_DL_PROVIDER_ID` 并被各处引用                                                                    | 名字常量泄漏        |
| C3 | `index.ts:238 / 250`                                | 定时器 `runDailyJobs` 直接 `syncAllRecommendPlaylists("go-music-dl")` / `purgeExpiredWebSongs("go-music-dl")` | 调度写死字符串       |
| C4 | `services/source/online/streamFallback.ts:160`      | 兜底默认 provider 写死 `song.pluginEntry \|\| "go-music-dl"`                                                   | 默认值写死         |
| C5 | `services/lyrics.ts:76-96 / 107`                    | `deriveGmdlLrcUrl()` 硬编码 `/music/download`→`/music/download_lrc` 推导                                      | gmdl 专属逻辑混在核心 |
| C6 | `services/source/online/recommendImport.ts:24`      | `RECOMMEND_URL_PREFIX = "gmdl://recommend/"` 写死前缀                                                        | 前缀写死          |
| C7 | `services/plugin/playlistSync.ts:145`               | `getConfiguredProvider("go-music-dl")` 直调                                                                | providerId 写死 |
| C8 | `frontend/.../Plugins/index.vue:98-111 / 117 / 167` | `sourceOptions` 平台列表写死；`isSourcePlugin` 判定 `provider==="go-music-dl"`；`providerId` 缺省回退 `"go-music-dl"`  | 前端语义写死        |
| C9 | `db/index.ts:391-407`                               | DB 种子把 `go-music-dl` 作为唯一内置插件写死 INSERT                                                                   | 种子写死          |

**已具备的插件化基础（保留，不推翻）**：

- `plugins` 表（manifest / config / enabled）+ `OnlineProvider` 接口 + 运行时 `Map` 注册表（`types.ts:78`）。

- `/v1/online/:providerId/*` 参数化路由；`baseUrl` 等配置存于 `plugins.config`。

- 前端 `Playlists/Detail.vue`、`Playlists/index.vue` 已通过 `/v1/plugins` 动态发现首个启用的 source 插件做搜索/匹配（**不写死** go-music-dl）。

- 管理员插件页支持启停 / 配 baseUrl / test / purge。

结论：Source 已有 70% 插件骨架，缺的是「统一 Manifest 契约 + 编译期去硬注册 + 核心去字符串 + 配置 schema 化」。

***

## 2. 目标架构（统一插件框架）

```
┌──────────────────────────────────────────────────────────────┐
│                         Core (核心)                            │
│  timers · lyrics · stream · recommend-sync · router (/v1/...) │
│  只认「能力(capabilities)」，绝不认具体插件名                  │
└───────────────┬──────────────────────────────────────────────┘
                │  getEnabledPlugins(type) / getPlugin(id)
                ▼
┌──────────────────────────────────────────────────────────────┐
│                   Plugin Registry (运行时 Map)                  │
│  boot: 各内置插件 export manifest + 实现 → register()          │
│  （Phase 3 可选：boot 扫描 data/plugins/<id>/index.js 动态加载）│
└───────────────┬──────────────────────────────────────────────┘
                │
   ┌────────────┼───────────────┬───────────────┬──────────────┐
   ▼            ▼               ▼               ▼              ▼
 Source      Importer       Recommender       Sync           (Lyrics/Sink…)
 (go-music-   (QQ/网易      (每日推荐/       (歌单自动       Phase 2/3
  dl = 唯一    『导入』)      本地推荐)        同步)           扩展点
  实现)                                                      
```

**关键原则**：

1. 核心永不直接引用 `go-music-dl` 或任何具体实现；只通过 `registry` 拿「带某能力的启用插件」。
2. 插件能力由 `manifest.capabilities` 声明，核心按能力遍历调用对应方法。
3. 插件配置由 `manifest.configSchema` 描述，前端按 schema 动态渲染表单（不再写死 baseUrl/sources 字段）。
4. 数据模型复用现有 `songs.pluginEntry + sourceData`，不变。

***

## 3. 数据模型

不加新表、不改 `songs` 结构。沿用：

- `plugins` 表：`id, name, version, description, manifest(JSON), enabled, config(JSON), created_at, updated_at`。

- `songs.pluginEntry`：存 provider id（如 `go-music-dl`），用于回溯「这首歌由哪个在线源来」。

- `songs.sourceData`：存原始元数据（title/artist/source 等）。

`manifest` 字段扩展为统一结构（见 §4）。DB 种子改为「遍历内置插件清单 → 不存在则 INSERT」，去掉写死的 `go-music-dl` 字符串（C9）。

***

## 4. 统一契约（类型与接口）

### 4.1 `plugins/types.ts`（新增，统一 Manifest）

```ts
export type PluginType = "source" | "importer" | "recommender" | "sync";

export type PluginCapability =
  | "search"          // 支持在线搜索
  | "recommend"       // 支持每日推荐歌单
  | "playlistSongs"   // 支持拉取单个远程歌单的歌曲
  | "stream"          // 支持构造音频流地址
  | "lyrics"          // 支持在线歌词
  | "webRotation";    // 支持在线歌曲过期清理（每日推荐轮换）

export interface ConfigField {
  key: string;
  label: string;
  type: "text" | "url" | "number" | "select" | "multiselect" | "radio" | "switch";
  required?: boolean;
  default?: unknown;
  options?: { label: string; value: string }[];
  help?: string;
}

export interface PluginManifest {
  id: string;                 // 唯一，如 "go-music-dl"
  name: string;               // 展示名
  version: string;
  type: PluginType;
  description?: string;
  capabilities: PluginCapability[];
  platforms?: string[];       // source 类可用：支持的平台 slug
  minAppVersion?: string;
  configSchema: ConfigField[];
}
```

### 4.2 `SourcePlugin` 契约（扩展现有 `OnlineProvider`）

在 `services/source/online/types.ts` 的 `OnlineProvider` 基础上：

- 新增 `manifest: PluginManifest`（插件自描述，含 capabilities / configSchema / platforms）。

- 新增可选方法 `lyricUrl?(config, song): string | null`（替代 C5 的 `deriveGmdlLrcUrl`，逻辑下沉到插件）。

- 新增可选方法 `recommendPlaylistRef?(channel: string, id: string): string`（替代 C6 的 `RECOMMEND_URL_PREFIX`）。

- `recommend?` / `playlistSongs?` / `streamUrl` / `search` / `test` 保持，但仅当对应 capability 存在时由核心调用。

> 其余 `importer / recommender / sync` 类型在 Phase 2 再定义各自接口；Phase 0+1 先只落地 `source`。

### 4.3 注册表 `plugins/registry.ts`（新增）

```ts
const registry = new Map<string, { manifest: PluginManifest; impl: any }>();

export function registerPlugin(manifest: PluginManifest, impl: any) { registry.set(manifest.id, { manifest, impl }); }
export function getPlugin(id: string) { return registry.get(id); }
export function getEnabledPlugins(type?: PluginType) { /* 读 plugins 表 enabled + registry 交集 */ }
export function getEnabledSourcePlugins() { return getEnabledPlugins("source"); }
export function getCapabilities(id: string): PluginCapability[] { return registry.get(id)?.manifest.capabilities ?? []; }
```

> 注意：`getEnabledPlugins` 需读 DB（plugins 表 enabled 列）与 registry 求交集，避免「代码注册了但管理员停用了」仍被调度调用。

***

## 5. 核心解耦映射（Phase 1）

| 原耦合                                           | 改为                                                                                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C3 `syncAllRecommendPlaylists("go-music-dl")` | 遍历 `getEnabledSourcePlugins()` 中 `capabilities.includes("recommend")` 的插件，逐个 `syncAllRecommendPlaylists(providerId, config)`                                    |
| C3 `purgeExpiredWebSongs("go-music-dl")`      | 同上，仅对 `capabilities.includes("webRotation")` 的插件调用                                                                                                              |
| C4 兜底默认 `"go-music-dl"`                       | 默认 provider = 第一个 `capabilities.includes("stream")` 的启用 source 插件；`song.pluginEntry` 仍优先                                                                        |
| C5 `deriveGmdlLrcUrl`                         | `lyrics.ts` 对 `type==="web"` 歌曲，取 `getPlugin(song.pluginEntry)?.impl.lyricUrl?.(config, song)`，无则走原 w:/l: 分支；`deriveGmdlLrcUrl` 逻辑移入 go-music-dl 插件的 `lyricUrl` |
| C6 `RECOMMEND_URL_PREFIX`                     | 由 `provider.recommendPlaylistRef(channel, id)` 生成；stale 检测用 `provider.recommendPlaylistRef` 反推前缀                                                                |
| C2 `GO_MUSIC_DL_PROVIDER_ID` 外部引用             | 仅在 go-music-dl 插件内部定义；核心调度不再 import 该常量                                                                                                                         |
| C8 前端写死                                       | 配置表单由 `manifest.configSchema` 渲染；`providerId` 由 `manifest.provider` 给出，无回退字符串；`sourceOptions` 来自 `manifest.platforms`                                           |

行为保持：go-music-dl 用户无感，搜索/歌词/推荐/兜底照常工作。

***

## 6. 后续里程碑

- **Phase 2（全量插件化）**：✅ 已完成（见 §7.2）。定义 `ImporterPlugin` / `RecommenderPlugin` / `SyncPlugin` 接口；把 `playlistImport` / `dailyRecommend` / `playlistSync` 注册进 registry，删掉 `playlistSync.ts` 的 `getConfiguredProvider("go-music-dl")` 与 `gmdl://` 写死；`localRecommend` 已注册为 `recommender`（`localPlaylist` 能力）。

- **Phase 3（外置插件）**：✅ 已完成（见 §7.3）。boot 扫描 `data/plugins/<id>/index.js` 动态 `import`（`plugins/discovery.ts`），加 manifest 校验 + 路径白名单（`safeResolve` 防穿越）+ `minAppVersion` 校验 + id 冲突保护；开发者文档见 `docs/PLUGIN_DEV.md`，参考实现见 `examples/plugins/hello-importer/index.js`。

- \**Phase 4（host.* 上下文 + Provider 注册表，P0）\*\*：✅ 已完成（见 §7.4）。`host.*` 受控上下文取代插件直接 import 后端；`lyricProvider`/`coverProvider` 注册表 + first-match-wins；go-music-dl 歌词/封面拆为独立 provider 插件。

- **Phase 5（能力扩展 + 权限，P1）**：✅ 已完成（见 §7.4）。`renderer`（DLNA）/`scrobbler` 插件化；声明式权限模型（`KNOWN_PERMISSIONS` + 命名空间通配 `songs.*` + 全局 `*`）；通用 KV `host.storage`；插件间 `host.comm`。

- **Phase 6（分发与运维，P2）**：✅ 已完成（见 §7.4）。分发注册表 `plugin_registries` + `listMarketplace()`（递归 includes / 同 id 多来源各自保留并带 sourceUrl，v1.6+ 由前端让用户选择安装源头）+ `installPlugin()`（下载 → 解压 `data/plugins/<id>/` → 热注册）；健康追踪 `plugin_health`（green/yellow/red）+ 管理页徽章；外置插件热重载 `hotReload.ts`（文件变更自动重发现，免重启）。

***

## 7. 任务清单（实现进度追踪）

> 每完成一项即标记完成。括号内为代码映射。

- [x] **T0** 复制基线 → `MusicFlow`，初始化新 git，改名 musicflow-\*（已完成）

- [x] **T1** 新增 `plugins/types.ts` 统一 Manifest/ConfigField；新增 `plugins/registry.ts` 注册表（含 `getEnabledSourcePlugins` / `getCapabilities`）；新增 `plugins/builtins.ts` 内置插件清单

- [x] **T2** 扩展 `OnlineProvider` → 带 `manifest`；新增 `lyricUrl?` 方法（`recommendPlaylistRef` 简化为 manifest 内 `recommendPrefix` 字段）

- [x] **T3** `db/index.ts` 删除 go-music-dl 硬种子；改由 `registerBuiltinPlugins()` 遍历内置清单 + `configSchema` 默认值写入（去 C9）

- [x] **T4** `index.ts` 定时器改为遍历 `getEnabledSourcePlugins()`，按 `recommend` / `webRotation` 能力调度（去 C3）

- [x] **T5** `lyrics.ts` 删除 `deriveGmdlLrcUrl`，改为 `getPluginImpl(song.pluginEntry).lyricUrl(config, song)`（去 C5，逻辑下沉插件）

- [x] **T6** `streamFallback.ts` 新增 `defaultStreamProviderId()`，从 registry 取首个具备 `stream` 能力的启用插件（去 C4）

- [x] **T7** `recommendImport.ts` 前缀改由 manifest `recommendPrefix` 生成，识别时遍历所有已注册前缀（去 C6）

- [x] **T8** 前端 `Plugins/index.vue` 配置表单由 `configSchema` 动态渲染；删除 `sourceOptions` 写死、`provider==="go-music-dl"` 判定与回退；purge 按钮由 `webRotation` 能力控制（去 C8）

- [x] **T9** 构建验证：后端 `tsc --noEmit` 通过（exit 0）、前端 `vue-tsc --noEmit` 通过（exit 0）；提交 `8a90908`

### 7.1 本轮完成情况与残留字符串审计

Phase 0 + 1 全部完成；**Phase 2 全量插件化已收口（v1.5.0）**。全库检索 `"go-music-dl"` 后残留位置及定性：

| 位置                                    | 性质                                                      | 处理                               |
| ------------------------------------- | ------------------------------------------------------- | -------------------------------- |
| `services/plugin/artistInfo.ts` 等插件实现 | 插件自身实现与 manifest 的 `id`                                 | **合理**，插件必须声明自己的 id              |
| 前端 `Playlists/*.vue`                  | 静态提示文案 + `manifest?.provider === "go-music-dl"` 旧字段兼容判定 | **可接受**，主路径已走 `/v1/plugins` 动态发现 |

结论：核心调度、歌词、流兜底、推荐前缀、DB 种子、前端配置表单、歌手抓取、路由对内置插件的访问**均已零硬编码**——go-music-dl 已是一个可被任意同契约插件替换的实现。

### 7.3 Phase 2 收口明细（v1.5.0）

核心对「具体平台 / 内置插件实现」的 5 处存量耦合已全部插件化，`scripts/check-core.mts` 白名单清空（新增越界零容忍）：

| 原耦合                                                          | 收口方式                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 路由直连 `playlistSync.ts`（syncPlaylist/rebuild/export/cooldown） | 新增 `services/pluginAccess.ts` 门面，按 `playlistSync` 能力取 impl 调用（`SyncPlugin` 接口扩展可选方法） |
| 路由直连 `dailyRecommend.ts`（候选/生成/推荐池）                          | 同上，经 `dailyPlaylist` 能力门面（`RecommenderPlugin` 接口扩展可选方法）                              |
| `rest` / 路由直连 `DAILY_TAG` 常量                                 | manifest 新增 `dailyTag` 字段，核心经门面读 `manifest.dailyTag`                                 |
| `db/index.ts` 硬编码平台榜单种子                                      | 迁移为 `daily-recommend` 插件内部 `DEFAULT_CANDIDATES`，`loadCandidates()` 无配置时 fallback     |
| `scraper/artist.ts` 写死 QQ/网易云抓取                              | 新增**内置插件** **`artist-info`**（新类型 `artist`、新能力 `artistInfo`，QQ 优先网易云兜底），核心按能力遍历       |

新增能力/类型：`artist`（PluginType）、`artistInfo`（capability，方法 `fetchArtistInfo`）。内置插件增至 **8 个**。
核心访问内置插件能力的唯一路径：`getEnabledByCapability(...)` / `services/pluginAccess.ts` 门面——`check-core.mts` 规则 B 强制。

### 7.2 Phase 2（全量插件化：importer / recommender / sync / artist）

> 目标：把 `playlistImport` / `dailyRecommend` / `playlistSync` 这些「名为插件、实为硬编码模块」的功能真正注册成 plugin 类型，核心只按能力遍历；并彻底删除最后一处 `go-music-dl` / `gmdl://` 字面量。**v1.5.0 全部完成**。

- [x] **T10** 新增 `plugins/types.ts` 的 `ImporterPlugin` / `PlaylistFilePlugin` / `RecommenderPlugin` / `SyncPlugin` 契约（含 `canHandle` / `canHandleFile` / `runDailyJob` / `runSyncJob`）

- [x] **T11** 把 `playlistImport.ts` 拆成三个独立 `importer` 插件：`qq-playlist-importer` / `netease-playlist-importer` / `musicflow-file-importer`（共享 `importers/http.ts` 的 `fetchJson` / `resolveRedirect`）；核心 `playlistImport.ts` 收敛为「能力分发器」（`getEnabledByCapability("playlistImport"|"playlistFile")` + `canHandle`/`canHandleFile` 路由）

- [x] **T12** `playlistSync.ts` 去耦合：`queueAutoMatch` 改用 `firstEnabledByCapability("autoMatch") ?? firstEnabledByCapability("search")`；`syncAllEnabledPlaylists` 跳过判断改用 `findUrlImporter(url)`（取代 `gmdl://` 前缀）；文件末尾新增 `playlistSync` 类型插件（`runSyncJob` → `syncAllEnabledPlaylists`）

- [x] **T13** `dailyRecommend.ts` 注册为 `recommender` 插件（`dailyPlaylist` 能力，`runDailyJob` → `runDailyRecommendJob`）

- [x] **T14** 解环重构：原 `registry.ts` 反向 import `builtins` 的三角循环，把 `registerBuiltinPlugins` / `seedBuiltinPluginRows` 下沉到 `builtins.ts`；`registry.ts` 不再 import `builtins`，依赖图变无环

- [x] **T15** DB-ready 钩子：`builtins.ts` 的 `registerBuiltinPlugins()` 在 `onDatabaseReady(seedBuiltinPluginRows)` 中播种，确保种子在 schema 之后；种子策略 `defaultEnabled`——source 插件 OFF（需 baseUrl），importer/recommender/sync 内置插件 ON（替代原硬编码核心路径）

- [x] **T16** 入口 `index.ts` 调度改写：`registerBuiltinPlugins()` 在 `initDatabase()` 前调用；`runDailyJobs` 遍历 `getEnabledByCapability("dailyPlaylist")` 调 `runDailyJob`；维护定时器遍历 `getEnabledByCapability("playlistSync")` 调 `runSyncJob`

- [x] **T17** `routes/api/index.ts` 导入改用 `parsePlaylistFile(raw)`（re-export自 `playlistImport`）

- [x] **T18** 前端 `admin/Plugins/index.vue` 四类插件可视化：类型标签（`typeLabel`/`typeTagColor`）+ 能力标签（`capabilityList`/`capLabel`）+ 按类型显示操作（source 显示测试/清理，其余显示配置/详情）；`configSchema` 动态表单不变

- [x] **T19** 前端 `Playlists/index.vue` 导入弹窗提示动态化：`importHint` / `importPlaceholder` 计算属性依据已启用 `playlistImport` 插件的 `platforms` 生成（停用导入插件后文案同步变化）；去除 `detectDailySource` 的 `go-music-dl` 硬编码（改 `manifest?.type === "source"`，无回退字符串）；`Detail.vue` 同步去硬编码

- [x] **T20** 新增 `tests/plugins/registry.test.ts`（20 用例）：注册幂等、四类型齐全、种子 enabled 策略、能力查找/启用过滤、`runDailyJob`/`runSyncJob` 存在、import 分发路由、disabled 停止路由、file 解析；`vitest.config.ts` 设 `fileParallelism:false` + `pool:"forks"`（修同 SQLite 文件行污染 + better-sqlite3 退出段错误 exit 139）

- [x] **T21** 构建验证：后端 `tsc --noEmit` 通过、前端 `vue-tsc --noEmit` 通过、测试 `87 passed (87)`（9 个测试文件）

**Phase 2 收口后残留** **`go-music-dl`** **字符串审计**：仅剩 `services/source/online/goMusicDl.ts` 插件自身实现与 manifest `id`（合理）；其余核心/前端均已零硬编码，可被任意同契约 source/importer 插件替换。

### 7.3 Phase 3（外置插件目录发现）

> 目标：让社区/高级用户把插件丢进 `data/plugins/<id>/index.js` 即被加载，核心零改动；并加足安全边界。

- [x] **T22** 新增 `plugins/discovery.ts`：`discoverExternalPlugins(appVersion, rootDir?)` 扫描 `data/plugins`，对每个子目录 `await import()` 其 `index.js`

- [x] **T23** Manifest 校验 `validateManifest()`（纯函数，可单测）：`id` 正则 / `type` 合法 / `capabilities` 非空且均合法 / `configSchema` 为数组；任一不过则跳过

- [x] **T24** 路径白名单 `safeResolve()`：仅允许 `<root>/<id>/index.js`，`../` 穿越返回 `null`（已单测）

- [x] **T25** `minAppVersion` 校验 `compareVersion()` / `isAppVersionCompatible()`：`dev` 构建放行，否则要求 `appVersion >= minAppVersion`（已单测）

- [x] **T26** id 冲突保护：已注册（内置/先发现）id 胜出，重复者跳过，避免外置插件遮蔽内置

- [x] **T27** 引导入启动序列：`index.ts` 在 `initDatabase()` 后 `await discoverExternalPlugins(APP_VERSION)`，注册后重播 `seedPluginRows()` 为外置插件建 `plugins` 行（DB 已 ready，幂等只补新 id）

- [x] **T28** `seedBuiltinPluginRows` 重命名为 `seedPluginRows`（现播种所有已注册插件，含外置）；导出 `getDataDir()` 供 discovery 复用

- [x] **T29** 外置插件加载失败（语法错误/坏路径）仅 `console.warn` 跳过，绝不中断启动

- [x] **T30** 参考实现 `examples/plugins/hello-importer/index.js` + 开发者文档 `docs/PLUGIN_DEV.md`（manifest 字段表、能力↔方法对照、安全边界、安装/启用流程、FAQ）

- [x] **T31** 测试 `tests/plugins/discovery.test.ts`：validateManifest / compareVersion / isAppVersionCompatible / safeResolve / discoverExternalPlugins（有效加载、跳过非法/版本不符/冲突/非目录）；全量 `100 passed (10 文件)`

***

### 7.4 Phase 4/5/6（songloft 调研启发落地）

> 来源：`docs/RESEARCH-songloft-plugin-inspiration.md`（P0–P3 行动清单）。核心结论：songloft 用 QuickJS 把插件隔在独立 VM，本仓库是 **Node/TS in-process**——所以「权限模型 / host.\*」是**契约级**而非运行时隔离，外部插件等同于信任其代码。务实做法：内置插件可信；外部插件走 `data/plugins` 拖入但仅给 `host.*`、禁止 import 后端内部，UI 市场页明确风险提示。真正该抄的是 **provider 注册表（first-match-wins + 多源共存）**、**受控 host 上下文**、**健康追踪** 与 **分发注册表 / 市场 / 热重载**。

**P0 —** **`host.*`** **受控上下文 + Provider 注册表（§7.4.1）**

- [x] **T32** 新增 `plugins/host.ts`：导出 `PluginHost` 接口 + `createPluginHost(manifest, config, appVersion)`；`host.log/config/version/storage/http/comm` 受控上下文。`http` 受 `net` 权限门禁、`comm` 受 `inter-plugin` 门禁、`storage` 受 `storage` 门禁。

- [x] **T33** 权限模型 `KNOWN_PERMISSIONS`（log/storage/net/command/fs/fs:music/fs:external/songs:read/songs:write/playlists:read/playlists:write/inter-plugin）+ 通配糖（`songs.*` 命名空间通配、`*` 全局授予）。`validatePermissions`（manifest 校验阶段）与 `hasPermission`/`requirePermission`（运行时调用点）语义一致——任一未知权限即拒绝。

- [x] **T34** 新增 `plugins/providers.ts`：`searchLyrics()` / `searchCover()` 遍历 `getEnabledByCapability("lyricProvider"|"coverProvider")`，**first-match-wins**；`hasLyricProvider()`/`hasCoverProvider()` 决定核心是否走插件路径。抛错计入健康追踪后跳过、绝不中断循环。

- [x] **T35** 把 go-music-dl 的 `lyricUrl` / 封面能力拆为独立插件：`services/plugin/lyrics/goMusicDlLyrics.ts`（`lyricProvider`）、`services/plugin/covers/goMusicDlCover.ts`（`coverProvider`）；核心 `services/lyrics.ts` 改为「先遍历 lyricProvider，无则回退原 w:/l: 分支」。多歌词 / 多封面源可并存，用户在插件页独立开关。

**P1 — 能力扩展 + KV + comm（§7.4.2）**

- [x] **T36** `renderer` 插件化：`plugins/renderers.ts` 包裹 DLNA（`services/plugin/renderers/dlna.ts` 注册为 `renderer` 插件），核心只按能力遍历 `discoverRenderers/castToRenderer/controlRenderer`；Chromecast / AirPlay / Kodi 可由社区新增插件接入，核心零改动。

- [x] **T37** `scrobbler` 插件化：`plugins/scrobblers.ts` 的 `notifyScrobble("play"|"scrobble", event)` 把播放事件分发给所有启用 `scrobbler` 插件（Last.fm / ListenBrainz 等）。

- [x] **T38** 通用 KV `storage.ts`：`plugin_storage` 表 + `makeScopedStorage(pluginId)` 按 `plugin_id` 隔离（插件 A 读不到 B 的键）；`host.storage.get/set/delete/keys` 供缓存 / OAuth token / 限流状态。

- [x] **T39** 插件间通信 `comm.ts`：`host.comm` 的 `send/broadcast/on/off` 事件总线，门禁 `inter-plugin` 权限；handler 异常只 `console.error` 不中断投递。

**P2 — 分发与运维（§7.4.3）**

- [x] **T40** 分发注册表 `registryCatalog.ts`：`plugin_registries` 表（id/url/enabled）+ `listRegistries/addRegistry/removeRegistry`；`listMarketplace()` 递归 follows `includes`、同 id 多来源各自保留（v1.6+，每个来源带 `sourceUrl`，前端据此让用户手动选择安装源头）。

- [x] **T41** `installPlugin(downloadUrl)`：下载归档 → 解压到 `data/plugins/<id>/` → 重新 `discoverExternalPlugins()` 热注册（免重启）；Windows 上 BSD `tar` 反斜杠 / `C:` 远程主机坑用 `--force-local` + 正斜杠路径规避。

- [x] **T42** 健康追踪 `health.ts`：`plugin_health` 表，连续失败数 0=green / 1–2=yellow / ≥3=red；`recordSuccess/recordFailure/getHealth/allHealth`；管理页「健康」列 + `GET /v1/plugins/health` 暴露。

- [x] **T43** 外置插件热重载 `hotReload.ts`：启动 `startPluginHotReload()` 监听 `data/plugins` 变更 → 重新发现 + 重注册 + 重建 `plugins` 行，免重启。

- [x] **T44** REST 路由补全（`routes/api/index.ts`）：`/v1/plugins/health`、`/v1/plugins/renderers`、`/v1/plugins/renderers/devices`、`/v1/plugins/scrobblers`、`/v1/plugins/registry`（GET 市场 / POST 加注册表 / DELETE 删注册表 / POST install）。前端「插件管理」新增「插件市场」标签页（注册表管理 + 一键安装）+ 权限 / 健康徽章。

- [x] **T45** 新增测试 `host.test.ts` / `storage.test.ts` / `comm.test.ts` / `health.test.ts` / `dispatch.test.ts` / `registryCatalog.test.ts`（共 +40 用例，覆盖权限校验、通配糖、KV 隔离、comm 门禁、first-match-wins、健康状态、市场去重 / installPlugin）；全部 154 用例绿、`tsc --noEmit` 零错误、`vue-tsc --noEmit` 零错误。

**Phase 4/5/6 收口后架构关键点**：

- 核心调度 / 歌词 / 封面 / 投屏 / 上报 **均已零硬编码具体插件名**，只按 `getEnabledByCapability(...)` 遍历。

- `host.*` 是插件唯一宿主入口；`KNOWN_PERMISSIONS` 是权限白名单单一真相源。

- 分发走 `plugin_registries` + 市场，安装即热加载；运维看 `plugin_health`。

- **沙箱差异须知**：in-process 下权限只是契约，`command/fs/net` 高风险权限对外置插件等同本机执行权，仅可信源安装。

***

## 8. 验证方式

1. **类型/构建**：`cd backend && npx tsc --noEmit`；`cd frontend && npx vue-tsc --noEmit`。
2. **行为不回归**（部署后手测）：

   - 启用 go-music-dl 插件、填 baseUrl → 在线搜索正常；

   - 播放任一在线歌曲歌词正常显示（V1 已修的逐字问题保持）；

   - 每日推荐歌单同步 + web 歌曲轮换清理仍触发；

   - 流播放兜底（原曲失效→多源）仍工作；

   - 全文检索后端源码，确认无残留字符串 `"go-music-dl"`（除插件自身实现与 manifest）。
3. **边界**：禁用 go-music-dl 插件后，定时器不再调度其任务（registry 交集过滤生效）。

***

## 9. OpenSubsonic 服务端与 HA 主链路（2026-08-12 收口）

### 9.1 OpenSubsonic 服务端（`routes/rest/index.ts`，46+ 端点）

MusicFlow 同时作为 **OpenSubsonic 服务端**（Subsonic API v1.16.1 + OpenSubsonic 扩展），
第三方客户端（Symfonik / DSub / MA / libopensonic）可直接连接播放曲库。本轮（v1.2.0）完整化：

- **品牌合规**：所有 `subsonic-response.type` 由复制残留的 `MusicFree` 改为 `MusicFlow`；
  `serverVersion` 取 `APP_VERSION`（不再写死 1.0.0）。

- **失败体合规**：全部 `ok({error})` 改为标准 `status:"failed"` + 错误码（70 not found / 50 权限 /
  40 未认证 / 10 缺参 / 0 通用），客户端能真正感知失败。

- **补齐标准端点**：`getAvatar`（SVG 占位）、`setRating`（`user_ratings` 表，0–5 星，
  `getSong/getAlbum/getArtist` 回填 `userRating`）、`getPlayQueue/savePlayQueue` 真实持久化
  （`user_play_queues` 表，按用户一份）。

- **扩展声明诚实化**：`getOpenSubsonicExtensions` 移除未实现的 `transcoding`；
  `getTopSongs` 支持 `artistId`（topSongsByArtistId 扩展）。

- **测试**：`tests/rest/opensubsonic.test.ts` 29 用例，挂真实 `authMiddleware` + `u/t/s` 认证，
  覆盖品牌/失败体/浏览/搜索/歌单 CRUD/收藏/评分/scrobble 去重/队列/头像。
  全量 vitest 185 用例绿。

### 9.2 HA 主链路（addon + integration + card 全部对接）

| 环节  | 仓库                                                                                                          | 状态                 |
| --- | ----------------------------------------------------------------------------------------------------------- | ------------------ |
| 镜像  | `MusicFlow`（ghcr.io/ray5378/**musicflow**:1.2.0，仅 amd64）                                                    | ✅ 已发布              |
| 加载项 | `hassio-addons/musicflow`（version 1.2.0，build\_from 钉镜像，arch 仅 amd64）                                       | ✅ 已对接              |
| 集成  | `hass-musicflow` 1.3.7（契约 = `/v1/peers*`、`/v1/groups`、`/v1/play`、`/rest/*` + `/rest/api/*` 代理、`/ws?token=`） | ✅ e2e 12/12 通过，零改动 |
| 卡片  | `hass-musicflow-card` v1.6.51（`/api/v1/peers`、`/api/v1/users/me`、代理 fallback、`/ws`）                         | ✅ API 面兼容，零改动      |

验证方式（无 Docker 环境的 e2e 套路）：`cd backend && npm run build` →
`DATA_DIR=<tmp> PORT=46401 node dist/index.js` → 登录拿 JWT → 按集成契约逐项 curl。
官方注册表种子（§7.4）在启动日志中确认生效。

### 9.3 CI 与发版

- `MusicFlow/.github/workflows/build.yml`：\**仅 v* tag 触发\*\*构建推 `musicflow:<版本>` + `:latest`；
  **workflow\_dispatch 手动触发也自动构建** **`:latest`**（版本号由 git describe 自动生成，
  无需手动指定升级版本）并附 `:main` 便于回溯；镜像仅 amd64（账号无 ARM runner）。

- 发版流程：MusicFlow 打新 tag → addon 的 `build.yaml` build\_from + `config.yaml` version 同步 → addon 仓库发版。

### 9.4 外置插件 QuickJS 沙箱（v1.3.0）

songloft 调研（`RESEARCH-songloft-plugin-inspiration.md`）的 QuickJS 隔离在本版落地：

- **运行时**：外置插件（`data/plugins/<id>/index.js`）运行在 QuickJS/WASM VM（`plugins/sandbox.ts`，
  quickjs-emscripten 0.32.0，sync 变体 + deferred-promise 宿主异步）。插件**拿不到 Node 能力**，
  网络只能走 `host.http`（自带超时）、存储走 `host.storage`（按插件隔离）、日志走 `host.log`；
  `permissions` 在宿主函数调用点强制（不再是契约）。

- **防护**：单插件内存 256MB / 栈 1MB / 单次调用超时 15s / 中断处理器可切断死循环；
  卡死可杀、崩溃不拖垮主进程；teardown 断言可捕获且不毒化模块（已实测）。

- **契约**：插件文件定义 `globalThis.__mfPlugin = { manifest, create(host) }`；
  调用走「信封」（guest 永远 resolve `{ok,value}|{ok,false,error}`）；沙箱注入 URL/URLSearchParams 兼容层。

- **内置插件保持 in-process**（可信核心、直连 DB/服务，与 VSCode 内置扩展同理）；
  **外置插件一律进沙箱**（不可信边界）。

- **热重载**：`reload` 模式先释放旧沙箱再覆盖注册（内置不可遮蔽）。

- **测试**：`tests/plugins/sandbox.test.ts`（8）+ `sandboxPlugins.test.ts`（9，真实 go-music-dl/listenbrainz
  源码 + mock http）；全量 202 测试绿。文档 `docs/PLUGIN_DEV.md` 为沙箱契约版。

- 官方外置插件已迁移：go-music-dl 1.2.0、listenbrainz 1.1.0（`MusicFlow-plugins`，Release 资产分发，
  `minAppVersion 1.3.0`）。

