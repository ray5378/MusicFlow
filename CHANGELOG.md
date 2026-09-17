# 更新日志 (Changelog)

本文件记录各版本的主要变更。版本号遵循语义化版本，仅在打 `vX.Y.Z` tag 时由 CI 构建并发布（产物：Docker 镜像）。

## [3.0.28] - 2026-09-17

### 新功能
- **Sendspin 播放器自动发现**：浏览局域网 `_sendspin._tcp`，新设备出现即自动拨号
  接入（只发现、不自动播放），前端播放目标列表自动出现，无需手工 dial。
  与记忆重拨互补：没拨过的设备靠这个首次出现；`another_server` 等拒绝过的不再骚扰；
  同目标 60s 去抖；插件配置加 `auto_discover` 开关（默认开）。
  - 边界：发现逻辑归 `services/sendspin/discover.ts`；mDNS 层只加通用共享实例
    `getSharedBonjour()`（无业务认知）。

### 测试
- 新增 `discover.test.ts`（IPv4 优选/回退、启停幂等）；`pluginConfig.test.ts` 补
  `auto_discover` 缺省与开关；sendspin 相关 71/71 绿。

### 镜像
- `ghcr.io/ray5378/musicflow:3.0.28`（同步 `ray5378/musicflow:3.0.28`）

## [3.0.27] - 2026-09-17

### Bug 修复（ESPHome Sendspin 真机联调，全部经 ESP32-S3 真机逐条确认）
- **legacy 握手补 `server/activate` + `group/update`**：此前只发 `server/hello`，
  设备 nursery 30 秒超时、每次准时 `goodbye(another_server)` 离开。
- **`server/hello` 五字段对齐严格校验**：`server_id/name/version/active_roles/
  connection_reason` 缺一或枚举非法即整条作废；`connection_reason` 取 `discovery`
 （对照 sendspin-cpp `protocol.cpp` 源码；多 server 仲裁下不抢占已有 playback 方）。
- **`stream/start` 补 FLAC `codec_header`**：base64(`fLaC`+0x80+u24(34)+34B STREAMINFO)
  定值合成（48k/立体声/16bit，块大小 4608 与 ffmpeg 实际一致）；缺头整条作废、之后每块音频全灭。
- **协商顺序改为 opus > pcm > flac**：ffmpeg flac 管道输出只在 EOF flush，
  实时推流每帧拿空包；flac 真正逐帧可用前绝不主动选。空包不上 wire。
- **曲终/停止/失败补 `stream/end` + `group/update(stopped)`**：此前设备永远卡 PLAYING。
- **`goodbye` 打日志 + `another_server` 等不自动重拨**（spec 语义，手动 dial 解除）；
  同目标拨号单飞（并发双连接触发设备仲裁踢人）。
- **广播 `_sendspin-server._tcp`**（供客户端发现；mDNS 层只加通用 `publishExtraService`，
  业务参数归 sendspin 包内 `advertise.ts`——包边界收敛，无核心改动）。

### 文档
- 新增 `docs/SENDSPIN_ESPHOME_DEBUG.md`：原生 API 看日志 / 抓包速查 / mDNS 速查 / 坑位表。

### 测试
- 新增 `encoding.test.ts`（STREAMINFO 结构锁死）、`legacy.test.ts` 加 activate+group/update
  顺序与 hello 五字段用例；sendspin 相关 69/69 绿。

### 镜像
- `ghcr.io/ray5378/musicflow:3.0.27`（同步 `ray5378/musicflow:3.0.27`）

## [3.0.17] - 2026-09-14

### Bug 修复
- **流探测（`probe()`）补 content-type 校验**：200/206 但 content-type 明确非音频
  （`application/json`、`*+json`、`text/*`）改判 `gone`，不再把「HTTP 200 包 JSON 错误体」
  的假活死链当可播。
  - 实锤案例：migu 源挂时 music-dl 透传 `HTTP 200 + {"code":"200002","info":"PE参数格式错误"}`
    （47 字节），原判定判 ok → 设备拉到垃圾后 MUZO 永久卡 BUFFERING（主卧《带我走》卡在前几秒）。
  - 判 `gone` 后 `ensurePlayableStream` 自动走 `findFallbackStream` 跨平台换源并回写 URL，
    死源歌曲下一次投屏即自动落到同曲可用 web 源（无需手工修数据）。
  - 黑名单式校验：content-type 缺失、`audio/*`、`application/octet-stream`、`application/ogg`
    等模糊值保守放行（宁漏杀不错杀）。

### 测试
- `streamFallbackTtl.test.ts` 新增 3 用例（200+JSON → gone / text+json → gone / 缺失与
  octet-stream 放行）；4 个测试文件的 fetch mock 显式音频 content-type（undici 对字符串
  body 自动补 `text/plain;charset=UTF-8`，会被新校验判 gone）。全量 960/960 绿。

### 镜像
- `ghcr.io/ray5378/musicflow:3.0.17`（同步 `ray5378/musicflow:3.0.17`）

