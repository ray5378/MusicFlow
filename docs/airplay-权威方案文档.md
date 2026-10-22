# AirPlay（RAOP）权威方案与验收文档

> **基线**：MusicFlow **v4.6.70** · 后端 `backend/src/services/airplay/*` · 230 测试床 shairport-sync（AP1/AP2）· 真机 HiVi H5MKII / MUZO / WR320
> **文档来历**：合并此前分散在 `PLAYBACK_SEEK_MA_REWORK.md`、`MusicFlow-AirPlay2(E2~E5)课题立项与实施计划`、`CHANGELOG` 4.6.5x 条目、230 真机排障记录与 `check-airplay-playback-chain.mjs` 守卫注释，并以 **2026-10-20 / 2026-10-21 / 2026-10-22 三轮 HiVi 真机实测** 的最新结论为准。
> **怎么读**：**第一～五部分是正确做法，照做即可**；**第六部分是踩过的坑（含被推翻的旧结论），务必别重蹈**；第七部分是回归守卫清单；**第八部分是 DLNA + AirPlay 合一设备的流转权威方案**（同设备双身份、双向时序、失败表、验收矩阵）。
> **本文是 AirPlay 链路的唯一权威**。与其它文档冲突时，以本文为准。

---

## 0. 一分钟总纲

AirPlay 1（RAOP）链路 = **RTSP 控制面** + **加密 RTP 音频面** + **ffmpeg 实时转码**。

```
QueueController（队列 / 自动切歌 / 重启恢复）
        │  UniversalPlayer → ProtocolPlayer
        ▼
airplay/protocolPlayer.ts     ← 薄适配器（只做协议操作 + 起播落点）
        ▼
airplay/control.ts            ← 编排：设备闸 / DLNA 互斥 / peer / lastCast / 音量状态
        ├── raop.ts            ← RTSP 握手 + RSA/AES + RTP 定速推送
        └── decoder.ts         ← ffmpeg 解码 → 有界 PCM 队列（前 1.5s 预填充）
```

五条最容易翻车的铁律：

| 铁律 | 一句话 |
|---|---|
| **RTSP 请求行必须三段** | `METHOD url RTSP/1.0`，版本段缺一个字节，shairport-sync 这类合规接收端直接 `400 Bad Request` |
| **seek = 完整重建会话** | TEARDOWN → 新 ANNOUNCE/SETUP/RECORD；**不存在“原地换流”** |
| **一次流转只能建一条会话** | 起播落点通过 `seekSec` 交给**本次**握手，**禁止**“先起播、再 seek”（第二次 RECORD 会让 HiVi 永久不答） |
| **任何超时都不得在定时器里 throw** | `withTimeout` 的 fallback 在 `setTimeout` 回调里抛错 = 未捕获异常 = **整个后端进程退出** |
| **每一步都要有硬上限** | 握手 8s / TEARDOWN 2.5s / connect 12s / 互斥 6s / 收尾 4s；没有上限的一步会永久占住 per-device 串行闸 |

---

# 第一部分：架构与职责边界

## 1.1 模块职责

| 文件 | 职责 | 不做什么 |
|---|---|---|
| `protocolPlayer.ts` | 把 RAOP 接收端接进统一 `UniversalPlayer/QueueController`；`playMedia(item, baseUrl, startMs)` 把落点换算成 `seekSec` | 不做 RTSP、不碰 ffmpeg |
| `control.ts` | 编排层：设备级串行闸、DLNA 双协议互斥、peer 注册、`volumeState`/`lastCast`、状态查询 | 不做字节级推流 |
| `raop.ts` | RTSP（ANNOUNCE/SETUP/RECORD/TEARDOWN/FLUSH/SET_PARAMETER）、RSA-OAEP、AES-128-CBC、RTP/SYNC 包、重传 | 不做设备发现、不读 DB |
| `decoder.ts` | ffmpeg 解码 → 有界 PCM 环形队列（预填充 1.5s / 上限 10s / 背压） | 不持有会话态 |
| `session.ts` | 独立的 `/rest/airplay/stream/:token` 凭证（落 SQLite；同 song+device 复用） | 不参与出流实现（复用 `serveCastStream`） |
| `sessionRuntime.ts` | 纯推流运行时：会话起停 / seek / 快照 / `sessionEnded`（可整体跑在子进程） | 不碰 DB / DLNA / peer |
| `supervisor.ts` / `childMain.ts` | fork 模式下的子进程管理（心跳、快照、RPC、看门狗、退避重启） | 设备发现与 DB 留主进程 |
| `discovery.ts` | mDNS 发现（`_raop._tcp`）+ AP2 能力打标（`_airplay._tcp`） | 不产生纯 AP2 设备 |
| `plugin/renderers/airplay.ts` | 把上述能力暴露为内置 `renderer` 插件（**默认开启**） | 外置沙箱插件不可行（要绑 TCP/UDP、要 Node crypto） |

## 1.2 进程模型

- **默认 fork（2026-10-22 起，与 sendspin 对齐）**：RTSP 会话 + 7.98ms 墙钟节拍整体跑在常驻子进程
  （`dist/services/airplay/child.js`），由 `rendererHost` 通用宿主管理（心跳 / 快照 / RPC / 看门狗 / 退避重启）。
  - 主进程保留：mDNS 发现、DB（`airplay_devices`）、DLNA 互斥、token 化 streamUrl、peer 注册、`volumeState`/`lastCast`。
  - 子进程保留：会话、解码器、RTP 推送、快照。**子进程不碰 DB**。
  - 理由：7.98ms 节拍比 sendspin 的 25ms 更紧，主进程一次长阻塞（封面缩图 / 批量任务）就会直接变成 `reanchors++` 与真机断音。
  - 240 实测（本地曲，24 并发前端请求 × 15s）：子进程 `chunks` 增量 2381（≈125.3/s），
    `reanchors`、`maxGap`、`loss` 增量全部为 **0** —— 推流节拍与主进程负载完全隔离。
- **in-proc 回落**：`MUSICFLOW_AIRPLAY_INPROC=1`（排障用，免 fork）；单测（VITEST）永不 fork。
- **强制 fork**：`MUSICFLOW_AIRPLAY_FORK=1`（显式开关，默认已是 fork，一般无需设置）。

## 1.3 状态归属（排障第一原则）

| 状态 | 归属 | 重启后 |
|---|---|---|
| 设备表 / 别名 / 禁用 | `airplay_devices`（DB） | 保留 |
| 队列 / 当前曲 / 轮播模式 | `device_queues`（DB） | 保留，启动 10s 后 `resumeActive` |
| 会话（RTSP/RTP） | 进程内存（或子进程） | **丢失**，需重新 cast |
| `volumeState` / 静音 | 进程内存 + `airplay_device_state`（DB） | 保留（2026-10-21 起持久化） |
| stream token | `airplay_stream_tokens`（DB） | 保留（30min TTL） |

---

# 第二部分：协议正确做法

## 2.1 设备发现

- 设备表**只**由 `_raop._tcp` 产生；`_airplay._tcp` 只给已存在的设备打 `supportsAp2` 能力标记。
- 纯 AP2-only 设备**不进**设备表（AP2 发送端未落地，进来只会变成“点了报错”的死设备）。
- TXT 关键字段：`et`（含 `1` = 支持 RSA）、`pk`（设备公钥）、`am`（型号）、`deviceid`。
- **不得把 `.local` 当可路由 host**：mDNS 记录没有 A/AAAA 时 `host` 必须回退到解析出的 IPv4；`svc.host` 只能作最后兜底（守卫 R16）。

