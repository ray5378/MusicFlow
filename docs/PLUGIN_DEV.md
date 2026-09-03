# MusicFlow 外置插件开发指南（PLUGIN_DEV）

> 适用版本：MusicFlow **沙箱运行时（QuickJS/WASM）1.3.0+**；核心按 `manifest.capabilities` 分发，**不写死任何插件名**。
> 当前主项目 ≈ **v1.13.40**；实例插件 `go-music-dl` 需后端 **≥ 1.7.39**（`longRunning` / 异步任务通道）。
> 目标：教你自己写一个 drop-in 插件，丢进 `data/plugins/<id>/` 即可被后端加载，**无需改任何核心代码**。

---

## 1. 插件放在哪

后端启动时（`initDatabase()` 之后）会扫描：

```
<data>/plugins/<your-plugin-id>/index.js
（可选：<data>/plugins/<your-plugin-id>/plugin.json —— 市场/校验用的 manifest 副本）
```

`<data>` 的位置由环境变量决定：

- 默认：`backend/data/`（即项目 backend 目录下的 `data/`）
- 或 `DATA_DIR` 环境变量指定的任意目录：`$DATA_DIR/plugins/<id>/index.js`

> 仓库里 `examples/plugins/hello-importer/index.js` 是一个可复制的参考实现。**它不在 `data/plugins` 下，所以不会被自动加载**——请把它整体复制到 `data/plugins/` 再启用。

**热重载**：修改 `data/plugins/<id>/` 下的文件后，后端会自动重新发现该插件——旧的 QuickJS 沙箱被释放、新代码重新加载，无需重启（见 §11）。

---

## 2. 插件 = 运行在 QuickJS 沙箱里的纯 JS

外置插件**不再**是 ES Module。它在独立的 QuickJS 虚拟机（WASM）里运行，只能拿到标准 JS（外加沙箱注入的 `URL` / `URLSearchParams` / `btoa` / `atob` 兼容层）。插件文件必须定义全局对象：

```js
globalThis.__mfPlugin = {
  manifest: { /* 自描述元数据 */ },
  create(host) { /* 返回 impl 对象 */ },
};
```

- `manifest`：告诉核心「我是谁、我会什么、需要什么配置、要什么权限」。
- `create(host)`：核心注入受控上下文 `host`（见 §6），插件用它闭包构造 `impl`——真正干活的函数集合。

**插件拿不到 Node 的任何能力**：没有 `import`/`require`/`fetch`/`fs`/`process`。网络只能走 `host.http` / `host.net` / `host.ws`（均自带超时与权限点），存储走 `host.storage`，文件走 `host.fs`（限插件目录），日志走 `host.log`。`permissions` 在宿主函数调用点强制执行——不再只是契约，是真实的运行时边界。

> 沙箱内**禁止使用 `eval` / `new Function`**（QuickJS 下即使用到也碰不到宿主，但核心直接拒绝此类代码）。

---

## 3. Manifest 字段（必填 + 选填）

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 全局唯一，正则 `^[a-zA-Z0-9][a-zA-Z0-9-]*$`，且必须与目录名一致。 |
| `name` | ✅ | 展示名（插件页显示）。 |
| `version` | ✅ | 插件版本，语义化版本串。**必须与 plugin.json 的 version 一致**，否则拒绝加载。 |
| `type` | ✅ | `"source" \| "importer" \| "recommender" \| "sync" \| "lyrics" \| "cover" \| "renderer" \| "scrobbler" \| "artist"` 之一。 |
| `capabilities` | ✅ | 非空数组，声明本插件提供的能力（见 §4，**沙箱据此白名单暴露 impl 方法**）。 |
| `configSchema` | ✅ | 数组（可为空 `[]`）。描述插件配置项，自动渲染成插件页表单。 |
| `description` | ⬜ | 描述。 |
| `permissions` | ⬜ | 字符串数组，声明本插件需要的权限（见 §6）。不声明则无受控能力可用。 |
| `platforms` | ⬜ | 字符串数组，用于前端提示（如 `["qq"]`）。 |
| `urlPatterns` | ⬜ | importer 插件专用：认领的分享链接 URL 模式（文档 + 管理端提示；实际路由用 impl 的 `canHandle()`）。 |
| `recommendPrefix` | ⬜ | source 插件专用：每日推荐歌单 URL 前缀。 |
| `dailyTag` | ⬜ | recommender 插件专用：每日推荐歌单标识 TAG（OpenSubsonic 等据此识别「今日推荐」）。 |
| `homePlaylistId` | ⬜ | recommender 插件专用：该插件在首页展示时对应的固定歌单 id（如「ListenBrainz」=`pl-lb-recommend`）。声明后插件才有资格参与「首页固定卡」自治（见 §4.12）。 |
| `platformLabels` | ⬜ | source 插件专用：平台 slug → 展示名 映射（如 `{ netease: "网易云", qq: "QQ 音乐" }`）。核心搜索结果据此显示平台中文名，**不再内置平台词典**——新增平台只需在插件里加一项。 |
| `sourcePreference` | ⬜ | source 插件专用：流兜底搜索的源排序偏好数组（越靠前越优先）。核心按此对兜底候选排序，缺省按插件返回顺序。 |
| `minAppVersion` | ⬜ | 要求的最低 App 版本；低于此版本会被跳过（沙箱运行时自 **1.3.0** 起）。 |
| `longRunning` | ⬜ | 方法级长耗时预算（毫秒）：`{ methodName: ms }`。声明的方法在沙箱调用时使用该预算（**上限 600000 = 10 分钟**），否则维持默认 15s 看门狗。用于拉取平台/外网歌单等慢网络操作（如 `go-music-dl` 的 `runDailyJob`/`playlistSongs`）。需后端 **≥ 1.7.39** 才生效，老后端会静默退化到 15s 并可能超时。**同时自动**在配置页注入「允许并行执行」开关（`batchParallel`，默认关，见 §3.3）：关 → 本插件的批量任务始终参与全局队列串行执行；开 → 被计入全局并发上限，可与其它开启该开关的插件并行执行。 |
| `schedules` | ⬜ | **定时能力声明**。指示本插件是否参与「每日定时同步 / 容器启动补拉」两条自动调度管线（见 §3.2）。取值 `true` / `false` / 对象 / 缺省（缺省按能力自动推断）。**涉及歌单能力的插件应显式声明它**。 |
| `documentation` | ⬜ | **Markdown 字符串**，插件详情页的「功能介绍 + 处理逻辑」说明（用户点「详情」看到的内容）。建议每个插件都写：功能一句话 + 处理逻辑（数据来源 / 触发时机 / 边界）。未提供时前端按能力自动生成通用说明。 |
| `author` / `homepage` / `icon` / `license` / `updateUrl` | ⬜ | 元数据，市场页展示。 |
| `defaultEnabled` | ⬜ | 外置插件默认 `false`（用户手动开启）。 |

