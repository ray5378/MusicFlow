# 调研：songloft 插件化架构对 MusicFlow-V2 的启发

> 调研对象：`github.com/ray5378/songloft`（v2.x，Go + QuickJS 沙箱 JS 插件）
> 目的：对照 songloft 的插件体系，找出 V2 还能把哪些内置能力「插件化」、以及如何「让插件充分调用后端能力」。
> 结论：**不落代码，只给行动清单**。下文带 `songloft/...` 引用的是已核实的源码事实。
>
> **后续状态（2026-08-12）**：本调研建议的 **QuickJS 沙箱方案（方案 B）已落地**——V2 ≥ 1.3.0 起，
> 外置插件运行在 QuickJS/WASM 虚拟机里（`backend/src/plugins/sandbox.ts`），无 Node 能力、
> 网络走 `host.http`（权限执行点强制）、`host.storage` 隔离存储、单插件内存/栈/超时上限。
> 本文档保留为设计参考（songloft 的 provider 注册表、first-match-wins 等机制供后续迭代借鉴）；
> 现役沙箱契约见 `docs/PLUGIN_DEV.md`。

---

## 1. songloft 插件架构核心要点（已核实）

### 1.1 双向能力模型：宿主把 `songloft.*` SDK 注入插件 VM
插件不是「被核心 import 的实现」，而是运行在独立 QuickJS VM 里的 JS，宿主在启动时把一个全局 `songloft` 对象注入进去。插件**反向调用**后端能力：

- `songloft.songs`：`list / getById / search / create / update / delete / download / organize / setAutoDownload`（`internal/jsplugin/api_bridge.go:231`）
- `songloft.playlists`：`list / getById / getSongs / search / create / update / delete / addSongs / removeSongs / reorder`（`:275`）
- `songloft.storage` / `songloft.persistentStorage`：插件级 KV（JSON 序列化，`get/set/delete/keys`）（`:195`、`:213`）
- `songloft.plugin`：`getToken / getHostUrl / getFileUrl / getNetworkAddresses`（`:319`）
- `songloft.command`：`exec / start / stop / download`（`:368`）；`songloft.fs`：受限于插件数据目录的文件读写（`:409`）
- `songloft.jsenv`：在插件内再开子 VM 跑用户脚本（`:339`）；`songloft.net`：原始 UDP/TCP socket（`:467`）
- `songloft.log`：同步日志（`:188`）

**关键点**：插件永远只通过这套受控 SDK 接触后端，**不能直接 import 宿主内部包**。这既是封装边界，也是未来接「外部不可信插件」的安全前提。

### 1.2 Provider 注册 + first-match-wins（最值得抄）
歌词、封面不是写死某个源，而是**插件注册成 provider，宿主惰性遍历**：

- 插件调用 `songloft.lyrics.registerProvider()` / `songloft.covers.registerProvider()`（`api_bridge.go:447`、`:457`），宿主在 `Manager` 里记录 `entryPath`。
- 宿主核心要找歌词时调 `Manager.SearchLyrics(...)`，遍历已注册 provider，对每个 provider `InvokeHTTP(GET, "/lyric-search", query)`（`manager.go:610`、`:630`）；封面同理 `SearchCover → /cover-search`（`manager.go:684`、`:703`）。
- 多个 provider 共存时按**注册顺序 first-match-wins**；还有「休眠 provider 被搜索请求唤醒」的 idle-wakeup 机制（`idle_wakeup_test.go`）。
- 宿主侧 `HasLyricProvider() / HasCoverProvider()` 决定要不要走插件路径（`manager.go:661`、`:732`）——这正是我们「核心按能力遍历启用插件」思路的强化版，但**把能力从接口方法升级成了 HTTP 端点的 provider 注册表**，解耦更彻底。

### 1.3 权限模型（声明式 + 前缀通配）
`plugin.json` 的 `permissions` 数组声明插件要用的能力，运行时在 bridge 调用点校验（`permissions.go`）：
- 细粒度：`storage`、`songs.read`、`songs.write`、`playlists.read`、`playlists.write`、`inter-plugin`、`command`、`jsenv`、`fs`、`fs:music`、`fs:external`、`websocket`、`persistent-storage`、`net`
- 通配糖：`songs.*`、`playlists.*`、`fs.*`（`CheckPermission` 前缀匹配）
- `ValidatePermissions` 在 manifest 校验阶段拒绝未知权限

### 1.4 分发注册表（registry.json）+ 安装/自更新
- 远端 `registry.json` 是 `plugins: [plugin.json URL]` 数组，支持递归 `includes`（`registry.go:53`）。
- `RegistryService.FetchAndMerge` 并发拉取、按 `entry_path+作者` 去重、高版本优先（`registry.go:79`、`:116`）；带 GitHub 代理失败回退。
- 安装走 `POST /upload`（≤50MB zip）或 `POST /registry/install`（按 download_url），**新装默认启用**（`jsplugin.go` 处理层）。
- `updateUrl` 支持 `check-update` / `update` 自更新（`jsplugin.go` 路由）。

