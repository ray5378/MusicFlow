# 更新日志 (Changelog)

本文件记录各版本的主要变更。版本号遵循语义化版本，仅在打 `vX.Y.Z` tag 时由 CI 构建并发布（产物：Docker 镜像）。

## [3.0.46] - 2026-09-20

### 修复 —— judge 正缓存盲信：扫描确认可播、播时已死的歌照推

- 新增共享 `recheckOnlineDirect`（在线直链短超时复核）：judge 在正缓存命中时
  先复核，直链明确已死（404/403/410）则逐出正缓存、找兄弟/远程替代，
  无替代直接跳过（知识非未知，不违"不误杀"边界）；预探测扫描侧改调同一函数。
- 清理 `refs/music-assistant-server/`（18MB 不完整 MA 源码）；音频流水线方案
  文档 MA 引证改为按 commit 拉取核对。

## [3.0.45] - 2026-09-19

### 修复 —— 预探测负缓存 45 秒导致坏源反复重试 + 补扫描可观测

**症状**：sendspin 播放中，持久性坏源（如已下架的酷狗直链 404）每次轮到都重试
约 30 秒（judge 现场探测 17s → 宽容放行 → pump 再探 16s → 失败）才跳过，
6 小时 25 次，体感"偶尔卡顿/断歌"。

**根因**：预探测把死歌标"不可播"只记住 45 秒（`negativeTtlSeconds`），而
lookahead 5 首 ≈ 15–25 分钟跨度——等播到那首时缓存早过期，judge 现场重探，
web 行又永远判不出"确定无源"，宽容尾巴只能放行再失败。

**修法**：`negativeTtlSeconds` 缺省 45→7200（2 小时）、上限 600→86400；
死歌学一次、2 小时内复播直接跳过。源恢复最长延迟该时长（直链下架不复活，
可接受）。附带：预探测每次扫描打一行 info（scanned/collected/deadRun），
此前成功完全静默、无从实证在跑；240 常驻监控脚本 `scripts/sendspin-monitor-240.sh`
（资源＋卡顿指纹＋坏源追踪＋进度停滞）。

**验证**：tsc 0 错；vitest 157 文件 / 1174 用例全绿；核心逻辑单测 hermetic 化
（模块 TTL＋配置行在 beforeEach 钉死，shuffle 乱序不再互串）。

## [3.0.44] - 2026-09-19

### 修复 —— ffmpeg 回环流恒 403（raw-stream 凭证跨进程不可见）

**症状**：v3.0.43 镜像（含 48ad83d 回环架构）上线后，Sendspin 播放仍失败，
ffmpeg 报 `Error opening input: Server returned 403 Forbidden`，输入已是
回环 URL `http://127.0.0.1:<port>/rest/dlna/stream/<token>?raw=1`。

**根因**：回环 token 的 raw-stream 注册表是**主进程内存 Map**，而 Sendspin
生产默认 **fork 模式** —— `streamEngine` 在**子进程**里 mint token、
`/rest/dlna/stream/:token` 路由在**主进程**里 resolve，Map 跨进程不可见，
token 永远查不到 → 恒 403。vitest 恒 in-proc（同进程共享内存），测试无法暴露。

**修法**：注册表落 SQLite `raw_stream_tokens` 表（WAL 多进程安全，与
`sendspin_device_state` 同模式），mint/resolve 全部走 DB，TTL 仍 30 分钟、
mint 顺带清理过期行。新增 `tests/services/rawStreamToken.test.ts` 回归锚点。

**验证**：tsc 0 错；vitest 156 文件 / 1170 用例全绿；240 实例注入修复后实测
Sendspin 音箱（ESP32）连续正常播放（pos 持续推进，403 消失）。

## [3.0.43] - 2026-09-19

### 修复 —— Sendspin / 转码 / 投屏链路带域名直链全部播放失败（ffmpeg DNS）

**症状**：Sendspin 音箱播放 WebDAV/网盘歌曲时，后端 ffmpeg 报
`Failed to resolve hostname xxx: System error`（exit 251）后跳曲；Web 客户端与本地播放（Node 代理链路）
完全正常 —— 因为只有 Sendspin / 转码 / AirPlay 这三条链路真正落到 ffmpeg 子进程。

**根因**：镜像里的 `ffmpeg-static` 是 **glibc 静态构建**（依赖运行时 dlopen glibc 的 NSS 库做域名解析），
而运行镜像是 **Alpine（musl）**——容器里根本没有 glibc 的 NSS 库，静态 ffmpeg 的 DNS 因此**全坏**
（实测对任何域名都报 `System error`，同一个二进制拿到 glibc 宿主机上正常）。此前没暴露，是因为
openlist 当时走本地代理、没有 302 出公网域名；直链一出现即命中。