> 发布到官方市场的插件，`plugin.json` 与 `index.js` 里的 manifest **必须逐字段一致**（`check.mjs` 会校验 id/version/capabilities）。

### 3.1 `configSchema` 字段结构

```js
{ key: "token", label: "访问令牌", type: "text", required: false, default: "", help: "可选" }
```

`type` 可选：`"text" | "url" | "number" | "select" | "multiselect" | "radio" | "switch" | "playlist-multi" | "candidate-list"`。
`select/multiselect/radio` 需提供 `options: [{ label, value }]`。

- `playlist-multi`：本地 + 平台导入歌单多选（可搜索），常用于「参考歌单」类配置（如本地推荐的 sourcePlaylists）。值 = 歌单 id 数组。
- `candidate-list`：可增删替换的编辑行列表（每项 `{ platform, url, name? }`），用于「推荐榜单」类配置（如每日推荐的 candidates）。值 = 对象数组。

### 3.2 定时能力声明（`schedules`）—— 涉及歌单能力的插件**必读**

> **规则**：凡是会**自动同步 / 生成 / 拉取歌单**的插件，都应参与宿主的两条自动调度管线，并在插件清单里**声明这一能力**。宿主据此往你的配置页注入两个开关（归入「**定时同步**」分组的「参与每日定时同步」与「容器启动时拉取一次」），用户可在插件配置页关闭某条管线，或让某插件只在容器启动时补拉。

两条自动管线（由 `backend/src/batch/jobs.ts` 的 `runSyncPipeline(gate)` / `maintenanceGated(gate)` 门控）：

| 管线 | 触发时机 | 门控开关 | 默认 |
|------|---------|---------|------|
| **每日定时同步** | 每天定点（默认 `03:00`，可在「首页推荐」定时设置改） | `scheduleEnabled`（`true`=参与，`false`=跳过此行） | 参与 |
| **容器启动补拉** | 每次 MusicFlow 启动/重启后 | `runOnBoot`（`true`=补拉一次） | 不补拉 |

两个开关**手动刷新不受影响**——「立即刷新」按钮 / `POST /rest/api/v1/recommend/refresh` 永远可用，不会被这两个开关挡掉。

#### `schedules` 的取值方式

| 取值 | 效果 |
|------|------|
| `true` | 两个开关（`scheduleEnabled` + `runOnBoot`）都注入配置页。 |
| `false` | 不注入任何开关，调度器也**不会**把它纳入两条管线。 |
| `{ scheduleEnabled: true }` | 只显示「参与每日定时同步」开关。 |
| `{ runOnBoot: true }` | 只显示「容器启动时拉取一次」开关。 |
| `{ scheduleEnabled: true, runOnBoot: true }` | 两个开关都显示。 |
| **缺省（推荐）** | 宿主按 `capabilities` **自动推断**：只要插件声明了下述任一**歌单能力**，就自动注入两个开关，无需手写 `schedules`。 |

> **涉及歌单能力 = 命中以下 `SCHEDULED_CAPS` 名单中的任一项**（`backend/src/services/plugin/scheduleFields.ts`）：
> `dailyPlaylist` / `localPlaylist` / `recommendPlaylist` / `localPlatformRecommend` / `comboPlaylist` / `playlistCleanup` / `recommend` / `webRotation` / `playlistSync` / `playlistImport` / `playlistFile` / `artistInfo`。
> 即：每日推荐、本地推荐、通用推荐、本地随机(按平台)、组合歌单、歌单清理、在线源每日推荐同步(`recommend`)、网页歌轮换(`webRotation`)、歌单再同步(`playlistSync`)、歌单导入(`playlistImport`/`playlistFile`)、歌手资料抓取(`artistInfo`)。
>
> 只要命中任一，缺省即可让配置页出现这两个开关——**这就是「所有歌单配置页面都接入定时能力而不用担心漏插件」的实现方式**：注入发生在注册的唯一漏斗 `registerPlugin()`（`backend/src/plugins/registry.ts` → `withScheduleFields`），**内置与外置沙箱插件统一走这一条路**，不靠逐个插件手写。

