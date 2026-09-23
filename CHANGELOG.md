# 更新日志 (Changelog)

本文件记录各版本的主要变更。版本号遵循语义化版本，仅在打 `vX.Y.Z` tag 时由 CI 构建并发布（产物：Docker 镜像）。

## [4.0.18] - 2026-09-24

### Sendspin —— 抗卡顿：设备缓冲深度可配（预填充／回补）＋ 推流循环不再饿死事件循环

针对「ESP32 Sendspin 播放时不时卡顿」的服务端两条硬修复，并把它做成 Web 可随时调整的配置项。

- **新增插件配置项「设备缓冲深度（抗卡顿）」**（Sendspin 插件页下拉档位）：
  `0.8 秒（关闭预填充，等同旧行为）` / `1.5 秒` / `3 秒（推荐）` / `5 秒` / `10 秒`。
  改完**立即生效**（推流循环每 5s 重读配置，无需重启、不中断当前播放）。
- **预填充 / 卡顿后自动回补**（`services/sendspin/streamEngine.ts`）：
  此前设备侧缓冲深度**恒等于首帧锚点（800ms）** —— 服务端按实时速率推、设备按实时速率播，
  差值永远填不满，所以「想缓冲 10s」只能靠把锚点抬到 10s，代价是**起播静默 10 秒**。
  现在两者解耦：**锚点固定 800ms（起播延迟不变），缓冲深度由推流循环在首帧后尽快灌满**；
  编码器/音源停顿时缓冲被抽干，恢复后还会**自动补回**目标水位（旧行为补不回来 → 持续卡顿）。
  对齐 MA：producer 领先消费端填充，直到客户端 `buffer_capacity` 上限。
- **推流循环落后时让出宏任务**（B2）：原 `if (delayMs > 0) await sleep(delayMs)` 在落后时
  **没有任何让出点** → 整条 `pushLoop` 退化成微任务自旋，WebSocket 的 I/O 回调（含设备发来的
  `client/time`）排不上队 → 设备侧 `Time message N/8 timed out` → 重同步 → 卡顿。
  现在落后时 `await setImmediate`（对齐 MA `connection.py` 每 50 次迭代 `asyncio.sleep(0)`）。
- **曲末排空**：缓冲变深后，曲末若立刻发 `stream/end`，协议要求客户端**清空缓冲**，
  设备里还没播的音频会被砍掉。现在先等设备播完缓冲再收流（只等超出旧水位 800ms 的那部分，
  尾部截断量与旧行为一致），且排空放在 `running=false` **之前**，避免外部误判「已停却仍在播」。
- **配置读取**：`readSendspinPluginConfig()` 新增 `prefillBufferMs`
  （`normalizePrefillBufferMs` 归一化，区间 100–30000ms，非法回落 3000）。
- **修复：播放中加入群组的新播放器（FLAC 链路）不出声**（`services/sendspin/playerCore.ts`
  + `server.ts`）：播中加入原本**在加入瞬间就发 `stream/start`**，但 FLAC 是块编码器
  （libFLAC 自选块大小 ≈4096 样本 ≈85ms），新成员的编码器要攒满一块才吐首帧 ——
  「先宣告、后等货」留出空窗，设备据此丢弃该流（本文件已记录过的同型事故：收到
  `Stream Started` 却不做 codec header 处理、扬声器不启动 = 无声）。PCM 每批即刻产出，
  所以只有 FLAC 暴露。
  改为与起播路径一致：`stream/start` 挂入 `pendingAnnounces`，由 `pushFrame` 在
  **该成员首块音频就绪时**才兑现（对齐 MA `_pending_stream_start`）。
  附带收益：`codec_header` 此刻必为该成员编码器的**真实 STREAMINFO**，不再回落合成头。
- **测试**：`pluginConfig.test.ts` 新增档位/越界/非法归一化用例；`playerGroup.test.ts` 桩音源
  由 1s 加长到 30s（预填充灌满后仍按实时推，播中加入才收得到直播帧）并新增
  「stream/start 必须延后到首块就绪」断言；`childMain.test.ts` 同步更新该语义；
  `queueModes.test.ts` 桩曲长 300ms → 5s（曲长短于缓冲时整首会被瞬间灌完，
  「按实时播完 → 自动切歌」的仿真前提不成立）。sendspin 36 文件 203 例全绿。

## [4.0.17] - 2026-09-24

### 群组 —— 容器语义恒在线 + 点群组即切 MINI 遥控栏

- **组是「容器」不是设备，可用性恒为在线**（`services/peer.ts::reconcileGroupPeers`）：
  注册组时 `available` 恒 `true`，空组、成员全部离线也显示在线。成员各自的在线状态仍由
  `GroupManager.resolveMemberStates()`（按成员 id 命名空间分派的唯一真相源）推导，
  汇总成 `onlineCount` **只供前端展示「x/y 在线」**，不再反向决定组行可用性。
  历史两版都把「容器在线」误当成「内容物在线」：① 只查 DLNA 设备缓存 ⇒ sendspin 组恒离线、
  被流转选择器按 `available` 剪掉整行；② 改 `some(m => m.available)` ⇒ 空组/成员离线时组又变离线。
- **点群组 = 切换 MINI 遥控栏 + 进入管理模式**（`frontend/src/layouts/MainLayout.vue`）：
  `toggleGroupManage` 内先 `await playerStore.switchPeer(gid)`，把 MINI 播放器栏切到该群组，
  再展开成员勾选（保留弹窗/抽屉，这是与 `onSwitchPeer` 的差异）；移除群组行的 ▶ 按钮
  （与勾选圈职责冲突）；组行状态标注：空组 → `layout.groupEmpty`，有成员 → `layout.groupMembersOnline`。
- **测试**：`tests/services/groupPeerAvailability.test.ts` 重写为 7 例（组恒在线 + `onlineCount`
  汇总，保留旧语义的负向验证，回退即红）。
- **i18n**：新增 `layout.groupEmpty` / `layout.groupMembersOnline`（zh + en）。

### 工程

