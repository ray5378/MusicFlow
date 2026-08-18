# MusicFlow 面向 AI 编程的完整技术契约规范（SPEC）

> 本文件是 MusicFlow 仓库内 **AI 协作者必须遵守的技术契约**。任何改动（新功能 / 修 bug / 重构）都必须：
> 1. 先对照「第 6 章 负面清单」划定边界；
> 2. 按「第 5 章 AC 格式」写明验收；
> 3. 交付前逐项勾选「第 9 章 AI 自检清单」。
>
> 核心理念：Spec 不是普通 PRD，而是 AI 可读、可验证的技术契约——把「做什么、不做什么、怎么验证」全部落成强制项，防止 AI 幻觉乱加功能、改错边界、留下不可验证的半成品。
>
> 版本：v1（2026-08-19，基线 v1.7.71）｜ 维护：ray（仓库 owner）｜ AI 改动本文档需经 ray 确认

---

## 一、技术栈与工程约束

### 1.1 技术栈（实测确认，禁止脑补）

| 层 | 选型 | 版本/备注 |
|----|------|----------|
| 语言 | TypeScript | `strict` 模式；target ES2022；module ESNext；moduleResolution bundler |
| 后端框架 | Node.js + Hono + @hono/node-server | 部署基线 Node 22（Docker node:22-alpine，musl） |
| 数据库 | SQLite（better-sqlite3 单连接）+ drizzle-orm | 迁移工具 drizzle-kit；**全库只有一个 `new Database`（db/index.ts）** |
| 前端 | Vue 3 + Vite + Element Plus + Pinia + Vue Router + Howler（音频） | 构建产物 `frontend/dist`，**gitignore，不入库**；后端仅当静态资源吐给浏览器。**大列表虚拟滚动已在 `components/SongTable.vue` 内置**（桌面端 >200 首自动窗口化，行高 68px，无需新依赖） |
| 插件运行时 | quickjs-emscripten（WASM 沙箱，主线程常驻）+ worker_threads（批量任务，按需起、跑完 `process.exit(0)`） | 每启用插件一份常驻沙箱（`pluginSandboxes`） |
| 网络 | ws（WebSocket）、undici（HTTP/代理）、bonjour-service（mDNS/DLNA）、sharp（图像）、music-metadata（音频标签） | |
| 认证 | jsonwebtoken + md5 | 密码 md5+盐 / pass_enc 加密；API key 存 hash |
| 测试 | vitest | `pool: "forks"`、每文件独立 DATA_DIR、`sequence.shuffle` |
| 规范/观测基建 | `utils/logger.ts`（零依赖结构化日志）、`utils/errors.ts`（统一错误码）、`middleware/metrics.ts`（慢请求+端点计数）、`middleware/auth.ts`（鉴权缓存） | 新代码一律使用，禁止裸 console 裸错误体 |

### 1.2 硬性工程约束

- **依赖管理**：严禁引入未授权的新第三方库、严禁升级现有依赖版本。缺能力 → 先说明理由，等确认。
- **命名规范**：
  - 文件/目录：全小写 + 下划线（`playlist_sync.ts`、`streamFallback.ts`）
  - 类/接口/枚举：大驼峰（`QueueController`、`PlaybackState`）
  - 函数/变量：小驼峰（`registerDlnaDevice`、`isIdle`）
  - 常量：全大写 + 下划线（`ASYNC_TASK_KEEP_MAX`、`CACHE_TTL`）
- **代码位置**：后端 `backend/src/**`（88+ TS 文件，456 个 HTTP 端点全量编译入堆）；前端 `frontend/src/**`；测试 `backend/tests/**/*.test.ts`。
- **脚本**：`dev`（tsx watch src/index.ts）｜ `build`（tsc）｜ `start`（node dist/index.js）｜ `test`（vitest run）｜ `db:generate/migrate/push`（drizzle-kit）。
- **内存红线**：新增任何常驻 `Map`/`Set`/数组缓存，**必须**带上限（FIFO/LRU/字节预算）或清理机制（TTL/定期驱逐/孤儿回收），禁止只增不删（见 6.8）。

---

## 二、数据模型契约（SQLite）

> 定义在 `backend/src/db/schema.ts`。**改表必须**走 drizzle-kit 迁移，并评估既有库兼容（启动时是真实存量库）。**禁止**在 AI 交付物中私自 `ALTER TABLE` 或内联建表（测试除外）。