超时/自动推断之外，**外置插件想在 `plugin.json` 里显式声明**时，加一行即可（无需改 `index.js`，发现流程会把它合并进沙箱 manifest）：

```jsonc
// plugins/<id>/plugin.json
{
  "id": "my-playlist",
  "capabilities": ["playlistSync"],
  "schedules": true   // 或 { "scheduleEnabled": true, "runOnBoot": true } / false
}
```

> `schedules` 只影响**配置页是否出现开关 + 调度器是否门控**；它不会替你决定歌单能力的有无——该跑的业务方法（`runDailyJob` / `runSyncJob` 等）仍然由 `capabilities` 决定是否暴露。**能力与方法成对声明、能力 + `schedules` 成对声明**，两者都是让插件按预期工作的前提。

### 3.3 并行执行声明 —— 批量任务并发

> 宿主把所有批量任务（同步/导入/推荐/匹配/清理/刮削）收进**全局队列**，默认并发上限 = 1（FIFO 串行，全部任务排队）。**只要插件参与批量任务队列**（声明了 `SCHEDULED_CAPS` 中的任一能力（见 §3.2 清单），或声明了 `longRunning`），宿主就在配置页自动注入「允许并行执行」开关（键 `batchParallel`，默认**关**）：
>
> - **关（默认）**：本插件的批量任务始终参与全局队列串行执行，不提升并发。
> - **开**：本插件被计入全局并发上限，可与**其它开启本开关的插件**并行执行（批量任务跑在独立子进程/worker，利用多核，更快但 CPU 占用更高）。
>
> 与 §3.2 `schedules` 同源的批量能力清单收口，注入发生在注册唯一漏斗 `registerPlugin()`（→ `withBatchParallelField`），**内置与外置插件统一覆盖**，无需手写；是否声明 `longRunning` 只影响该插件有没有独立 worker 线程（线程隔离），**不影响开关是否出现**。开关切换无需重启，保存即生效（`batchPacer` 并发上限实时联动，幂等）。

---

## 4. 能力（capabilities）→ impl 方法：沙箱**白名单**暴露

> ⚠️ **这是最容易踩的坑，务必先读这一段。**
>
> 外置插件沙箱在 `makeImpl()` 阶段，**只从 `manifest.capabilities` 派生 impl 对象**：对每个声明的 capability，把 `CAP_METHODS[cap]`（见 `backend/src/plugins/sandbox.ts`）里的方法列出，再与 `create(host)` 实际返回的方法取交集。**未声明某 capability，对应方法就不会出现在 impl 上。**
>
> 后果：
> - **播放类插件必须声明 `stream` capability**，否则 `impl` 上没有 `streamUrl`，核心在 `/rest/stream-remote` 调用 `cfg.provider.streamUrl(...)` 会抛 **`streamUrl is not a function`**（`catch` 后返回「streamUrl is not a function」），前端/HA 卡片「搜索即播」直接失败。
> - 同样的规则适用于所有 capability：声明 `lyricProvider` 才有 `searchLyrics`，声明 `recommendPlaylist` 才有 `runDailyJob`，声明 `albumSearch` 才有 `searchAlbums`，依此类推。
> - **测试桩也受此约束**：任何要验证播放（`stream-remote` / 在线源「搜索即播」）的桩插件，`manifest.capabilities` 必须包含 `stream`，且 `create(host)` 必须返回 `streamUrl`。忘记声明会得到「is not a function」这种令人困惑的报错，而不是「插件未实现」。
>
> 校验脚本 `scripts/check.mjs` 会反向检查「有方法但没声明能力」并警告，但**不会**拦截「声明了能力但方法因 capability 缺失而没暴露」——那只在运行时表现为调用失败。所以：能力与方法必须成对声明。

### 4.0 通用调用约定

- **方法签名注意**：`source` 系方法（search*/recommend/playlistSongs/streamUrl）核心以 `(config, …)` 调用，`config` 即时刷新；而 `lyricProvider` / `coverProvider` / `scrobbler` / `artistInfo` 的方法，核心以 `(host, …)` 调用，但**沙箱门面会剥掉第一个 host 参数**——插件方法里直接用 `create(host)` 闭包捕获的 `host`（始终实时）。
- **同步方法**：`streamUrl` / `lyricUrl` / `canHandle` / `canHandleFile` 是纯同步的（构造 URL / 判断 URL 是否可处理），**不得发起网络**。
- **批量/慢方法**：拉取平台/外网的方法（如 `runDailyJob` / `playlistSongs` / `searchPlaylists` / `searchAlbums` / `searchSongs`）应在 `manifest.longRunning` 声明预算（需后端 ≥ 1.7.39）。
- **`search*` 系列参数**：`(config, { query, sources? })`，`sources` 是调用方指定的平台子集，空/缺省表示搜全部已声明平台。

### 4.1 `source` 类型（在线音乐源）—— 搜索/推荐/播放