**修复（Dockerfile）**：runtime 阶段 `apk add ffmpeg`（musl 动态版，实测 8.1.2，含 libopus 编码 /
flac 解码）并设 `ENV FFMPEG_PATH=/usr/bin/ffmpeg`。代码零改动 —— sendspin/encoding.ts、
transcode.ts、airplay/decoder.ts 三处 `ffmpegBin()` 本就优先读 `FFMPEG_PATH`，一条环境变量同时修好
三条链路。

## [3.0.42] - 2026-09-19

### 清理 —— dailyRecommend 的旧表 / 旧设置兼容代码（接续 3.0.41 的「不考虑向后兼容」）

接续上一版定调，把每日推荐里最后一批只为「升级用户」存在的兼容分支删掉：

- **`services/plugin/dailyRecommend.ts`**：删除 `loadCandidatesFromSettings()` / `findPlaylistByName()` /
  `purgeOldDailyPlaylists()` / `DAILY_TAG_LOCAL`；`saveCandidates()` 不再往 settings 表双写候选；
  `ensureDailyPlaylists()` 简化为「缺则建」，移除旧歌单认领与「今日推荐」→「每日推荐」的改名逻辑
  （+12 / −61）。
- **`db/index.ts`**：移除 `daily_recommend_candidates` / `daily_recommend_retention` 两条种子语句（−9）。
  候选与保留期现在只由 `dailyRecommend` 自己的表承载，老库重建即可。

### 文档 —— 全仓文档时效性梳理（25 个文件）

- **校准硬数字**：OpenSubsonic `/rest` **51** 端点、DB **37** 张表、内置插件 **18** 个（source 0，
  go-music-dl 已外置）、`PluginType` **10**、`PluginCapability` **≈25**；文件名统一小驼峰。
- **修正 4 处与实现相反的描述**，含 1 处代码注释：播放器管理页的离线实例并非「自动消失」，而是
  **保留该行并打「离线」标签**（只有队列会被回收、只有流转选择器会剪掉别的离线实例）。
- **回标落地状态**：3 份方案类文档（player-unification / memory-optimization / sandbox-limits）补
  「已落地 / 部分 / 未做」；**8 份带日期的历史文档**顶部加「⏳ 历史快照」横幅（内容不重写）。
- **删除 2 处已失效的发版步骤**：PLUGIN_ARCHITECTURE / sandbox-limits 里指向已删除 addon 仓库的
  同步发布步骤。

### 修正 —— 两处名不副实的 CI 文案 + 一处与实现相反的注释

- `backend/scripts/check-builtins.mts` 头注释与 `ci.yml` 的 step 名原写「校验 7 个内置插件 manifest」，
  而该清单实际只覆盖 18 个内置插件中的 **13 个** → 改为据实描述（**未扩清单**；扩清单需连带改插件
  manifest、能力白名单与权限白名单，属独立改动）。

## [3.0.41] - 2026-09-19

### 清理 —— 删除 DB 字段迁移 / 兼容代码（项目自用，不考虑向后兼容）

定调：本项自用、本地升级即可，**不为老库/老字段保留兼容分支**。据此整段删除两处只为「升级用户」
存在的迁移逻辑（5 文件，+2 / −169）：

- **旧版 Sendspin 全局密钥继承**（`services/sendspin/deviceState.ts`）：6053 密钥从「插件页一把全局」
  改为「每台设备各自一把」时，曾留了一个继承窗口——服务启动后 10 分钟内连上来的设备，把
  `plugins.config` 里的旧全局密钥（`esphome_psk` / `esphome_port`）抄成自己那一行的密钥，以免升级后
  静默失联。现连同 `readLegacyPluginEsphome()` / `inheritLegacyEsphomePsk()` 一并移除；子进程
  （`sendspin/child.ts`）与主进程（`sendspin/index.ts`）两条设备注册路径里的调用同步删掉。
  设备现在**只认自己那一行**的密钥，不再读任何旧字段。
- **`sendspin_device_state` 的 PRAGMA 探测补列**（`db/index.ts`）：老库缺 `disabled` / `esphome_psk` /
  `esphome_port` 时用 `ALTER TABLE ... ADD COLUMN` 幂等补齐的那段循环已删除（新库由 `CREATE TABLE`
  一次到位；老库重建即可）。**今后新增字段直接改进 `CREATE TABLE` 语句，不要再加补列迁移。**

`deviceState.test.ts` 相应删掉 7 个迁移用例（旧字段读取 / 继承落库 / 不覆盖已有密钥 / 端口优先 /
只继承一次 / 窗口期判定 / 无旧密钥与空 clientId），全量回归因此从 155 文件 1172 例变为 155 文件 1165 例。

## [3.0.40] - 2026-09-19

### 测试 —— 补上渲染器子进程 fork 路径的冒烟测试（此前零覆盖）