## 2.2 取流会话

- AirPlay 使用**独立命名空间**：`/rest/airplay/stream/:token`。
- 不许复用 `/rest/dlna/stream/:token`：DLNA 的兼容头（`contentFeatures.dlna.org`、12h 假 `Content-Length`、ICY）不属于 AirPlay，且会把滤镜通道键钉死成 `dlna`。
- 同 `(songId, deviceId)` 的未过期 token **必须复用**（只续期）。否则同歌 seek 后 `mediaUri` 变化，`PlaybackTracker` 会判“换歌”并自动 advance（守卫 R22）。
- token 表落 SQLite：fork 模式下主进程 mint、子进程经回环 URL 消费，内存 Map 跨进程不可见。

## 2.3 RTSP 握手

```
TCP connect（端口 4515 LinkPlay / 5000 标准）
  → ANNOUNCE（SDP：ALAC 44100/16/2、RSA aeskey、latency）
  → SETUP（transport: RTP/AVP/UDP;control_port;timing_port）
  → RECORD
```

- 请求行：`METHOD <url> RTSP/1.0`（**版本段必须存在**，守卫 R20）。
- 加密：设备公钥 RSA-OAEP 加密 `aeskey` → 音频 AES-128-CBC。
- 超时预算（守卫 R18/R23）：
  - 常规 RTSP：10s
  - `TEARDOWN` / `FLUSH`：2.5s（设备不答也必须尽快放行）
  - 握手三步**合计** 8s（单步取 `max(1.5s, min(10s, 剩余预算))`）
  - `connect` 整体 12s（含 UDP bind / TCP connect / 三步握手），任一卡死都必须失败返回
- 日志锚点：`RTSP ANNOUNCE|SETUP|RECORD <status> (<ms>, 握手总耗时 <ms>)`、`UDP bind 完成 <ms>`、`RTSP TCP 已连上 <ms>`。

## 2.4 音频推送

- 编码：ffmpeg 解码任意源 → PCM → **RAW-ALAC**（`pcm_to_alac_raw`，`CHUNK_LEN=352` 帧/包，1408 字节）。
- 节拍：按墙钟定速，352 帧 @44.1kHz ≈ **7.98ms/包**；不要用 `sleep(固定值)` 累积漂移，必须用绝对时间对齐。
- 缓冲：解码侧预填充 **1.5s**；PCM 队列上限 **10s**；超过上限 `pause` ffmpeg stdout（背压），回落到一半 `resume`。不丢帧。
- SYNC 包：NTP 锚点锚**推流墙钟**；`seek` 只改变内容偏移，**不得**把内容偏移当成未来时间（守卫 R12）。
- 丢包：依赖接收端的 NTP timing 请求做重传（libraop 同款语义）。
- 可观测：`RaopRealtimeStats`（发包数、`reanchors`、最大包间隔）。单次包间隔 > 50ms 打 `HEALTH_WARN_GAP_MS` 告警。

## 2.5 控制语义

| 操作 | 实现 | 注意事项 |
|---|---|---|
| pause | RTSP `SET_PARAMETER`（`rate: 0`） | 保持会话，不 TEARDOWN |
| resume | `rate: 1` | 不重建会话 |
| stop | `FLUSH` + `TEARDOWN` | 清理类请求用 2.5s 短超时 |
| seek | **完整重建会话**（TEARDOWN → ANNOUNCE/SETUP/RECORD） | 这是协议语义，不是实现偷懒 |
| volume | `SET_PARAMETER volume: <dB>`（0→-144，100→0dB） | LinkPlay（HiVi/MUZO 等）**忽略**该指令 → 必须转发同 host 的 DLNA `RenderingControl.SetVolume`（守卫 R21） |
| mute | 独立状态位 | 取消静音恢复**原音量**，不能靠“音量置 0”实现 |

## 2.6 与队列/播放器集成

- **PLAYING 主动上报**：会话建立成功立即上报一次（不等 5s 轮询）。这是“放完不自动下一首 / 从头重播 / 切歌无效”三类现场问题的共同修复点（守卫 R1）。
- **IDLE 必须带真实落点**：`sessionEnded` 携带 `positionSec/durationSec`，队列据此判断“自然结束”还是“异常停止”。
- **过期会话抑制**：被新起播/显式 stop 取代的旧会话，其 finalizer 上报的 `IDLE` 必须带 `current=false` 并被主进程**抑制**，否则会把新曲判成“已结束”。
- **状态词表归一**：内部 `PAUSED/IDLE` 在 API 出口翻译为 `PAUSED_PLAYBACK/STOPPED`（客户端只认这套，守卫 R15）。

## 2.7 双协议互斥（AirPlay ↔ 同一台 DLNA 设备）

HiVi / MUZO / WR320 都是 **同时广播 AirPlay + DLNA** 的双协议设备，同一台机器的两个入口必须互斥：

1. AirPlay 起播前：`QueueController.stopPlayback(dlnaPeer)` **冻结** DLNA 队列 → `stopDevicePlayback(dlnaPeer)` 发 SOAP `Stop`。
2. 反向：DLNA 起播时 `stopAirPlaySessionsForHost(host)`。
3. 顺序不可颠倒：必须先冻结队列再停设备，否则 DLNA 侧 `GENA` 的 `STOPPED` 会触发队列自动切歌。
4. 互斥让位有 **6s 硬上限**；旧会话收尾 **4s 硬上限**（守卫 R18）。上限放在助手内部，保证互斥守卫 R2 的两次直调计数不被破坏。
5. 起播分段日志：`AirPlay 起播分段耗时: 互斥DLNA=<ms> 旧会话TEARDOWN=<ms> RAOP握手=<ms>`。
6. **停稳窗（2026-10-22）**：DLNA `Stop` 的 SOAP 200 只代表指令已受理，固件切输入还要时间。AirPlay 起播前若 DLNA **确实在播**（`QueueController` 快照 `isActive`），必须轮询 `GetTransportInfo` 直到 `STOPPED`（上限 2.5s），再给 300ms 宽限，然后才建 RAOP 会话。日志：`双协议互斥:DLNA 已停稳,开始建 AirPlay 会话 … state=STOPPED ms=…`。
7. **反向收尾守卫（2026-10-22，关键）**：DLNA 侧的 `stop/reset` 在发 SOAP `Stop` 前必须检查同 host 是否有活跃 AirPlay 会话（`hasActiveAirPlaySessionForHost`）。**有则只清本地队列、不下发设备 Stop** —— 同一台 Linkplay/HiVi 的 DLNA Stop 会连带停掉 AirPlay 输出（详见 §2.11）。`stopDevicePlayback`（互斥让位）**不设**此守卫，AirPlay 起播前必须仍能硬停 DLNA。

## 2.8 起播即落位（流转接续）★ 2026-10-21

**唯一正确做法**：把源端进度交给**本次**握手。

```
transfer-from（源 DLNA → 目标 AirPlay）
  → 读源进度 inCastPos
  → playFrom(..., startPositionMs = inCastPos*1000)
  → UniversalPlayer.playMedia(item, baseUrl, startMs)
  → AirPlay protocolPlayer: seekSec = startMs/1000
  → castToAirPlayDevice({ seekSec }) → 唯一的 ANNOUNCE/SETUP/RECORD
  → 不再补 seek
```