| capability | impl 方法 | 说明 |
|------|------|------|
| `search` | `search(config, params)` → `{ songs: OnlineSongResult[] }` | 统一/兼容搜索入口（go-music-dl 等仍声明）。 |
| `songSearch` | `searchSongs(config, {query, sources?})` → `{ songs: RemoteSongShape[] }` | **歌曲搜索**（核心 `/v1/song-search` 实际调用）。 |
| `albumSearch` | `searchAlbums(config, {query, sources?})` → `{ albums: RemoteAlbumShape[] }` | **专辑搜索**（核心 `/v1/album-search`；HA 卡片也走此）。 |
| `artistSearch` | `searchArtists(config, {query, sources?})` → `{ artists: RemoteArtistShape[] }` | 歌手搜索。 |
| `playlistSearch` | `searchPlaylists(config, {query, sources?})` → `{ playlists: RemotePlaylistShape[] }` | **歌单搜索**（核心 `/v1/playlist-search`）。 |
| `recommend` | `recommend(config)` → `{ channels: [...] }` | 每日推荐频道。 |
| `playlistSongs` | `playlistSongs(config, source, id)` → `{ songs, name }` | 拉取单个远程歌单的歌曲。 |
| `stream` | `streamUrl(config, song, range?)` → **string（纯同步）** | 构造可播流地址；**不发起网络**。 |
| `lyrics` | —（**当前沙箱 `CAP_METHODS` 未映射此能力**，`lyricUrl` 不会被暴露到 impl） | ⚠️ 已废弃路径；请改用 `lyricProvider` → `searchLyrics`（见 §4.5）。声明 `lyrics` 但实际不会暴露任何方法，歌词会静默失效。 |
| `webRotation` | （由核心 purge 逻辑触发，无需方法） | 回收不再被引用的 web 歌曲/封面。 |

`OnlineSongResult` / `RemoteSongShape` = `{ id, source, name/title?, artist, album, duration, cover, extra? }`。
`RemoteAlbumShape` = `{ id, source, name, artist?, cover?, trackCount?, year?, link? }`。
`RemotePlaylistShape` = `{ id, source, name, creator?, cover?, trackCount?, link? }`。

> **`albumSearch` 实现要点**（血泪教训）：核心按 `albumSearch` 能力路由到 `searchAlbums`，但**前端/HA 卡片的专辑 DOM 结构是 `<li class="album-card" data-*>`**（与歌曲卡片同构），不是 `<div class="album-card">`。解析器必须同时匹配 `<li class="album-card">` 与 `<div class="album-card">`，并优先读 `data-*` 属性（`id/source/name/artist/cover/trackCount/link`），按 `source:id` 去重，跳过 `source==="local"`。只匹配 `<div>` 会得到 0 条结果，表现为「插件专辑在 HA 卡片和主项目都搜不到」。

### 4.2 `importer` 类型（歌单导入）

| capability | impl 方法 |
|------|------|
| `playlistImport` | `canHandle(url): boolean`（同步）+ `fetchPlaylist(url): Promise<ImportedPlaylistShape>` |
| `playlistFile` | `canHandleFile(raw): boolean`（同步）+ `parseFile(raw): Promise<ImportedPlaylistShape[]>` |

`ImportedPlaylistShape` = `{ name, platform, coverUrl?, tracks: ImportedTrackShape[] }`。

### 4.3 `recommender` 类型（每日 / 固定推荐歌单）

| capability | impl 方法 | 调度角色 |
|------|------|------|
| `dailyPlaylist` | `runDailyJob(): Promise<string\|null>`（可选 `generateDailyPlaylist(date?, {force,seedSalt})`） | 每日推荐（如 `pl-daily-today`） |
| `localPlaylist` | `runDailyJob(): Promise<string\|null>`（可选 `generateLocalDailyPlaylist(...)`） | 本地推荐（如 `pl-daily-local`） |
| `comboPlaylist` | `runDailyJob(): Promise<string\|null>`（可选 `generateComboPlaylist({force})`） | 组合歌单（如 `pl-daily-roam`，合并前两者去重） |
| `recommendPlaylist` | `runDailyJob(opts?): Promise<string\|null>` | **通用推荐歌单（第三方插件自管）** |

> `recommendPlaylist` 与上面三个内置调度类的区别：它是**给外置插件用的通用推荐入口**——插件自己拥有并维护一张固定歌单（通过 `manifest.homePlaylistId` 声明，如 `pl-lb-recommend`），核心不关心其内容来源。go-music-dl（私人歌单）与 listenbrainz（协同过滤推荐）都走这个 capability。`runDailyJob` 返回摘要行或 `null`（无操作）；手动刷新 `POST /v1/recommend/refresh` 传 `pluginId` 会以 `force` 强制重跑（走后端异步任务通道）。

调度顺序（内置三类）：`dailyPlaylist` → `localPlaylist` → `comboPlaylist`（组合歌单依赖前两者产物，必须最后跑）。`recommendPlaylist` 与它们并行参与每日调度与首页固定卡。

#### 首页固定卡（推荐插件自治）
推荐插件可通过 manifest 声明参与「首页顶部固定展示」：
- `manifest.homePlaylistId`：该插件在首页展示时对应的固定歌单 id（核心按此聚合，不写死歌单 id）。
- `configSchema` 声明两个配置项（插件设置页自动渲染）：
  - `showOnHome`（`switch`，默认 false）——是否显示在首页顶部；
  - `homePosition`（`number`，默认 0）——首页固定位次（1 起；0 = 未固定）。
- 核心经 `GET /v1/recommend/home-cards` 按位次排序返回固定卡列表；保存插件配置（`PUT /v1/plugins/:id`）或启用插件时，若位次与其它「显示在首页」的插件重复 → 400 拒绝并提示占用者。

内置 `daily-recommend` / `local-recommend` / `daily-roam` 是推荐类的参考实现；外置 `go-music-dl` / `listenbrainz` 通过 `recommendPlaylist` + `homePlaylistId` 接入同一套机制。

### 4.4 `sync` 类型（歌单同步）

| capability | impl 方法 |
|------|------|
| `playlistSync` | `runSyncJob(): Promise<string\|null>` |
| `autoMatch` | （复用 `search` 方法作在线匹配源） |

