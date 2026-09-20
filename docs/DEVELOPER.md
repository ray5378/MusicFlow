# MusicFlow 架构与开发指南（DEVELOPER）

> 适用于 **v3.0.x（当前主线）**。给想理解、修改、扩展本项目的开发者。
> 与插件相关的架构见 `PLUGIN_ARCHITECTURE.md`，写插件见 `PLUGIN_DEV.md`。
>
> 本文件描述 **main 分支的现状**，不是某个历史版本的快照。发现描述与代码不符时以代码为准，
> 并顺手把这里改对。

## 1. 技术栈与顶层形态

| 层 | 技术 | 说明 |
|---|---|---|
| 后端 | **Hono**（Web 框架）+ **SQLite**（`better-sqlite3` + drizzle-orm） | TypeScript。**单端口对外，但非单进程**（见 §1.1） |
| 前端 | **Vue 3 + Element Plus + Pinia + Vue Router** | Vite 构建，生产由后端托管 dist |
| 沙箱 | **quickjs-emscripten**（WASM QuickJS） | 外置插件隔离，**三层**（见 §1.1） |
| 实时 | **WebSocket**（ws 库） | 播放状态推送 |
| 设备 | **DLNA/UPnP**（SSDP + SOAP）、**AirPlay/RAOP**、**Sendspin** | 三类投屏渲染器 |
| 部署 | 单容器镜像（`ghcr.io/ray5378/musicflow` + `ray5378/musicflow`） | 仅 amd64 |

生产部署为**单端口**：后端在 `:46400`，前端构建产物由后端 `serveStatic` 托管；对外同时暴露
原生 API（`/v1/*` + `/rest/api/*` 别名）、OpenSubsonic（`/rest/*`）与 WebSocket（`/ws`）。

### 1.1 进程模型（一主多子）

**主进程**：HTTP/WS 路由、`QueueController` / `PlayerManager`（队列语义的单一权威）、dailyScheduler、
插件沙箱主线程 VM、sharp 封面渲染。

**子进程**（不留在主进程，避免节拍抖动与崩溃连带）：

| 子进程 | 生命周期 | 为什么在外 |
|---|---|---|
| 渲染器运行时（Sendspin / AirPlay RAOP） | **常驻**，由 `services/rendererHost/` 托管 | 硬实时推流节拍（25ms / 7.98ms）+ 原生 addon / WASM，需崩溃隔离 |
| 批量任务（scan / daily-jobs / boot-sync / maintenance / plugin-job） | **一次性**（fork → run → exit，全局 FIFO 只跑 1 个） | 内存峰值随退出归还 OS + 外置插件代码不可信 |
| ffmpeg（解码 / 转码） | 每次任务 | CPU 天然在进程外 |

常驻渲染器子进程**统一由 `services/rendererHost/` 托管**（fork、`mainReady` 握手、心跳看门狗、
退避重启 3s→30s、RPC、快照镜像）。**接新渲染器照 `rendererHost/index.ts` 顶部的六步清单走**，
不要另写一套 —— CI 的 `check-renderer-host.mjs` 会拦。

> 判定「该不该独立进程」的收益/成本信号（G1-G4 / K1-K4）见
> `docs/PROCESS_MODEL_AND_ISOLATION_PLAN.md` §2。

## 2. 后端目录结构