反面做法（**已证伪**）：先 `cast`（从头起播）→ 再 `seekAirPlay` 对齐。AirPlay 的 seek 是完整重建会话，等于一次流转连开 2~3 条 RTSP 会话；HiVi 只认一条会话，第 2/3 次 `RECORD` **永久不答**，现场表现为“流转经常失败 / 接续无声”。

## 2.9 失败与恢复

| 现象 | 判定 | 处置 |
|---|---|---|
| 握手超预算 | `RTSP <method> timeout(<ms>)` | 快速失败，交上层重投；**不得**拖到 cast 30s 硬顶 |
| cast 超 30s | `playMedia 超过 30000ms 未返回(cast 挂死)` | 兜底回调返回 `null`（**不得 throw**）→ async 内抛错 → `player.stop()` 回收半开会话 |
| 设备离线 | `available=false` | 队列悬挂（不 deactivate），设备回归后 `resumeActive` |
| 容器重启 | 启动日志 `resuming N active device queue(s)` | 10s 后 `resumeActive`；设备缓存需先由 SSDP/mDNS 填充 |

## 2.10 重启后音量保持 ★ 2026-10-21

**现象**：容器重启后设备音量被改成 20。

**根因（最终结论）**：**HA 自动化**在设备上线/容器重启后调用 `media_player.volume_set` 把音量设为 20，**与本项目无关**。日志 `[peer-volume] <peer> <- 20 ua=HomeAssistant/…aiohttp` 可直接确认来源。

**本项目侧的职责边界**：只保证「重启后保留用户上次设置」这条不变量，不对第三方行为做拦截。

1. 服务端：`airplay_device_state` 设置即落库、`getAirPlayStatus` 用持久值播种；永久删除设备时清行。
2. HA 集成（`hass-musicflow` v2.1.2）：实体剪枝加 120s 恢复窗口 —— 避免后端重启时实体被瞬时剪掉再重建。属集成稳定性改进，与「20」无因果关系。

> **已否决的做法（4.6.57 移除）**：曾按「启动 120s 内 + HA UA + 每 peer 第一笔」静默丢弃音量/静音请求。这不合语义 —— 用户在重启后任何时刻调音量都必须生效；UA 匹配也脆弱。现在写入口只保留统一解析与永久观测日志，不做任何按来源/时间窗的过滤。

**真机验证**：设 48 → 重启容器 → `airplay` 状态 48、同 host DLNA 设备实测音量 48、DB 仍为 48；Sendspin 38、群组 70 均前后一致（前提：HA 自动化不介入）。

**观测锚点**：`[peer-volume] <peer> <- <value> ua=<UA>`、`[peer-mute] ...`。

## 2.11 同设备流转后的源端收尾（客户端 reset）★ 2026-10-22

**适用设备**：同时广播 AirPlay + DLNA 的合一设备（HiVi H5MKII、MUZO、WR320 等），
两个入口 `airplay:<id>` / `dlna:<uuid>` 共享同一个 `host`。

### 完整时序（客户端真实行为）

```
1. 主卧(DLNA) 正在播
2. POST /peers/airplay:<HiVi>/queue/transfer-from  { from: "dlna:主卧" }
     → 读源进度（起播前定格）→ playFrom(startMs) → 本次 RAOP 会话即落位
     → 互斥：冻结 DLNA 队列 → stopDevicePlayback(主卧) → 等 STOPPED + 300ms
3. 客户端随即 POST /peers/dlna:主卧/reset         ← 源端收尾
     → stopPlayback + stopDevice(主卧)
```

### 致命点：DLNA Stop 会连带停掉 AirPlay 输出

同一台设备的 DLNA `Stop` **不是**只作用于 DLNA 通道：固件会停掉整机播放器。
第 3 步若照旧向设备下发 SOAP `Stop`，刚建立的 AirPlay 会话立刻静音，而服务端
RAOP 仍在推流、位置照走 —— 用户看到的就是「队列和进度都过来了，但一点声音没有」。
此时再拖一次进度会重建会话，设备已处于停止态，反而出声。

240 现场（2026-10-22，逐秒取证）：

```
16:31:09.947 RTSP RECORD 200 → AirPlay 会话建立
16:31:10.167 [DLNA][Stop] 发起   ← 客户端 reset 源端，1.2s 后到达
16:31:11.180 [ws][state] STOPPED
16:31:11+   服务端 AP=PLAYING 位置持续前进；设备 getPlayerStatus=stop / curpos=0
```

### 正确方案（已实现）

1. `airplay/control.ts` 导出 `hasActiveAirPlaySessionForHost(host)`：同 host 是否存在
   活跃 AirPlay 会话（in-proc 看 `sessions`，fork 看子进程镜像；复用 `hasActiveSession`）。
2. `dlna/control.ts` 的 `stopDevice()` 在下发 Stop **之前**判定：
   - host 取 `device.avTransportUrl`（**不要用 `location`**：持久化/缓存记录可能缺该字段，
     得到空串会让守卫静默失效）；
   - 同 host 有活跃 AirPlay 会话时 → **只做本地收尾**（事件态置 `STOPPED`），直接 return；
   - 判定异常 → 按旧口径执行（宁可停，不可漏）。
3. `stopDevicePlayback()`（AirPlay 起播前的互斥让位）**保持原样**，不得加这个守卫；
   否则 AirPlay 起播时 DLNA 停不掉，设备仍占着 DLNA 输入。
4. DLNA 侧仍可 `stopPlayback` 清掉本地队列 / `isActive`，客户端感知与旧行为一致。

### 验收判据（不依赖人耳）

用设备自己的 Linkplay HTTP 接口取真实播放态，而不是只看服务端进度：

```bash
curl -s "http://<设备IP>/httpapi.asp?command=getPlayerStatus"
# 健康：{"status":"play","curpos":"<递增>","vol":"31","mute":"0"}
# 无声：{"status":"stop","curpos":"0"}（服务端仍报 PLAYING）
```

验收序列：DLNA 起播 → transfer-from 到 AirPlay → 立即 `POST /peers/<源端>/reset`
→ 连续采样 30s，`status` 必须保持 `play` 且 `curpos` 递增。
日志必须出现：`[DLNA][Stop] … 同 host AirPlay 会话在播 → 跳过设备 Stop(防误杀 AirPlay 输出)`。

> **部署注意**：该守卫曾以热补丁写入容器 `dist`，随后一次 `docker compose up --force-recreate`
> 用镜像重建容器把补丁覆盖，现场表现为「有时能出声、有时又不行」。热补丁验证通过后
> 必须尽快走正式发版（镜像内置），不要把热补丁当作最终交付。

## 2.12 独立子进程的 RPC 健壮性 ★ 2026-10-22

fork 模式首次真机验证暴露两处「子进程 RPC 永久挂起」，表现为拖动进度报
`airplay rpc 超时: cast (25000ms)`、随后起播报 `RAOP connect 总超时(12000ms)`：

1. **RTSP 连接关闭不 reject**：`sendRtsp` 在等响应期间对端关闭时只 `clearTimeout`，
   Promise 永不 settle ⇒ `player.stop()`/`cast()` 永久挂起。修复：`close`/`error`
   一律 reject（带 `socket closed`），并在 cleanup 时摘掉监听器。