- `scripts/sendspin-monitor-240.sh`：匹配串 `pollDBG` → `[QueueController][poll]`（poll 日志改
  debug 级后旧串不再出现，脚本此前**静默漏采**）；新增位置回退 >5s 的 `REWIND`、链路不可用连续
  3 轮的 `LINKDOWN`，卡顿指纹（PUSHBREAK / ENCSTALL / WINEOF / CURSORLAG / LOOPLAG / LOOPDEATH）
  统一写带时间戳的 `[ALERT]` 行；新增高采样率变体 `scripts/sendspin-hires-240.sh`。
- **版本号守卫**：新增 `backend/scripts/check-release-version.mjs` + `.github/workflows/version-guard.yml`
  —— 版本号必须是数字（vX.Y.Z），`main` / `master` / `latest` 等分支名一律判红；静态禁止 workflow
  把 `github.ref_name` 当版本号（推分支时它等于 `main`）；监听 `tags: ["*"]` 以便非法 tag 进来就被判红。

### 验证

- `backend tsc --noEmit` 0 错；`frontend vue-tsc --noEmit` 0 错；
  全量 vitest **186 文件 / 1579 例全绿**；7 个 `check-*.mjs` + `check-i18n` 全通过。

## [4.0.16] - 2026-09-23

### 功能 —— 群组音量持久化（空组也落库）+ 默认 20 + 卡顿监控文档

- **组音量落库**（`player_groups.volume`，0–100 整数）：
  - `schema.ts` 与 `db/index.ts` 的 `CREATE TABLE player_groups` 同步加 `volume INTEGER NOT NULL DEFAULT 20`（无 `ALTER TABLE`，老库按约定重建）；
  - `GroupManager`：新建组默认 **20**（用户定稿，替代原 100）；`getVolume` / `setVolume`（钳位 + `persist` + `group_updated`）；`loadFromDb` / `persist` 读写 volume；
  - **无成员也持久**：空组 / 全离线调音量重启后恢复；改成员、改名不覆盖已存音量。
- **写路径**：
  - 路由 `POST /v1/peers/:peerId/volume` group 分支：**先** `gm.setVolume` 落库，再 `transport` 扇出（扇出失败不回滚库值）；
  - `GroupProtocolPlayer.setVolume`、`createSendspinGroupPlayer.setVolume`：先落库再下发。
- **回显**：`getGroupStatus` 音量权威 = GroupManager 持久值（空组/全离线也回显）；sendspin leader 有实时组值则用实时，DLNA leader 覆盖为持久组音量。
- **ug 懒创建回填**（子进程 `SendspinGroup.volume` 缺省 100 的对称修复）：
  - 起播 `playMedia`、成员加入对齐 `alignGroupMembers`、看门狗成员回归：入组/起播前 `sendspinGroupTransport(ug, "volume", gm.getVolume(id))` 灌入持久值。
- **测试**：3 个测试文件内嵌 `CREATE TABLE player_groups` 补 `volume` 列；`GroupManager` 新增 3 例（默认 20 / 空组持久重启恢复 / 钳位与事件 / 改成员改名不丢音量）；GroupPlayback·GroupWatchdog 的 `getGroupManager` stub 补 `getVolume`/`setVolume`。
- **文档**：新增 `docs/STALL_MONITORING.md` —— 多线程容器卡顿监控方法（`sendspin-monitor-240.sh` / `sendspin-hires-240.sh` / `pull-240-monitor.sh` 部署、事件判读、排查顺序、盲区、DLNA 对照）。
- **验证**：`tsc --noEmit` 0；组相关 5 个测试文件 44 用例绿；`check-i18n` 0。

## [4.0.15] - 2026-09-23

### 对齐 MA —— ffmpeg 解码参数（P0）+ 滑动窗口 300s（BALANCED）

- **ffmpeg 参数对齐 MA（P0）**（`audio/pipeline.ts`）：
  - 新增 `INPUT_READ_ARGS`：每输入自带 `protocol_whitelist` + `probesize 8096` + `analyzeduration 500000`（对齐 MA `_INPUT_READ_ARGS`，起播/切歌不再等满 5MB 默认探测）；
  - 新增 `HTTP_RECONNECT_ARGS`：http(s) 输入补 `-reconnect 1 -reconnect_delay_max 10 -reconnect_streamed 1 -reconnect_on_network_error 0 -reconnect_on_http_error 5xx,429`（对齐 MA `get_ffmpeg_args` 重连窗）；
  - 全局补 `-nostats -ignore_unknown`。
- **滑动窗口 30→300 秒**（`sendspin/streamSource.ts`）：`WINDOW_HIGH_SEC=300` / `WINDOW_LOW_SEC=290`（滞回 10s 同宽），对齐 MA `BUFFER_SIZE_MAP[BALANCED]`（240 ≥4GB 落 BALANCED）。未消费前沿 PCM 上限 ~115MB（Buffer 外部内存，不占 V8 老生代）；5 分钟曲内 seek 回跳几乎总能命中窗口。
- **概念分层写清**：300s = 服务端 PCM 解码环；MA `_PRODUCER_BUFFER_LIMIT_US`（30→60s，发送侧推流背压，MA 源码侧已改）是另一层，注释与设计文档 §2.5 已区分。
- **插件 help（中英）与设计文档同步**：30s/11.5MB → 300s/115MB；`SENDSPIN_MULTIROOM_STREAMING_PLAN.md` §2.1/2.2/2.5/§A 重写（60→30→300 演进、水位 290/300、MA 侧 60s ≈26MB）。
- **测试**：pipeline / transcode / streamSource 相关用例同步；`tsc --noEmit` 0；`check-i18n` 0。
- **240 热补丁核验 + CPU 峰值压测**：容器内 grep 全部参数在位、`/ping` ok；12–16×`yes` 忙等使 loadavg 峰值 23.11，期间 `state=PLAYING` 位置线性推进、无 STALL；20:11:44–51 卡顿反馈经 events/docker 日志对齐为**自然切歌**（`contentEnded` → `advance` → dur 170→126），非卡死。

