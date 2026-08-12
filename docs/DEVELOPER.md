# MusicFlow-V2 架构与开发指南（DEVELOPER）

> 适用 v1.4.0+。给想理解、修改、扩展本项目的开发者。
> 与插件相关的架构见 `PLUGIN_ARCHITECTURE.md`，写插件见 `PLUGIN_DEV.md`。

## 1. 技术栈与顶层形态

| 层 | 技术 | 说明 |
|---|---|---|
| 后端 | **Hono**（Web 框架）+ **SQLite**（`better-sqlite3` + drizzle-orm） | TypeScript，单进程单端口 |
| 前端 | **Vue 3 + Element Plus + Pinia + Vue Router** | Vite 构建，生产由后端托管 dist |
| 沙箱 | **quickjs-emscripten**（WASM QuickJS） | 外置插件运行隔离 |
| 实时 | **WebSocket**（ws 库） | 播放状态推送 |
| 设备 | **DLNA/UPnP**（SSDP + SOAP） | 投屏渲染器 |
| 部署 | 单容器镜像（`ghcr.io/ray5378/musicflow-v2`） | 仅 amd64 |

生产部署为**单进程、单端口**：后端在 `:46400`，前端构建产物由后端 `serveStatic` 托管；对外同时暴露
原生 API（`/v1/*` + `/rest/api/*` 别名）、OpenSubsonic（`/rest/*`）与 WebSocket（`/ws`）。

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
    plugin/           # 内置插件实现(importer/recommender/sync/renderer 等)
    lyrics.ts / coverCache.ts / playlistCover.ts / scraper/   # 歌词/封面/歌手信息抓取
  plugins/            # 插件框架
    types.ts          # PluginManifest / 能力枚举
    registry.ts       # 插件注册表 + 按能力遍历(getEnabledByCapability)
    builtins.ts       # 7 个内置插件(seedPluginRows 幂等落库)
    discovery.ts      # 外置插件扫描 + 沙箱加载 + validateManifest + host.* env 构造
    sandbox.ts        # QuickJS 沙箱(host.* 全量桥接:http/storage/comm/songs/plugin/fs/command/net/ws/jsenv)
    host.ts           # 权限白名单 KNOWN_PERMISSIONS + 校验
    storage.ts / comm.ts / registryCatalog.ts / hotReload.ts   # 插件 KV/通信/市场注册表/热重载
```

## 3. 关键数据流

### 3.1 播放链路（核心）
```
前端/集成 → POST /v1/peers/:peerId/play → services/player/PlayerController
  → 解析歌曲(本地/在线) → 取流地址(本地文件 | 插件 streamUrl | 流兜底)
  → UniversalPlayer 驱动:单设备(DLNA/本地) 或 播放组(group 多设备同步)
  → PlaybackTracker 记历史 → WS /ws 推送状态 → scrobble 插件上报(可选)
```
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

## 4. 数据库（SQLite，28 表）

| 组 | 表 |
|---|---|
| 用户 | `users`（含 api_key）、`user_favorite_songs`、`play_history`、`user_ratings`、`user_play_queues` |
| 曲库 | `artists`、`albums`、`album_artists`、`songs`、`genres`、`media_sources`、`cleaning_rules`、`wishes` |
| 歌单 | `playlists`、`playlist_songs`、`recommend_pool` |
| 播放 | `dlna_devices`、`device_queues`、`local_queues`、`player_groups`、`group_queues`、`player_webhook_tokens` |
| 插件 | `plugins`（含 config JSON + enabled）、`plugin_registries`、`plugin_storage`（按插件隔离 KV） |
| 其他 | `settings`（key/value，如官方注册表种子标志）、`flows` |

> **双写约定**：改 `db/schema.ts` 必须同步 `db/index.ts` 的建表 SQL（无迁移框架，`IF NOT EXISTS` 自动补齐旧库）。songs 的 `path` 为 NOT NULL；`INSERT OR IGNORE` 会吞掉约束错误（调试"影响行数 0"时先查约束）。

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
| 改前端播放体验 | `stores/` + `components/` + `views/Groups|Playlists` |

## 8. 环境变量

见 `README.md`「环境变量」表（`JWT_SECRET` / `CORS_ORIGINS` / `PLAY_HISTORY_RETENTION_DAYS` /
`DLNA_BASE_URL` / `DATA_DIR` / `MUSICFLOW_OFFICIAL_REGISTRY` / `APP_VERSION`）。