2. **子进程收尾无上限**：主进程 in-proc 用 `withDeadline(4s)` 包住旧会话收尾，子进程却直接
   `await player.stop()`。修复：`AirplaySessionRuntime.stop()` 用 `STOP_DEADLINE_MS=4s`
   （可用 `AIRPLAY_STOP_DEADLINE_MS` 覆盖）包住；超时调用 `RaopPlayer.forceClose()`
   立刻释放 socket/RTP 端口，保证 RPC 一定回包。
3. **微任务饿死 IPC**：`producer` 有 10s 抖动缓冲时，追赶发包可连续数百次只走微任务，
   子进程的 IPC/RTSP 响应（poll 阶段）被饿死。修复：每追发 16 包 `setImmediate` 让出一次。

**fork 路径与 in-proc 的对齐（易漏）**：子进程的 `cast`/`seek` 也必须把偏移编进
**服务端回环流** `?timeOffset=N`，`spawnDecoder(url, undefined)`；绝不对 live FLAC 做
`-ss`（残帧 ⇒ 有进度无声，见 §2.11 / 4.6.66）。

**真机回归（240 + HiVi H5MKII，fork 默认）**：起播 / seek 60 / 暂停 → `/play` 恢复 /
音量 40（转发到同 host DLNA）/ 停止 / 主卧→HiVi 流转 + reset 源端 / AP→DL→AP 快速往返，
设备 `getPlayerStatus` 全程 `play` 且 `curpos` 前进；无 `rpc 超时`、无 `RAOP connect 总超时`。

---

# 第三部分：超时与预算总表

| 项 | 值 | 常量 / 位置 | 破坏后果 |
|---|---|---|---|
| 常规 RTSP | 10s | `RTSP_TIMEOUT_MS` | 慢设备拖死操作 |
| TEARDOWN / FLUSH | 2.5s | `RTSP_CLEANUP_TIMEOUT_MS` | 新 cast 被旧会话拖着 |
| 握手总预算 | 8s | `HANDSHAKE_BUDGET_MS` | 三步各 10s = 撞 30s cast 硬顶 |
| 握手单步下限 | 1.5s | `RTSP_STEP_MIN_MS` | 预算将尽时设备没机会应答 |
| RAOP connect | 12s | `AIRPLAY_CONNECT_BUDGET_MS`（可覆盖） | `bindUdp` 卡死 → 永久占闸 |
| DLNA 互斥让位 | 6s | `DLNA_YIELD_DEADLINE_MS` | 慢 DLNA 拖死 AirPlay 起播 |
| 旧会话收尾 | 4s | `STOP_SESSION_DEADLINE_MS` | 同上 |
| cast 硬顶 | 30s | `MF_CAST_TIMEOUT_MS`（可覆盖） | 超时回调 throw → 进程退出 |
| 设备闸 | 串行 | `withDeviceGate` | 无上限的占闸 = 该设备后续全部静默排队 |
| 子进程会话收尾 | 4s | `STOP_DEADLINE_MS`（`AIRPLAY_STOP_DEADLINE_MS` 可覆盖） | 设备不答 TEARDOWN ⇒ cast/seek RPC 挂死 |

---

# 第四部分：设备兼容矩阵（实测）

| 设备 | 协议 | 端口 | RSA | 音量 | 已知限制 |
|---|---|---|---|---|---|
| HiVi H5MKII | AP1 + DLNA | 4515 | 是 | **忽略 RAOP 音量** → 走 DLNA 转发 | 单会话；连续建会话时后续 `RECORD` 永久不答 |
| MUZO | AP1 + DLNA | 4515 | 是 | 同上 | 同上 |
| WR320 | AP1 + DLNA | 4515 | 是 | 同上 | 同上 |
| shairport-sync（230 AP1/AP2） | AP1 | 7000 / 7100 | 是 | `ignore_volume_control=yes` | 严格校验 `RTSP/1.0`；用于 RIFF/PCM 双端对账 |
| 纯 AP2 设备 | AP2 | — | — | — | **暂不支持**（发送端未落地） |

---

# 第五部分：验收方案

## 5.1 判定原则：双端对账

**只看服务端 `/status` 不算通过。** 每一条用例必须同时满足：

1. 服务端：`state=PLAYING`、`position` 按 1:1 前进、队列 `currentIndex` 正确；
2. 播放器侧：目标接收端真实产出音频（PCM 字节增量 ≈ 176400 B/s 且 RMS > -60dB）；
3. 进程健康：`RestartCount` 不增长、日志无 `cast 挂死` / `RECORD timeout`。

## 5.2 用例矩阵

| # | 用例 | 操作 | 通过判据 |
|---|---|---|---|
| A1 | 起播 | `POST /v1/peers/airplay:<id>/queue/play` | ≤ 2s 进入 PLAYING；AP1 PCM 10s 内 ≥ 1.5s 音频；RMS > -60dB |
| A2 | 暂停/恢复 | `POST .../pause`、`.../play` | 会话不断、PCM 停止/恢复、position 不跳 |
| A3 | 停止 | `POST .../stop` | `RTSP TEARDOWN` 有应答；设备 PCM 停止；队列保留 |
| A4 | 拖动（seek） | `POST .../seek {seconds}` | 新会话建立；落点误差 ≤ 1s；position 继续 1:1 |
| A5 | 拖动后 3s 内再拖 | 连续两次 seek | 第二次仍成功；无 `RECORD timeout` |
| A6 | 自然结束 | 播放至结尾 | `IDLE` 带真实落点；自动切下一首（不重播本首） |
| A7 | 流转接续 | DLNA 播 30s → `transfer-from` 到 AirPlay | ≤ 7s 完成；**只有一条** RTSP 会话；落点一致；`RECORD 200` |
| A8 | 连续流转 ×10 | 重复 A7 10 次 | 10/10 成功；`RestartCount` 保持 0 |
| A9 | 双协议互斥 | AirPlay 在播时向同 host DLNA 发起 cast | DLNA 先 Stop；AirPlay 会话被正确清理；无交叉出声 |
| A10 | 容器重启恢复 | `docker restart musicflow` | 10s 后 `resuming`；队列续播；不重复建会话 |
| A11 | 音量/静音 | `POST .../volume {0..100}`、`.../mute` | LinkPlay 设备实际音量跟随（DLNA 转发）；静音恢复原音量 |
| A12 | 离线设备 | 断电接收端 10s 后回归 | 队列悬挂不丢；回归后 `resumeActive` 续播 |

## 5.3 230 测试床模拟器

| 链路 | 启动方式 | 真实数据源 |
|---|---|---|
| AirPlay AP1/AP2 | `<测试床脚本目录>/restart_players.sh`（shairport-sync 7000/7100） | `<测试床脚本目录>/ap1a_out.pcm`、`<测试床脚本目录>/ap2a_out.pcm` |
| DLNA | `node <测试床脚本目录>/dlna_mock.js 49500 <测试床IP>` | `http://127.0.0.1:49501/__state`（bytes/state/offset） |
| Sendspin SDK/C++ | 同上（`run_ss.sh` 守护） | `ss_pcm_out.pcm`、`ss_flac_out.pcm`、`ss_cpp.pcm` |