## [4.0.14] - 2026-09-23

### 优化 —— 播放优选：WebDAV 可播「成功记忆」（跳转性能 F 项）

- **问题**：`utils/localSourceProbe.ts` 只记**失败**（`localFailCache` 5 分钟），成功不记。
  而「这首歌的 WebDAV 源可播」这个结论在**每次起播 / 每次 seek** 都被重新探测一遍 ——
  240 实测单次 `probeLocalSourceOk` = 597~1410ms，`resolvePlayableRow` 的 `preferred-swap`
  因此要 1.7~2.0s（judge 一次 + 出流一次，成对出现）。
- **做法**：新增与失败记忆**对称**的成功记忆 `webdavOkCache`（TTL 同为 5 分钟）：
  - **只缓存 WebDAV 分支** —— 本地 `l:` 走 `existsSync` 零成本，缓存它零收益，
    反而会引入「文件已删却仍返回死行」的风险；
  - 对外暴露 `evictProbeOk(songId)`，**出流失败**（源行缺失 / 非 2xx / 取流异常）时逐出，
    接线在 `resolveAudio.ts` 的 `fetchRowBytes`;
  - 缓存条目上限 512，超出先清过期再丢最旧，防无界增长。
- **收益（240 真机）**：同一首 WebDAV 行连测 3 次 `probeLocalSourceOk`：
  831ms → **0ms → 0ms**；`preferred-swap` 裁决 2007/1731/1758ms → **957/810/727ms**（约 -55%）。
  `resolvePreferredSong` 的 6 个调用点自动受益，无需改动任何链路。
- **测试**：新增 `tests/utils/webdavOkCache.test.ts` 5 例（命中 / 过期 / 逐出 / 失败不记 / 本地分支不参与），
  并做负向变体验证守卫会红（破坏命中判定 → 2 红；`evictProbeOk` 置空 → 1 红；还原后 5 绿）。
  全量回归 185 文件 / 1568 用例全绿，`tsc --noEmit` 与 9 个 CI 门禁全 0。

## [4.0.13] - 2026-09-23

### 优化 —— seek 取流：回环 raw 流加 256KB 稀疏块缓存（跳转性能 B 项）

- **问题**：ffmpeg 对**无 SEEKTABLE** 的网盘 FLAC 做输入 `-ss` 时会发 9 次**开放式 Range**
  （每次往前退一点、读到文件尾），每次一个上游往返，累计 **4~13s** 才出声。
  旧的回环 raw 分支是**纯透传**，这些回溯请求一个都省不掉。
- **做法**：新增 `services/dlna/rawStreamCache.ts`，把 `/rest/dlna/stream/:token?raw=1` 从纯透传
  升级为 **256KB 稀疏块缓存代理**（`proxyRawRange`）—— 未命中时透传并顺带镜像、命中时本地供给
  零上游往返；未命中时**并行补「块首 → 请求起点」前缀**，让 ffmpeg 逐步往前退的回溯 Range 能命中。
  五条链路的 seek 都走同一段 `-ss`（`audio/pipeline.ts`）⇒ **Sendspin / DLNA / 客户端 / Web / AirPlay 一起受益**。
- **形态红线（四轮 240 真机事故沉淀，离线单测测不出来）**：
  ① 响应头必须在上游响应头到达后**立刻发出**、数据边下边喂（「先把窗口下完再回话」会把首响应
  拖到几十秒 ⇒ 前奏无声 / 拖动卡住）；② 后台补块**不得带客户端 signal**（ffmpeg 读几百字节就断连，
  会把补块自己掐断，缓存永远补不上）；③ 续接上游必须**一条请求读到完**（逐 chunk 现场开请求 ⇒
  26MB 顺序播放退化成 ~100 次小请求，真机 21 分钟零输出）；④ 续接交给上游后**不得再回头读缓存**
  （上游顺序覆盖 ⇒ 同一段吐两次，总长不变、只有 md5 看得出）。
- **兜底与降级**：上游 5xx 先重试一次，仍失败则让下游看到错误而**不是假 EOF**（静默结束会被
  当成「播完了」自动切歌）；任何异常路径一律回退旧透传 + `[rawStreamCache]` 告警（30s 节流）；
  `RAW_STREAM_CACHE=0` 可整体回到纯透传（A/B 对照用）。
- **效果（240 真机，26MB 天翼网盘 FLAC）**：整曲回环长度与直连一致、**md5 三方全等**（直连×2 + 回环）、
  `upstream=0`；端到端 `ffmpeg -ss` 冷态 **1.3~1.9s**（旧基线 3.4~8.9s）、同曲热态 **31ms**。
  **已知差距**：回溯序列实测 5 次只命中 1 次（补块 TTFB ≈450ms 与回溯间隔同量级），
  「9 → 1~2」属设计目标、真机未达成 —— 收益主要来自**整曲续读走缓存 + 热态重放**。
- **验证**：新增 24 例单测（真 HTTP 上游：分片慢给 / 只发头不发 body / 整块 416 / 5xx 注入）；
  负向矩阵 12 变体（11 条守卫各自精确变红 + V1b 对照组全绿）；全量 184 文件 **1563 用例全绿**；
  9 个 CI 门禁脚本全 0；240 真机四轮实测 + 用户收听验收通过。

## [4.0.12] - 2026-09-22

### 修复 —— 拖拽 seek 打死 sendspin 子进程（整秒契约）+ 取流重建加固

- **根因**：sendspin 流式引擎按 **25ms 帧栅格**取帧（`lo = floor(pos/25) * 2400` 样点），而滑动窗口
  基准是「毫秒 → 样本」换算（`base = floor(pos/1000 * 48000 * 2)`）—— **只有目标为 25ms 整数倍时两者相等**。
  HA 卡片 / 网页把当前播放位置原样下发（31.178s / 30.178s 这类毫秒精度）→ `lo < base` →
  `PcmWindow.slice()` 抛 `WindowEvictedError` → 主循环 `continue` 用**同一个游标**重算 → 再抛 →
  纯微任务自旋（不 await I/O）→ 事件循环彻底饿死 → 心跳与 `poll` RPC 全排不上队（管辖进程记
  `悬挂 RPC 12~15 个` / `最后消息 71s 前`）→ **65s 看门狗 SIGKILL** → 重启 → frozen 兜底重投
  （位置仍是毫秒精度）→ 再挂。现象：拖完进度条播放静默死掉、进度冻住。
  客户端下发 `Duration.inSeconds` 恒为整秒（1000/25 = 40），所以**从来只有 HA 卡片与网页会挂**。