## [3.0.16] - 2026-09-14

### 行为变更
- **shuffle 起播归属对齐纯 web 前端**：起播位置按「整列表播放 vs 指定居中某首」区分——
  - 整列表播放（未给起点，或 `startIndex ≤ 0`）且 shuffle 且多于 1 首 → 服务端**随机挑首**（不再固定列表第一首；随机只发生在服务端这一处）；
  - 指定居中某首（如音流/HA 投歌单第 N 首，`startIndex > 0`）与恢复断点（`currentIndex` 续播）→ 严格尊重该下标，不随机。
- `/v1/play` 起点定位注释同步更新（整列表起播落在第 1 首时，shuffle 下同样由服务端随机挑首）。

### 文档
- SPEC 新增「shuffle 起播归属」规则与「§1.7 统一音源裁决与取流抽象（`resolveAudio`，所有播放链路强制入口）」契约。

### 测试
- `PlayStartOwnership.test.ts` 契约守卫随新语义收敛（整列表 0 → 随机；指定中间 >0 → 尊重）；`queueModes.test.ts` shuffle 用例首曲断言改为接受任意随机起播。

### 镜像
- `ghcr.io/ray5378/musicflow:3.0.16`（同步 `ray5378/musicflow:3.0.16`）

## [2.3.27] - 2026-09-11

### Bug 修复
- 前端预探测调试日志（`console.warn`）含硬编码中文，被 i18n 守卫（源码禁硬编码中文）判红；改为英文。纯日志文案，无功能影响。

### 镜像
- `ghcr.io/ray5378/musicflow:2.3.27`（同步 `ray5378/musicflow:2.3.27`）

> 关联客户端版本：MusicFlow Client **v4.3.45**

## [2.3.26] - 2026-09-11

### 新功能
- **三条链路共用一套服务端预探测**：服务端预探测从「只服务投屏链路」升级为
  Web / 投屏(DLNA) / 本机客户端三条链路共用的"提前找可播源"大脑。
  - 本机链路接入：`PeerManager` 本机队列也会调度预扫描，队列快照附带 `preProbe`。
  - 洗牌序修复：`enqueue` / `setPlayMode` 路径在调度前按需物化 `shuffleOrder`，
    修复「洗牌模式下向前扫描 0 个位置」（此前只有 `playFrom` 路径会扫描）。
  - 调度器多监听者：单回调改为可多订阅，投屏与本机链路并存不互相顶掉。
- `/v1/stream/probe` 新增**四态判定** `verdict`（`playable | unplayable | transient | unknown`，
  与预探测调度器同源判据）；客户端**只应在 `unplayable` 时预跳**，
  `transient`（网络抖动）/ `unknown`（未探过）必须照常播放。`ok` 字段保留向后兼容。

### 优化
- 队列预探测提示（Web 右上角持久轻提示）的文案与可读性打磨：标题改为「预探测已暂停」，标题文字改为主文本色、仅图标保留告警色；加 `aria-live="polite"` 便于读屏播报；`cooldownUntil` 缺失时不渲染倒计时；兜底文案改为「已为你缓存 N 首可继续播放」。（commit `5b23ff9`）

### 文档
- 新增 `docs/PRE_PROBE.md`：统一预探测架构说明（三条链路 / 四态判定 / TTL）。

### 镜像
- `ghcr.io/ray5378/musicflow:2.3.26`（同步 `ray5378/musicflow:2.3.26`）

> 关联客户端版本：MusicFlow Client **v4.3.44**

## [2.3.25] - 2026-09-11

### 新功能
- **队列预探测（Pre-probe）**：在播放 / 投屏前提前扫描后续歌曲的可用音源，让切歌零等待；当连续默认 50 首无可用音源时自动暂停预探测并提示，冷却（默认 90s）后自动重试。无效源只做「留队列 + 短 TTL 跳过」，**绝不写入数据库、不做死歌名单**，源后续变有效即可被重新采用。
- `core-pre-probe` 内置插件（9 项配置：lookaheadSongs / deadRunLimit / exhaustedCooldownSeconds / 各类 TTL / 并发数等）
- `QueueController` 改为留队列跳过 + 绕圈上限（= 队列长度），避免死源误删与无限跳曲
- Web 端右上角持久轻提示（不自动关、手动关闭、按设备去重），**不上 HA 卡片**

### Bug 修复
- 可播性缓存加时间戳与双向 TTL（已缓存可播 1h / 已知不可播 45s / 网络瞬断 5s 退避），修掉「一次网络抖动被永久拉黑」的问题

### 文档
- 移除 HA 加载项（hassio-addons）相关引用，不再发布 HAOS 容器镜像

### 镜像
- `ghcr.io/ray5378/musicflow:2.3.25`（同步 `ray5378/musicflow:2.3.25`）

> 关联客户端版本：MusicFlow Client **v4.3.43**（需配对升级以启用客户端侧四态播放模式与预跳过）