详细的启动/调试/判据见 [`播放器链路调试与模拟播放器验收手册.md`](./播放器链路调试与模拟播放器验收手册.md)。

## 5.4 一键验收脚本

| 脚本 | 用途 |
|---|---|
| `<测试床脚本目录>/ops2.py` | 全可能性操作矩阵（服务端 + 播放器侧逐条对账） |
| `<测试床脚本目录>/apdiag.py` | AirPlay 双端对账：空闲/播放/拖动/停止四段（RTP 锚点 + PCM 能量） |
| `<测试床脚本目录>/apwin.py` | 指定时间窗 PCM 截取 + `volumedetect` |
| `<测试床脚本目录>/hivi_one2.py` | HiVi 单次流转（DLNA→AirPlay）计时与状态 |
| `<测试床脚本目录>/hivi_stress3b.py` | HiVi 流转压测 + `RestartCount` 监控 |
| `<测试床脚本目录>/twoside.py` | 双端对账公共库（登录/peers/sizes/anchor/rms/snap） |

---

## 5.5 同一台设备的双协议流转（AirPlay ↔ DLNA，2026-10-21）

HiVi H5MKII 同时以 `airplay:00226C••••••`（HiVi）与 `dlna:FF31••••-…`（别名「主卧」）出现在列表 —— 同一台设备的两个身份。流转必须按「同一物理设备换协议」处理，四个要点缺一不可：

1. **同设备识别**：AirPlay 设备 host == DLNA renderer `location` 的 hostname（与双协议互斥同一套映射）。
2. **落点定格**：目标端起播时的互斥会立刻停掉源端（AirPlay→DLNA 停同 host AirPlay；DLNA→AirPlay 冻结同 host DLNA 队列），源端进度必须在**任何起播动作之前**读取，否则恒为 0。
3. **起播即落位**：DLNA 的 `playMedia` 必须把 `startMs` 编进流 URL 的 `timeOffset`（并把位置基线初始化为该偏移，设备不报 RelTime 时进度条才不从 0 重爬）；AirPlay 走 `playMedia(startMs)` 的 `seekSec`。
4. **反向互斥对称**：停 AirPlay 会话前**先冻结它的队列**，否则设备回 IDLE 会被判成「自然放完」→ advance → 重新 cast，把刚建立的 DLNA 会话反杀（真机表现：主卧 0 秒不出声、HiVi 又播起来）。
5. **源端收尾不得碰设备（2026-10-22 新增，缺一不可）**：客户端在流转完成后会 `reset` 源端。若源端是同一台设备的 DLNA 身份，`reset → stopDevice` 的 SOAP `Stop` 会**连带停掉 AirPlay 输出**（设备 `status=stop`，服务端进度继续走）。必须在 `stopDevice` 里用 `hasActiveAirPlaySessionForHost` 守卫，只清本地队列；详见 §2.11。

**真机验收（240，2026-10-21）**：

| 方向 | 源端进度 | 目标端结果 | 源端 |
|---|---|---|---|
| 主卧(DLNA) → HiVi(AirPlay) | 12.6s | 13.0s 起播并前进；队列 295 首 / idx 33 保持 | DLNA 被互斥冻结 |
| HiVi(AirPlay) → 主卧(DLNA) | 16.95s | 设备拉 `?timeOffset=17`，17.0s → 25.9s 前进 | AirPlay `STOPPED`，不再反抢 |

**真机验收（240，2026-10-22，源端 reset 场景）**：主卧 DLNA 起播 → 流转到 HiVi → 立即 `reset` 主卧。

| 判据 | 修复前 | 修复后 |
|---|---|---|
| 设备 `getPlayerStatus` | `stop` / `curpos=0`（服务端 PLAYING） | `play` / `curpos` 持续递增 |
| 日志 | `[DLNA][Stop] 发起 → 成功` | `同 host AirPlay 会话在播 → 跳过设备 Stop` |

**守卫**：`check-airplay-playback-chain.mjs` 的 **R25**（同设备识别 / 落点定格 / DLNA timeOffset / 基线偏移 / 冻结后再停 / flow 取消与单会话）、**R28**（偏移走服务端回环流 + 停稳窗）、**R29**（反向收尾守卫）。

> 完整方案（双方向时序、客户端契约、失败模式速查、验收矩阵、240 真机记录）见
> **第八部分：DLNA + AirPlay 合一设备的流转权威方案**。

# 第六部分：踩坑录（**被推翻的旧结论**）

1. **“seek 可以原地换流”** —— 错。AirPlay seek 必须 TEARDOWN 后重建会话；任何“复用旧会话换 streamUrl”的实现都会在真机上不出声。
2. **“流转时先起播再 seek 更简单”** —— 错，且是 2026-10-21 HiVi 流转失败的直接根因。一次流转只能建一条会话（§2.8）。
3. **“超时兜底可以在定时器里 throw”** —— 错。`setTimeout` 回调里的异常没有 Promise 承接，直接结束 Node 进程；现场表现为接口 connection refused + `RestartCount` 持续增长。
4. **“握手三步各 10s 就够了”** —— 错。合计 30s 正好等于 cast 硬顶，慢设备会让一次流转必然失败。必须有 8s 总预算。
5. **“TEARDOWN 反正设备会回，等 10s 无妨”** —— 错。旧会话收尾会阻塞新 cast，清理类请求必须短超时。
6. **“RTSP 请求行可以省版本段”** —— 错。LinkPlay 宽松、shairport-sync 严格；省版本段时只有部分设备 400，极难定位。
7. **“mDNS 给的 `.local` 主机名可以直接连”** —— 错。无 A 记录时连接必失败，必须用解析出的 IPv4。
8. **“AirPlay 音量走 SET_PARAMETER 就够了”** —— 错。LinkPlay 全系忽略该指令，音量条不动；必须转发同 host 的 DLNA RenderingControl。
9. **“静音就是把音量设 0”** —— 错。会丢原音量，取消静音无法恢复。
10. **“设备放完自然停 = 直接 IDLE 即可”** —— 不完整。IDLE 必须带落点，且过期会话的 IDLE 必须被抑制，否则会误判结束/误切歌。
11. **“AirPlay 可以复用 DLNA 取流路由”** —— 错。DLNA 兼容头与滤镜通道键会串链路；必须独立 token 命名空间。
12. **“重启后音量变 20 是项目里谁在回放”** —— 最终定位为 **HA 自动化**调用 `media_player.volume_set` 设 20，与本项目无关；`[peer-volume]` 日志的 UA 可直接确认来源。项目侧的职责只有「重启保留用户上次设置」（落库 + 持久值播种），**不得**用吞请求的方式兜第三方行为。
13. **“DLNA Stop 只影响 DLNA 通道”** —— 错。同一台 Linkplay/HiVi 上的 DLNA `Stop` 会停掉整机播放器，连带静音 AirPlay。客户端流转后 `reset` 源端 DLNA 时若照发 Stop，就会得到「进度在走、完全没有声」；必须在 `stopDevice` 里挡掉（§2.11）。
14. **“热补丁部署过的容器可以随便 force-recreate”** —— 错。`docker compose up --force-recreate` 会用镜像重建容器，热补丁写进 `dist` 的文件全部丢失，现场表现为「同一个操作有时能出声、有时不行」。热补丁验证通过后必须走正式发版。

---

# 第七部分：回归守卫