### 4.5 `lyricProvider`（歌词提供方）

| capability | impl 方法 |
|------|------|
| `lyricProvider` | `searchLyrics(song): Promise<{ lrc?, text? } \| null>` |

first-match-wins（首个返回非空结果的胜出；抛错被记入健康追踪后跳过）。

### 4.6 `coverProvider`（封面提供方）

| capability | impl 方法 |
|------|------|
| `coverProvider` | `searchCover(song): Promise<{ url? } \| null>` |

### 4.7 `renderer`（设备投屏）

| capability | impl 方法 |
|------|------|
| `renderer` | `discover(): Promise<RendererDevice[]>` + `cast(deviceId, songId)` + 可选 `control(...)` |

### 4.8 `scrobbler`（播放上报）

| capability | impl 方法 |
|------|------|
| `scrobbler` | 可选 `onPlay(event)` + 可选 `onScrobble(event)` |

`ScrobbleEvent` = `{ songId, title, artist, album?, duration?, playedAt }`。回调抛错会记入健康面板。

### 4.9 `artist`（歌手资料）

| capability | impl 方法 |
|------|------|
| `artistInfo` | `fetchArtistInfo(name): Promise<{ name, platform, coverArtUrl?, bio? } \| null>` |

first-match-wins（首个返回非空结果的胜出）。封面下载与数据库持久化由核心完成，插件只负责抓取返回纯数据。参考实现：内置 `artist-info`。

### 4.10 `source` 额外方法（非 capability，自动暴露）

- `test(config)`：source 插件的连线探测（核心「测试连接」按钮调用）；无需声明额外 capability，沙箱对 `type==="source"` 自动纳入。
- `health()`：可选自检钩子（非 capability）；插件实现了就暴露，供 `/v1/plugins/health` 主动 ping（结果缓存 60s）。

### 4.11 完整 capability → impl 方法映射（sandbox `CAP_METHODS`）

| capability | 暴露的 impl 方法 |
|------|------|
| `search` | `search` |
| `playlistSearch` | `searchPlaylists` |
| `songSearch` | `searchSongs` |
| `artistSearch` | `searchArtists` |
| `albumSearch` | `searchAlbums` |
| `recommend` | `recommend` |
| `playlistSongs` | `playlistSongs` |
| `stream` | `streamUrl` |
| `autoMatch` | `search` |
| `lyricProvider` | `searchLyrics` |
| `coverProvider` | `searchCover` |
| `scrobbler` | `onPlay`, `onScrobble` |
| `artistInfo` | `fetchArtistInfo` |
| `playlistImport` | `canHandle`, `fetchPlaylist` |
| `playlistFile` | `canHandleFile`, `parseFile` |
| `dailyPlaylist` | `runDailyJob` |
| `localPlaylist` | `runDailyJob` |
| `recommendPlaylist` | `runDailyJob` |
| `playlistSync` | `runSyncJob` |

> 记住：**这张表就是「声明了某 capability，核心才会去找对应方法」的依据。** impl 上最终只保留「capability 要求 + 插件实际实现」的交集。

---

## 5. 格式契约：音频格式与 `suffix`

> 与「`stream` capability 必须声明」同等重要——否则即使 `streamUrl` 存在，播放也可能因格式未知失败。

- **插件最清楚自己后端的输出格式**：`searchSongs` / `playlistSongs` 返回的歌曲对象**应带 `suffix` 字段**（如 `"flac"` / `"mp3"` / `"wav"` / `"aac"` / `"ogg"`）。前端优先用 `suffix` 决定解码格式，**不要求 URL 带扩展名**。
- **核心 `mapItems` 会原样透传 `suffix`**（不会丢弃），后端 → 前端链路都保留该字段。
- 若插件不提供 `suffix`，前端会对 `/rest/stream-remote` 做一次 `Range: bytes=0-0` 探测，读上游 `Content-Type` 推断格式（缓存，失败回退 `mp3`）。**探针路径更慢且依赖上游返回正确的 Content-Type**，所以播放类插件尽量带上 `suffix`。
- 该契约使 MusicFlow 兼容**所有音频格式**（mp3/flac/wav/aac/ogg...），而非硬编码 mp3。

---

## 6. 受控上下文 `host.*`（沙箱桥接）

插件运行在 QuickJS VM 里，`host` 是它触达宿主的**唯一**通道。权限在宿主函数的调用点检查——无权限时直接返回 `{ ok:false, error:"PERMISSION_DENIED: <perm>" }`，不会执行。

```js
globalThis.__mfPlugin = {
  manifest: { /* ... */ },
  create(host) {
    return {
      async searchLyrics(song) {
        host.log("looking up", song.title);
        const cached = await host.storage.get("lyric:" + song.title);   // storage 权限
        if (cached) return { text: cached };
        const res = await host.http("https://api.example.com/lyric?t=" + encodeURIComponent(song.title)); // net 权限
        if (!res.ok) return null;
        return { text: res.body };   // res.body 是文本
      },
    };
  },
};
```