`mode.ts` 见到 `VITEST` 一律返回 false，业务侧测试**永远不可能真的 fork** —— 于是
「生产里 supervisor 到底有没有 fork 起子进程」此前只由注释与 CHANGELOG 背书，一条断言都没有。
本版绕开 `isRendererForkMode()`，直接构造通用宿主 `RendererHostSupervisor` 并指向一个纯 JS
夹具子进程，真的过一遍这条路径：fork → mainReady 握手（断言载荷真的过了 IPC 边界）→ RPC 往返
（断言响应里的 pid 就是被 fork 的子进程）→ 快照进镜像 → `kill -9` → 退避重启（新 pid 可继续
服务）→ 优雅 `stop` → 「启动即退」的失败分支。整套约 3.5s。

夹具用 `.mjs` 而非 `.ts`（`tests/rendererHost/fixtures/stubRendererChild.mjs`）：`fork()` 直接跑
node，不依赖任何 TS loader，因此与 vitest 的 `process.execArgv` 完全解耦。

### 可观测 —— AirPlay 推流节拍指标 `reanchors` / `maxGapMs` 对外可见

这两个数此前只在 `stream()` 收尾时打一行日志：只能事后归因、拿不到趋势，也无法在播放**过程中**
判断「此刻是不是已经被拖垮」。现在：

- `RaopPlayer.realtimeStats` 暴露 `{ chunks, reanchors, maxGapMs, elapsedMs, lossRequests }`；
- 进会话镜像 → `getAirPlayStatus().stream` 与 `getAirPlayPeerStatus().stream`（HTTP 可直接 curl），
  fork 与 in-proc 两条路径读同一份语义；
- 会话运行期每 15s 打点一行趋势；`reanchors > 0` 或 `maxGap > 50ms` 升级为 warn，便于日志过滤。

至此开启 `MUSICFLOW_AIRPLAY_FORK=1` 的两个前提（架构就位 + 可观测）都已具备。

### 验证

`tsc` + 9 项静态门禁 + 全量回归（155 文件 / 1172 用例，较 3.0.39 新增 1 文件 / 10 用例）全绿。

## [3.0.39] - 2026-09-19

### 重构 —— 抽出「常驻渲染器子进程」通用宿主 `services/rendererHost/`

sendspin 自 3.0.34 起跑通的那套「常驻子进程」模式（fork / mainReady 握手 / 心跳看门狗 /
退避重启 / 优雅 stop / RPC / 状态镜像）此前只有它自己一份实现，AirPlay 要照抄就会变成
两份各自漂移的 IPC 契约。本版把它抽成通用层，业务只声明自己的载荷与 op 表：

- `RendererHostSupervisor`：主进程侧宿主（fork、握手、看门狗、退避重启、`rpc`/`post`、镜像容器、事件分发）；
- `ChildRpcHost`：子进程侧控制器（`req`→`res` 按 id 回填、快照 150ms 节流 + 1s 兜底扫、心跳、stop 生命周期）；
- `ipcProtocol`：通用信封类型与常量。用 `({ t: "state" } & TSnapshot)` 这类交叉类型承载业务载荷，
  所以**消息的运行时形状与重构前完全一致**（仍是 `{ t:"state", clients, groups, … }`）；
- `resolveChildEntry`（prod `.js` / dev `.ts`）、`isRendererForkMode`（三态模式判定，只有默认值不同）、
  `createFrontAccessor`（fork→代理、in-proc→真实实例）、`childBootstrap`（致命异常兜底 / 数据层 / 消息循环）。

**Sendspin 已迁移到通用层，行为不变**：`sendspinSupervisor` 单例、`SendspinChildController(deps, send)`
构造签名、全部公开 API、IPC 消息形状、日志文案都保持原样，由既有 sendspin 测试（39 文件 / 221 用例）守等价。
此后新增渲染器（airplay2、cast、roon…）照 `rendererHost/index.ts` 顶部的六步清单接线即可。

### 新功能 —— AirPlay RAOP 推流会话接入子进程（默认关闭）

AirPlay 的推流是「每 352 帧（≈7.98ms）一个 RTP 包」的墙钟节拍循环，且 ALAC 位打包与
AES-CBC 加密都在 JS 侧 —— 与 sendspin 同构，只是节拍更紧（7.98ms vs 25ms），此前却留在主进程：
一次长阻塞、一次封面缩图、一次后台批量任务都会直接体现为 `reanchors++` 与真机断音。

- 新增 `services/airplay/{sessionRuntime,childMain,child,supervisor,mode,ipcProtocol}.ts`：
  子进程持有 RTSP 会话 + ffmpeg 解码 + 推流节拍；**不碰 DB、不注册插件**（符合 SPEC「每进程一个
  SQLite 连接」——子进程压根不新开）。