脚本：`backend/scripts/check-airplay-playback-chain.mjs`（零依赖，挂 `.github/workflows/ci.yml`）

```bash
cd backend && node scripts/check-airplay-playback-chain.mjs
```

覆盖规则：

| 组 | 内容 |
|---|---|
| R1 | PLAYING 单一上报出口，in-proc / fork 两个入口都调用 |
| R2~R6 | 设备闸、状态词表、pollState 契约、取流契约 |
| R7~R10 | `mediaUri` 契约、解码器 SIGKILL 回收、上游超时只约束建连 |
| R11 | 设备级串行闸：流转 + 拖动不得交错建会话 |
| R12 | SYNC NTP 锚点锚推流墙钟 |
| R13 | seek 默认完整重建 + seq 连续 |
| R14 | stop/reset 对离线设备也生效 |
| R15 | 状态词表与 dlna/sendspin/local 对齐 |
| R16 | mDNS 无 A 记录不得用 `.local` |
| R17 | 陈旧 GENA 不得覆盖 SOAP |
| R18 | 流转接续：起播即落位 + 建会话硬预算 + 超时不 throw + 超时回收会话 |
| R19 | 插件默认开启 + 停用零残留（2026-10-21） |
| R20 | 两处 RTSP 请求行必须带 `RTSP/1.0` |
| R21 | 音量 dB 端点、LinkPlay DLNA 转发、静音独立 |
| R22 | 独立取流路由 + 同 song+device token 复用 |
| R23 | 重启恢复走统一起播路径 + 设备闸排队可观测 |
| R24 | 音量/静音写入口径统一 + 永久观测日志 |
| R25 | 同设备双协议流转（AirPlay ↔ DLNA）：同设备识别 / 落点定格 / 起播即落位 / 冻结后再停 / 单会话 |
| R26 | 慢源熔断：DLNA 25s 窗口 + 跨曲连跳上限 |
| R27 | flow 起播不被整队预解析阻塞 + 大文件直通默认关 + 播放路径预取判官 + 负缓存失效 |
| R28 | 流转/seek 落位：偏移走服务端回环流（不在 live FLAC 上 `-ss`）+ DLNA 停稳窗 |
| R29 | **DLNA Stop 不得误杀同 host AirPlay 输出**：反向守卫 / host 取 `avTransportUrl` / 守卫先于 Stop / 互斥让位不受影响 |
| R30 | **AirPlay 独立子进程**：默认 `defaultFork: true`；RTSP 关闭必须 reject；收尾 4s 硬顶 + `forceClose`；fork 偏移走 `timeOffset`；追赶每 16 包让出事件循环 |

配套单测：

```bash
npx vitest run tests/airplay tests/services/airplayProtocolPlayer.test.ts tests/player/castTimeoutGuard.test.ts
# 反向收尾守卫（R29）
npx vitest run tests/dlna/controlTransportGuards.test.ts tests/airplay/mutex.test.ts
# 独立子进程 RPC 健壮性（R30）
npx vitest run tests/airplay/raopTransport.test.ts tests/services/airplaySessionRuntime.test.ts
```

---

# 第八部分：DLNA + AirPlay 合一设备的流转权威方案

> **适用设备**：HiVi H5MKII / MUZO Cobblestone / WR320 等 Linkplay 系——同一 IP 上同时广播
> AirPlay(RAOP) 与 DLNA，两个入口在 MusicFlow 里是**两个 peer、一台机器**：
> `airplay:<MAC>` 与 `dlna:<UUID>`。音频输入互斥，且 **DLNA `Stop` 会停掉整机播放器**。
>
> **定位**：本部分是这类设备「流转」的唯一权威方案。实现细节分别见 §2.7（互斥）、
> §2.8（起播即落位）、§2.11（源端 reset）、§2.12（子进程 RPC）；验收见 §5.5。

## 8.1 识别与建模

| 项 | 规则 |
|---|---|
| 同一台设备 | AirPlay 设备 `host` == DLNA renderer 的 `location` hostname（`peers.ts::isSamePhysicalDevice`） |
| 不要用名字匹配 | 两个入口别名常不同（DLNA 叫「主卧」、AirPlay 叫「HiVi H5MKII」），只能按 host 配对 |
| 不要合并 peer | 两个入口都保留：用户可以分别投；合并会丢失 DLNA 单独使用的场景 |
| 停止判定的 host | `stopDevice` 的反向守卫取 `avTransportUrl` 的 hostname（`location` 在缓存/持久化记录里可能缺失，空串会让守卫静默失效） |
| owner（当前出声方） | AirPlay：子进程镜像 `sessions` 非空（in-proc 看 `sessions`）；DLNA：`QueueController` 快照 `isActive` |
| 设备真实播放态 | Linkplay HTTP：`http://<ip>/httpapi.asp?command=getPlayerStatus` → `status/curpos/vol/mute`（**唯一不依赖人耳的判据**） |

## 8.2 五条不变量（缺一条就会「有进度没声音」）

1. **单一 owner**：同一台设备同一时刻只允许一条音频链路在推。AirPlay 起播前停 DLNA；DLNA 起播前停 AirPlay。
2. **先定格、再起播**：源端进度必须在**任何互斥动作之前**读取（互斥会先把源端停掉，晚读恒为 0）。
3. **起播即落位**：落点通过**本次** cast 交出去（AirPlay `seekSec` / DLNA `startMs`），**禁止**「先起播、再 seek」——第二次 RECORD 会被 HiVi 永久忽略。
4. **先冻队列、再停设备**：先 `QueueController.stopPlayback`（冻结），再发传输 Stop；顺序颠倒会让 `IDLE → advance` 把刚建立的目标端反杀。
5. **收尾不得碰设备**：客户端流转后 `reset` 源端时，若同 host 的 AirPlay 会话在播，DLNA 侧**只清本地队列、不下发设备 Stop**（DLNA Stop 会连带静音 AirPlay）。

## 8.3 所有权状态机

```
                ┌──────────────┐
                │ none / idle  │
                └──────┬───────┘
     cast AirPlay      │      cast DLNA
   ┌───────────────────┴───────────────────┐
   ▼                                       ▼
┌──────────────────┐   transfer AP→DL   ┌──────────────────┐
│ owner = airplay  │ ─────────────────► │ owner = dlna     │
│ (RAOP 子进程)    │ ◄───────────────── │ (DLNA renderer)  │
└──────────────────┘   transfer DL→AP   └──────────────────┘
   │  stop / 自然结束                      │  stop / 自然结束
   └──────────────► none ◄───────────────┘
```

切换 owner 的**唯一**入口是 `QueueController` 的 cast/transfer；任何“旁路停设备”都会被
§8.2-5 的守卫拦下（DLNA 侧）或被队列冻结拦下（AirPlay 侧）。

## 8.4 两个方向的完整时序

### A. 主卧(DLNA) → HiVi(AirPlay)