### 2.1 表清单与关键约束

| 表 | 主键 | 关键字段 / 硬约束 |
|----|------|-------------------|
| `users` | id(text uuid) | username **unique notNull**；password/salt/subsonicSalt notNull；isAdmin/isActive 0/1；apiKey + apiKeyHash + apiKeyExpiresAt（API key 与 JWT 双通道） |
| `songs` | id(text uuid) | title/path notNull；type 默认 `"local"`（在线音源歌曲带 url/pluginEntry/sourceData/streamHeaders）；duration/bitRate/track/discNumber/size 为整数秒/字节；coverArt 可空 |
| `albums` / `artists` | id(text uuid) | name notNull；playCount/songCount/duration 整数；coverArt/bio 可空 |
| `album_artists` | (albumId, artistId) 复合 | role 默认 participant |
| `playlists` | id(text uuid) | name/ownerId notNull；isPublic/favorite/syncEnabled 0/1；sourcePlatform/sourcePlugin/externalId 为平台歌单同步字段 |
| `playlist_songs` | id(自增 integer) | playlistId notNull；position 整数；external* 字段存平台侧元数据；playable 0/1 |
| `user_favorite_songs` | (userId, songId) 复合 | 收藏 |
| `play_history` | id(自增 integer) | userId+songId+playedAt；写入去重窗口 10 分钟（HISTORY_DEDUPE_WINDOW_MS） |
| `user_ratings` | (userId, itemType, itemId) 复合 | itemType ∈ song\|album\|artist；rating 0–5（0=删除评分） |
| `user_play_queues` | userId | OpenSubsonic get/savePlayQueue 持久化；entryIdsJson 存 songId[] |
| `media_sources` | id | type 默认 local；config 存 JSON 文本 |
| `plugins` / `plugin_registries` | id | manifest/config 存 JSON 文本；enabled 0/1 |
| `settings` | key | value 文本；**禁止新增表**，设置项直接加 key |
| `recommend_pool` | id(自增) | sourceType ∈ playlist\|favorites；每日推荐池 |
| `dlna_devices` | id(=UDN uuid) | 持久化设备（**离线/禁用设备保留**，供用户管理）；alias 用户自定义名 |
| `device_queues` / `group_queues` / `local_queues` | device_id/group_id/peer_id | itemsJson 存 QueueItem[]；playMode ∈ order\|one\|all\|shuffle；local_queues.lastActiveAt 驱动 10 分钟失效清理 |
| `player_groups` | id | memberIds 存 dlna deviceId[]（**成员只能是 DLNA 设备，组不能套组**）；name 限 50 字符 |
| `genres` | id | name unique |
| `flows` | id | token **unique**（免登录 webhook 凭据）；lastRunStatus ∈ waiting\|playing\|success\|error\|timeout |
| `player_webhook_tokens` | id | token unique；enabled 0/1；ownerUserId |
| `cleaning_rules` / `wishes` | id | wishes.status 默认 pending（枚举扩展需 spec 明确） |

### 2.2 全库硬性约束（边界条件）

- **时间格式**：一律 ISO 8601 文本 `new Date().toISOString()`（`yyyy-MM-ddTHH:mm:ss.sssZ`）。
- **布尔**：integer `0|1`，禁止存 `true/false` 字符串。
- **JSON 字段**：text 列存 JSON 序列化（config/manifest/itemsJson/memberIds/definitionJson），解析时 `try/catch` 容错。
- **数值**：duration/size/位次等非负整数；rating 0–5；volume 0–100。
- **NULL 纪律**：声明 notNull 的列不得写 NULL；可空列读取后必须容错（`?? ""` / `|| 0`）。

### 2.3 状态流转（必须穷举，禁止非法路径）

**任务/扫描状态**（内存态，重启清零）：

```
startAsyncTask:  running ──成功──▶ ok
                        └──失败──▶ error
scanJobs:        running ──完成──▶ completed
                        ├──中止──▶ stopped
                        └──失败──▶ failed
```

**播放器状态机**（`services/player/types.ts` 的 PlaybackState）：

```
IDLE ⇄ PLAYING ⇄ PAUSED ⇄ BUFFERING
（BUFFERING 由 DLNA TRANSITIONING 映射；PlaybackTracker 负责瞬态屏蔽与去抖迁移判断）
```

**队列播放模式**：`order | one | all | shuffle`（切换只允许在这 4 值间进行）。

---

## 三、API 接口契约