| 成员 | 说明 | 所需权限 |
|------|------|----------|
| `host.config` | 本插件当前配置（**每次调用前刷新**，调用时实时读取） | — |
| `host.version` | 运行中的 App 版本 | — |
| `host.log(...args)` | 带插件前缀的日志 | `log`（默认允许） |
| `host.storage` | 插件级 JSON KV（`get/set/delete/keys`，异步） | `storage` |
| `host.http(input, init)` | fetch 封装：`init` 可带 `{ method, headers, body, timeout }`；返回 `{ ok, status, headers, body(text) }` | `net` |
| `host.comm` | 插件间通信（`send/broadcast/on`） | `inter-plugin` |
| `host.songs` | 宿主曲库**只读查询**（`list({limit,offset})` / `search(query,{limit})` / `getById(id)`），返回脱敏歌曲视图 `{ id, title, artist, album, duration, coverArt, playCount, genre, track, type }`（不含内部路径字段） | `songs:read` |
| `host.plugin` | 宿主身份/地址信息（`getHostUrl()` 返回 `DLNA_BASE_URL` 配置值、`getNetworkAddresses()` 返回本机 IPv4 列表） | —（只读低敏） |
| `host.fs` | 插件**专属目录** `<data>/plugins/<id>/files/` 内文件读写：`readFile/writeFile/appendFile/readdir/unlink/exists/mkdir/stat/rename`（**路径穿越拒绝**，任何越界路径直接抛错） | `fs` |
| `host.command` | 执行外部命令：`exec(program, args, {timeout})`（走 `execFile` 不经 shell，默认超时 30s）、`start(name, program, args)` / `stop(name)` / `isRunning(name)` 管理常驻进程 | `command` |
| `host.net` | 原始网络 socket：`udpBind({port,address,reuseAddr})` / `udpSend(id, data, {address,port})` / `udpClose` / `onData(id, handler)`；`tcpConnect(host, port, {timeout})` 返回 `{ send, onData, onClose, close }`。数据以 **base64** 传输（沙箱提供 `btoa/atob`），事件经回调推回 VM | `net` |
| `host.ws` | WebSocket 客户端：`connect(url, {headers, protocols, timeout})` 返回 `{ send, onMessage, onClose, close }`（文本直传、二进制 base64） | `websocket` |
| `host.jsenv` | 嵌套 QuickJS 子环境跑隔离脚本：`create(name, initCode)` / `execute(name, code)` / `destroy(name)`——子环境只有标准 JS，**没有 host.***，无法触达宿主 | `jsenv` |
| `host.playlists` | 受控写推荐歌单（需 `playlists:write`）：`upsert/get/replaceEntries/updateCover`。`opts.sourcePlatform` / `opts.sourceUrl` 写入歌单的平台标签/来源，前端据此显示平台徽标 | `playlists:write` |
| `host.sources` | 在线源补全（需 `songs:write`）：`complete({artist,title})` 把匹配不到本地的曲目交给已启用的 source 插件搜索并导入为可播本地 song，返回 `{ songId }` | `songs:write` |
| `host.crypto` | 纯同步工具（需 `crypto` 权限）：`md5(input)`（Last.fm api_sig 等签名用） | `crypto` |

### 6.1 权限白名单 `KNOWN_PERMISSIONS`

manifest 的 `permissions` 只能是白名单中的值，支持命名空间通配（`songs.*`）与全局 `*`。

```
log  storage  net  command  fs  fs:music  fs:external
websocket  jsenv  crypto
songs:read  songs:write  playlists:read  playlists:write  inter-plugin
```

> **已桥接的权限**：`log` / `storage` / `net`（`host.http` + `host.net` socket）/ `inter-plugin`（`host.comm`）/ `songs:read`（`host.songs`）/ `songs:write`（`host.sources`）/ `playlists:write`（`host.playlists`）/ `fs`（`host.fs` 插件目录内）/ `command`（`host.command`）/ `websocket`（`host.ws`）/ `jsenv`（`host.jsenv`）/ `crypto`（`host.crypto`）。
> **挂名未桥接**（白名单校验放行，但沙箱里没有对应宿主函数——刻意保留为未来扩展位）：`fs:music`、`fs:external`、`playlists:read`。外置插件无法改宿主曲库、无法读写宿主音乐库文件；`host.fs` 被限定在插件自己的 `files/` 目录。

---

## 7. 插件间通信 `host.comm`

```js
host.comm.on((msg) => { /* 收到消息 */ });
host.comm.send("other-plugin-id", { type: "hello", payload: 1 });
host.comm.broadcast({ type: "tick" });
```

---

## 8. 安全边界（后端强制 + 沙箱隔离）

加载外置插件时：

1. **QuickJS 沙箱**：代码在独立 VM 里运行，拿不到 Node 能力；内存上限 256MB、栈上限 1MB、单次调用超时 15s（长耗时方法见 `longRunning`）、中断处理器可切断死循环。
2. **路径白名单**：只能加载 `<data>/plugins/<id>/index.js`，路径穿越拒绝。
3. **Manifest 校验**：id / type / capabilities / configSchema 必须合规；`index.js` 与 `plugin.json` 不一致拒绝加载。
4. **权限执行点**：`host.http` 无 `net` 权限直接拒绝，不发起请求。
5. **minAppVersion**：低于要求版本跳过。
6. **id 冲突**：内置插件不可被外置遮蔽。
7. **高风险能力的硬限制**（均经权限执行点 + 运行期限制）：
   - `host.fs` 只能读写插件自己的 `<data>/plugins/<id>/files/`，**路径穿越（`../`、绝对路径）在宿主侧直接抛错**；
   - `host.command.exec` 走 `execFile`（**不经 shell**，参数不可拼接注入），默认 30s 超时、16MB 输出上限；`start` 管理的常驻进程随 `stop`/退出回收；
   - `host.net` / `host.ws` 与 `host.http` 同级（需 `net` / `websocket` 权限），socket 有连接超时；
   - `host.jsenv` 子环境**只有标准 JS，没有 `host.*`**——嵌套脚本无法触达宿主。