```
Client                Server(QueueController)             AirPlay 子进程        DLNA 设备(同一台)
  │ POST transfer-from {from: dlna:主卧}
  │ ───────────────────►
  │                      │ ① 定格源进度 srcPosEarly（此刻源端还在播）
  │                      │ ② playFrom(airplay, startMs=srcPosEarly)
  │                      │    ├─ 冻结 DLNA 队列（stopPlayback）
  │                      │    ├─ stopDevicePlayback(主卧)：SOAP Stop
  │                      │    ├─ 若 DLNA wasActive：轮询 GetTransportInfo
  │                      │    │   直到 STOPPED（≤2.5s）+ 300ms 宽限
  │                      │    └─ RPC cast → 子进程 ANNOUNCE/SETUP/RECORD
  │                      │                                        │ ③ 设备切到 AirPlay 输入
  │                      │    └─ seekSec 编进 /rest/airplay/stream/:token?timeOffset=N
  │ ◄── 200 {position} ──│
  │ POST /peers/dlna:主卧/reset       ← 客户端源端收尾
  │ ───────────────────►
  │                      │ ④ stopPlayback(清本地) + stopDevice()
  │                      │    └─ 守卫：同 host AirPlay 活跃 ⇒ 跳过 SOAP Stop
  │                      │       日志「同 host AirPlay 会话在播 → 跳过设备 Stop」
```

**关键点**：第 ④ 步如果照旧向设备发 DLNA Stop，设备会整机停止，AirPlay 立刻静音而服务端
进度继续走；用户再拖一下进度重建会话才恢复。这是 2026-10-22 现场定位的根因（§2.11）。

### B. HiVi(AirPlay) → 主卧(DLNA)

```
Client                Server(QueueController)             AirPlay 子进程        DLNA 设备(同一台)
  │ POST transfer-from {from: airplay:HiVi}
  │ ───────────────────►
  │                      │ ① 定格源进度 srcPosEarly
  │                      │ ② playFrom(dlna, startMs)
  │                      │    ├─ stopAirPlaySessionsForHost(host)
  │                      │    │   ├─ 先冻结 AirPlay 队列（防 IDLE→advance 反杀）
  │                      │    │   └─ 再 TEARDOWN 会话（子进程 RPC）
  │                      │    ├─ SetAVTransportURI（timeOffset=N）+ Play
  │                      │    └─ 基线位置初始化为 N（设备不报 RelTime 也不从 0 爬）
  │ ◄── 200 {position} ──│
  │ POST /peers/airplay:HiVi/reset    ← 源端收尾：只停 AirPlay 会话（已停，幂等）
```

**关键点**：AirPlay 的 `reset` 只会 TEARDOWN RAOP，不会向 DLNA 设备发 Stop，因此这个方向
不需要反向守卫；但仍必须「先冻队列、再停会话」，否则设备回 IDLE 会被判自然结束并重新 cast。

## 8.5 客户端行为契约

| 客户端动作 | 服务端要求 | 备注 |
|---|---|---|
| `queue/transfer-from {from, position?}` | `position` 优先用客户端本地读数（更接近真实出声点）；缺省回落到服务端读数 | 同设备流转必须在起播前定格 |
| 流转成功后 `POST /peers/<源端>/reset` | 必须安全：只清源端运行态，不得影响目标端设备 | DLNA 源端走守卫；AirPlay 源端天然只停 RAOP |
| 流转后 `seek` | 允许；AirPlay 走完整重建（新会话带新 `seekSec`），DLNA 走 `timeOffset` 重投 | 不再「先起播再 seek」 |
| `pause` / `play` | 路由到目标 peer；AirPlay 暂停只冻结 RTP 时钟，不 TEARDOWN | 恢复用 `/peers/:id/play`（不是 `/resume`） |
| 音量 / 静音 | AirPlay 音量转发同 host DLNA RenderingControl（LinkPlay 忽略 SET_PARAMETER） | 流转不改变用户音量 |
| 停止 | 目标 peer `/stop`；源端 `/reset` | 两者都不得误伤另一协议的活跃会话 |

## 8.6 预算与硬上限

| 步骤 | 上限 | 常量 / 位置 | 超时处置 |
|---|---|---|---|
| 定格源进度 | 一次读取 | `readPeerPositionSeconds` | 读不到则回落到服务端快照 |
| AirPlay 互斥让位（停 DLNA） | 6s | `DLNA_YIELD_DEADLINE_MS` | 跳过继续，仍建会话 |
| DLNA 停稳窗 | 2.5s + 300ms | `DLNA_SETTLE_MAX_MS` / `DLNA_SETTLE_GRACE_MS` | 读到 STOPPED 即提前结束 |
| 旧 AirPlay 会话收尾 | 4s | `STOP_SESSION_DEADLINE_MS`（主进程） | 跳过继续，避免拖死 cast |
| 子进程会话收尾 | 4s | `STOP_DEADLINE_MS` / `AIRPLAY_STOP_DEADLINE_MS` | `forceClose()` 强制释放 |
| RAOP 握手 | 8s | `HANDSHAKE_BUDGET_MS` | 快速失败交上层重投 |
| RAOP connect | 12s | `AIRPLAY_CONNECT_BUDGET_MS` | 快速失败，回收半开会话 |
| cast 总硬顶 | 30s | `MF_CAST_TIMEOUT_MS` | 兜底返回 null，**不得 throw** |
| DLNA 侧 Stop | 无额外等待 | `stopDevicePlayback` | SOAP 失败忽略，继续起播 |

## 8.7 失败模式速查（现象 → 根因 → 处置）

| 现象 | 根因 | 正确处置 |
|---|---|---|
| 流转后进度在走、完全没声；拖一下进度又有声 | 客户端 `reset` 源端 DLNA → SOAP Stop 连带停掉同一台设备的 AirPlay | `stopDevice` 反向守卫（§2.11，守卫 R29） |
| 起播就有进度但没声，且没有任何 `-ss` 报错 | 偏移用 `-ss` 落在 live FLAC 帧中间（残帧） | 偏移编进 `?timeOffset=N`，解码器不做 `-ss`（守卫 R28） |
| AirPlay 刚出声 1 秒就被切走 | 停 AirPlay 前没先冻结其队列 → `IDLE` 被判自然结束 → advance → 重 cast | `stopAirPlaySessionsForHost` 先冻结再 TEARDOWN |
| 流转接口卡到 30s | 互斥 / 旧会话收尾无上限，占住 per-device 串行闸 | 各步硬上限（§8.6） |
| 目标端从 0 秒开始 | 源端已被互斥停掉，落点读得太晚 | 起播前定格 `srcPosEarly` |
| 设备显示在播但无声（DLNA→AP 刚切） | SOAP Stop 返回 ≠ 固件切完输入 | 停稳窗：等 `STOPPED` + 300ms |
| 两个入口同时“在播” | 双向互斥缺失或队列未冻结 | 单一 owner + 双向互斥（§8.2-1/4） |
| 快速往返后无声 / `rpc 超时` | 旧 RAOP 连接 close 不 reject、子进程收尾挂死 | `sendRtsp` close reject + `forceClose`（§2.12，守卫 R30） |
| 流转后音量变了 | 把 AirPlay 音量写死 / 未转发 DLNA | 用户音量持久化 + 同 host DLNA 转发（§2.10） |

## 8.8 队列与播放模式语义

- **冻结（freeze）**：流转让位时使用——保留队列内容、清 `isActive`/tracker 的 prev 状态，之后可原地续播。
- **清空（clear/reset）**：客户端源端收尾使用——清 items / 游标 / 洗牌序列 / 设备端 currentMedia；`playMode` 保留。
- **播放模式随队列流转**：`order/one/all/shuffle` 搬到目标端；目标端按自己的 shuffle 序重建，不复制源端随机序列。
- **单曲/多曲一致**：流转只搬 `currentIndex` + 落点；后续自动续播由目标端队列负责。
- **同一首歌重复流转**：`createAirPlaySession` 对同 `(song, device)` 复用 token，避免 token 泄漏。