- **主进程保留**设备发现（mDNS）、`airplay_devices` 持久化、DLNA 双协议互斥、`createCastSession`
  取 token 化 streamUrl、peer 注册、`volumeState`/`lastCast`：它们要么状态密集要么纯 I/O，搬进去只会多一跳 IPC。
- 状态读走**镜像**（`getAirPlayStatus` 会被 QC 每 5s、DLNA announce 每 500ms 调用，绝不能每次打 IPC），
  命令写走 RPC；会话结束由子进程发 `sessionEnded`，主进程照旧上报 IDLE 让队列自动续播。
- 解码/缓冲层（ffmpeg spawn + 有界 PCM 队列 + 音量 dB 换算）抽到 `services/airplay/decoder.ts`，
  两条路径共用同一份实现。
- **默认仍是 in-proc**：开发机没有 AirPlay 设备，这条路径无法端到端验证，所以先只把能力就位。
  显式 `MUSICFLOW_AIRPLAY_FORK=1` 才启用（`MUSICFLOW_AIRPLAY_INPROC=1` 可临时回落）；
  真机验证无回归后，把 `services/airplay/mode.ts` 的 `defaultFork` 翻成 `true` 即与 sendspin 对齐。

**顺带修掉一处真实缺陷**：`startSession` 里 `makeProducer(ff)` 建了一份却丢弃（变量未使用），
那个 producer 的 stdout `data` 监听器仍在 —— 它会把整首歌的 PCM 再缓存一份且无人消费（内存翻倍），
还会与真正在跑的 producer 争抢 `pause/resume` 背压，表现为间歇性卡顿。现在只建唯一一份。

### 门禁 —— 新增 `check-renderer-host.mjs`（CI: renderer-host-guard）

「重活必须落到独立进程」此前只是惯例：7 个 check 脚本 + 8 个 workflow 关键词扫描 **0 命中**
（SUP 红线和 sendspin 的 fork 都只靠注释与 CHANGELOG 背书）。新增静态守卫，三条规则：

- **R1** `backend/src/services` 下只允许 `rendererHost/supervisor.ts` 出现 `child_process.fork`——
  禁止各业务再自建一套 supervisor；
- **R2** 命中「deadline 循环形态」（墙钟取时 + `setTimeout` 自排 + 定长分块三条全中）的文件，
  必须落在**本业务**`child.ts` 的 import 闭包内，否则要么接宿主、要么显式豁免
  `// allow-main-process-render: <理由>`。
  （按业务归属判定而非「任一闭包」——实测 sendspin 的子进程闭包会跨业务拖进 `airplay/raop.ts`，
  只判「任一闭包」会让谁都没接宿主的情况蒙混过关。）
- **R3** 声明为渲染器业务的目录必须具备 `child.ts` + 用 `RendererHostSupervisor` 的 `supervisor.ts`
  + 用 `isRendererForkMode` 的 `mode.ts`。

**DLNA 不在守卫范围内**，这是有意的：DLNA 的 `/rest/dlna/stream/:token` 是字节代理 + Range，
渲染器自己回连拉流，服务端没有任何节拍循环（实测该目录零 `child_process`、定时器全是等待/续订语义），
进程化纯属浪费。守卫只认「节拍形态」不认目录名 —— 将来谁写下节拍循环就自动被要求接宿主。

### 验证

`tsc` + 9 项静态门禁 + 全量回归（154 文件 / 1162 用例）+ 前端 `vue-tsc && vite build` 全绿。

## [3.0.38] - 2026-09-19

### 新功能 —— ESPHome 6053 密钥独立入口（与设备音量彻底分开）

- 播放器页 Sendspin 设备行原本把「密钥 / 端口 / 测试连接」和设备音量滑杆挤在同一个
  弹窗里，现拆成两个独立弹窗：新增**「ESPHome 密钥」**按钮与独立弹窗，行内两个按钮
  各自反映连接状态。
- 密钥回显分级：`GET /v1/sendspin/devices/:clientId/esphome` 仅对持有
  `renderer.manage` 的账号回明文 `psk`（管理员恒有），其余账号只拿到
  `pskConfigured` 布尔值；**设备列表端点始终不回显** —— 一次列表把所有设备的密钥
  全吐出去毫无必要，弹窗打开时按需单取一台。
- 设备行内「解绑」与「重命名」两个按钮互换位置。

### 新功能 —— AirPlay 主动扫描（与 DLNA 扫描语义对齐）

- 新增 `POST /v1/airplay/scan`（`renderer.use`）：立刻重发一次 mDNS(`_raop._tcp`)
  查询，并把命中的接收端 `upsert`（新增 + 落库 + alive 事件）—— 刚上电、常驻
  browser 还没捞到的接收端，点一下就出来。插件关闭时是**立即 resolve 的 no-op**，
  随后回当前列表。
- `services/airplay/discovery.ts` 抽出 `spinQuery()`：常驻 30 秒续期与主动扫描共用同一条
  「短命新 browser 句柄」通路，避免两套发现逻辑各改各的。