- **三层防御（引擎）**：①新增 `alignFrameMs()` 帧栅格对齐，在 `play()`（源起点 + 游标）、`seek()`
  （发布位置 + 记忆）、`armSeek()`（装填）**四处统一**向下取整到 25ms（代价 ≤24ms，不可闻）；
  ②`PcmWindow.slice()` 亚帧容错 —— 只在请求段与窗口**全无交集**（`hi <= baseSample`）时才抛错，
  `lo < base < hi` 时钳到 base 返回短帧；新增 `get baseMs()`；③pushLoop 淘汰护栏 —— 淘汰分支把
  落后于窗口基准的游标**贴齐**到 `ceil(baseMs / FRAME_MS) * FRAME_MS` 并重锚 pacing（+ warn 取证），
  保证「每轮淘汰必然前进」，机制上杜绝自旋。
- **唯一入口兜底**：`POST /v1/peers/:peerId/seek` 经 `alignSeekSeconds()` 统一向下取整 —— 任何来源
  （HA 卡片 / 网页 / 第三方客户端）都不可能把非整秒目标送进引擎。
- **取流重建加固**：并发 `play` 世代守卫、重建失败告警 + 子进程 loop 自检、音源获取 30s 熔断。

### 门禁

- 新增 `backend/scripts/check-seek-granularity.mjs`（6 条规则：两侧 util 导出、后端路由必须兜底、
  前端每个 `/seek` 下发站点必须对齐、不得有未识别的 `/seek` 字面量、引擎 `alignFrameMs` 应用点 ≥5
  且 `WindowEvictedError` 仍在），挂 `ci.yml` 新 job。
- 新增 `backend/tests/utils/seekGranularity.test.ts`（截断语义 / 整秒恒等 / 25ms 帧栅格不变式 / 非法归 0）。
- 新增 `streamSource.test.ts` 2 例（亚帧钳制返回短帧 / 真淘汰仍抛错）、`streamPumpSeek.test.ts` 3 例。

### 构建信息

- Docker 镜像：`ray5378/musicflow:4.0.12` + `:latest`
- 配套：客户端 **v5.0.28**／HA 卡片 **v2.4.8**／HA 集成 **v2.0.5**（同一批次）

## [4.0.11] - 2026-09-22

### 调试日志补全（seek 全链路）

- AirPlay protocol seek：入口＋结果＋耗时（原裸调，成败靠猜）
- sendspin `seekCore`：请求值／钳制结果／有无在播／重建耗时／ephemeral 回落
- DLNA（cast/seek/guard/status）、group 扇出、transport 入口：既有覆盖不变
- 零行为变更；配套客户端 **v5.0.26**

### 构建信息

- Docker 镜像：`ray5378/musicflow:4.0.11` + `:latest`

## [4.0.10] - 2026-09-22

### 修复 —— 拖动后切歌／从头重播（240 联调实锤三连）

- **同歌重投误判换歌**：`track_changed` 用全 URI 字符串比较，重投只改 `?timeOffset` 也算"换歌"→自动 advance。比较前剥 query（真换歌 token 必变，不受影响）；回归单测锁定。
- **重投间隙 STOPPED 清基线**：Stop 生效期的瞬态 STOPPED 走 else 分支删掉 seek 锚点，随后 PLAYING rawPos=0 只能就地播种 0 → 进度/歌词从头重爬。保护窗内保留基线并回填预期位置；重投路径补开保护窗。
- **手动 next/prev 归因日志**：`[Peer] 手动切歌`，区分误触与自发切歌（此前 playCurrent 无决策无请求，无法定案）。
- 三链路核查：sendspin（pump 设目标值）／AirPlay（原地 FLUSH 保 position）／group（透传成员）无同类瞬态清锚逻辑，不用动。

### 构建信息

- Docker 镜像：`ray5378/musicflow:4.0.10` + `:latest`

## [4.0.9] - 2026-09-22

### 修复 —— DLNA 重投风暴串行化 + Web 投屏跟手保护

- **重投风暴串行化**：连续拖动产生背靠背完整重投（Stop/SetURI/wait/Play），小设备 HTTP 栈被打死后全 500（240 联调实锤：5 连拖）。同设备重投排队串行＋400ms settle 收敛到最新目标＋世代号后来者胜，旧重投在 Stop/SetURI/wait/Play 检查点退出（`SeekSupersededError`，不记失败）。
- **Web 投屏跟手**：拖拽标志（拖拽中 tick 不推进手指值）＋分母未知不发 seek＋尾部 `duration-0.5s` 钳位＋换歌/停轮询清理 seek 状态（与卡片 seekDragging、客户端因果屏障同构）。
- 配套客户端 **v5.0.25**（看门狗意图作废＋间隙 0 屏蔽）。

### 构建信息

- Docker 镜像：`ray5378/musicflow:4.0.9` + `:latest`

## [4.0.8] - 2026-09-22

### 修复 —— 同歌 seek 重投被 tracker 误判为换歌，自动 advance 切下一首（HA 卡片/客户端同病）

**根因（240 真机日志实锤）**：拖动进度触发「重投流重建」时，`createCastSession`/
`createAirPlaySession` 每次 mint **新 token** → 设备 TrackURI/mediaUri 随之变化。
`PlaybackTracker` 的 native gapless 判据「PLAYING 且 uri 变 = 换歌」
（PlaybackTracker.ts:165）把同歌重投误判成换歌 → `track_changed` → 自动 advance。
4 次拖拽 2 次中招；轮询恰好采到 BUFFERING 瞬态时幸免，故体感「拖到靠近结尾必切下一首」。
HA 卡片与客户端共用后端队列，两边同时中招 —— 与前端无关。