### 3.1 路由挂载（实测确认，写新路由必须对齐）

| 前缀 | 归属 | 鉴权 |
|------|------|------|
| `POST /rest/api/v1/auth/login` | authRoutes | 无（登录本身） |
| `/rest/api/*` | apiRoutes（管理/业务 API） | `authMiddleware` 全挂；`/v1/admin/*` 再叠 `adminMiddleware` |
| `/rest/*` | restRoutes（OpenSubsonic/Subsonic 兼容，456 端点大面） | authMiddleware（Bearer / OpenSubsonic u+t+s / u+p / token） |
| `/api/*` | navidromeRoutes | authMiddleware |
| `/rest/dlna/*` | DLNA 控制/事件 | 设备回调/事件无需登录（NOTIFY） |
| `/ws` | WebSocket（HTTP upgrade） | `?token=<apiKey|jwt>`，401 拒绝 |

**新端点默认挂 `/rest/api/v1/...`**，除非 spec 明确是 OpenSubsonic 兼容端点（挂 `/rest/...` 并遵循 subsonic 返回格式）。

### 3.2 响应与错误格式（禁止发明第三种格式）

- 业务 API：`{ "success": true, ...data }` 或 `{ "success": false, "code": <BusinessErrorCode>, "error": "中文可读信息" }`
- **错误码（必带）**：所有业务错误响应必须带 `code` 字段，枚举定义在 `utils/errors.ts`：

| code | 语义 | 典型场景 |
|------|------|---------|
| `INVALID_PARAM` | 入参缺失/类型错误/越界 | 空值、非法枚举、数值范围 |
| `NOT_FOUND` | 资源不存在 | id 查不到行 |
| `CONFLICT` | 状态冲突 | 重复扫描、重复导入 |
| `BUSY` | 资源占用/超并发 | 批量锁被占、任务已在跑 |
| `FORBIDDEN` | 权限不足 | 跨用户访问、非 admin |
| `UPSTREAM_ERROR` | 外部依赖失败 | 插件/上游/网络 |
| `INTERNAL` | 未预期异常 | 兜底(必须伴随 error 日志) |

  新代码/新端点一律用 `apiError(code, message)` 构造错误体；禁止裸造 `{ success:false, error }`。
- OpenSubsonic：`{ "subsonic-response": { "status": "ok"|"failed", "version": "1.16.1", "type": "MusicFlow", ...payload } }`
- 鉴权失败 401：`code 40 Unauthorized`；无权限 403：`code 50 Admin required`（格式同 subsonic-response failed，**不归 BusinessErrorCode 管**）
- **错误码纪律**：业务错误码不动态生成；错误信息中文、含可操作提示；沙箱类错误附 `sandboxCode`（如 `SANDBOX_TIMEOUT`）与 `hint`。

### 3.3 鉴权链（顺序固定，禁止跳过）

```
X-API-Key → Authorization: Bearer(JWT→API key) → X-ND-Authorization: Bearer → 
OpenSubsonic 参数(u+t+s / u+p) → token 参数(流媒体 URL 场景)
```
中间件：`backend/src/middleware/auth.ts`。WS 用 `authenticateWsToken`。

**鉴权缓存（v1.7.72+）**：apiKey 用**内存索引**（`apiKeyHash(sha256) → { userId, expiresAt }`，懒构建 + 自愈回填存量明文），JWT 用户查库带 60s TTL 缓存，替代每请求全表扫。用户资料/apiKey 写操作后必须调用 `invalidateAuthCaches()`（生成/撤销 key、改密码、改名），否则缓存最多 60s 内过期收敛。

### 3.4 幂等与并发（必须遵守，防止重复副作用）

| 场景 | 机制 | 位置 |
|------|------|------|
| 异步任务（歌单导入/搜索导入/同步） | 同 kind+key 在跑 → `alreadyRunning`（runningKeys 去重） | `services/plugin/asyncTasks.ts` |
| 媒体源扫描 | 同媒体源 running → 拒绝重复扫描 | `routes/api/index.ts` scanJobs |
| 全进程批量任务（同步/匹配/导入/推荐） | `acquireBatchLock` 全局 FIFO 锁，**必须 finally release** | `services/plugin/batchPacer.ts` |
| scrobble 派发 | 10min（scrobble）/ 60s（play）窗口去重 | `plugins/scrobblers.ts` |
| 播放历史写入 | 10 分钟窗口去重 | rest 路由 HISTORY_DEDUPE_WINDOW_MS |