### 优化 —— 四个设备区块头部统一为「扫描」

- 客户端 / DLNA / AirPlay / Sendspin 四个区块头部只保留一个贴右边缘的「扫描」按钮
  （原来 AirPlay / Sendspin 叫「刷新」）。根因：`.section-head` 是
  `justify-content: space-between`，Sendspin 头部有 3 个孩子时中间那个必然被挤离右边缘。
- 「添加播放器」保留不删，从头部移到 Sendspin 列表盒子下方、右对齐。
- 修正客户端区块说明与实现不符：「离线后自动消失」→「离线后该行保留并打「离线」标记」
  （后端对 local peer 只 `markLocalOffline()`，从不删行）。

### 优化 —— 流式解码窗口高水位 60 → 30 秒（与 MA 对齐）

- `WINDOW_HIGH_SEC` 60 → 30：PCM 窗口内存上限 ~23MB → **~11.5MB**（＋5 秒历史环 ~2MB），
  与 MA 的 `sleep_to_limit_buffer(30 秒)` 齐平；`WINDOW_LOW_SEC` 保持 20。
  代价：seek 回跳更可能落出窗口、按 `-ss` 重建解码（约 1 秒空窗），越界频率继续在
  240 soak 观察。插件配置页帮助文案与 `docs/SENDSPIN_MULTIROOM_STREAMING_PLAN.md`
  的内存对照表同步。

### 验证

- `tsc --noEmit` 0；`vue-tsc` + `vite build` 0；`check-i18n` 0；
  `vitest run` **154 文件 / 1162 用例全绿**；7 项门禁
  （frontend-plugins / overlays / element-overrides / fixed-playlist-ids / core / i18n）全 0。
- 新增 `backend/tests/airplay/rescan.test.ts`：守住「插件关闭时扫描立即返回、不卡 loading」。

## [3.0.37] - 2026-09-18

（本节为补记：该版打 tag 时未写 CHANGELOG 条目，内容据 `v3.0.36..v3.0.37` 提交历史整理。）

### 新功能 —— Sendspin 设备音量持久化 + 流式解码开关进配置页

- 设备音量（6053 桥）持久化并全端回显（`sendspin_device_state` + `peerVolume.ts` + WS 广播）。
- 流式解码开关（`stream_source`）进插件配置页，默认开启。
- 文档补解码内存与 MA 的对照结论。

## [3.0.36] - 2026-09-18

### 新功能 —— Sendspin 真多房间组（与 DLNA 组统一语义）

- **流式解码**（默认关，`SENDSPIN_STREAM_SOURCE=1` 开启）：`PcmWindow` 滑动窗口
  （长命 ffmpeg＋60 秒窗口＋真背压），子进程内存预计从 ~300–570MB 降到 ~120MB；
  `GroupPump` 双路径（整包/窗口），时长未知不钳制 position。
- **用户组多房间**：成员 id 命名空间化（`sendspin:`/`dlna:`/裸 id＝DLNA）；
  组内 sendspin 成员共享单 pump 同一时间线（`ug:<组id>` 组），双成员首帧同 ts；
  播中加入走直播沿（无需历史），摘除收 stream/end；离线可建组。
- **组管理 API**：`POST /v1/groups/:id/members` 增量原子口（幂等、无读写竞态，
  供 Flutter 随时加减）；PUT 沿用精确顺序并共用加入对齐钩子；
  mute/volume/status/playback 按 kind 扇出；群组对话框可选 sendspin 设备。
- 全量验证：`tsc`＋`vue-tsc`＋`vitest` 146 文件 / 1080 用例全绿。

## [3.0.35] - 2026-09-18

### Bug 修复 —— Sendspin 链路两处回归 + CI 测试隔离

- **mute 接口 500**(`index.ts`):`getSendspinFront()` 把 `isForkMode()` 误传给形参
  `inProc`，布尔反转导致双模式下恒返回 null，`/v1/peers/:id/mute` 报"服务未运行"。
  改为 `!isForkMode()`，一行恢复（生产 fork 模式的 mute 同 bug 同修）。
- **第二次播报卡死**(`encoding.ts`):`LibFlacEncoder.flush()` 调
  `FLAC__stream_encoder_finish` 终结编码流，而组编码器在多次播报/切歌间复用，
  之后再 `encode` 在 asm 堆内空转永不返回，卡死整进程事件循环（一次 FLAC 播报后
  后续播报/推流全挂）。现 flush 取走尾帧后原地重建新流，对象保持可用，
  `codec_header` 照常重建；音乐推流路径从不 flush，行为不变。
- **测试间 fetch 污染**(6 个测试文件):模块级 `vi.stubGlobal("fetch")` 从不还原，
  同进程串行时 `proxy` 直连测试读到 `"stream-bytes"`、TTS 拉取进 ffmpeg 报错。
  各文件 `afterAll` 加 `vi.unstubAllGlobals()`，生产代码零改动。