**修复（对齐 MA「同一队列项流 URL 恒定」语义）**：
- `createCastSession`（DLNA + sendspin mediaUri 共用）：同 (songId, deviceId)
  未过期会话**复用 token、仅续期**（6h TTL 内同歌重投 TrackURI 不变）。
- `createAirPlaySession`（AirPlay 独立会话）：同样复用（SQLite 主路径 +
  内存回退路径）。换歌（songId 变化）仍 mint 新 token，真换歌的
  track_changed 判据不受影响。
- 新增回归测试：`tests/dlna/castSessionReuse.test.ts`、
  `tests/airplay/sessionReuse.test.ts`（复用/换歌/跨设备/解析一致性共 8 例）。

## [4.0.7] - 2026-09-22

### 重做 —— sendspin seek 按 Music Assistant 权威语义推倒重来（真机验证通过）

**v4.0.6 的「后台预建 + 帧边界原子切换」方案在真机上失败，本版整体废弃，
改为与 MA `player_queues/controller.py::seek`(@862) 逐条对齐的实现：**

- **seek = 发布位置对 + 整条流重建**（MA `play_index(seek_position)`）：
  - ① 先发布 `group.positionMs = targetMs`（MA `elapsed_time + last_updated`），
    推送循环取帧改用**自有游标**（`playCursorMs`），共享位置只写不读 ——
    v4.0.6 的 swap 前置问题：pushLoop 用共享 positionMs 反推帧下标，
    seek 一发布目标位置旧循环即误判 EOF（真机 FP-TRACE 堆栈钉死）。
  - ② `seekCore` 走与正常起播**完全相同**的 `playCore/playGroupCore` 路径重建流：
    停旧流 → stream/end 成对 → 全新音源带 `-ss` 起点起流 → 新时间线锚点
    （now + send_ahead，MA `_resolve_channel_play_start` auto 模式）。
    MA 没有帧边界换流；设备缓冲自然耗尽后接新流，即 MA 真机行为。
- 删除 v4.0.6 引入的全部自创机制：`beginRebuild` / `applySwap` / `swap*` /
  `rebuildGen` / `rebuildInFlight`。
- `playCore`/`playGroupCore` 新增 `seekPositionMs` 通道（MA seek_position 等价）；
  组状态 `current` 补存 `mime`。
- **真机验证**（240 容器 + 真实音源）：
  - sendspin(esp32-player2)：seek 30s→31.2s 续播、seek 45s→47.0s 续播，
    真实节奏推进不断线；音量 30/45/80 即时回读一致。
  - DLNA(主卧 HiVi H5MKII)：seek 40s→43.0s、seek 70s→73.0s 续播正常；
    设备恒报 RelTime=0 时自动降级「重投流重建」标记生效；音量 20→40→70 即时生效。
- 排查附记：测试曲「Ditch」实际音频仅 30s（试听片段）而元数据 131s，
  seek 超出实际音频末尾的 EOF→切歌行为与 MA 一致，非本版缺陷。

## [4.0.6] - 2026-09-22

### 修复 —— 进度条跳转(sendspin / DLNA)按 Music Assistant 语义重做

根因一句话:此前 seek 的语义是「在跑着的流里挪指针」,而 MA 的语义是
「用新起点重建一条流」(`controllers/player_queues/controller.py:862`)。
前者在实时转码管道上物理落不了位 —— sendspin 卡顿、进度条比真实快、DLNA 进度虚高,
是同一个根因的三种表现。完整方案见 `docs/PLAYBACK_SEEK_MA_REWORK.md`。

- **sendspin 跳转后持续卡顿 + 进度条比真实时间快**:`window.seekTo()` 是 kill 旧 ffmpeg
  再冷起新的,设备端实测 **5~7.4s 完全断流**,缓冲耗尽后按实时速率补不回来;且 seek
  瞬间就写了 pacing 锚点、首帧却晚到数秒,`dueMs` 全部落在过去 → 帧无节制连发
  (实测 3.94s 内 `pos` 涨 8.875s)。现在改为 MA 式**后台预建新流 + 帧边界原子切换**:
  `seek()` 立即发布目标位置(防 UI snapback)→ `beginRebuild()` 后台预建 → 就绪后由
  pushLoop 在帧边界换流 —— **旧流在预建期间继续播,设备端零空窗**;`rebuildGen`
  保证连续拖动只认最后一次,过期的重建立即释放(防泄漏);seek 后重锚提前量抬到 3s
  (设备上报的缓冲参数常常全 0,`send_ahead` 退化成 800ms,太浅)。
- **ffmpeg 孤儿泄漏(P0)**:`GroupPump.play()` 用 `this.window = stream` 直接覆盖,
  旧 `WindowStream` 从未 `close()` → 每次切歌泄漏一个 ffmpeg。240 现场堆积 10 个、
  存活 18~29 分钟、各占 ~65MB RSS,最终触发 `PcmWindow 等数超时(15000ms)` →
  `idle_early` 误判 → 切歌 → 再泄漏,恶性循环。改为 play 前先 `releaseAudio()`。
  部署后实测:ffmpeg 10→1、僵尸 5→0、容器内存 1.35G→674MB。
- **DLNA 进度虚高 + 外推越过时长误判切歌**:HiVi/MUZO 播实时转码流时 `GetPositionInfo`
  **恒回 `RelTime=0`**,SOAP `Seek(REL_TIME)` 静默失效,而位置基线仍被锚到请求目标 →
  纯墙钟外推。现在连续 2 次「设备不报位置」即判定该设备 SOAP Seek 无效(**并落库持久化**,
  重启后首次 seek 就直接走,不必再试错两回),此后 seek 改为**带 `timeOffset=N` 重投一条
  新流**(MA `play_index(seek_position=N)` 在 DLNA 侧的等价实现)。
- **起播跳转不再二次冷起**:`PumpSource` 增加 `startMs`,起播即带 ffmpeg `-ss`,
  省掉「建流 → `seekTo()` → 再冷起」的整段空窗。