```
backend/src/
  index.ts            # 入口:初始化顺序(env→db→builtin 插件→官方注册表种子→外置插件→路由→定时器→WS/DLNA)
  utils/              # env(环境变量/DATA_DIR/JWT)/logger/...
  db/
    schema.ts         # drizzle 表定义(权威)
    index.ts          # db 实例 + CREATE TABLE IF NOT EXISTS(与 schema 保持双写一致)
  middleware/
    auth.ts           # 鉴权:Bearer(JWT/API Key) / OpenSubsonic u/t/s、u/p / ?token= 全部支持
  routes/
    api/index.ts      # 原生 API /v1/*(曲库/播放/插件/设置/用户/每日推荐/DLNA/groups/peers/flows/...)
    api/online.ts     # 在线源搜索/导入/推荐同步(按插件能力遍历)
    auth/index.ts     # 登录(挂载为 /rest/api/v1/auth/* 别名 + /api/v1/auth/*)
    rest/index.ts     # OpenSubsonic 服务端(46+ 端点)
    navidrome/        # Navidrome 风格原生 API 别名挂载(薄层)
  services/           # 业务逻辑(路由只做解析/鉴权/响应)
    content.ts        # 曲库浏览聚合(专辑/歌手/流派/统计)
    source/online/    # 在线源:搜索/流兜底/推荐导入/匹配/清理(全部按插件能力分发)
    player/           # 播放内核:UniversalPlayer / PlayerController / QueueController / PlaybackTracker / webhook
    dlna/             # DLNA:SSDP 发现 / SOAP 控制 / 事件订阅 / 队列
    group/            # 播放组(多设备同步)/ 离线看门狗
    peers.ts          # 同网段多实例发现(mDNS)
    ws/               # WS 推送服务端(/ws?token=)
    flows/            # 场景/自动化流
    rendererHost/     # ★常驻渲染器子进程通用宿主(supervisor/childHost/ipcProtocol/mode/front/
                      #   childBootstrap/paths)——新接渲染器照 index.ts 顶部六步清单
    sendspin/         # Sendspin 渲染器运行时(WS 38927 / mDNS / 拨号 / ESPHome 6053 桥 / 编解码推流)
    airplay/          # AirPlay 渲染器运行时(raop.ts 节拍 / sessionRuntime / decoder / 子进程接线)
    plugin/           # 内置插件实现(importer/recommender/sync/renderer/artist/core 等)
    lyrics.ts / coverCache.ts / playlistCover.ts / scraper/   # 歌词/封面/歌手信息抓取
  batch/              # ★批量任务一次性子进程(runner.ts: fork → ready → run → progress → result/exit)
  plugins/            # 插件框架
    types.ts          # PluginManifest / 能力枚举
    registry.ts       # 插件注册表 + 按能力遍历(getEnabledByCapability)
    builtins.ts       # 18 个内置插件(见 §4 后的清单;seedPluginRows 幂等落库)
    discovery.ts      # 外置插件扫描 + 沙箱加载 + validateManifest + host.* env 构造
    sandbox.ts        # QuickJS 沙箱(host.* 全量桥接:http/storage/comm/songs/plugin/fs/command/net/ws/jsenv)
    sandboxWorker.ts  # 沙箱 worker 线程入口(仅 manifest.longRunning 非空时创建)
    host.ts           # 权限白名单 KNOWN_PERMISSIONS + 校验
    storage.ts / comm.ts / registryCatalog.ts / hotReload.ts   # 插件 KV/通信/市场注册表/热重载
```

**内置插件清单（18 个，按类型）**：

| 类型 | 插件 |
|---|---|
| importer（3） | QQ 音乐、网易云、本地导入 |
| recommender（5） | 每日推荐、本地推荐、今日漫游、随机歌曲、本地随机(按平台) |
| sync（1） | 歌单同步 |
| renderer（3） | DLNA、AirPlay、Sendspin |
| artist（1） | 歌手信息 |
| core（5） | 多源组、播放优选、导入命中门禁、换源兜底、预探测（config-only，逻辑在核心） |

> `BUILTIN_SOURCE_PLUGINS` 目前为空 —— go-music-dl 已改回外置插件（经 MusicFlow-plugins 仓库分发）。

## 3. 关键数据流

### 3.1 播放链路（核心）
```
前端/集成 → POST /v1/peers/:peerId/play → services/player/PlayerController
  → 解析歌曲(本地/在线) → 取流地址(本地文件 | 插件 streamUrl | 流兜底)
  → UniversalPlayer 驱动:单设备 或 播放组(group 多设备同步)
  → PlaybackTracker 记历史 → WS /ws 推送状态 → scrobble 插件上报(可选)
```
- **渲染器后端由插件决定**：DLNA（推流地址给设备自己回连拉）、AirPlay（RAOP 推流）、
  Sendspin（WS 推流给 ESPHome 等设备）。三者都是 renderer 插件，核心按能力遍历 ——
  **加设备类型 = 写插件**。其中 AirPlay / Sendspin 的**推流运行时在子进程**（见 §1.1），
  主进程只发 RPC、读快照镜像；DLNA 无节拍循环，留在主进程（字节代理 + Range）。