---

## 9. 安装与启用流程

**方式 A：拖入目录（开发 / 自托管）**

```bash
mkdir -p backend/data/plugins
cp -r my-plugin backend/data/plugins/
```

启动日志应出现 `[PLUGIN] 已加载外置插件 my-plugin (…) [沙箱]`。打开「插件」管理页启用即可。
插件首次使用 `host.fs` 时，宿主会自动创建它的专属目录 `<data>/plugins/<id>/files/`。

**方式 B：插件市场（推荐给普通用户）**

管理员「插件」页 →「插件市场」→「安装」，归档自动解压到 `data/plugins/<id>/` 并热加载。

> 外置插件默认 `defaultEnabled: false`，必须手动启用。

---

## 10. 官方外置插件（参考实现）

| id | 版本 | type | capabilities | 说明 |
|----|------|------|--------------|------|
| `go-music-dl` | 1.6.2 | source | `search` / `playlistSearch` / `songSearch` / `albumSearch` / `recommend` / `playlistSongs` / `stream` / `webRotation` / `lyricProvider` / `coverProvider` / `recommendPlaylist` | 全网聚合（源+歌词+封面+推荐 四合一）；私人歌单经 `recommendPlaylist` 持久同步 |
| `listenbrainz` | 1.5.9 | scrobbler | `scrobbler` / `recommendPlaylist` | **双功能**：播放记录上报（scrobbler）+ 协同过滤推荐歌单（recommendPlaylist，固定 `pl-lb-recommend`） |
| `lastfm` | 1.0.4 | scrobbler | `scrobbler` / `recommendPlaylist` | 双功能：Last.fm 播放记录上报 + 推荐歌单 |

> `go-music-dl` 的歌词 / 封面能力随该外置 source 插件分发（`lyricProvider` / `coverProvider`），核心按能力遍历调用，不再内置独立的歌词/封面插件。