### 3.5 入参/出参纪律

- 入参**必须**做空值/类型校验（`c.req.param/json/query` 均可能缺失）；非法入参返回 `success:false` 而非抛 500。
- 数组/列表入参注意 SQLite `IN` 上限与空数组边界（空 → 直接返回空结果，不构造 `IN ()`）。
- 分页/列表端点：不强制分页，但**禁止**一次加载全表后在前端过滤（大曲库红线）。

---

## 四、异常处理与安全

- **统一兜底**：Hono `app.use("*")` 链已含错误兜底；**新增路由不得裸抛**，业务错误转 `success:false` 返回，未捕获异常由兜底转 500。
- **SQL 注入**：**必须**用 drizzle 绑定变量 / better-sqlite3 `prepare` 参数，**严禁**字符串拼接 SQL（历史教训：所有 `?` 参数位）。
- **敏感字段**：日志**禁止**打印密码明文、`JWT_SECRET`、`apiKey`、`pass_enc`；错误信息不得回显完整密钥。
- **XSS**：前端用 Vue 模板插值（自动转义）；**禁止** `v-html` 直插未净化内容。
- **插件沙箱**：插件只能经能力门面（capability/permission）交互，业务逻辑**不得侵入核心**；长任务必须经 `jobRunner`（longRunning 预算），禁止在主线程沙箱跑重活。
- **沙箱宿主文件约束**：`plugins/sandbox.ts` 被 worker 线程以 **node 原生 ESM** 加载（不认 `.js→.ts` 映射），**禁止**在其中新增任何 import 依赖（如 utils/logger），保持零新依赖；需要日志用 `console.error`（存量豁免）。
- **连接/资源**：新增 socket/fetch/定时器必须考虑关闭路径（异常时 finally）；`AbortSignal.timeout` 是既有约定。

---

## 五、验收标准（AC）格式

所有验收场景用 **Given-When-Then** 三句式，且必须覆盖：主流程 / 异常流程 / 边界值。

示例（歌单导入）：

```
Given 用户已登录、目标歌单 URL 合法、同 key 无进行中任务
When  发起导入请求 POST /rest/api/v1/playlists/import
Then  立即返回 taskId；任务完成后歌单出现在歌单列表；再次触发同 URL 返回 alreadyRunning

Given 目标 URL 已失效
When  发起导入
Then  任务最终状态为 error，error 含可读信息；前端轮询可见
```

示例（内存边界）：

```
Given 连续启动超过 50 个已完成异步任务
When  查询最早的任务 id
Then  getAsyncTask 返回 null（FIFO 修剪生效）；最近 50 条仍可查
```

---

## 六、负面清单（边界划定，优先级最高，防幻觉核心）

> AI 在动手前逐条默读；交付时逐条确认「未违反」。**本清单的优先级高于任何口头需求**——需求与本清单冲突时，先问。

1. **禁止**引入未授权新依赖或升级依赖版本。
2. **禁止**修改现有数据库表结构 / 新增表，除非 spec 明确写迁移方案。
3. **禁止**重构未指明的模块（换框架、重命名 Utils、大规模抽公共层）；重构必须由 ray 显式下达。
4. **禁止**新增缓存层 / 消息队列 / 新中间件 / 新的全局状态。
5. **禁止**改变既有行为契约：路由路径、返回结构、错误码、`success` 字段语义、OpenSubsonic 兼容格式。
6. **禁止**改动与任务无关的文件；"顺手修复"一律先报备。
7. **禁止**在 AI 交付物中新增无上限 / 无清理的常驻 Map、Set、数组、定时器（内存红线，见 1.2）。
8. **禁止**吞异常：所有 catch 必须打 Error 日志且含关键入参（见第八章）。
9. **禁止**碰 `.workbuddy/`、`node_modules/`、`dist/`、`backend/data/`、`.test-data/` 等目录；不删用户数据。
10. **禁止**私自提交 / push / 打 tag / 发版（提交与发布流程由 ray 控制；发布走既有规范：仅推 ray5378 自有仓库、不触发 hassio-addons 自动发布、release notes 注明升级步骤、README 不维护版本映射）。
11. **禁止**把插件仓库（MusicFlow-plugins）的改动混入本仓库；核心与插件边界不可互相侵入。
12. **禁止**在代码注释中编造不存在的 API / 配置项 / 环境变量 / 端点——写前先 grep 确认。