- **"停止" vs "关闭"**：停止=只停当前曲、队列保留；关闭=停止+清空队列（产品语义，勿混）。
- 播放组对 HA 只读，集成不做 GROUPING。

### 3.2 插件链路（能力驱动）
```
核心需要某能力 → getEnabledByCapability("search"|"dailyPlaylist"|...) → 遍历启用插件 impl
外置插件(不可信) → QuickJS 沙箱 → host.* 桥接(权限执行点) → 信封返回
```
- **铁律：核心零平台字符串**。推荐前缀、平台名、providerId 全部来自插件 manifest。

### 3.3 前端数据流
```
Vue 页面 → src/api/(fetch 封装) → /v1/* 或 /rest/api/v1/*(同源) → Pinia store → 组件渲染
WS /ws?token= → 播放状态实时更新(播放中/进度/队列/设备)
```

## 4. 数据库（SQLite，37 张表）

> 构成：`db/schema.ts`（drizzle，权威）34 张 + 仅写在 `db/index.ts` 的 2 张
> （`airplay_devices` / `playlist_cover_claims`）+ 由 `plugins/storage.ts` 自建的
> `plugin_storage` 1 张。

| 组 | 表 |
|---|---|
| 用户 | `users`（含 api_key）、`user_favorite_songs`、`user_favorite_albums`、`user_favorite_artists`、`user_ratings`、`user_permissions`、`user_play_queues`、`play_history` |
| 曲库 | `artists`、`albums`、`album_artists`、`songs`、`genres`、`media_sources`、`cleaning_rules`、`wishes` |
| 歌单 | `playlists`、`playlist_songs`、`playlist_favorites`、`recommend_pool`、`playlist_cover_claims`（固定推荐歌单的封面去重锁） |
| 播放 | `dlna_devices`、`device_queues`、`local_queues`、`player_groups`、`group_queues`、`player_webhook_tokens`、`player_name_overrides`、`player_prefs` |
| 渲染器 | `sendspin_device_state`、`airplay_devices`、`user_renderer_grants` |
| 插件 | `plugins`（含 config JSON + enabled）、`plugin_registries`、`plugin_storage`（按 `plugin_id` 隔离 KV） |
| 其他 | `settings`（key/value）、`flows` |

> **双写约定**：改 `db/schema.ts` 必须同步 `db/index.ts` 的建表 SQL，两者必须一致。
>
> **本项目自用，不写任何向后兼容的迁移代码**：新增字段**直接改 `CREATE TABLE` 语句**，
> 老库自行重建即可 —— `ALTER TABLE ... ADD COLUMN` 的 PRAGMA 探测补列、「旧版字段继承给新字段」
> 这类逻辑**已全部删除，不要再加回来**（不要再维护「手工清 DB 旧字段」流程）。
>
> songs 的 `path` 为 NOT NULL；`INSERT OR IGNORE` 会吞掉约束错误（调试「影响行数 0」时先查约束）。

## 5. 前端目录结构

```
frontend/src/
  api/          # REST 封装(登录/曲库/播放/插件/设置)
  stores/       # Pinia(播放状态/用户/设置)
  router/       # 路由(登录守卫)
  layouts/      # 主布局
  views/        # 页面:Home(首页推荐)/Music(媒体库)/Albums/Artists/Genres/Playlists(含每日推荐)/
                #   Groups(播放组)/Flows/History/Favorites/Settings/admin/(插件管理/用户/数据等)
  components/   # 通用组件(播放条/歌词卡/虚拟滚动列表等)
  composables/  # 组合式函数(WS 订阅/虚拟滚动等)
```

## 6. 鉴权体系（一处打通全部）