- 全量验证：`tsc` + `vitest` 142 文件 / 1060 用例全绿。

## [3.0.34] - 2026-09-18

### 架构 —— Sendspin 强制独立子进程(fork 隔离)

- **动机**:sendspin 推流是 25ms 节奏的硬实时循环(解码 → FLAC 编码 → 逐帧下发),
  与主进程(API 路由 / 后台批量任务 / 前端状态轮询)共享事件循环时,任何长任务都会
  顶住推流节奏,表现为真机端周期性卡顿。现把**整个 sendspin 运行时**(WS 38927 +
  mDNS + 拨号重拨 + 解码/编码/推流 + ESPHome 6053 只读桥)fork 进**专属常驻子进程**,
  事件循环与主进程彻底隔离。
- **通信协议**(`ipcProtocol.ts`):状态读走「快照推送」(脏了立即推,150ms 节流 +
  1s 兜底扫);命令写走 RPC(自增 id 回填,超时 25s / stop 15s / announce 360s);
  心跳 30s,主进程看门狗 3 周期无心跳即判定卡死并退避重启(3s→30s,稳定 5min 复位)。
  `positionMs` 高频字段**不进快照**,走 poll 轮询,防 IPC 风暴。
- **状态镜像 + 命令代理**(`proxy.ts`):主进程不再持有 server 实例 —— 路由/外围代码
  统一经 `getSendspinFront()`:fork 模式返回镜像代理(同步读快照、写走 RPC、mute
  setter 本地即时反馈),in-proc(单测/子进程自身)返回真实 server,调用方**零分叉**。
  类型哨兵 `AssertServerLike` 编译期锁定代理与真实 server 的公共结构。
- **核心下沉**(`playerCore.ts`):推流操作核心(play/stop/pause/seek/volume/poll/
  announce 等)从 protocolPlayer / announce.ts 原样抽取,跟随真实 server 进程运行,
  不 import QueueController/PlayerManager —— 主进程状态(队列冻结/恢复/播放器注册)
  留在主进程。播报现场(在播/进度)拆出 `announceProbeCore`,必须在 `qc.deactivate`
  **之前**捕获(时序坑:deactivate 清 current,之后捕获恒为零)。
- **配对密钥不外泄**:镜像快照**剥离 `pskHex`/`pskId`** —— 配对密钥永不出子进程;
  端口变更等配置热更新经 RPC `applyCfg` 下发,主进程 DB 仍是配置单一可信源。
- **崩溃自愈**:子进程 uncaughtException → exit(1),supervisor 退避重启;`stop` 走
  优雅关停(反注册/关连接/停 mDNS)后退出。单测与子进程共用 `MUSICFLOW_SENDSPIN_INPROC=1`
  装配路径,测试路径 = 生产路径(新增 `childMain.test.ts` 8 例:快照剥离 PSK /
  RPC 回包契约 / announceProbe 时序 / unpair 断连)。
- 文档:`docs/SENDSPIN_FLAC_ROADMAP.md` 标记完成(任务 1 真机基线一次达标:flac +
  codec_header 协商生效,零 Lost sync / 零解码报错 / 零 underrun,任务 2 无需进行)。

## [3.0.33] - 2026-09-18

### 文档

- 新增 **FLAC 链路专项开发任务书** `docs/SENDSPIN_FLAC_ROADMAP.md`:核心矛盾
  (25ms 喂料 vs libFLAC 块攒样脉冲)、真机基线验证步骤、消脉冲方案阶梯
  (compression 0 → 块对齐喂料)、micro-flac `BAD_BLOCK_SIZE` 约束、验收清单;
  链接真相文档与踩坑录,作为后续 FLAC 打磨的唯一起点。

## [3.0.32] - 2026-09-18

### Bug 修复 —— Sendspin 音量「回退」与增益标度

- **音量增益平方根因**:`setVolume` 此前同时写 `conn.volume` 与 `group.volume`,
  而 `appliedGain = conn.volume × group.volume / 100` ⇒ 实际下发增益 **= vol²/100**
  (拖 50 实得 25)。现只写**组音量**(单设备组的权威标度),每连接 trim 保持缺省 100;
  PCM 链路在 `pushFrame` 的 `scalePcm` 里按帧生效。
- **`/status` 音量回读源改为组音量**:原先回读 `conn.volume`(恒 100),会把前端
  刚拖的值顶回去。
- **前端轮询陈旧保护**(插件 `isStaleSample`):无 `reportedAt` 的设备型 peer
  (sendspin / DLNA)在命令下发后 **1.5s 短窗**内一律视为陈旧采样,防止
  「拖 20 → 立刻拖 30」时 2s 轮询把服务端仍停在的 20 顶回 UI;
  下发时刻改为**按设备**记录(切换播放端互不误伤)。窗后恢复同步,
  设备端自己的改动仍能及时镜像。