---

## 七、文件索引与调用链

### 7.1 目录地图（后端 `backend/src/`）

| 目录 | 职责 |
|------|------|
| `routes/api/` | 业务 API（index.ts 是主文件：159+ 端点；online.ts 在线搜索；entitySearch/playlistSearch） |
| `routes/rest/` | OpenSubsonic 兼容（456 端点大面） |
| `routes/auth/` | 登录 |
| `routes/navidrome/` | Navidrome 兼容路由 |
| `services/dlna/` | control（设备缓存/DB）、discovery（SSDP）、eventing（GENA）、announce、queue（兼容层） |
| `services/player/` | PlayerController（去抖决策）、QueueController（队列/切歌）、UniversalPlayer、ProtocolPlayer、types |
| `services/group/` | 播放器组（SyncGroup）、watchdog、protocolPlayer |
| `services/plugin/` | 插件编排：registry、sandbox、discovery、jobRunner、asyncTasks、batchPacer、libraryIndex、dailyRecommend/localRecommend、playlistSync、comm、health、scrobblers 入口在 `plugins/` |
| `services/memory/` | reclaim（空闲回收）、pruneOrphans（孤儿清理） |
| `services/source/` | scanner（本地/WebDAV 扫描）、online/（在线搜索/匹配/导入/streamFallback） |
| `services/` | peer、settings、proxy、lyrics、covers、coverCache、coverImage、playlistCover、content、backfill、scraper、ws |
| `plugins/` | 内建插件注册（builtins.ts 9 个）、沙箱宿主（sandbox.ts/sandboxWorker.ts）、registry、health、comm、scrobblers |
| `utils/` | auth（JWT/md5/hashApiKey）、env、errors（BusinessErrorCode/apiError/apiOk）、logger（createLogger 结构化日志） |
| `middleware/` | auth（鉴权链 + 缓存）、metrics（慢请求 + 端点计数，挂 app.use("*")） |
| `db/` | schema.ts + 连接（唯一 `new Database`） |
| `scripts/` | e2e.sh（本地一键 e2e：临时 DATA_DIR 起服 + 关键契约验证 + 自动清理） |

前端 `frontend/src/`：`api/`（axios 封装）、`stores/`（pinia）、`views/`、`components/`、`composables/`、`router/`、`utils/`、`layouts/`。

### 7.2 典型调用链（改动前先画清上下游）

```
Web/HA → /rest/stream → authMiddleware → rest 路由 → 源插件(stream 能力) → streamFallback(换源) → 客户端
WS 推送: eventing GENA → PlayerController(reportState/去抖) → QueueController(切歌决策) → WS peer/queue 事件
任务: 前端 POST 导入 → startAsyncTask(立即返回 taskId) → 后台 fn + batchPacer 锁 → 前端轮询 GET /v1/tasks/:id
内存: 启动 index.ts → startIdleReclaimer(60s) + startOrphanPruner(10min) + peer.startCleanup(60s)
```

**交付时**：在提交说明列出「本次涉及文件 + 上下游影响面」。

---

## 八、可观测性规范

- **日志基础设施（v1.7.72+，新代码必须用）**：统一走 `utils/logger.ts` 的 `createLogger(prefix)`，禁止裸 `console.log/console.error`。
  - 级别：`debug < info < warn < error`，`LOG_LEVEL` 环境变量控制（默认 info）。
  - 结构化：`log.error("任务失败", { pluginId, taskId, err })` → 输出 `[PLUGIN-JOB] ERROR 任务失败 pluginId=x taskId=y err=z`。
  - **强制**：所有 catch 块打 `error` 且**必须包含关键入参**（userId/songId/deviceId/playerId/pluginId/taskId/url 之一或多个），禁止吞异常、禁止仅 `console.error(e)` 无上下文。