### 1.5 生命周期 + 健壮性
- 全局钩子：`onInit / onDeinit / onHTTPRequest / onWebSocket`（`api_bridge.go` 注释）。
- **健康检查**：`HealthChecker` 记录下载成功率，标 green/yellow/red，失败自动恢复 `RecoverPlugin`（`health.go:485`、`:600`）；`GET /api/v1/plugins/health` 暴露。
- **热重载**：活跃插件被上传覆盖/更新时自动 `ReloadPlugin`（`jsplugin.go` 处理层），无需重启。
- 路由以 `entry_path` 作唯一前缀（`/api/v1/plugins/{entryPath}/...`），同名不同作者需 `overwrite` 确认。

### 1.6 Manifest 完整字段 + 完整性校验
`plugin.json`：`name/version/description/author/homepage/license/entryPath/main/minHostVersion/permissions/renderEngine/updateUrl/download_url`，外加**完整性哈希** `entryHash`（sha256(main.js)）、`zipHash`（除 plugin.json 外全量哈希），缺失/不符则拒装（`docs/js-plugin-development-guide.md`）。

### 1.7 沙箱
每插件独立 QuickJS VM，Actor 模型，`ServiceScheduler` 调度消息；`fetch`/crypto/定时器为默认开放能力。

---

## 2. V2 现状对照（gap）

| 维度 | songloft | MusicFlow-V2 现状 |
|---|---|---|
| 调用方向 | 宿主注入 `songloft.*` SDK，**插件反调后端** | 插件是 in-process TS 模块，**直接 import 后端内部包**（goMusicDl 等） |
| Provider 注册 | lyrics/covers 注册成 provider，first-match-wins | 仅 `lyrics` 能力挂在 source 插件上，go-music-dl 垄断歌词；**无 coverProvider** |
| 权限 | 声明式 + 校验 | 无权限概念 |
| 分发 | registry.json + 市场 + 自更新 | 仅 `data/plugins/<id>/index.js` 拖入；无市场/注册表/自更新 |
| 健康检查 | green/yellow/red + 自动恢复 | 无（DLNA 设备有下线逻辑，但插件无） |
| 热重载 | 上传即重载 | 改插件需重启后端 |
| 存储 | `storage`/`persistentStorage` KV | 仅 `config`（每插件配置），无通用 KV |
| Manifest | 含 author/icon/updateUrl/hash | 仅 id/type/capabilities/configSchema/platforms/minAppVersion |
| 沙箱 | QuickJS 隔离 | in-process，无隔离 |
| 插件间通信 | `comm.send/call` + `inter-plugin` | 无，核心做编排 |
| 已插件化 | 音源/歌词/封面/元数据/设备/命令 | source / importer×3 / dailyRecommend / playlistSync |

**尚未插件化的 V2 内置功能**（用户关心的「内置功能要插件化」）：
- `localRecommend`（本地「猜你喜欢」推荐引擎）—— 仍是核心，未注册成 recommender 插件
- 歌词 provider —— 只有 source 插件顺带提供，无独立 lyricProvider 注册表
- 封面 provider —— 完全没有插件路径（封面只来自 source URL + 本地扫描）
- 渲染器/设备控制（DLNA）`services/dlna/*` + `peer.ts` —— 全核心，无可插拔 rendererProvider
- 播_scrobbler（Last.fm/ListenBrainz）、元数据指纹（AcoustID） —— 无

---

## 3. 需要做的（行动清单，按优先级）

### P0 — 架构性（先做，否则后面都是补丁）
1. **定义受控 `host.*` 上下文，取代插件直接 import 后端**
   - 仿 `songloft.*`：给每个插件注入 `ctx`（或 `host`）对象，暴露 `host.songs / host.playlists / host.storage / host.log / host.http / host.config`。
   - 先把内置插件（goMusicDl、qq/netease/native importer、dailyRecommend、playlistSync）从「import 核心服务」改造成「只用 `host.*`」。这一步是后面接外部插件、做权限的前提。
   - 对应文件：`backend/src/plugins/{types,registry,builtins}.ts`、`services/plugin/*`。

2. **歌词 / 封面 provider 注册表（first-match-wins）**
   - 新增 `lyricProvider` / `coverProvider` 两类 capability（或独立 plugin type）。
   - 宿主侧新增 `SearchLyrics() / SearchCover()`：遍历 `getEnabledByCapability("lyricProvider")`，逐个调插件 `lyricSearch(title,artist,...)` / `coverSearch(...)`，first-match-wins；`HasLyricProvider()` 决定走不走插件路径（抄 `manager.go:610`）。
   - 把 go-music-dl 的 `lyricUrl` 拆成独立的 `lyricProvider` 插件（可多个并存），核心不再写死。
   - 封面同理新增 `coverProvider`，让社区能补网易云/QQ 封面源。