### 新增 —— AirPlay 通道独立(播放通道不再复用)

AirPlay 此前与 DLNA、sendspin 共用 `/rest/dlna/stream/:token` **一条**路由,带来三个
结构性问题:① DLNA 音箱兼容头(`contentFeatures` / 12h 假 `Content-Length` / ICY)被
强加给 AirPlay 解码器;② 滤镜通道键恒为 `dlna`,`pipeline.airplay` 开关形同虚设;
③ 任一链改 URL 参数会串到别的链。现在 AirPlay 有自己的 token 命名空间
(`services/airplay/session.ts`,**SQLite 登记** —— AirPlay fork 模式下主进程 mint、
子进程经回环 URL 消费,内存 Map 跨进程不可见)与 `/rest/airplay/stream/:token` 路由;
出流核心抽成 `serveCastStream()` 由两条链共用,按通道取各自的 DSP 查键与管线开关,
不复制 100+ 行出流逻辑。

### 文档
- 新增 `docs/PLAYBACK_SEEK_MA_REWORK.md`:真机取证(F1~F4 + 两个放大器)、MA 权威契约、
  通道复用现状图、四层改造总纲、patch 全表、验收矩阵、发布与回滚方案。

### 构建信息

- Docker 镜像:`ray5378/musicflow:4.0.6` + `:latest`

## [4.0.5] - 2026-09-21

### 修复 —— CI 合规

- **`check-i18n` 阻断「前端插件隔离守卫」**：`c42757a`（拖动进度条四端修复）在
  `frontend/src/stores/player.ts` 的 castPoll seek 护栏里留了一行中文 `console.debug`
  （`丢弃 seek 后偏离读数`），而 `backend/scripts/check-i18n.mjs` 要求前端源码（注释除外）
  不得出现硬编码 CJK —— 于是 v4.0.4 发版提交 64f3e11 上 `ci` 工作流的该步骤变红。
  日志不是用户可见文案、无需走 i18n，改为英文即可；**播放逻辑与产物零变化**。

### 构建信息

- Docker 镜像：`ray5378/musicflow:4.0.5` + `:latest`

## [4.0.4] - 2026-09-21

### 新增

- **日志等级运行时可调**：新增设置键 `log.level` + admin API（`GET/PUT /rest/api/v1/admin/log-settings`），
  设置页新增「日志等级」卡片。此前只能靠启动时的 `LOG_LEVEL` 环境变量定死，排查线上问题要么重启、
  要么零日志。fork 出去的子进程有独立 logger 实例，故新增 `setLogLevel` IPC 显式下发
  （否则推流/解码侧的 debug 明细不出现）。
- **请求级 trace id**：`runWithTrace()` 给 `/rest`、`/api`、`/webhooks` 请求生成短 id 放进
  `AsyncLocalStorage`，debug 日志自动附加 `tid=`。一次「拖动进度条」会级联 HTTP → QueueController
  → DLNA SOAP → sendspin 多层，靠 tid 才能把跨层日志串成一条链。静态资源不生成（纯噪音）。

### 修复 —— 播放链路

- **PLAYING 但位置冻结无看门狗**（用户观感＝「进度条卡住不动」，永不自愈）：实测 sendspin 报
  `PLAYING pos=173.6 dur=280` 三分钟不推进、pump 零日志，而现有的 IDLE 卡死（15s）与结束兜底（8s）
  都够不着。新增 `frozen` 判据（位置**真变化**的墙钟超 30s）→ 就地重投当前首并拉回位置
  （**不切歌**），与 stalled 共用连续计数；seek 冷静期内与复查后撤销。
- **链路不可用却冒充设备状态**：子进程僵死期间 RPC 25s 超时，旧代码 catch 成
  `{playing:false,pos:0}` ＝ 向 tracker 谎报「设备停了」→ 凭空造出 PLAYING→IDLE 迁移 →
  判「自然结束」切歌。新增 `PlayerState.unavailable`：sendspin 三种 player 与 DLNA 的 `pollState`
  在拿不到真实读数时标它，QueueController 读到即不喂 tracker、不计数、登记 linkLost，等真恢复再续播。
- **DLNA 在设备未发现时冒充 STOPPED**：`getDeviceStatus` 的早退分支在设备不在发现缓存时返回
  `STOPPED pos=0`，容器重启 / 重新发现窗口期会被读成「设备真停了」，连续 2 次判卡死后**放行切歌**
  （真机复现：重启后 35s 队列凭空少一首、位置归零，极易被误判成 seek bug）。修法同款：标
  `unavailable` 不冒充。判据用**发现缓存**而非 `runtimes` 的 available 位——后者对未知设备乐观返回 true。
- **「链路恢复」≠「设备回来了」**：fork 模式 sendspin 子进程重启后要重新拨号、设备要重新入组，
  这中间 `poll` 会合法地回 IDLE。盲目 cast 会投进一个不存在的连接（没声音但状态显示在播）→
  30s 后被冻结看门狗判死 → 第 2 次直接放行切歌。新增 `ProtocolPlayer.isAvailable?()` 作为续播前门，
  不在线就**保留** linkLost 等下一拍（5s 后）再试。
- **子进程僵死窗口过长**：心跳看门狗 3×+5s(95s) → 2×+5s(65s)，检查间隔 30s→10s（最坏 125s→75s）；
  超时日志补「最后消息 Xs 前 | 最后 RPC op | 悬挂 RPC 数」，下次能直接看出卡在哪一步。
- **拨号目标过期不重发现**：`dialRemembered()` 只重拨记忆中的 host:port、不做 mDNS 重解析，
  设备 DHCP 换 IP（实测 .245→.246）后旧目标无限 `EHOSTUNREACH`，把子进程拖住并连带所有 RPC 25s 超时。
  现在连续 3 次**地址类**错误（EHOSTUNREACH/ENETUNREACH/EHOSTDOWN/ENOTFOUND/EAI_AGAIN/ENETDOWN）
  即淘汰记忆目标并落盘（非破坏性，mDNS 会重新发现新 IP），并加单飞与 5s 连接超时。