- **豁免条款（仅限以下场景，必须配注释）**：① 纯解析容错（`JSON.parse` 失败回落默认值）；② 幂等清理（`ALTER TABLE` 迁移失败跳过、socket/资源 close 失败）；③ 高频轮询兜底（设备状态/组状态查询失败走默认值，如 DLNA poll 失败继续轮询）。以上场景允许静默或 `log.debug`，**禁止**在关键业务路径（播放/导入/同步/鉴权）吞异常。
- **日志前缀**（沿用既有标签习惯，新增标签先查重）：`[MEMORY-RECLAIM]`、`[ORPHAN-PRUNE]`、`[PLUGIN-JOB]`、`[PLUGIN-WORKER]`、`[PLUGIN-HOTRELOAD]`、`[SCANNER]`、`[DAILY-RECOMMEND]`、`[LOCAL-RECOMMEND]`、`[DAILY-SCHEDULER]`、`[ARTIST-SCRAPE]`、`[AUTO-SYNC]`、`[REGISTRY]`、`[DLNA]`、`[peer]`、`[group]`、`[QueueController]`、`[SECRET]`、`[FATAL]`、`[SECURITY]`、`[PLAY-HISTORY]`、`[HTTP]`（慢请求）。
- **请求 metrics（v1.7.72+）**：`middleware/metrics.ts` 已挂载全链路——`≥1000ms` 请求打 `[HTTP] WARN 慢请求 {method, route, ms}`；`GET /rest/api/v1/admin/metrics` 返回总请求数/慢请求数/按端点计数（key=路由模板，**禁止用真实 URL 计数**防无界 Map）。
- **内存观测（v1.7.72+）**：`GET /rest/api/v1/admin/memory-settings` 返回 `rssMB/heapUsedMB/externalMB/arrayBuffersMB/isIdle/isBatchBusy/lastReclaimAt/lastReclaim`；`POST /rest/api/v1/admin/memory/reclaim` 返回回收前后内存快照。发版后先看 `rssMB` 曲线定论（稳定高位=正常；持续上涨=查泄漏）。
- 入口/出口关键动作打 Info（含耗时可选）；分支判断 Debug。

---

## 九、测试映射策略与 AI 自检清单

### 9.1 测试纪律

- 测试框架 vitest（`pool: forks`、每文件独立 DATA_DIR、shuffle）。
- **单元测试**：核心业务逻辑（player/memory/plugins/group/source）必须覆盖；新增/修改逻辑**必须**附测试或更新既有测试。
- **集成/冒烟**：行为类改动（新路由/新流程）用本地隔离实例实测（临时 DATA_DIR + 桩插件，跑通后端直连/代理/真浏览器三层），或至少补集成测试。
- **一键 e2e（v1.7.72+）**：`bash scripts/e2e.sh` —— 临时 DATA_DIR 起服 + 登录 + 验证 `users/me`、`peers`、`groups`、`memory-settings`、`metrics`、OpenSubsonic 错误凭据契约，自动清理。交付前跑一遍。
- **交付门槛**：`tsc --noEmit` 0 错误 + 相关测试全绿 + 无回归；未附冒烟用例视为未完成。

### 9.2 AI 自检清单（交付前逐项勾选）

```
□ 1. 负面清单（第六章）12 条逐条确认未违反
□ 2. 仅修改了任务指定文件；未波及无关代码（git status 核对）
□ 3. tsc --noEmit 通过
□ 4. 新增/修改逻辑的测试已编写并通过；相关回归全绿
□ 5. 未引入新依赖、未升级依赖版本
□ 6. 新增常驻 Map/Set/缓存均带上限或清理机制
□ 7. 所有 catch 均打 error 日志（createLogger）且含关键入参，无吞异常
□ 8. 未改变既有行为契约（路径/返回结构/错误码/格式）
□ 9. 入参 NULL/空字符串边界已处理；SQL 全部绑定变量
□ 10. 未提交/未 push/未打 tag（除非 ray 明确要求走发布流程）
□ 11. 新代码/新端点使用 apiError(code, message) 与 createLogger()，未裸造错误体/裸 console
□ 12. 鉴权写操作（apiKey/密码/用户名变更）已调用 invalidateAuthCaches()
```

---

## 附：新功能开发时的 Spec 最小模板（喂给 AI 前先填）

```markdown
## 需求一句话
## 1 技术栈与约束（对齐本文档第一章）
## 2 数据模型（若涉及：表/字段/状态流转，否则"不涉及"）
## 3 API 契约（路径/Method/入参 JSON/出参/错误/幂等）
## 4 异常与安全（敏感字段/注入/资源关闭）
## 5 验收 AC（Given-When-Then × 主流程/异常/边界）
## 6 负面清单（明确本次禁止做的事，覆盖第六章 + 本次特例）
## 7 文件索引与调用链（改动文件 + 上下游）
## 8 可观测性（新增日志前缀/级别）
## 9 测试计划（单测/集成/冒烟步骤）
## 10 自检清单（勾选第九章 9.2）
```