`middleware/auth.ts` 统一支持：
- **Bearer JWT**：登录 `POST /api/v1/auth/login`（内部 REST 别名 `/rest/api/v1/auth/login`）拿 `token`（24h）；
- **Bearer API Key**：`/v1/users/me/api-key` 生成，常驻客户端（HA 集成）用，可随时吊销；
- **OpenSubsonic**：`u/t/s`（`t=md5(password+salt)`）、`u/p` 明文、`?token=`（JWT/API Key）。

> HA 集成契约（对外兼容）：`/v1/peers*` + `/v1/groups` + `/v1/play` + `/rest/*`(OpenSubsonic)
> + `/rest/api/*`(内部 REST 别名) 代理 + `/ws?token=`。**peers/groups 返回 `{"peers":[]}` 包裹对象**（不是裸数组）——写客户端时注意。

## 7. 常见开发任务速查

| 任务 | 改哪里 |
|---|---|
| 加一个 `/v1` 端点 | `routes/api/index.ts`（鉴权用 `adminMiddleware`） |
| 改 OpenSubsonic 行为 | `routes/rest/index.ts`（失败体用 `fail()`，勿 `ok({error})`） |
| 加数据库表 | `db/schema.ts` + `db/index.ts` 双写 |
| 加插件能力 | 写插件即可（核心零改动）；如需新能力枚举改 `plugins/types.ts` + `discovery.ts` 白名单 |
| 改播放行为 | `services/player/PlayerController.ts` / `QueueController.ts` |
| 改 DLNA 投屏 | `services/dlna/*` |
| 改 AirPlay 推流 | `services/airplay/{raop,sessionRuntime,decoder}.ts`；子进程接线见 `supervisor.ts` / `childMain.ts` / `child.ts` |
| 改 Sendspin 推流 | `services/sendspin/*`（运行时）+ `services/rendererHost/*`（宿主，通常不用动） |
| 新接一个渲染器 | 照 `services/rendererHost/index.ts` 顶部六步清单；CI `check-renderer-host.mjs` 会校验 |
| 改批量任务 | `src/batch/{runner,jobs,child}.ts`（一次性子进程，勿改回主进程内联） |
| 改前端播放体验 | `stores/` + `components/` + `views/Groups|Playlists` |

## 8. 环境变量

由 `utils/env.ts` 统一读取的核心项：

| 变量 | 说明 |
|---|---|
| `DATA_DIR` | 数据目录（SQLite 主库 + 歌词/封面/插件/密钥）；容器内为 `/data` |
| `PORT` | HTTP 监听端口（生产 `46400`） |
| `STATIC_DIR` | 前端构建产物目录（生产由后端 `serveStatic` 托管） |
| `JWT_SECRET` | 留空则首次启动自动生成并落盘 `.jwt-secret`（重启后稳定） |
| `CORS_ORIGINS` | 允许的跨域来源 |
| `LOG_LEVEL` | 日志级别 |
| `PLAY_HISTORY_RETENTION_DAYS` | 播放历史保留天数 |
| `MUSICFLOW_OFFICIAL_REGISTRY` | 插件市场注册表地址覆写 |

其余按子系统分布（语义以源码为准）：DLNA（`DLNA_BASE_URL` / `DLNA_EVENT_BASE_URL`）、
转码（`FFMPEG_PATH` / `TRANSCODE_MAX_CONCURRENT`（音质转码池上限）/
`TRANSCODE_PIPELINE_MAX_CONCURRENT`（默认实时管道池上限））、封面缓存与代理（`COVER_CACHE_BUDGET_MB` /
`COVER_CACHE_IDLE_MINUTES` / `COVER_PROXY_ALLOW_HOSTS` / `COVER_PROXY_ALLOW_PRIVATE`）、
插件沙箱（`SANDBOX_MEMORY_LIMIT` / `SANDBOX_CPU_IDLE_MS` / `SANDBOX_WORKER_DISABLE`）、
Sendspin 推流（`SENDSPIN_JITTER` / `SENDSPIN_PUSH_SPEED` / `SENDSPIN_STREAM_SOURCE`）、
版本注入（`APP_VERSION` / `APP_COMMIT`，由 CI 构建时写入）。

> 容器部署见 `docker-compose.yml`（已给出常用项）；完整清单以 `utils/env.ts` 与各子系统源码为准。