### 修复 —— 拖动进度条（四端）

- **Web 端缺 seek 护栏**：`castPoll` 此前**无条件采纳**设备上报位置，设备实际生效有延迟时轮询读到的
  仍是拖动前的旧位置 → 进度条被拽回。新增每设备 `seekIssued`（时刻+目标）护栏，与卡片
  `_seekIssuedAt`、客户端 `_seekIssuedAtMs`、HA 集成 `seek_guard_until` 同语义，且必须在 POST
  **之前**置位（请求在途期间就可能有一次轮询返回旧位置）。
- **服务端 DLNA `seekGuard`**：拖动后设备把陈旧读数报回来的窗口内，丢弃陈旧值、采纳落位值、到期解除。
  判定抽成纯函数以便 CI 用固定时间轴钉死（失效形态是偶发跳回，手测极难复现）。
- **sendspin 重定位代数化**：「校验失败→重发」此前会让 `seekDevice` 末尾派生新 gen 的新校验 →
  每秒一次的无限风暴；更隐蔽的后果是每次重发都重设护栏 → 位置恒被 `seekExpectedPosition` 顶住 →
  **进度卡住不前进**。现在重发恰好一次（`{verify:false}`），设备恒报 0（HiVi/MUZO 播转码 chunked 流）
  时直接放弃落位校验。
- **起播窗口内拖动**：拖动落在 pump 尚未运行的空档时记下起播位置交由 `play()` 消费，不再丢弃。

### 构建信息

- Docker 镜像：`ray5378/musicflow:4.0.4` + `:latest`

## [4.0.3] - 2026-09-21

### 修复

- **插件沙箱交互型调用超时 30s→20s**：15s 配额过窄，20s 兼顾等待与卡死可杀；重建预算 30s 不变。
- **沙箱 OOM 清理排空 pending jobs**：被 interrupt 打断的 async continuation 残留会钉住 `gc_obj_list`，`dispose` 即触发 QuickJS teardown 断言 abort（WASM 层 SIGABRT，宿主 try/catch 抓不住，直接杀死整个 vitest worker、全量陪葬）。`oomCleanup` 前后各排空一次；`sandbox.test.ts` 连续 3 次 27/27 通过。
- **sendspin `seekCore` 类型修正**：v4.0.2 带入的 TS2345（ephemeral 假组传给 `pumpFor`），改用 `srv.group` 取真组，`tsc` 干净。

### 构建信息

- Docker 镜像：`ray5378/musicflow:4.0.3` + `:latest`

## [4.0.2] - 2026-09-21

### 修复 —— 拖动进度条问题（分播放器逐一修复）

- **sendspin 拖动后无法播放/进度不对**：`seekCore` 只写 `positionMs` 标记，pump 主循环下一帧即按下标覆盖（进度回跳、音频原地），且不钳制 duration（拖到尾直接触发播完→跳歌/停播）。改为走组 pump 跳转（含 clamp＋流式窗口 `-ss` 重起）；暂停态拖动保持暂停（与 DLNA/Web 同语义）。
- **timeOffset 接受 0.1s 粒度小数**：新增 `parseTimeOffset`（4 处替换 `parseInt`，非法/负值归零），ffmpeg `-ss` 前置定位直接支持小数。整秒 floor 时代的系统性 `<1s` 偏小是 Web/客户端「进度定位不对」的来源之一。
- DLNA/AirPlay/group/local 本体核实无害（REL_TIME 整秒是设备规范；AirPlay 有 FLUSH＋换 decoder；group fan-out；local 转发），坏的都在调用侧，已由三端（Web/客户端/HA）配套修复。

### 配套

- Web 前端：seek 越界钳位 `duration-0.5s`、拖动开始快照 autoplay、`localSeekActive` 跟手保护、时长按 `song.duration` 播种、0.1s 粒度 timeOffset。
- 客户端 **v5.0.19**、HA 卡片 **v2.4.3**、HA 集成 **v2.0.2** 同步发版（四端同批）。

### 构建信息

- Docker 镜像：`ray5378/musicflow:4.0.2` + `:latest`

## [4.0.1] - 2026-09-21

### 修复 —— 播放结束判定与卡死兜底

承接 4.0.0 的「出流管道化」：本版不新增能力，只把「一首歌什么时候算放完」「卡住了怎么办」
这两件事的判据补齐到与上游 MA 同口径。

- **卡死兜底 60s → 15s，判据改为墙钟累积**：旧判据是「相邻两次 IDLE 上报间隔 > 60s」，
  但设备采样固定 5s 且每次上报都把 `updatedAt` 刷成当前时刻 → 差值恒为 5s，**生产里永远
  触发不了**；唯一的可达旁路（队列停轮询 / advancing 占用超 60s）触发时，恰好会去重投一个
  **已经播完**的队列。现在改为「进入 IDLE 记时刻、离开即清」的墙钟累积，与采样频率解耦。
  阈值 15s 与 `dlna/control.ts` 的 `TRANSPORT_STATE_CACHE_MS = 15000` 同口径。
- **cast 失败不再静默**：`playCurrent` 的 catch 原先只 `endOptimistic` 就返回 —— 这首既不
  重投也不切歌，队列就此停死（设备瞬时离线时表现为「再也不播了」）。现在接入既有 stalled
  通道（复查 → 每首最多重投一次 → 第 2 次放行切歌），并按「一整圈」（2×曲数）封顶，防止
  整队都投不出去时无界绕圈；到顶即判整队不可播。
- **已结束 / 未激活队列不重投**：卡死阈值降到 15s 后 stalled 路径才**真正可达**，而它原先
  全程不看 `q.isActive` / `q.ended`。加护栏，置于最前、零副作用。