## 8.9 验收矩阵（不依赖人耳的判据）

判据统一用设备 `getPlayerStatus`：健康 = `status=play` 且 `curpos` 递增；无声 =
`status=stop/curpos=0`（即使服务端 `/status` 报 PLAYING）。

| # | 场景 | 操作 | 期望 |
|---|---|---|---|
| 1 | DLNA→AP 普通流转 | 主卧播放 10s → transfer 到 HiVi | 设备 `play`、`curpos` 从落点递增；日志 `DLNA 已停稳` |
| 2 | DLNA→AP + 源端 reset | 同上，成功后立即 `reset` 主卧 | 设备保持 `play`；日志 `跳过设备 Stop(防误杀 AirPlay 输出)` |
| 3 | AP→DL 流转 | HiVi 播放 → transfer 到主卧 | 设备 `play`；DLNA 拉 `?timeOffset=N`；AirPlay `STOPPED` 不再反抢 |
| 4 | 快速往返 | AP→DL→AP（间隔 ≤5s） | 两端不互杀；最终设备 `play`、`curpos` 递增 |
| 5 | 流转后 seek | 场景 2 后 seek 60 | 新会话 `pos=60` 继续；设备 `play` |
| 6 | 流转后暂停/恢复 | pause → `/play` | `PAUSED_PLAYBACK` → `PLAYING`；设备 `play` |
| 7 | 客户端直投（无 DLNA） | 客户端 → HiVi 起播 | 设备 `play`；互斥让位耗时 ≈0（未等停稳窗） |
| 8 | 多曲自动续播 | 两首以上队列流转 | 当前曲放完自动下一首，落点/模式不丢 |

**关键日志锚点**：`双协议互斥`、`DLNA 已停稳`、`跳过设备 Stop(防误杀 AirPlay 输出)`、
`AirPlay 起播分段耗时`、`RTSP RECORD`、`stream done (… reanchors/loss)`。

## 8.10 240 真机验收记录

| 日期 | 场景 | 结果 |
|---|---|---|
| 2026-10-21 | 主卧(DLNA)→HiVi(AirPlay)，源进度 12.6s | 目标 13.0s 起播并前进；队列 295 首 / idx 33 保持；DLNA 被冻结 |
| 2026-10-21 | HiVi→主卧，源进度 16.95s | 设备拉 `?timeOffset=17`，17.0→25.9s；AirPlay `STOPPED` 不反抢 |
| 2026-10-22 | DL→AP + 客户端 reset 源端 | 修复前设备 `stop`（服务端 PLAYING）；修复后 `play` 且 `curpos` 递增 |
| 2026-10-22 | fork 默认下的全量回归 | 起播/seek/暂停恢复/音量/停止/流转/快速往返全部通过；无 `rpc 超时` |
| 2026-10-22 | 前端负载隔离 | 24 并发请求 ×15s：`chunks` 增量 2381（125.3/s），`reanchors/maxGap/loss` 增量 0 |

## 8.11 代码坐标与守卫

| 环节 | 文件 / 函数 |
|---|---|
| 流转入口 | `backend/src/routes/api/peers.ts` → `queue/transfer-from`、`/reset`、`/stop` |
| 同设备判定 | `peers.ts::isSamePhysicalDevice`（host 比对） |
| AirPlay 起播互斥 + 停稳窗 | `airplay/control.ts::yieldSiblingDlnaForAirPlay` |
| AirPlay 反向互斥 | `airplay/control.ts::stopAirPlaySessionsForHost` |
| 反向收尾守卫 | `airplay/control.ts::hasActiveAirPlaySessionForHost` + `dlna/control.ts::stopDevice` |
| 起播落位 | `airplay/control.ts::withPlaybackOffset` + `sessionRuntime.ts::withOffset` |
| 互斥让位（必须无守卫） | `dlna/control.ts::stopDevicePlayback` |
| 轻量停稳读取 | `dlna/control.ts::getTransportState` |
| 子进程 RPC 健壮性 | `airplay/raop.ts::sendRtsp/forceClose`、`sessionRuntime.ts::stopPlayerBounded` |

| 守卫 | 覆盖 |
|---|---|
| R25 | 同设备双协议流转：识别 / 落点定格 / 起播即落位 / 冻结后再停 / 单会话 |
| R28 | 偏移走服务端回环流 + DLNA 停稳窗 |
| R29 | DLNA Stop 不得误杀同 host AirPlay 输出 |
| R30 | 默认独立子进程 + RPC 不挂死 |

```bash
cd backend
node scripts/check-airplay-playback-chain.mjs
node scripts/check-airplay-dlna-mutex.mjs
npx vitest run tests/airplay tests/dlna/controlTransportGuards.test.ts tests/services/airplaySessionRuntime.test.ts
```

---

# 附录 A：日志锚点速查

| 场景 | 关键字 |
|---|---|
| 起播分段 | `AirPlay 起播分段耗时` |
| 握手各步 | `RTSP ANNOUNCE` / `RTSP SETUP` / `RTSP RECORD` |
| 互斥 | `双协议互斥` / `互斥:开始` |
| 设备闸 | `[AirPlay][gate] <id> 排队 <ms>ms 后开始` |
| 超时 | `RTSP <method> timeout` / `cast 挂死` |
| 音量 | `SET_PARAMETER volume=` / `forwarded to DLNA device` |
| 会话结束 | `sessionEnded` / `IDLE pos=` |

# 附录 B：环境变量与端点

| 项 | 值 |
|---|---|
| `MF_CAST_TIMEOUT_MS` | cast 硬顶（默认 30000） |
| `AIRPLAY_CONNECT_BUDGET_MS` | connect 总预算（默认 12000） |
| `MUSICFLOW_AIRPLAY_FORK` | `1` 显式启用子进程模式（**默认已启用**） |
| `MUSICFLOW_AIRPLAY_INPROC` | `1` 强制主进程内装配（排障回落） |
| `AIRPLAY_STOP_DEADLINE_MS` | 子进程单会话收尾硬上限（默认 4000） |
| 取流 | `/rest/airplay/stream/:token` |
| 设备表 | `airplay_devices`（DB） |
| 会话凭证 | `airplay_stream_tokens`（DB，TTL 30min） |

# 附录 C：本文覆盖的版本变更

| 版本 | 变更 |
|---|---|
| 4.6.52 | 流转接续三层根因修复：起播即落位 / cast 超时不杀进程 / 全链路硬预算 |
| 4.6.53 | 互斥硬上限移入助手内部（修复 R2 守卫计数） |
| 4.6.66 | 流转/seek 落位改走服务端 `?timeOffset=N`（解码器不再对 live FLAC 做 `-ss`，守卫 R28） |
| 4.6.67 | DLNA 停稳窗 + `stopDevice` 反向守卫（流转后 reset 源端不再误杀 AirPlay 输出，守卫 R29；§2.11） |
| 4.6.70 | AirPlay 默认独立子进程（与 sendspin 对齐）：RTSP close reject / 收尾 4s 硬顶 / 追赶让出事件循环 / fork 偏移对齐，守卫 R30（§1.2、§2.12） |