### 附带

- **ESPHome 6053 只读监控(在 sendspin-renderer 插件内)**:设备 IP 从 Sendspin
  拨入连接自动派生(无需手填);插件配置页新增 `esphome_mirror` 开关、
  `esphome_psk` 密钥(带常显「测试连接」按钮,保存前即可验证,成功回显
  设备名/版本/播放状态,失败给出原因);`GET /v1/sendspin/esphome` 只读查询
  (绝不回显 PSK)。依赖 `esphome-client@^2.0.0`(零第三方依赖)。
- 插件配置页新增 `preferred_codec`(PCM / FLAC 下拉,默认 PCM)。
- 文档:`docs/SENDSPIN_ESPHOME_FLAC_2026-09-17.md` 重写为验证过的真相版;
  被推翻的旧结论沉淀为 `docs/SENDSPIN_PITFALLS_2026-09-18.md`。

## [3.0.31] - 2026-09-18

> 本条合并了此前**预写但从未发布**的 `[3.0.30]` 与 `[3.0.31]` 两个条目 —— 它们都只写了 CHANGELOG
> 而没打出 tag,远端最新 tag 仍停留在 `v3.0.29`,因此两版内容并未发布到任何用户手上。
> 现两版描述的修复已全部完成,合并为一次发布。
> 权威记录(真相版):`docs/SENDSPIN_ESPHOME_FLAC_2026-09-17.md`
> 走错的路(踩坑录):`docs/SENDSPIN_PITFALLS_2026-09-18.md`

### Bug 修复 —— ESP32 真机**出声,并且零卡顿**

⚠️ **勘误**:较早版本的 CHANGELOG 曾把「STREAMINFO block size 4096」写成**决定性根因**、
把音频帧头写成「9B → **13B**(带 `send_ahead`)」、把协商顺序写成「flac 优先」——
**这三条均经设备端源码取证推翻**,已从本次记录中删除。真实根因如下(全部真机验证):

- **① 音频二进制帧头必须是 9B(决定性)**:设备 `sendspin-cpp` 只剥 1B type,其
  `player_role.cpp` 常量 `BINARY_TIMESTAMP_SIZE = 8`,8B 时间戳之后**一律当作编码音频**。
  此前多塞的 4B `send_ahead` 落在 payload 头部 → 首字节 `0x00` 而非 FLAC 同步字 `0xFF`
  → 每包 `Serious error decoding FLAC file` → **完全无声**。
  且 `send_ahead` 在整个 sendspin-cpp 源码库中**零出现** ⇒ 它根本不是 wire 字段。
- **② 时间线必须按实际产出推进**:编码器攒样期若按喂入量推进,时间线会超前约 75ms →
  设备报 `Lost sync (75006us off)` → 往音乐里**插静音**补空 → 卡顿。
  改为「无产出不推进」,零产出超 500ms 才降级(避免编码器真失效时时间线冻结)。
- **③ pacing 改为绝对时刻调度**:固定 `sleep(25)` 之外还有 encode/send 开销,实际周期约 26ms
  而时间戳只推 25ms → 每包落后 1~1.8ms 并**单向累积**(实测漂到 −611ms);
  设备 hard sync 阈值仅 **5ms**,越界即插静音 → 听感「一卡一卡」。
  改为 `due = start + i * frameMs / speed`,误差 ±0.5ms 正负自校正。
- **④ 冷起播是空操作**:`POST /peers/:id/play` → `resume()` 在「队列 `isActive` 但从未起播」
  时是空操作 → 无 `playMedia` / 无 `stream/start` = 静默。改为 `pump.active` 则原地 resume,
  否则走 `playMedia` 冷起播。
- **⑤ 脏 dial 目标致 `goodbye: another_server` 死循环**:`dial_targets.json` 残留设备自身端口
  `8928`,服务端每 60s 拨过去被判为竞争第二个 server 并踢回,继而触发 `noAutoRedial` 永久抑制。
  正确方向是**设备经 mDNS 自行拨入 38927**。
- ⑥ **协商顺序改为 PCM 优先、FLAC 兜底**(见下方新功能中的可配置项)。

### 新功能

- **默认音频编码可在插件页切换**:Sendspin 播放器插件新增 `preferred_codec`
  (**PCM(推荐,零延迟)** / **FLAC(省带宽)**),默认 PCM —— 设备侧对 PCM 只是一条 `memcpy`,
  零解码零攒样;FLAC 每 85ms 要解一个 4096 样本帧,低端 ESP32 易失步。
  偏好只决定**优先顺序**,设备不支持会自动退到另一种;切换**不中断当前流**,重新投一次歌即生效。
