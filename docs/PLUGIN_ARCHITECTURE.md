# MusicFlow-V2 插件化架构与开发文档

> 版本：基于 MusicFlow 复制基线（v1.1.29）重构
> 目标：把内置的 `go-music-dl` 从「深度耦合」改造成「真正的插件」，核心代码不再写死任何具体在线源实现；并搭建一套可扩展的统一插件框架，为后续把「歌单导入 / 每日推荐 / 歌单同步」也插件化预留接口。

---

## 0. 范围说明（本次交付）

本版（V2 Phase 0 + 1）聚焦 **在线音乐源（Source）的插件化**，这是用户原始诉求「go-music-dl 不再和项目深度耦合」的完整答案：

- Phase 0：统一插件注册表 + 统一 Manifest 类型 + DB 种子改由 manifest 驱动；go-music-dl 改为通过 registry 注册，删除编译期硬 import。
- Phase 1：核心调度 / 歌词 / 流兜底 / 推荐前缀全部改为「遍历有能力的启用插件」，不再出现字符串 `"go-music-dl"`。

**后续进度**：Phase 2（把 `playlistImport` / `dailyRecommend` / `playlistSync` 注册成 plugin 类型，并彻底去掉 `getConfiguredProvider("go-music-dl")` 与 `gmdl://` 写死）已在 §7.2 全部完成；`localRecommend` 因价值低保持为内置模块、不强制插件化。Phase 3（社区外置 drop-in 插件）见 §6 仍为待实现里程碑。

---

## 1. 现状调研结论（耦合点清单）

| # | 位置 | 耦合表现 | 类型 |
|---|------|---------|------|
| C1 | `services/source/online/index.ts:13` | `initOnlineProviders()` 在模块加载时直接 `import goMusicDl.ts` 并 `register` | 编译期硬注册 |
| C2 | `routes/api/online.ts` / `index.ts:15` | 导出常量 `GO_MUSIC_DL_PROVIDER_ID` 并被各处引用 | 名字常量泄漏 |
| C3 | `index.ts:238 / 250` | 定时器 `runDailyJobs` 直接 `syncAllRecommendPlaylists("go-music-dl")` / `purgeExpiredWebSongs("go-music-dl")` | 调度写死字符串 |
| C4 | `services/source/online/streamFallback.ts:160` | 兜底默认 provider 写死 `song.pluginEntry \|\| "go-music-dl"` | 默认值写死 |
| C5 | `services/lyrics.ts:76-96 / 107` | `deriveGmdlLrcUrl()` 硬编码 `/music/download`→`/music/download_lrc` 推导 | gmdl 专属逻辑混在核心 |
| C6 | `services/source/online/recommendImport.ts:24` | `RECOMMEND_URL_PREFIX = "gmdl://recommend/"` 写死前缀 | 前缀写死 |
| C7 | `services/plugin/playlistSync.ts:145` | `getConfiguredProvider("go-music-dl")` 直调 | providerId 写死 |
| C8 | `frontend/.../Plugins/index.vue:98-111 / 117 / 167` | `sourceOptions` 平台列表写死；`isSourcePlugin` 判定 `provider==="go-music-dl"`；`providerId` 缺省回退 `"go-music-dl"` | 前端语义写死 |
| C9 | `db/index.ts:391-407` | DB 种子把 `go-music-dl` 作为唯一内置插件写死 INSERT | 种子写死 |

**已具备的插件化基础（保留，不推翻）**：

- `plugins` 表（manifest / config / enabled）+ `OnlineProvider` 接口 + 运行时 `Map` 注册表（`types.ts:78`）。
- `/v1/online/:providerId/*` 参数化路由；`baseUrl` 等配置存于 `plugins.config`。
- 前端 `Playlists/Detail.vue`、`Playlists/index.vue` 已通过 `/v1/plugins` 动态发现首个启用的 source 插件做搜索/匹配（**不写死** go-music-dl）。
- 管理员插件页支持启停 / 配 baseUrl / test / purge。

结论：Source 已有 70% 插件骨架，缺的是「统一 Manifest 契约 + 编译期去硬注册 + 核心去字符串 + 配置 schema 化」。

---

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

---

## 3. 数据模型

不加新表、不改 `songs` 结构。沿用：

- `plugins` 表：`id, name, version, description, manifest(JSON), enabled, config(JSON), created_at, updated_at`。
- `songs.pluginEntry`：存 provider id（如 `go-music-dl`），用于回溯「这首歌由哪个在线源来」。
- `songs.sourceData`：存原始元数据（title/artist/source 等）。

`manifest` 字段扩展为统一结构（见 §4）。DB 种子改为「遍历内置插件清单 → 不存在则 INSERT」，去掉写死的 `go-music-dl` 字符串（C9）。

---

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

---

## 5. 核心解耦映射（Phase 1）