### P1 — 继续插件化内置功能
3. **`localRecommend` 插件化**：注册成 `recommender` 类型、capability `localPlaylist`（或复用 `recommend`），核心推荐入口改为遍历启用 recommender。
4. **`rendererProvider`（设备/渲染器）插件化**：把 DLNA 控制从核心抽成 `rendererProvider` capability（capability 如 `render`/`discoverDevices`/`control`），核心只做「按能力遍历渲染器」。这样 Chromecast / AirPlay / Kodi 可由社区插件接入，不必改核心。涉及 `services/dlna/*`、`peer.ts`、`index.ts` 的设备调度。
5. **`scrobbler` 插件化**（中优先）：新增 `scrobbler` capability（`onPlay/onScrobble` 钩子），核心在播放事件里遍历启用 scrobbler。Last.fm / ListenBrainz 各一插件。
6. **`metadataProvider`（元数据/指纹）插件化**（低优先）：封面/标签补全可由插件提供，丰富本地扫描。

### P1 — 权限模型
7. **PluginManifest 加 `permissions` 字段 + 校验**
   - 仿 `permissions.go`：定义权限白名单（`songs:read`、`playlists:read`、`storage`、`net`、`command`、`fs` 等）+ 通配糖。
   - `validateManifest` 里 `ValidatePermissions`；`host.*` 各命名空间按权限拒绝越权调用。
   - 前端插件页展示「该插件要哪些权限」，启用前让用户知情。

### P2 — 分发与运维
8. **分发注册表 + 插件市场 UI**
   - 新增 `RegistryService`（抄 `registry.go` 的递归 includes / 去重 / 高版本优先 / GitHub 代理回退）。
   - 后端 `GET /v1/plugins/registry` + 前端「插件市场」页：列出注册表插件、一键安装（下载 zip → 落到 `data/plugins/<id>/`）。
   - 保留现有 `data/plugins` 拖入作为「手动安装」路径。
9. **自更新**：manifest 加 `updateUrl`；后端 `check-update` / `update`，前端市场页展示「可更新」。
10. **健康检查 + 自动恢复**：插件可选实现 `health()`；宿主记录失败率标 green/yellow/red，连续失败 N 次自动跳过并标「异常」，恢复后自动回启（抄 `health.go`）。对外部 source/lyric provider 特别有价值。
11. **热重载**：`data/plugins` 文件变更 → 监听 → 重新 `registerPlugin` + `seedPluginRows`，无需整后端重启。

### P2 — Manifest / 存储增强
12. **Manifest 增强**：补 `author / homepage / license / icon / updateUrl / downloadUrl`；市场下载的插件加 `entryHash/zipHash` 完整性校验（抄 1.6）。
13. **`host.storage` KV**：给插件一个通用键值存储（JSON），区别于 `config`（配置）。用于歌词缓存、OAuth token 等（抄 `songloft.storage`）。

### P3 — 进阶
14. **插件间通信 `host.comm`**：`send/call` + `inter-plugin` 权限，让 recommender 问 source 解析曲目等组合场景；核心编排压力下沉到插件（抄 `communication.go`）。

---

## 4. 不适合照搬 / 风险提示

- **沙箱差异（最大）**：songloft 用 QuickJS 把插件隔在独立 VM，即使恶意也碰不到宿主内存。我们是 **Node/TS in-process**，插件能 `require` 任意模块、直接摸 DB。**因此「权限模型」在我们这里只是契约/文档级，不是运行时隔离**——不能指望它挡住恶意外部插件。务实做法：内置插件可信（在仓库里）；外部插件走 `data/plugins` 拖入但**仅给 `host.*` 上下文、禁止 import 后端内部**（靠约定 + lint/code review，非运行时强隔离），UI 上明确「外部插件需自行承担风险」。
- **provider 用 HTTP 端点还是 TS 方法**：songloft 跨 VM 所以用 HTTP 端点（`/lyric-search`）。我们 in-process，直接用 TS 方法更自然；**不必为了像而像**——保留「能力遍历 + 方法调用」即可，provider 注册表（first-match-wins + 可共存多源）才是真正该抄的。
- **`command`/`fs`/`net` 权限风险高**：这类在 in-process 下几乎等于「给插件本机执行权」，对外置插件应默认关闭或仅限可信源。
- **不要过度插件化**：均衡器/DSP、转码等和核心播放管线强耦合，拆插件收益低、风险高，建议维持核心。

---

## 5. 建议落地路线图

- **Phase 4（P0）**：`host.*` 上下文 + 内置插件改用 `host.*`；lyricProvider/coverProvider 注册表 + first-match-wins；go-music-dl 歌词拆独立插件。
- **Phase 5（P1）**：localRecommend / rendererProvider(DLNA) / scrobbler 插件化；权限模型。
- **Phase 6（P2）**：分发注册表 + 市场 UI + 自更新 + 健康检查 + 热重载 + Manifest/存储增强。

> 注：当前 V2 已落地 Phase 0+1（能力驱动核心）+ Phase 2（importer/recommender/sync 插件化）+ Phase 3（外置插件发现）。以上为 Phase 4+ 的调研输入。