源码在 [ray5378/MusicFlow-plugins](https://github.com/ray5378/MusicFlow-plugins)，发布前跑 `node scripts/check.mjs <id>`。
插件目录结构、打包（`pack.sh`）、Release 资产上传与 `registry.json` 登记的**完整发布流程见该仓库的
[README](https://github.com/ray5378/MusicFlow-plugins/blob/master/README.md)**；想贡献新插件也建议先读它。

---

## 11. 完整示例

### 11.1 歌词提供方（lyricProvider）

```js
globalThis.__mfPlugin = {
  manifest: {
    id: "demo-lyrics",
    name: "示例歌词源",
    version: "1.0.0",
    type: "lyrics",
    capabilities: ["lyricProvider"],
    permissions: ["net", "storage"],
    defaultEnabled: false,
    minAppVersion: "1.3.0",
    configSchema: [{ key: "apiKey", label: "API Key", type: "text" }],
  },
  create(host) {
    return {
      async searchLyrics(song) {
        const cacheKey = "lyric:" + (song.title || "") + ":" + (song.artist || "");
        const hit = await host.storage.get(cacheKey);
        if (hit) return { text: hit };
        const res = await host.http(
          "https://api.example.com/lyric?t=" + encodeURIComponent(song.title || ""),
          { timeout: 8000 },
        );
        if (!res.ok) return null;
        try {
          const data = JSON.parse(res.body);
          if (!data || !data.text) return null;
          await host.storage.set(cacheKey, data.text);
          return { text: data.text };
        } catch { return null; }
      },
    };
  },
};
```

### 11.2 播放上报（scrobbler）

```js
globalThis.__mfPlugin = {
  manifest: {
    id: "demo-scrobbler",
    name: "示例播放上报",
    version: "1.0.0",
    type: "scrobbler",
    capabilities: ["scrobbler"],
    permissions: ["net"],
    defaultEnabled: false,
    configSchema: [{ key: "token", label: "Token", type: "text" }],
  },
  create(host) {
    const token = () => (host.config && host.config.token) || "";
    return {
      async onScrobble(event) {
        if (!token()) throw new Error("未配置 token");
        const r = await host.http("https://api.example.com/scrobble", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event),
          timeout: 10000,
        });
        if (!r.ok) throw new Error("上报失败: HTTP " + r.status);
      },
    };
  },
};
```

### 11.3 双功能推荐插件（scrobbler + recommendPlaylist）

```js
globalThis.__mfPlugin = {
  manifest: {
    id: "demo-recommender",
    name: "示例推荐上报双功能",
    version: "1.0.0",
    type: "scrobbler",
    capabilities: ["scrobbler", "recommendPlaylist"],
    homePlaylistId: "pl-demo-recommend",
    permissions: ["net", "storage", "songs:read", "songs:write", "playlists:write"],
    minAppVersion: "1.7.39",
    longRunning: { runDailyJob: 120000 },
    defaultEnabled: false,
    configSchema: [{ key: "username", label: "用户名", type: "text", required: true }],
  },
  create(host) {
    return {
      async onScrobble(event) { /* 上报逻辑 */ },
      // recommendPlaylist 能力 → runDailyJob 才会被沙箱暴露
      async runDailyJob() {
        const top = await host.http("https://api.example.com/recommend?u=" + host.config.username);
        if (!top.ok) return null;
        const ids = JSON.parse(top.body).ids;
        await host.playlists.upsert("pl-demo-recommend", { name: "示例推荐", entries: ids });
        return "已生成 " + ids.length + " 首";
      },
    };
  },
};
```

### 11.4 读宿主曲库（host.songs，需 `songs:read`）

```js
globalThis.__mfPlugin = {
  manifest: {
    id: "demo-library",
    name: "示例曲库统计",
    version: "1.0.0",
    type: "lyrics",
    capabilities: ["lyricProvider"],
    permissions: ["songs:read"],
    defaultEnabled: false,
    minAppVersion: "1.3.0",
    configSchema: [],
  },
  create(host) {
    return {
      async searchLyrics(song) {
        const hit = await host.songs.getById(song.songId || "");
        if (!hit) return null;
        const sameTitle = await host.songs.search(hit.title, { limit: 20 });
        return { text: `[${hit.title}] 曲库共 ${sameTitle.length} 首同名/相关曲目` };
      },
    };
  },
};
```

> `host.songs.search("周杰伦")` 会模糊匹配 `title / artist / album`；`list({ limit, offset })` 支持分页（limit 上限 2000）。返回的歌曲是**脱敏视图**——拿不到 `path` / `streamHeaders` / `sourceData` 等内部字段。

### 11.5 高风险能力（host.fs + host.command，需 `fs` + `command` 权限）

```js
globalThis.__mfPlugin = {
  manifest: {
    id: "demo-fs-cmd",
    name: "示例文件+命令",
    version: "1.0.0",
    type: "lyrics",
    capabilities: ["lyricProvider"],
    permissions: ["fs", "command"],
    defaultEnabled: false,
    minAppVersion: "1.4.0",
    configSchema: [],
  },
  create(host) {
    return {
      async searchLyrics(song) {
        await host.fs.mkdir("files", { recursive: true });
        await host.fs.writeFile("files/report.txt", `title=${song.title}\ntime=${Date.now()}`);
        const r = await host.command.exec("node", ["-e", "console.log('ok')"], { timeout: 5000 });
        return { text: `wrote=${r.code === 0} stdout=${r.stdout.trim()}` };
      },
    };
  },
};
```

> ⚠️ `command` / `fs` / `net` / `websocket` / `jsenv` 是**高风险权限**：只给可信插件声明。`host.command` 等于把该插件的代码当作可执行程序信任——虽然沙箱隔离了代码本身，但**通过 `command` 跑出的进程是宿主级的**。安装第三方插件前请确认其来源与 `plugin.json` 声明的权限。

### 11.6 播放类测试桩（**必须声明 `stream`**）

```js
globalThis.__mfPlugin = {
  manifest: {
    id: "mf-test-stream",
    name: "播放测试桩",
    version: "1.0.0",
    type: "source",
    // ⚠️ 不声明 stream，impl 上就没有 streamUrl，/rest/stream-remote 会抛
    //    "streamUrl is not a function"。验证播放的桩必须带它。
    capabilities: ["songSearch", "stream"],
    permissions: ["net"],
    defaultEnabled: false,
    minAppVersion: "1.3.0",
    configSchema: [],
  },
  create(host) {
    return {
      async searchSongs(config, { query }) {
        // 带 suffix：前端直接拿到格式，无需 Range 探测
        return { songs: [{ id: "t1", source: "test", name: query, artist: "T", album: "A", duration: 120, cover: "", suffix: "mp3" }] };
      },
      // 纯同步：只拼地址，不发起网络
      streamUrl(config, song) {
        return "http://localhost:46401/" + song.id + ".mp3";
      },
    };
  },
};
```

---

## 12. 健康追踪

每个插件的核心调用都会记录成功/失败：0 失败 → green，1–2 → yellow，≥3 → red。状态在「插件」页「健康」列实时显示。

---

## 13. 常见问题

- **插件没出现？** 看启动日志里的 `[PLUGIN]` 行；被跳过会写明原因。
- **改了插件要生效吗？** 不需要重启——`data/plugins` 变更触发热重载（释放旧沙箱、加载新代码）。
- **能覆盖内置插件吗？** 不能。内置/先注册者优先。
- **插件能 import 或使用 Node API 吗？** 不能。沙箱里只有标准 JS + `host.*`；Node 的 `fetch`、`require`、`fs`、`process` 等一律不存在。文件操作走 `host.fs`（限插件 `files/` 目录），网络走 `host.http` / `host.net` / `host.ws`。
- **网络超时怎么办？** `host.http(url, { timeout: 8000 })` —— 不需要 AbortController。
- **URL / URLSearchParams 有吗？** 沙箱注入了兼容层，与浏览器行为一致；另有 `btoa/atob`（`host.net` 数据通道用）。
- **TypeScript 写的插件？** 先编译成纯 JS（无 ESM export）再放进去。
- **为什么报 `streamUrl is not a function`？** 你的 `manifest.capabilities` 里**没有 `stream`**，沙箱 `makeImpl()` 不会把 `streamUrl` 暴露到 impl 上（见 §4 开头）。补上 `stream` 能力并在 `create(host)` 返回 `streamUrl` 即可。同理适用于所有 capability。
- **`searchAlbums` 搜不到东西？** 确认前端/HA 的专辑 DOM 是 `<li class="album-card" data-*>`，解析器必须读 `data-*` 属性并按 `source:id` 去重（见 §4.1 注）。
- **外部插件安全吗？** 代码运行在 QuickJS 沙箱（内存/栈/超时受限、权限执行点强制、无 Node 能力）；但 `fs` / `command` / `net` / `websocket` / `jsenv` 是**高风险权限**——尤其 `command` 跑出的进程是宿主级的，只对可信插件开放。安装前请确认插件来源与其 `plugin.json` 声明的权限。