- **乐观窗口拆成两段**：原实现「cast 命令发出前」就起 5s「等设备确认 PLAYING」计时，而那 5s
  会被 `Stop → SetAVTransportURI → Play` 三次 SOAP 往返（单次超时 8s）吃掉，判出的 stalled
  只是「命令还没发出去」。拆为 `beginOptimistic`（阶段 1，仅屏蔽切歌瞬态）与
  `armOptimisticTimeout`（阶段 2，cast 送达后才起计时），对齐 MA `PLAYBACK_START_TIMEOUT = 5.0`
  「命令送达后起算」的语义。

### 配套

- 客户端 **v5.0.18** 同步补齐：直投 DLNA 时 `getTransportInfo` 读失败返回的 `UNKNOWN` 不再与
  真 `STOPPED` 同判，15s 宽限窗口内沿用最近一次成功读数（与服务端 `TRANSPORT_STATE_CACHE_MS`
  同口径）—— 修「时长未知的曲目上一次 SOAP 读失败就被误判放完 → 曲中段切歌」。

### 构建信息

- Docker 镜像：`ray5378/musicflow:4.0.1` + `:latest`

## [4.0.0] - 2026-09-20

### 大版本 —— 音频出流全面管道化

版本号从 3.0.x 跳到 **4.0.0**：本版不是补丁累加，而是把「出流」这件事整体换掉了做法。
原先每条链路各转各的、必要时才转码（存在若干**原样直出旁路**），现在 HTTP / Web / DLNA /
Sendspin / AirPlay 五条链路统一走同一条**六段流水线**：

> ① 解码成 F32 → ② 响度归一化 → ③ DSP（音色）→ ④ 交叉淡入 → ⑤ 限制器 → ⑥ 编码输出

已清掉全部直出旁路（`?raw=1` 直透、`serveWebSongStream`、`serveDlnaWebStream`），
**没有「绕过管道」的路径了**。

### 新增 —— 听得见的能力

- **换歌不再忽大忽小（② 响度归一化）**：每首歌拉到同一目标响度，默认 −14 LUFS，
  可在「音频」页配成 −30…−5（对齐 Music Assistant 的区间）。有离线测量值时走静态增益，
  没有则走实时 loudnorm —— 两种口径共用同一个解析函数，不会互相打架。
- **交叉淡入（④，默认关）**：连续播放时两首歌重叠过渡，时长 1…15 秒（默认 8 秒），
  在「音频」页开启。只在**顺序播放**下生效：洗牌 / 单曲循环 / 列表循环的「下一首」
  不由队列下标决定，拼流会与设备真实顺序打架。
- **每台设备独立音色（③ DSP）**：前级增益 / 三段音色（低中高）/ 左右平衡 / 参量 EQ，
  按设备存、不跟账号走。参量 EQ 是手算 biquad 系数（不用 ffmpeg `equalizer`），
  高/低通可选 12 / 24 / 48 dB/oct 陡度（级联 Butterworth）。全 0 = 不加滤镜、零开销。
- **本地行离线预测量（默认关）**：提前跑一遍响度分析，起播直接走静态增益，省掉实时 loudnorm。

### 新增 —— Web 端「音频」页

侧边栏新增「音频」模块，「音频管道」「设备音色」两张卡片从「设置」页整块搬过来，
并加上「音量归一化」。每张卡片都能单独开关：全局总开关 × 四个通道（HTTP / DLNA /
Sendspin / AirPlay），DLNA 还能**按设备单独回退**（某台老音箱听不了就只给它关掉）。
管理员可见全部，仅被授予播放权限的账号只能看到自己能控的设备的音色。

### 修复 —— 全量代码审核抓出的 5 处缺陷

管道化的错误几乎都是「不报错、只是难听」，所以本版对全部相关代码做了一轮审核：

1. **交叉淡入静默丢掉上一曲尾段**：下一曲首段短于过渡窗口时，那段既没播出也没参与混合，
   最长丢一整个窗口（默认 8 秒）且**完全不报错**。
2. **ffmpeg 日志保留方向反了**：缓冲区到上限就不再追加 ⇒ 冻结在**流的开头**，
   而 loudnorm 的测量报告打在**末尾** ⇒ AirPlay 超过约 5.7 分钟、Sendspin 超过约 11.5 分钟的
   曲目**永远解析不到响度值**（静默失败）。已统一为「超限丢开头、末尾永远在」。
3. **DSP 端点越权**：音色是设备属性，原实现只校验「有播放权限」⇒ 任意可播放账号都能改
   **全服务器每台设备**的 EQ。已补设备级授权（`canControlPeer`）。
4. **高/低通缺了陡度维度**：只有单节（用 Q 值），补上 12 / 24 / 48 dB/oct 级联选项。
5. **残留的向后兼容迁移块**：`audio_analysis` 表的 `PRAGMA` 探列 + 补列已删（本项目的既定约定）。

### 变更 —— 客户端与接口侧需要知道

- **HTTP 流式 seek 改按服务端能力判定**：4.0.0 起所有 HTTP 流都是实时流（无直传旁路），
  字节 Range 失效，seek 改为带 `timeOffset` 重拉。客户端按服务端版本号门控（≥ 3.0.47 即启用，
  4.0.0 满足）；Navidrome 等其他服务端不受影响，沿用旧判定。
- **DLNA 全通道走管道**：cast / enqueue / DIDL 的 MIME 三处同步，音箱兼容头
  （`contentFeatures` + 12 小时假长度）恒定带上。
- **并发转码槽拆成三个独立池**：`quality`（音质转码）/ `pipeline`（实时管道）/ `flow`（交叉淡入），
  互不抢槽，上限按 CPU 核数派生。
- **DB 新增 2 张表**（`audio_analysis`、`player_dsp_configs`）：均为**一次性建表**，
  本版不做旧数据迁移（自用项目的既定约定，升级即重建）。

### 验证

- `tsc --noEmit` 0；7 个静态门禁全 0（`check-i18n` 1347 键中英对齐）。
- 前端 `vue-tsc && vite build` 通过。
- 后端 **139 个测试文件 / 1236 例**全绿；新增的 31 例（设备授权 8 / 陡度 9 / 归一化 14）
  全部做了**负向验证**——先把修复改回旧行为确认测试确实变红，再还原。

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