| 原耦合 | 改为 |
|--------|------|
| C3 `syncAllRecommendPlaylists("go-music-dl")` | 遍历 `getEnabledSourcePlugins()` 中 `capabilities.includes("recommend")` 的插件，逐个 `syncAllRecommendPlaylists(providerId, config)` |
| C3 `purgeExpiredWebSongs("go-music-dl")` | 同上，仅对 `capabilities.includes("webRotation")` 的插件调用 |
| C4 兜底默认 `"go-music-dl"` | 默认 provider = 第一个 `capabilities.includes("stream")` 的启用 source 插件；`song.pluginEntry` 仍优先 |
| C5 `deriveGmdlLrcUrl` | `lyrics.ts` 对 `type==="web"` 歌曲，取 `getPlugin(song.pluginEntry)?.impl.lyricUrl?.(config, song)`，无则走原 w:/l: 分支；`deriveGmdlLrcUrl` 逻辑移入 go-music-dl 插件的 `lyricUrl` |
| C6 `RECOMMEND_URL_PREFIX` | 由 `provider.recommendPlaylistRef(channel, id)` 生成；stale 检测用 `provider.recommendPlaylistRef` 反推前缀 |
| C2 `GO_MUSIC_DL_PROVIDER_ID` 外部引用 | 仅在 go-music-dl 插件内部定义；核心调度不再 import 该常量 |
| C8 前端写死 | 配置表单由 `manifest.configSchema` 渲染；`providerId` 由 `manifest.provider` 给出，无回退字符串；`sourceOptions` 来自 `manifest.platforms` |

行为保持：go-music-dl 用户无感，搜索/歌词/推荐/兜底照常工作。

---

## 6. 后续里程碑

- **Phase 2（全量插件化）**：✅ 已完成（见 §7.2）。定义 `ImporterPlugin` / `RecommenderPlugin` / `SyncPlugin` 接口；把 `playlistImport` / `dailyRecommend` / `playlistSync` 注册进 registry，删掉 `playlistSync.ts` 的 `getConfiguredProvider("go-music-dl")` 与 `gmdl://` 写死；`localRecommend` 保留为内置模块（价值低，不强行插件化）。
- **Phase 3（外置插件）**：⏳ 待实现。boot 扫描 `data/plugins/<id>/index.js` 动态 `import`，加 manifest 校验 + 路径白名单 + `minAppVersion` 校验；出插件开发文档 `PLUGIN_DEV.md`。

---

## 7. 任务清单（实现进度追踪）

> 每完成一项即标记完成。括号内为代码映射。

- [x] **T0** 复制基线 → `MusicFlow-V2`，初始化新 git，改名 musicflow-v2-*（已完成）
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

Phase 0 + 1 全部完成。全库检索 `"go-music-dl"` 后残留位置及定性：

| 位置 | 性质 | 处理 |
|------|------|------|
| `services/source/online/goMusicDl.ts` | 插件自身实现与 manifest 的 `id` | **合理**，插件必须声明自己的 id |
| `services/plugin/playlistSync.ts:145` | `getConfiguredProvider("go-music-dl")` | Phase 2 收口（该函数已走 registry，只剩 providerId 字符串） |
| `streamFallback.ts` 末位兜底 | registry 无任何 stream 插件时的 last-resort 默认值 | **可接受**，仅防御性回退 |
| 前端 `Playlists/*.vue` | 静态提示文案 + `manifest?.provider === "go-music-dl"` 旧字段兼容判定 | **可接受**，主路径已走 `/v1/plugins` 动态发现 |

结论：核心调度、歌词、流兜底、推荐前缀、DB 种子、前端配置表单**均已零硬编码**，go-music-dl 已是一个可被任意同契约插件替换的实现。

### 7.2 Phase 2（全量插件化：importer / recommender / sync）

> 目标：把 `playlistImport` / `dailyRecommend` / `playlistSync` 这些「名为插件、实为硬编码模块」的功能真正注册成 plugin 类型，核心只按能力遍历；并彻底删除最后一处 `go-music-dl` / `gmdl://` 字面量。

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

**Phase 2 收口后残留 `go-music-dl` 字符串审计**：仅剩 `services/source/online/goMusicDl.ts` 插件自身实现与 manifest `id`（合理）；其余核心/前端均已零硬编码，可被任意同契约 source/importer 插件替换。

---

## 8. 验证方式

1. **类型/构建**：`cd backend && npx tsc --noEmit`；`cd frontend && npx vue-tsc --noEmit`。
2. **行为不回归**（部署后手测）：
   - 启用 go-music-dl 插件、填 baseUrl → 在线搜索正常；
   - 播放任一在线歌曲歌词正常显示（V1 已修的逐字问题保持）；
   - 每日推荐歌单同步 + web 歌曲轮换清理仍触发；
   - 流播放兜底（原曲失效→多源）仍工作；
   - 全文检索后端源码，确认无残留字符串 `"go-music-dl"`（除插件自身实现与 manifest）。
3. **边界**：禁用 go-music-dl 插件后，定时器不再调度其任务（registry 交集过滤生效）。