- **ESPHome 只读监控(6053)**:新增 `esphomeBridge`,对已连设备反向建立 Native API 连接,
  用于**保活**(设备掉网时不会因 `api.reboot_timeout` 看门狗自愈重启)与**只读状态镜像**
  (读回设备侧真实 `state` / `volume`,作为「服务端推的流有没有真的播出去」的外部判据)。
  - 插件页新增 `esphome_mirror` 开关 + `esphome_psk` 密钥;**设备 IP 自动派生,无需填写**。
  - 密钥输入框下方**常显「测试连接」按钮**,保存前即可验证:正确密钥约 2.6s 返回设备名/版本/
    当前播放状态;错误密钥约 **27ms** 即报 `Noise handshake failure`,不用干等超时。
  - 查询出口 `GET /v1/sendspin/esphome`(**不回显 PSK**);测试出口 `POST /v1/sendspin/esphome/test`。
  - ⚠️ 该链路**只做只读与保活**:设备 `featureFlags = 0x12520d` 不含
    `SEEK` / `NEXT_TRACK` / `PREVIOUS_TRACK` / `PLAY`,切歌与进度的权威始终在服务端;
    音量也请继续用 Sendspin 组音量(6053 的是 speaker 硬件音量,两者相乘会语义打架)。

### 文档

- `docs/SENDSPIN_ESPHOME_FLAC_2026-09-17.md` **重写**为真相版,删除上述被推翻的结论。
- 新增 `docs/SENDSPIN_PITFALLS_2026-09-18.md`:11 个踩坑条目 + 共同模式 + 取证顺序清单。

### 实测结果(ESP32-S3 `esp32-player-meet` / ESPHome 2026.9.0)

- 出声三件套齐全:`speaker_mixer Starting` → `i2s_audio.speaker Starting` → `96000 ring_buffer`。
- 设备侧自报 `state=2 (PLAYING) / volume=0.36`;服务端 `Lost sync`、`Regained` 计数均**归零**。
- 播放连续推进、自动切歌正常,长时间无重启。
- 守卫:`tsc` 通过;backend sendspin **27 文件 / 116 用例**通过;`check-i18n` 四项通过;
  前端构建通过。

## [3.0.29] - 2026-09-17

### 变更（Sendspin ESPHome 真机出声联调 — FLAC 推流对齐 MA 金标准）

- **端口与 MA 解耦**：Sendspin 服务端监听端口 8927 → **38927**（避开 Music Assistant 独占的 8927，
  二者可在同一网关共存）。前端、renderer schema 默认、测试、文档全线同步。
- **音频协商对齐金标准**：`negotiateCodec` 改为 **FLAC 优先、默认 FLAC**（原 opus/PCM 被 ESPHome
  sendspin 客户端拒收或进不了 PLAYING）；键名兼容 `player@v1_support` 与 `player_support`。
- **音频帧头补全 send_ahead**：`packAudioChunk` 帧头 9B → **13B**（`>BqI`：1B `0x04` + 8B 大端微秒时间戳
  + 4B send_ahead ms），`sendAudio` 用组公共 `computeCommonSendAhead` 填值，对齐 aiosendspin wire 格式。
- **推流空包跳过**：ffmpeg flac 流式空缓冲不再上 wire，避免严格客户端判 `Invalid data`。

### 实测结果（ESP32-S3 真机 esp32-player-meet）

- 设备成功连入 `MusicFlow Sendspin`（discovery），完整走通 FLAC 48000/2ch/16bit：Group playing →
  Stream Started → codec header flac → speaker_mixer/ring_buffer 启动 → PLAYING；MusicFlow 侧位置持续推进且自动续播。
- **仍无确定声音输出**：主要怀疑 FLAC 实时编码（ffmpeg flac EOF 前零输出，`FfmpegPcmEncoder` 60ms 兜底
  只返回空包）。下一步详见
  `docs/SENDSPIN_ESPHOME_FLAC_2026-09-17.md`（分段 FLAC / send_ahead 单位核对 / PCM 回退验证等）。

### 文档
- 新增 `docs/SENDSPIN_ESPHOME_FLAC_2026-09-17.md`（本次专项：修复过程、排查方案、已验证方案、
  未出声的下一步方向、风险点、环境速查）。

### 镜像
- `ghcr.io/ray5378/musicflow:3.0.29`（同步 `ray5378/musicflow:3.0.29`）

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
- **协商顺序定为 flac 优先 → pcm 次选 → 默认 flac**（2026-09-17 真机实锤：MA 金标准用 FLAC 才进
  PLAYING，opus 被这类客户端拒收）。⚠️ 当时误判为 "opus > pcm > flac"，已更正（见 3.0.30）。
  ffmpeg flac 管道输出只在 EOF flush，实时推流每帧拿空包 → 空包不上 wire，随后改分段 FLAC。
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
