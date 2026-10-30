# AirPlay（RAOP）权威方案与验收文档

## 文档关系（先读这一块）

> **本文件的角色**：**权威现状**。AirPlay/RAOP 与桥接环的**唯一事实来源** —— 桥的 28B 帧格式、锚点公式（`firstFrameTsUs + anchorShiftUs`）、投递窗口/水位、`stats` 判据、AirPlay 侧守卫全在这里。

**5 份相关文档（都在 `docs/`，链接可直接点开）**

| 文档 | 角色 | 一句话用途 |
|---|---|---|
| [airplay-权威方案文档.md](./airplay-权威方案文档.md) | 权威现状 | AirPlay/RAOP 协议正确做法、airplay 子进程、桥接环（帧格式/锚点/stats）与 AirPlay 侧守卫 |
| [sendspin-权威方案文档.md](./sendspin-权威方案文档.md) | 权威现状 | Sendspin 协议链路、FLAC 链路、ESPHome 设备端配置、多房间组与组泵 |
| [group-权威方案文档.md](./group-权威方案文档.md) | 权威现状 | 群组数据模型与生命周期、选歌硬约束、出流双路、组成员、延迟补偿 |
| [AirPlay1-2与Sendspin桥接-最终实施方案.md](./AirPlay1-2与Sendspin桥接-最终实施方案.md) | **历史方案（Phase 计划）** | 桥接的开发执行版：Phase 0~8 分阶段实施、接口、守卫矩阵、逐轮审计修正索引 |
| [AirPlay1-2与Sendspin桥接落地方案.md](./AirPlay1-2与Sendspin桥接落地方案.md) | **历史方案** | 桥接的调研与落地方案：MA 精要、MusicFlow 现状盘点、Phase 拆解、230 模拟验收 |

**硬口径**：**历史方案文档不再作为事实来源；任何冲突以三份权威文档为准。** 历史方案文档只保留「为什么这样设计」与「当时踩了什么坑 / 推翻了什么」两类价值 —— 其中的 Phase 条目、行号、字段名一律可能过期。

**三份权威文档的分工边界（排障时先按这张表定位文档）**

| 问题域 | 归属文档 |
|---|---|
| 协议（RTSP / RAOP / AP2 报文、Sendspin 帧与握手配对）、airplay 子进程模型、桥接环（28B 帧 / 锚点公式 / `stats` 判据） | [airplay-权威方案文档.md](./airplay-权威方案文档.md) |
| 设备协议（Sendspin 连接 / 编码协商 / 预填充水位 / pacing / 音量）与组泵（`SendspinGroup.pushFrame`、`pcm:100` 编码组、晚加入回填） | [sendspin-权威方案文档.md](./sendspin-权威方案文档.md) |
| 组成员与命名空间、生命周期状态机、选歌推进硬约束、出流双路（组泵 / AirPlay 桥）、延迟补偿、组验收判据与失败速查 | [group-权威方案文档.md](./group-权威方案文档.md) |

---

> **基线**：MusicFlow **v4.6.77** · 后端 `backend/src/services/airplay/*`（实测 21 个 `.ts`） · 230 测试床 shairport-sync（AP1/AP2）· 真机 HiVi H5MKII / MUZO / WR320
> **文档来历**：合并此前分散在 `PLAYBACK_SEEK_MA_REWORK.md`、`archive/MusicFlow-AirPlay2(E2~E5)课题立项与实施计划-2026-10-20.md`、`CHANGELOG` 4.6.5x 条目、230 真机排障记录与 `check-airplay-playback-chain.mjs` 守卫注释，并以 **2026-10-20 / 2026-10-21 / 2026-10-22 三轮 HiVi 真机实测** 的最新结论为准。
> **怎么读**：**第一～五部分是正确做法，照做即可**；**第六部分是踩过的坑（含被推翻的旧结论），务必别重蹈**；第七部分是回归守卫清单（7 个脚本 / 273 个 `check()` 调用点(其中 1 处是 8 次展开的模板)，运行时 280 条断言）；**第八部分是 DLNA + AirPlay 合一设备的流转权威方案**（同设备双身份、双向时序、失败表、验收矩阵）；
> **第九部分是实现级代码地图**（21 个文件逐个 + 行为→代码反查表，排障从这里开始）；**第十部分是桥接环的时间基准**（`tsUs` 唯一口径、窗口/水位/锚点/stats 判据）；**第十一部分是群组 A/V 延迟补偿 R31**（v4.8.0 起按成员一格、±30s；AirPlay 侧改完要重建/自愈该成员桥，细节唯一出处 group 权威文档 §6）。
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

HiVi H5MKII 同时以 `airplay:00226C••••••`（HiVi）与 `dlna:FF31••••-…`（别名「主卧」）出现 —— 同一台设备两个身份。流转必须按「同一物理设备换协议」处理，五条判据（**完整方案见 §8**）：

| # | 判据 | 违反后的真机表现 |
|---|---|---|
| 1 | **同设备识别**：AirPlay host == DLNA renderer `location` 的 hostname（与双协议互斥同一套映射） | 流转被当成两台设备，双会话抢同一台机器 |
| 2 | **落点定格**：源端进度必须在**任何起播动作之前**读取（互斥会立刻停源端） | 落点恒 0 |
| 3 | **起播即落位**：DLNA 把 `startMs` 编进 `timeOffset` 并初始化位置基线；AirPlay 走 `playMedia(startMs)` 的 `seekSec` | 进度条从 0 重爬 |
| 4 | **反向互斥对称**：停 AirPlay 会话前先冻结它的队列 | 设备回 IDLE 被判「放完」→ advance → 反杀新建的 DLNA 会话 |
| 5 | **源端收尾不得碰设备**：`stopDevice` 用 `hasActiveAirPlaySessionForHost` 守卫，只清本地队列（详见 §2.11） | 客户端 reset 源端时连带停掉 AirPlay 输出 |

守卫：**R25**（同设备识别 / 落点定格 / timeOffset / 基线偏移 / 冻结后再停 / 单会话）、**R28**（偏移走服务端回环流 + 停稳窗）、**R29**（反向收尾守卫）。真机记录见 §8.10。

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

# 第七部分：回归守卫（7 个脚本 / 273 个 `check()` 调用点(其中 1 处是 8 次展开的模板) ⇒ 运行时 280 条断言）

七个零依赖 node 脚本,全部挂 `.github/workflows/ci.yml`。**它们钉的不是风格,是
已经付过真机代价的静默故障** —— 每条断言都做过「最小违规反证」,删掉即回归对应 bug。

| 脚本 | 条数 | 钉的面 | 失败时的现场表现 |
|---|---|---|---|
| `check-airplay-stream-auth.mjs` | 19 | 取流鉴权豁免面 / token 自校验 | 裸拉曲目、或新取流端 401/无限流 |
| `check-airplay-dlna-mutex.mjs` | 10 | 同 host 双协议互斥单一助手 | 「有进度没声音」 |
| `check-airplay-decode-af.mjs` | 20 | 解码 `-af` 只留协议输出段 | 动态被二次压缩 / 设备无声 |
| `check-airplay-playback-chain.mjs` | 139 | R1~R30 全链路契约 | 卡 PLAYING、误切歌、流转失败、RPC 挂死 |
| `check-airplay-rtsp-line.mjs` | 6 | RTSP 请求行三段 | 部分接收端 `400` |
| `check-airplay-ap2-discovery.mjs` | 17 | AP1 造表 / AP2 只打能力 | 死设备、HAP 配对全挂 |
| `check-airplay-bridge.mjs` | 62 | 桥接环 17 组不变量 | 慢 3.7s / underrun / 切歌无声 / Lost sync |

> **条数口径**:上表 = 脚本里 `check(...)` 的**调用点数**(静态可数,`grep -c '^\s*check('` 再扣掉模板)。
> `check-airplay-bridge.mjs` 有 1 处 `check()` 写在 `uniq()` 模板体内、被调用 8 次 ⇒ 该脚本**运行时**
> 执行 **69** 条断言(61 固定 + 8 动态);七个脚本合计 **62+19+10+20+139+6+17 = 273** 个调用点(含该模板) ⇒
> **运行时 272 + 8 = 280** 条。三者对不上时**以脚本实测为准**(`grep -c '^\s*check('` + `grep -c 'console.log("====='`)。

```bash
cd backend
for f in scripts/check-airplay-*.mjs; do echo "== $f"; node "$f" || exit 1; done
```

配套单测(与静态守卫互补,行为锁不能只靠正则):

```bash
npx vitest run tests/airplay tests/services/airplayProtocolPlayer.test.ts tests/player/castTimeoutGuard.test.ts
# 反向收尾守卫(R29)
npx vitest run tests/dlna/controlTransportGuards.test.ts tests/airplay/mutex.test.ts
# 独立子进程 RPC 健壮性(R30)
npx vitest run tests/airplay/raopTransport.test.ts tests/services/airplaySessionRuntime.test.ts
# 群组 A/V 延迟补偿(R31)
npx vitest run tests/group/delayCalib.test.ts tests/routes/apiGroupDelays.test.ts
# 桥会话音量路由(native 未命中回落桥会话表;缺陷 D-1)
npx vitest run tests/airplay/bridgeVolumeRouting.test.ts
```

## 7.1 `check-airplay-stream-auth.mjs`(19 条)

**钉什么**:AirPlay 独立取流命名空间 `/rest/airplay/stream/:token` 的**鉴权豁免面**只能有
三条取流端(`/rest/dlna/stream/`、`/rest/membuf/`、`/rest/airplay/stream/`),判定只有一处实现
(`middleware/restExempt.ts::isRestAuthExemptPath`),豁免之外的 `/rest/*` 一律走 `authMiddleware`;
AirPlay handler 必须**自己校验 token**(`resolveAirPlaySession`,`403` 拒绝);出流复用公共核心
`serveCastStream(kind:"airplay")`,不复制出流逻辑;慢请求预算表与探针避让闸都要认出这条新前缀。

**删掉会回归什么**:放开豁免面 = 任何人可裸拉任意曲目(鉴权旁路);漏认 AirPlay 前缀 =
慢请求预算/探针避让对 AirPlay 出流失效(直播类卡顿排查失真);抄一份出流逻辑 = 两条链的
兼容头/DSP/统计口径立刻分叉。

| 行号 | 钉住的不变量 |
|---|---|
| **44** | **R1 豁免清单单一真源(middleware/restExempt.ts)** |
| 49 | 清单恰好是三条取流端且逐字一致(新增/改名必须同步改守卫与本行) |
| 54 | 单源导出 isRestAuthExemptPath(判定只能有一处实现) |
| 58 | 判定基于 includes(与既有 dlna/membuf 同一口径,不引入语义分叉) |
| **63** | **R2 index.ts 的 `/rest/*` 门禁接线** |
| 68 | 能定位到 `/rest/*` 门禁块 |
| 70 | 门禁走单一真源判定 isRestAuthExemptPath(c.req.path) |
| 75 | 门禁仍以 authMiddleware 兜底(豁免之外一律鉴权) |
| 80 | **常量断言**:旧的内联判定(裸 includes('/dlna/stream/'))已彻底移除,不得两套并存 |
| 85 | 第二道独立门禁仍在:/rest/api/* 之上另挂 authMiddleware(豁免放松不透穿到 API 面) |
| **90** | **R3 AirPlay 取流 handler 的自校验(token 即凭证)** |
| 95 | 能定位到 /airplay/stream/:token handler |
| 97 | handler 校验自己的 token(resolveAirPlaySession) |
| 102 | token 无效/过期必须拒绝(403),不得静默出流 |
| 107 | 出流复用共用核心 serveCastStream(kind: "airplay")(不复制出流逻辑) |
| 116 | 对照实现 DLNA 端仍是「自校验 + 403」 |
| **120** | **R4 出流族两处分类必须同步认 AirPlay** |
| 123 | 慢请求预算表含 GET /rest/airplay/stream/:token → SLOW_MS_STREAM(与 DLNA 同级) |
| 127 | 探针避让闸 isStreamRequest 认 /rest/airplay/stream/ 前缀 |
| 131 | 对照:DLNA 档仍在(防止改坏对照实现) |
| 137 | 无泛化误判:isStreamRequest 未出现 startsWith("/rest/") 这类整面放行 |
| **141** | **R5 用例在册(行为锁不能只靠静态断言)** |
| 144 | restExempt 行为单测在册(穷举放行/拒绝两面) |
| 149 | metrics 用例已覆盖 AirPlay 出流端(预算 + 避让闸) |

## 7.2 `check-airplay-dlna-mutex.mjs`(10 条)

**钉什么**:同 host 双协议互斥只有**一个助手** `yieldSiblingDlnaForAirPlay`,
助手内顺序固定为「先冻结 DLNA 队列(`getQueueController().stopPlayback`)→ 再 SOAP Stop
(`stopDevicePlayback`)」,且助手之外**不得出现裸 `stopDevicePlayback`**;in-proc(`startSession`)
与 fork(`castViaChild`)两个起播入口各调一次;反向互斥 `dlna/control.ts::castToDevice` 必须调
`stopAirPlaySessionsForHost`(动态 import 防循环依赖)。

**删掉会回归什么**:顺序颠倒 = GENA 异步回投把刚起播的队列反杀(「有进度没声音」);助手外
裸停 = 绕过冻结,DLNA 队列自动续播顶掉 AirPlay;漏一个入口 = fork/in-proc 行为分叉(排障
时换模式就复现)。

| 行号 | 钉住的不变量 |
|---|---|
| **48** | **R1 单一助手:同 host DLNA 互斥只能有一处实现** |
| 52 | 存在统一助手 yieldSiblingDlnaForAirPlay |
| 54 | 助手内冻结同 host DLNA 队列(getQueueController().stopPlayback) |
| 59 | 助手内下发 SOAP Stop(stopDevicePlayback) |
| 66 | 助手内顺序:先冻结队列,再 SOAP Stop(GENA 事件异步回投,冻结必须抢在前面) |
| 71 | 助手经动态 import 取 QueueController(避免 airplay↔player↔dlna 静态循环依赖) |
| **76** | **R2 两个起播入口都必须经过该助手** |
| 78 | startSession(in-proc)与 castViaChild(fork)各调用一次(共 2 处) |
| **83** | **R3 常量断言:起播路径不得再出现「只停 SOAP、不冻队列」的裸实现** |
| 87 | **常量断言**:助手之外无裸 stopDevicePlayback 调用(互斥只能走单一助手) |
| **92** | **R4 反向互斥(DLNA 起播 → 停同 host AirPlay 会话)仍在** |
| 95 | 能定位到 dlna/control.ts 的 castToDevice |
| 97 | castToDevice 仍调用 stopAirPlaySessionsForHost(动态 import 避免循环依赖) |
| **103** | **R5 反向互斥的实现仍在 airplay/control.ts** |
| 105 | 仍导出 stopAirPlaySessionsForHost(返回被停会话 id 列表) |

## 7.3 `check-airplay-decode-af.mjs`(20 条)

**钉什么**:解码侧 `-af` **只保留协议输出段**(44100Hz / 16bit / stereo 恒 pin),链中
**不得**出现 `loudnorm` / `alimiter` / `volume=` —— 响度归一由出流侧公共链路
(`resolveRequestAf → resolveLoudnessAf`)承担**唯一一遍**;`buildAirplayAf` 必须仍被
`spawnDecoder` 使用(不是死函数);两条会话路径(in-proc `control.ts` / fork `sessionRuntime.ts`)
共用同一解码器。

**删掉会回归什么**:解码侧再归一 = 同一段音频被压两遍,听感动态被二次压缩(静默故障,不报错);
输出段被一起删 = 设备按非 44.1k/16bit 收流直接无声;`buildAirplayAf` 变死函数 = 归一悄悄回到
解码侧而无人察觉。

| 行号 | 钉住的不变量 |
|---|---|
| **47** | **R1 解码侧不得引用响度归一(也不得再依赖 pipeline.airplay 开关)** |
| 49 | decoder.ts 不再引用 resolveLoudnessAf(归一改由出流侧公共链路承担) |
| 54 | decoder.ts 不再依赖 pipelineSwitches(解码侧与开关脱钩,开关只在出流侧生效) |
| 59 | decoder.ts 从 pipeline 只取 decodeArgs / outputFilters / isLoopbackUrl |
| **64** | **R2 输出段必须仍在,且 44.1k/16bit/stereo 参数锁定(RAOP 硬性要求)** |
| 65 | buildAirplayAf 仍走 outputFilters() |
| 66 | 采样率恒 pin SAMPLE_RATE(targetRate) |
| 67 | 位深恒 pin 16bit(targetBits) |
| 68 | 过渡期强采样率 forceRate 仍在 |
| 70 | hasLoudnorm 恒 false(链中确无响度段) |
| **72** | **R3 常量断言:解码侧不得再出现旧链三件套(loudnorm / alimiter / volume=)** |
| 73 | 剥注释后全文无 loudnorm |
| 74 | 剥注释后全文无 alimiter |
| 75 | 剥注释后全文无 volume= 增益段 |
| 76 | buildAirplayAf 仍被 spawnDecoder 使用(不是留了个没人调的死函数) |
| **78** | **R4 反向断言:归一与音色 DSP 必须仍在出流侧公共链路做一遍** |
| 79 | resolveRequestAf 仍调 resolveLoudnessAf(唯一的一遍归一) |
| 80 | resolveRequestAf 仍调 playerDspFilters(音色链未丢) |
| **87** | **R5 单一实现:buildAirplayAf 不得在别处被复制一份** |
| 89 | buildAirplayAf 的函数声明只出现在 decoder.ts |
| 95 | 两条会话路径共用同一解码器(control.ts / sessionRuntime.ts 均从 ./decoder.js 引入) |

## 7.4 `check-airplay-playback-chain.mjs`(139 条,R1~R30)

主守卫。**R 编号是契约编号,任何文档/PR 引用都不得重排或复用**(改规则只能新增 Rn 或
在原编号下改文案)。R1~R9 = 状态上报/契约面;R10~R18 = 传输面;R19~R21 = 插件/请求行/音量;
R22~R24 = 取流 token / 重启恢复 / 音量写入口径;**R25~R30 = 同设备双协议流转、慢源熔断、
flow 解析、回环偏移、DLNA Stop 反向守卫、独立子进程** —— 这一段是「有进度没声音」类事故的
固化防线,删一条就是把一个已经付过真机代价的 bug 重新放回来。

下表按 R 编号归并同行断言（**行号全部保留**，脚本 `backend/scripts/check-airplay-playback-chain.mjs` 是终裁；行号漂移时以 Rn + 断言文字为准）：

| 行号 | 钉住的不变量 |
|---|---|
| `57`·`59`·`66`·`71`·`76` | **R1 单一 PLAYING 上报出口，且 in-proc / fork 两入口都调用**：存在统一助手 `reportAirPlayPlaying`（会话建立即上报）；常量断言「出现且仅出现 3 次」（定义 1 + 两入口各 1）；`runStream` 与 `castViaChild` 都必须调它 |
| `81`·`86`·`88`·`93` | **R2 PLAYING 载荷必须带 `mediaUri`**（否则「uri 变 = 换歌」判据恒不可达）：能定位函数体；载荷 `playbackState = PlaybackState.PLAYING`、`mediaUri = 取流地址`（不得省略） |
| `98`·`103`·`110` | **R3 上报时点必须晚于「会话已就绪」**，不能挂在起播前的占位态上：`runStream` 在 `active.streamPromise = p;` **之后**；`castViaChild` 在 `lastCast.set(opts.deviceId` **之后** |
| `116`·`118`·`125`·`127`·`134`·`142` | **R4 IDLE 出口唯一 + 必须带真实落点（不得写死 0）**：`reportAirPlayIdle` 接收 `positionSec/durationSec`；载荷用 `Math.max(0, positionSec)`；常量断言「IDLE 载荷不得出现写死的 `position: 0,`」；`control.ts` 的 `reportState` 调用点恰为 2 |
| `147`·`149`·`155`·`165`·`176`·`181` | **R5 过期会话抑制：被取代的旧会话不得上报 IDLE**（切歌通路）：`handleAirplaySessionEnded` 收第 4 参 `endInfo`；`endInfo.current === false` 时**不上报**（else 支才调 `reportAirPlayIdle`）；in-proc finalizer 的 `stillCurrent` 判定**先于** `sessions.delete`，且 `endInfo` 带 `current: stillCurrent` |
| `187`·`189`·`197`·`205`·`210`·`217`·`223`·`230`·`235` | **R6 子进程（fork）侧同口径：事件带落点与 `current`**：`sessionRuntime` 导出 `AirplaySessionEndInfo(current/positionSec/durationSec)`、`hooks.onSessionEnded` 传 info 对象（不再是裸 stderr 字符串）、finalizer 同样「先判 `stillCurrent` 再删」；`ipcProtocol`/`childMain` 透传三字段；`supervisor` 原样交主进程、hook 类型用 `AirplaySessionEndInfo` |
| `240`·`244`·`246`·`253`·`260` | **R7 `pollState` 契约与 DLNA 对齐：PLAYING 必须带 `mediaUri`（且不得删其余字段）**：`getAirPlayMediaUri(deviceId)` 与 `playMedia` 同源；**反向断言**：`playbackState`/`position`/`duration` 不得为加 `mediaUri` 而删 |
| `266`·`280`·`285`·`291`·`297`·`303`·`308`·`314`·`319` | **R8 取流契约：解码器吃「本机回环的完整管道」，且不得静默重连**：`toLoopbackAirPlayStreamUrl` 只改 origin（路径仍是 `/rest/airplay/stream/`）；in-proc 起播与原地 seek 重建都用重编 `timeOffset` 的 `feedUrl`；**反向断言**：`control.ts` 不得再用 `resolvePipelineInput` 包装 AirPlay 出流地址；fork 路径的 `streamUrl` 同样必须是回环管道；解码器显式 `reconnect: false`，但**反向断言**该开关缺省仍为 `true`（其它链路零变化） |
| `324`·`326`·`331`·`336` | **R9 解码器回收必须 SIGKILL**（SIGTERM 对卡在重连/阻塞写的 ffmpeg 无效）：`decoder.ts` 导出 `killDecoder` 且实现为 SIGKILL；常量断言「airplay 两个模块的 kill 调用一律走 `killDecoder`」；`control`/`sessionRuntime` 都从 decoder 模块引入 |
| `342`·`349`·`354`·`359`·`364` | **R10 上游超时只约束「建连+响应头」，不得挂到 body**（否则长流每 15s 被掐断）：`fetchHeadersWithTimeout` 拿到响应头即解绑；**反向断言**不得再把 `AbortSignal.timeout` 交给 `fetch` 挂全程；两个入口（`openUpstream`/`passthrough`）都走它 |
| `370`·`376`·`381`·`386`·`391`·`396`·`401` | **R11 设备级串行闸：「流转 + 拖动」并发不得交错建 RTSP 会话**：`withDeviceGate`（per-device promise 链）必须可重入（`AsyncLocalStorage` 记录已持有设备）；常量断言「六个会话入口都走闸」（cast/seek/stop/pause/resume/stopAirPlaySession）；**反向断言**闸内实现（`castUnlocked`/`seekUnlocked`）不得再调公开入口（防自锁） |
| `408`·`416`·`421`·`426`·`431`·`436` | **R12 SYNC 包 NTP 锚点必须锚「推流墙钟」，不得把内容偏移（seek）当成未来时间**：`RaopPlayer` 持 `startNtp`；RECORD 记 `ntp0 → startNtp`；`stream()` 起播（含 seek 重建）重锚 `startNtp = ntpNow()`；`sendSync: ntp = startNtp + ts2ntp(headTs − startTs)`；**反向断言**不得再用 `ts2ntp(this.headTs)` |
| `442`·`446`·`451`·`456`·`461` | **R13 seek 语义：默认完整重建 + seq 连续**：`prepareSeek` 不得随机重置 `seq`（接收端会判丢包/持续 NACK）；`setStartPosition` 只重锚时间线不发 FLUSH；默认完整重建（`AIRPLAY_SEEK_INPLACE=1` 才走原地实验路径），重建起播按 seek 目标重锚 RTP 时间线 |
| `467`·`471`·`476`·`481` | **R14 stop/reset 容错：离线设备也必须停得掉、清得掉**：cast 端 stop 统一 best-effort（transport 抛错不回 500，但 `stopPlayback` 必落）；**反向断言** reset 不得在 catch 里直接回 500 跳过 clear |
| `487`·`491`·`496`·`501`·`506` | **R15 AirPlay 状态词表归一**（与 dlna/sendspin/local 对齐）：出口把 `PAUSED → PAUSED_PLAYBACK`、`IDLE → STOPPED`；归一必须是拷贝（不得改写共享状态对象）；group 状态同样归一 |
| `513`·`517`·`522`·`528` | **R16 mDNS 无 A 记录时不得把 `.local` 当可路由 host**：维护 hostname → IPv4 旁路表；无可路由地址时不登记；**反向断言**不得再 `|| svc.host ||` 兜底 |
| `534`·`539`·`544` | **R17 陈旧 GENA 不得覆盖 SOAP**：status 路由对 GENA state 有新鲜度闸（15s）；`castToDevice` 成功后同步事件缓存 PLAYING |
| `550`·`557`·`563`·`568`·`575`·`581`·`587`·`593`·`598`·`605`·`611`·`616` | **R18 流转接续：起播即落位 + 建会话硬预算**（HiVi 真机 2026-10-21）：cast 超时兜底回调**不得 throw**（定时器里抛错 = 未捕获异常 = 进程退出）、超时后 best-effort 回收设备侧半开会话；`playFrom`/`playCurrent` 透传 `startPositionMs`、`UniversalPlayer` 透传 `startMs`、AirPlay 的 `seekSec` 由 `startMs` 派生、transfer 到 AirPlay 把源进度交给本次 cast 且**不再补 seek**；RAOP 握手/connect 有总预算（单步等待按剩余预算收缩，清理类 RTSP 用短超时）；互斥收尾有硬上限 |
| `625`·`629`·`634`·`639`·`647`·`654` | **R19 插件默认开启 + 启停零残留**（2026-10-21 用户拍板）：manifest `defaultEnabled` 必须 `true`、文案不得再称「默认关闭」；停用必须回收设备/会话/discovery；默认开启 ≠ 不可手动关闭，且有「关→停在播会话 / 开→起监听」回归用例 |
| `662`·`669` | **R20 RTSP 请求行必须带 `RTSP/1.0`**（缺了标准接收端直接 400）：两处请求行都带 |
| `675`·`679`·`685`·`690`·`697`·`703` | **R21 音量链路：0-100 → dB、同 host DLNA 转发、静音独立**：0 → −144（静音）、100 → 0dB；LinkPlay（HiVi/MUZO）必须转发同 host 的 DLNA RenderingControl；静音与音量独立（取消静音恢复原音量，不把 volume 归零）；音量/静音必须落库并用持久值播种（不得写死缺省） |
| `711`·`715`·`720` | **R22 取流会话：独立 token 命名空间 + 同 (song,device) 复用**：走 `/rest/airplay/stream/`；未过期时复用 token（否则 uri 变会误判换歌） |
| `727`·`731`·`738` | **R23 起播/重启恢复不得绕开统一起播路径**：`resumeActive` 仍走 `playCurrent`；设备闸排队必须可观测（排队耗时日志） |
| `744`·`752`·`757`·`762`·`767` | **R24 音量/静音写入口径统一 + 永久观测日志**：音量/静音写入各有永久日志（UA/peer/值）；不得按来源或启动窗口丢弃请求（用户否决的兜底做法）；body 只在写入口解析一次（五个 kind 分支不得各自解析） |
| `773`·`779`·`784`·`790`·`796`·`802`·`807`·`812` | **R25 同设备双协议流转（AirPlay ↔ DLNA）**：识别同一 host 双身份（AirPlay host == DLNA location host）；起点在任何起播/互斥动作**之前**定格（`srcPosEarly`）；DLNA `playMedia` 把 `startMs` 编进 `timeOffset`、基线带 `timeOffset`（进度不归零）；起播前**先冻结同 host AirPlay 队列再停会话**（防 IDLE→advance 反杀）；flow 会话把下游取消接到 `session.abort()`；新 flow 会话接管旧会话 |
| `818`·`823`·`830` | **R26 慢源熔断**：DLNA 阶段2 窗口 25s（其余 5s）；跨曲连续卡死 3 首即停队列 |
| `838`·`846`·`853`·`858`·`863`·`870`·`876`·`885`·`890`·`899`·`907` | **R27 flow 起播不得被整队预解析阻塞 + 大文件直通 + 负缓存失效**：只同步解析首曲（禁止起播前整队解析）、上一首播放期间预解析下一首、预热前 3 首（并行、不阻塞首字节）、连续流实时节流；解析失败跳过时先把上一曲 carry 吐出去；大文件直通默认关（DLNA 插件开关 + DLNA 链路同时满足才生效）；复用预取判官（preview/not-audio 判死 + 负缓存，too-small 装不下期望时长 ⇒ too-small-hard 判死(v4.8.3),装得下只回退直通）；too-small 不立即判死（先换源再重试一次、不写负缓存）；整曲字节完整后失效负缓存（预取 + 播放两条链路） |
| `914`·`919`·`926`·`931`·`938`·`946` | **R28 流转/seek 落位走服务端回环流，不在 live FLAC 上 `-ss`**：起播偏移编进 feed URL（`timeOffset`）；原地 seek 同样重编 `feedUrl`；AirPlay + web 源 seek 先整曲缓冲（服务端 `-ss` 落在可定位 membuf）；同设备 DLNA→AirPlay 等 DLNA 报 STOPPED + 宽限后再建会话；DLNA 侧提供轻量 `GetTransportInfo`（不得用 full status 轮询） |
| `953`·`958`·`964`·`970`·`980`·`985`·`990` | **R29 DLNA Stop 不得误杀同 host AirPlay 输出**（流转后 reset 源端）：`hasActiveAirPlaySessionForHost` 判定；`stopDevice` 在 AirPlay 会话活跃时跳过**硬停**（只做本地收尾）；常量断言「硬停分支必须在守卫之后」（不得先发 Stop 再判）；守卫 host 取 `avTransportUrl`（不得用可能缺失的 location）；常量断言「SOAP Stop 调用点恰为 4 处」；`stopDevicePlayback` 保持无守卫（AirPlay 起播前必须仍能硬停 DLNA） |
| `1002`·`1008`·`1013`·`1019`·`1024`·`1031`·`1037` | **R30 AirPlay 独立子进程：默认 fork + RPC 不得被收尾挂死**：`defaultFork: true`；RTSP 等待响应期间连接关闭必须 reject；`RaopPlayer.forceClose` 强制释放；子进程收尾硬上限（`STOP_DEADLINE_MS` + `stopPlayerBounded`）；子进程 cast/seek 与 in-proc 同口径（偏移编进服务端流、解码器不做 `-ss`）；推流追赶每 16 包 `setImmediate` 让出事件循环 |

## 7.5 `check-airplay-rtsp-line.mjs`(6 条)

**钉什么**:``${this.url} RTSP/1.0`` 全仓**恰好 2 处**(`sendRtsp` + `sendRtspNoWait`),
不存在缺版本段的请求行模板;`raopTransport.test.ts` 必须覆盖三条握手请求行与 fire-and-forget
分支(`SET_PARAMETER`)的版本段。

**删掉会回归什么**:省版本段时 LinkPlay 宽松、shairport-sync 严格 —— 只有部分设备 `400`,
现场表现为「同一功能有的机器能用」,极难定位(见 §6 第 6 条)。

| 行号 | 钉住的不变量 |
|---|---|
| **49** | **R1 两个发送函数的请求行都拼成三段式(METHOD url RTSP/1.0)** |
| 53 | **常量断言**:`${this.url} RTSP/1.0` 出现且仅出现 2 次(sendRtsp + sendRtspNoWait) |
| 58 | sendRtsp 存在且在其体内拼接请求行 |
| 63 | sendRtspNoWait 存在且在其体内拼接请求行(fire-and-forget 同样不得漏版本段) |
| **68** | **R2 反向钉死:不得再出现只拼两段的请求行** |
| 72 | 不存在 `METHOD url`(缺版本段)的请求行模板 |
| **77** | **R3 动态契约:单测必须断言请求行以 RTSP/1.0 收尾** |
| 79 | raopTransport.test.ts 断言三条握手请求行以 RTSP/1.0 收尾 |
| 84 | raopTransport.test.ts 覆盖 fire-and-forget 分支(SET_PARAMETER)的版本段 |

## 7.6 `check-airplay-ap2-discovery.mjs`(17 条)

**钉什么**:`_raop._tcp` 造设备表、`_airplay._tcp` **只打能力**(`upsertAp2` 不得写
`devices` 表,`ap2Caps.set` 恰好 1 处);`supportsAp2` 必须同时满足「能力表命中」与
`protovers ≥ 1.1`(`AP2_MIN_PROVERS=[1,1]`),缺省/非法值返回 false;`_airplay` 的 `down` 走
`dropAp2`(只清能力,不标设备离线),`_raop` 的 `down` 才标离线;renderer 的 `cast` 仍只调
`castToAirPlayDevice`(AP2 不提前分流)。

**删掉会回归什么**:`upsertAp2` 写设备表 = 纯 AP2 广播造出「点了报错」的 AP1 死设备;能力判定
写死 true = 不支持 AP2 的设备被当 AP2,后续 HAP 配对全挂;down 走错分支 = 一次 `_airplay`
记录抖动就把整台设备标成离线。

| 行号 | 钉住的不变量 |
|---|---|
| **45** | **R1 两种 mDNS 记录都浏览,但设备表只有一个来源** |
| 47 | 同时浏览 `_raop._tcp` 与 `_airplay._tcp` |
| 52 | `_raop` 常驻 browser 仍由 upsert(建表)驱动 |
| 57 | `_airplay` 常驻 browser 由 upsertAp2(只打能力)驱动 |
| 64 | **upsertAp2 不得写 devices 表**(纯 AP2-only 广播不能造出 AP1 设备) |
| 69 | upsertAp2 只往能力表写(ap2Caps.set 恰好 1 处) |
| 74 | `_airplay` 缺 deviceid 时直接忽略(不靠名字猜设备) |
| **79** | **R2 判据:protovers ≥ 1.1 且必须同时有 `_airplay` 记录** |
| 82 | 存在唯一写 supportsAp2 的助手 applyAp2 |
| 87 | supportsAp2 = 同时依赖 ap2Caps 命中与 protovers 下限(不得写死 true) |
| 92 | protoversAtLeast 对缺省 / 非法值返回 false(宁可不认 AP2,也不误判) |
| 97 | AP2 协议版本下限常量为 1.1(与 230 接收器 protovers 实测一致) |
| **102** | **R3 down 必须清能力(否则关掉 AP2 仍长期显示支持)** |
| 105 | 存在 dropAp2 且删除能力表条目 |
| 110 | `_airplay` 的 down 走 dropAp2(不是把设备标记离线) |
| 115 | `_raop` 的 down 仍只把设备标记离线(AP1 行为未变) |
| 120 | stop 时清空能力表(避免下一轮启动残留旧能力) |
| **125** | **R4 AP1 零回归:对外能力透出存在,投屏入口未改** |
| 127 | listAirPlayDevices 透出 supportsAp2 与 ap2 原始能力 |
| 132 | renderer 的 discover meta 带 supportsAp2 |
| 137 | **renderer 的 cast 仍只调 castToAirPlayDevice**(E2 不得提前分流 AP2) |

## 7.7 `check-airplay-bridge.mjs`(①~⑰ 组 / 61 个固定断言点 + 8 条 `uniq()` 动态展开 ⇒ 运行时 69 条)

### 7.7.1 ①~⑰ 与脚本 `console.log` 小节逐条对齐（一条不差）

> 脚本现为 **706 行 / 17 节**（`grep -c 'console.log("====='` = 17）。「小节标题」列**逐字照抄**
> `console.log("===== … =====")` 的正文；行区间 = 该段到下一个 `console.log` 之间的全部行（含断言体与注释）。
> 断言点数列按**运行时**计（`uniq()` 展开后）。

| 序号 | 行区间 | `console.log` 小节标题（逐字） | 运行时断言 |
|---|---|---|---|
| ① | 161-204 | 锚点链不得出现 Date.now / performance.now / Unix 毫秒来源 | 6 |
| ② | 205-236 | latencyFrames 不得被赋 0 / 不得 Math.min(...,0) 钳零 | 4 |
| ③ | 237-283 | 常量唯一源 + 取值钉死(禁止散落硬编码) | **11** = 3 固定 + 8 动态 `uniq()` |
| ④ | 284-312 | PCM 不得走 JSON IPC(必须二进制帧) | 3 |
| ⑤ | 313-331 | 不得存在 start(anchorUnixMs) 旧接口 | 2 |
| ⑥ | 332-357 | 组指令 fanOut 必须跳过桥占用设备(避免与桥会话互踩) | 3 |
| ⑦ | 358-390 | members 不得退化为 Set<any>,桥集合绝不并入 members | 4 |
| ⑧ | 391-417 | commonSendAheadUs 体内不得出现 bridge/lead(MAJ-01 回归防线) | 3 |
| ⑨ | 418-440 | pushFrame 必须含 pcm:100 虚拟组补偿(BLK-01) | 3 |
| ⑩ | 441-493 | playGroupCore 不得清桥;clearGroupBridges 只许两处终态(stopGroupCore/空组回收) | 6 |
| ⑪ | 494-522 | generation 必须取 epoch * 1_000_003 + timelineReseed,rehost 不得 epoch++ | 4 |
| ⑫ | 523-565 | RAOP RECORD 后四锚点同域:baseTs 在列表、先 >>> 0 再 % CHUNK_LEN、禁 & 0xFFFFFFFF | 5 |
| ⑬ | 566-592 | 不得伪造 acked,上报字段名必须是 scheduledAnchorUs | 3 |
| ⑭ | 593-635 | 桥 socket 路径必须是 mfab/<短 hash>(deviceId/token 不进文件名) | 6 |
| ⑮ | 636-657 | 锚点一次性:aligner 非空必须早退(改延迟只能重建桥) | 2 |
| ⑯ | 658-680 | 群延迟补偿只有一个落点(firstFrameTsUs + anchorShiftUs) | 2 |
| ⑰ | 681-707 | RAOP 重连退避必须双层封顶(指数项与抖动项都 clamp) | 2 |
| **合计** | 161-707 / **17 节** | — | **69**（61 固定 + 8 动态） |

**两处口径必须说清（否则条数对不上）**:

1. **③ 是唯一带动态断言的小节**。脚本里 `uniq(needle)` 是模板（`:246-249`，体内一句 `check(…)`，文案是
   「字面量 <needle> 全仓只允许出现 1 次」），被调用 **8 次**（`:250-257`，依次 `"= 147"`、`"= 160"`、
   `"4_500_000"`、`"2_500_000"`、`"BRIDGE_MIN_BUFFER_US = 1_000_000;"`、`"384 * 1024"`、`"1536 * 1024"`、`"0.3627"`）
   ⇒ 静态扫描在 ③ 只数到 **4** 处，运行时实际执行 **11** 条。
2. **`grep -c '^\s*check('` = 62**（含 `uniq()` 模板体内那 1 处）；减掉模板、按展开次数补回 ⇒ **61+8 = 69**。

**⑮⑯⑰ 钉什么**（⑭ 之外的三条「改延迟/重连」侧不变量）：⑮ 锚点一次性（`if (this.aligner !== null) return;` 必须恰好 1 处 + `new BridgeTimelineAligner(` 全仓只 1 处）—— 若改成「热改锚点」又不换 aligner ⇒ 延迟调了没反应、或新旧锚点同时在用（整组缓慢飘音，无报错）；⑯ 群延迟补偿**只有一个落点**（`firstFrameTsUs + anchorShiftUs`），sendspin 侧不得出现 `anchorShift`、airplay 侧不得出现 `dspDelay`，否则同一偏移两头各加一次 = 双倍补偿（调 100ms 实际偏 200ms）；⑰ RAOP 重连退避**双层封顶**（`min(maxMs, base·2^(n-1))` 再 `min(maxMs, exp·jitter)`）—— 指数项不封顶 ⇒ 离线久了永不重连；抖动项不封顶 ⇒ 实际间隔超上限（重连风暴）。

**钉什么**:桥接环的 17 组不变量（见上表小节标题，编号与脚本 `console.log` 完全一致）。

**删掉会回归什么**:这些缺陷**全都不报错**,只表现为「声音慢 3.7 秒」「周期性 underrun」
「切歌后整组无声」「真机 Lost sync 风暴」。⑧ 被破 = 全组时间戳 +3.7s;⑩ 被破 = 桥会话被重建
路径掐断(整首无声);⑫ 被破 = 设备侧 RTP 时间线与内容错位(长曲后段爆音);⑯ 被破 = 延迟补偿翻倍。

**①~⑭ 逐条断言（行号 = 现 HEAD `6c13bd6` 的 706 行版；同一行号组内以「·」分隔）**:

| 行号 | 钉住的不变量 |
|---|---|
| `163`·`168`·`174`·`181`·`188`·`193` | ① `hostClock` 剥注释后无 `Date.now`/`performance.now`；`nowUs` 取 `hrtime.bigint()/1000n`；`sendspin/clock.ts` 只 re-export；`bridgeMath.ts` 无墙钟；`raop.ntpNow()` 体内是 `ntpFromHostUs(nowUs())`；RECORD 的 `ntp0` 取 `ntpNow()` 而非 `Date.now()` |
| `206`·`213`·`219`·`225` | ② 全仓无 `latencyFrames = 0`/`latencyFrames: 0`；不得用 `Math.min(…,0)` 钳零；RECORD 的 `Audio-Latency` 用 `Math.max` 抬高；`bridgeSession` 取 L 时 `Math.max(1, …)` 兜底 |
| `238`·`265`·`270` | ③ `rates.ts` 是速率唯一源（`SENDSPIN_RATE=48000`/`AIRPLAY1_RATE=44100`）；`ANCHOR_SAFE_LEAD_US` 全仓只在 `rates.ts` 声明一次（800_000）；`RESAMPLE_L/RESAMPLE_M` 只在此声明，`resampler.ts` 不得内联 147/160 |
| `285`·`294`·`301` | ④ `ipcProtocol.ts` 无 `JSON.stringify`、载荷不得 `toString("base64")`、`stringify` 200 字符邻域内不得出现 pcm/audio 载荷 |
| `314`·`320` | ⑤ 全仓无 `anchorUnixMs`、无 `.start(anchorUnixMs)` 调用形态 |
| `336`·`341`·`346` | ⑥ `fanOut` 的 airplay 成员必须 `.filter((d) => !isBridgeOwned(d))`，且该过滤全仓唯一；回落 solo cast 的设备由 `soloFallback` 单独记名 |
| `359`·`368`·`374`·`379` | ⑦ `members` 必须是 `new Set<SendspinConnection>()`；桥接相关模块不得出现 `new Set<any>()`；`bridgeAttach.ts` 内 `members.add` 应为 0 次；`bridges` 是与之并行的独立字段 |
| `392`·`399`·`406` | ⑧ `commonSendAheadUs` 体内不得出现 bridge/lead 任一标识（含 camelCase 复合名），且只由 `members` 的 `sendAheadInputOf` 汇总 |
| `419`·`424`·`429` | ⑨ `pushFrame` 内以 `encoderKey("pcm",100)` 建虚拟组键、`members=[]`、**只在有桥时创建**（不给无桥场景加编码开销） |
| `443`·`449`·`458`·`466`·`476`·`481` | ⑩ `playGroupCore` 内不得调 `clearGroupBridges`/`bridges.clear`/清 `bridgeSpecs`；`clearGroupBridges` 全仓恰好两处（`stopGroupCore` + `onConnectionClosed` 空组回收）且定义只在 `bridgeAttach.ts` |
| `495`·`500`·`505`·`511` | ⑪ `get generation()` 返回 `this.epoch * 1_000_003 + this.timelineReseed`，基数必须是 `1_000_003`；`rehost` 分支不得自增 `epoch`；`FrameSequencer.reset` 用 `>>> 0` 归一 |
| `525`·`530`·`537`·`545`·`554` | ⑫ `headTs` 由 `ntpToRtpMod(ntp0, sampleRate, CHUNK_LEN)` 产出；四锚点同域赋值且 `baseTs` 必须出现在 RECORD 的赋值列表里；`ntpToRtpMod` 必须**先 `>>> 0` 再 `% chunkLen`**（反了残 32 破坏 352 对齐）；不得用 `& 0xFFFFFFFF`（边界得 −1） |
| `567`·`573`·`581` | ⑬ 全仓无 `acked` 字段；上报字段名必须是 `scheduledAnchorUs`；不得用 `anchorUsMs`/`scheduledAnchorMs`/`anchorMs` 等毫秒口径 |
| `594`·`596`·`601`·`609`·`616`·`621` | ⑭ `bridgeSocketPath`：Unix 侧 `path.join(os.tmpdir(), "mfab", `${name}.sock`)`；短 hash 恒 11 位 base36（sha1 前 64bit → base36 → `padStart(11).slice(0,11)`）；文件名不得拼 `deviceId`/`token`（只进 sha1 输入 `${deviceId}:${token}`）；bind 前断言路径 < 100 字节 |


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
| 2026-10-22 | fork 默认下的全量回归 + 前端负载隔离 | 起播/seek/暂停恢复/音量/停止/流转/快速往返全通过、无 `rpc 超时`；24 并发请求 ×15s：`chunks` 增量 2381（125.3/s），`reanchors/maxGap/loss` 增量 0 |

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

# 第九部分：实现级代码地图（`backend/src/services/airplay/` 全 21 个文件）

> 本部分解决一个具体问题:**看到现象后 30 秒内定位到该读哪个函数**。
> 所有 `文件:行号` 以 **v4.6.77（commit `1b2a57b` 之后的 main）** 为准;
> 行号为函数**声明行**(`export ...`/`function`/方法名所在行),常量行号为 `export const` 所在行。
> 目录实测 **21 个 `.ts`**(不含 `ap2/` 子目录),9.1~9.21 逐个覆盖,9.22 给「行为 → 代码」反查表。

## 9.0 文件清单与一句话职责

| # | 文件 | 行数 | 一句话 | 状态归属 |
|---|---|---|---|---|
| 1 | `control.ts` | 1425 | 编排层:设备闸 / 双协议互斥 / peer / lastCast / 音量 / 桥 owner | 主进程内存 + DB |
| 2 | `raop.ts` | 1097 | RAOP 协议实现:RTSP 握手 + ALAC + AES + RTP/SYNC 定速推送 | 会话对象(主进程或子进程) |
| 3 | `bridgeSession.ts` | 875 | 桥接环接收端:listener + 对齐器 + 锚点 + RAOP 出声 | 子进程(或 in-proc) |
| 4 | `sessionRuntime.ts` | 399 | 纯推流运行时(会话起停 / seek / 快照),可整体跑在子进程 | 子进程 |
| 5 | `bridgeServer.ts` | 397 | MFAB 帧服务器:unix socket listener + 粘包解码 + stall 判定 | 子进程 |
| 6 | `discovery.ts` | 376 | mDNS `_raop` 造表 + `_airplay` 打 AP2 能力 | 主进程内存 |
| 7 | `bridgeSource.ts` | 353 | 桥接环发送端:会合连接 + 队列 + 硬上限 + 退避重连 | sendspin 子进程 |
| 8 | `bridgeChannel.ts` | 301 | MFAB 帧格式(28B 头)编解码 + 流式解析 | 纯函数 |
| 9 | `decoder.ts` | 266 | ffmpeg 解码 → 有界 PCM 队列(预填充 1.5s) | 会话内(随会话销毁) |
| 10 | `resampler.ts` | 208 | 48k↔44.1k 多相重采样(147/160,33 抽头) | 会话内 |
| 11 | `childMain.ts` | 176 | 子进程 RPC 分发器(11 个 op) | 子进程 |
| 12 | `bridgeMath.ts` | 144 | 时间↔样本换算唯一出处(锚点 / 漂移 / 发送时刻) | 纯函数 |
| 13 | `rates.ts` | 128 | 采样率 / 重采样 / 桥接全部常量唯一源 | 常量 |
| 14 | `session.ts` | 90 | AirPlay 独立取流 token(落 SQLite,同 song+device 复用) | DB `airplay_stream_tokens` |
| 15 | `protocolPlayer.ts` | 88 | `ProtocolPlayer` 薄适配器(起播即落位) | 无状态 |
| 16 | `deviceState.ts` | 87 | 按设备音量/静音持久化 | DB `airplay_device_state` |
| 17 | `ipcProtocol.ts` | 76 | 主↔子进程业务载荷类型(含 `BridgePrepareArgs`) | 类型 |
| 18 | `supervisor.ts` | 75 | 子进程宿主(心跳/快照/RPC/看门狗/退避重启) | 主进程 |
| 19 | `child.ts` | 57 | 子进程入口(装配 runtime → mainReady → 消息循环) | 子进程 |
| 20 | `bridgeCalib.ts` | 44 | 全局 A/V 标定位移 `bridge.avShiftMs`(无组上下文时回落) | DB `settings` |
| 21 | `mode.ts` | 22 | fork/in-proc 三开关判定(leaf,零依赖) | 环境变量 |

**另**:`group/delayCalib.ts`(116 行,目录外但属本链路)见 §11.1;`group/protocolPlayer.ts` 的桥路由编排见 §11.2。

**`airplay/ap2/` 子目录（不在上表 21 个之内）**:15 文件 3067 行(`alac`/`ap2Session`/`ap2Stream`/`ap2Trace`/`bplist`/
`hapCredentials`/`hapCrypto`/`hapPairing`/`hapSocket`/`pairingContract`/`rtpAudio`/`rtspClient`/`srp6a`/`timingClient`/`tlv8`)。
**已实现并有 7 个协议级 QA 用例直接覆盖**(`tests/airplay/ap2Session|ap2Transport|ap2HapPairing|ap2HapCredentials|ap2Trace|ap2Audio|ap2Contract.qa*.test.ts`),
但**未接入生产链路**:`control.ts` / `childMain.ts` 无任何静态引用,也无 flag 入口 ⇒ 设备仍一律走 `raop`。
**不是「空目录」,也不要当成可删死代码**;接入点与验收口径见《最终实施方案》§4 P6a/P6b 与 §5。

## 9.1 `control.ts`（1425 行）

| 项 | 内容 |
|---|---|
| 职责 | 主进程编排层:**设备级串行闸**、**同 host DLNA 双协议互斥**、peer/lastCast 登记、音量/静音唯一咽喉、桥 owner 与 bridgePrepare/bridgeStop 编排、状态派生 |
| 对外导出(关键) | `toLoopbackAirPlayStreamUrl(streamUrl: string): string`(:150)<br>`withPlaybackOffset(streamUrl: string, seekSec?: number): string`(:173)<br>`isAirplayBridgeEnabled(): boolean`(:270)<br>`registerBridgeOwner(deviceId: string, token: string): void`(:280) / `clearBridgeOwner`(:284) / `isBridgeOwned(deviceId: string): boolean`(:289)<br>`bridgePrepareDevice(deviceId: string, token: string, protocol: BridgeProtocol, groupId?: string \| null): Promise<{ listening: true; socketPath: string }>`(:296)<br>`bridgeStopDevice(token: string, deviceId?: string): Promise<void>`(:326)<br>`hasActiveAirPlaySessionForHost(host: string): boolean`(:356) / `stopAirPlaySessionsForHost(host: string): Promise<string[]>`(:373) / `stopAirPlaySession(deviceId: string): Promise<void>`(:404)<br>`castToAirPlayDevice(opts: AirPlayCastOptions): Promise<{ mediaUri: string }>`(:826)<br>`getAirPlayMediaUri(deviceId: string): string \| undefined`(:922)<br>`handleAirplaySessionEnded(...)`(:936) / `pauseAirPlay`(:1021) / `resumeAirPlay`(:1033) / `stopAirPlay`(:1058) / `seekAirPlay(deviceId: string, seconds: number): Promise<void>`(:1072)<br>`setAirPlayVolume(deviceId: string, volume: number): Promise<void>`(:1177) / `setAirPlayMuted(deviceId: string, muted: boolean): Promise<void>`(:1205)<br>`getAirPlayStatus(deviceId: string): AirPlayDeviceStatus`(:1278) / `getAirPlayPeerStatus(deviceId: string)`(:1321)<br>`startAirPlayService(): void`(:1351) / `isAirPlayEnabled()`(:1380) / `stopAirPlayService(): Promise<void>`(:1392)<br>`makeProducer`/`killDecoder` 转出(:35/:37) |
| 关键常量 | `DLNA_YIELD_DEADLINE_MS = 6_000`(:230,互斥硬顶)<br>`DLNA_SETTLE_MAX_MS = 2_500`(:232) / `DLNA_SETTLE_GRACE_MS = 300`(:234) / `DLNA_SETTLE_POLL_MS = 200`(:236)(停稳窗)<br>`STOP_SESSION_DEADLINE_MS = 4_000`(:237,收尾硬顶)<br>**为什么是这些值**:互斥 6s < cast 硬顶 30s,保证「互斥卡住」不会吃掉整次 cast;停稳窗 2.5s 是 HiVi/Linkplay 报 STOPPED 的实测上限(超过即按宽限放行) |
| 状态归属 | 主进程内存 `sessions: Map<string, ActiveSession>`(:103)、`volumeState: Map`(:104)、`bridgeOwners: Map<string,string>`(:278)、`lastCast`;DB `airplay_devices` / `airplay_device_state` |
| 上下游 | 上游:`protocolPlayer.ts`(六个传输 op)、`group/protocolPlayer.ts`(bridgePrepare/Stop)、`routes/api/*`(音量/静音/状态)、`dlna/control.ts`(反向互斥)<br>下游:`raop.ts`、`decoder.ts`、`supervisor.ts`(RPC)、`discovery.ts`、`session.ts`、`deviceState.ts`、`group/delayCalib.ts`(取 `anchorShiftUs`) |
| 失败模式 | ①设备闸内自锁(闸内再调公开入口)→ 永久排队,日志 `[AirPlay][gate] … 排队 Nms`;②互斥顺序颠倒 → IDLE 回投反杀;③`bridgePrepare` 成功但 owner 未登记 → native cast 与桥互踩;④音量只走 SET_PARAMETER → LinkPlay 全系音量条不动 |

## 9.2 `raop.ts`（1097 行）

| 项 | 内容 |
|---|---|
| 职责 | RAOP 协议实现:TCP RTSP(ANNOUNCE/SETUP/RECORD/TEARDOWN/FLUSH/SET_PARAMETER)+ RSA-OAEP 交 aeskey + AES-128-CBC + RAW-ALAC 打包 + RTP/SYNC 定速推送(墙钟锚点) |
| 对外导出 | 常量:`SAMPLE_RATE=44100`(:28)/`SAMPLE_SIZE=16`(:29)/`CHANNELS=2`(:30)/`CHUNK_LEN=352`(:31)/`PCM_BYTES_PER_CHUNK=1408`(:32)/`RAOP_LATENCY_MIN=11025`(:33)/`NTP_EPOCH_DELTA=2208988800`(:34)<br>超时:`RTSP_TIMEOUT_MS=10_000`(:37)/`RTSP_CLEANUP_TIMEOUT_MS=2_500`(:39)/`HANDSHAKE_BUDGET_MS=8_000`(:45)/`RTSP_STEP_MIN_MS=1_500`(:47)/`rtspTimeoutFor(method, remainingHandshakeMs)`(:50)<br>时间:`ntpNow()`(:73)/`ntpFromDate`(:86)/`ts2ntp`(:92)/`ntp2ts`(:97)/`ms2ts`(:101)/`ts2ms`(:105)/`ntpToMs`(:109)/`seekStartTs`(:116)/`seekPositionSec`(:124)<br>编解码:`pcmToAlacRaw(sample, frames, bsize): Buffer`(:133)/`resolveRsaPublicKey(pkBase64?)`(:186)/`rsaOaepEncrypt`(:227)/`aesCbcEncrypt`(:234)<br>类型:`RaopSession`(:243)/`RaopConnectOptions`(:250)/`PcmProducer`(:262)/`RaopBridgeAnchor`(:266)<br>类:`class RaopPlayer`(:286);`connect()`(:577)、`sendChunk`(:728)、`stream(producer…)`(:807)、`streamBridge(producer, session, anchor)`(:908)、`bridgeSkipFrames(frames)`(:401)、`prepareSeek`(:1019)、`setStartPosition`(:1045)、`setVolumeDb(db)`(:1053)、`flush()`(:1059)、`stop()`(:1065)、`forceClose()`(:1082) |
| 关键常量(为什么) | `CHUNK_LEN=352`(≈7.98ms@44.1k)= libraop 的 `DEFAULT_FRAMES_PER_CHUNK`,与接收端 SYNC 语义绑定,改它等于换协议<br>`RAOP_LATENCY_MIN=11025`(0.25s)= libraop `LATENCY_MIN`,RECORD 回包的 Audio-Latency 只允许**抬高**不得下沉<br>`HANDSHAKE_BUDGET_MS=8_000`:三步各 10s 合计 30s 正好撞 cast 硬顶,慢设备必然失败(§6 第 4 条)<br>私有 `latencyFrames` 初值 = `SAMPLE_RATE`(:312,即 1s),`negotiatedLatencyFrames`(:388)是锚点 L 的唯一来源 |
| 状态归属 | `RaopPlayer` 实例:RTSP socket、UDP audio/control/timing socket、`baseTs/startTs/headTs/startNtp`、`latencyFrames`;不读 DB |
| 上下游 | 上游:`control.ts`(in-proc)、`sessionRuntime.ts`(fork)、`bridgeSession.ts`(`streamBridge` 走「桥锚点」而非内容墙钟)<br>下游:设备 RTSP/RTP |
| 失败模式 | ①请求行缺版本段 → 严格接收端 400(:427 注释即事故记录);②`latencyFrames` 归零 → 设备跑空 underrun;③SYNC 锚用 `ts2ntp(headTs)`(含 seek 偏移)→ 内容被当成未来时间;④RECORD 期间连接关闭不 reject → 子进程 RPC 挂死(靠 `forceClose` :1082 兜底) |

## 9.3 `bridgeSession.ts`（875 行）

| 项 | 内容 |
|---|---|
| 职责 | 桥接环**接收端**:unix socket 收 MFAB 帧 → 对齐器 → 重采样 48k→44.1k → 按「四锚点」以 RAOP 出声到 AirPlay 设备 |
| 对外导出 | `realignedLogLevel(act): "debug" \| "warn"`(:79,无动作降噪)<br>`class BridgeTimelineAligner`(:100):`onFrame(tsUs): BridgeAlignAction`(:124)/`produced(n)`(:160)/`padded(n)`(:165)/`takeDrop(n)`(:170)<br>`planBridgeAnchor(opts: {firstFrameTsUs, latencyFrames, rate, resampled, nowUs, anchorShiftUs?}): BridgeAnchorPlan`(:198)<br>`class BridgeSession`(:272):`start()`(:338)/`ingest`(:380)/`pullOutChunk()`(:387)/`stop()`(:743)/`**setVolumeDb(db: number): void**`(:773,桥占用设备音量唯一落点)/`snapshot()`(:782);私有 `ingestAudio`(:394)/`onBoundary(gen, reason)`(:422)/`onLinkStall`(:453)/`onBridgeHeartbeat(paused)`(:469)/`scheduleRaopReconnect`(:549)/`emitAnchorReport`(:596)/`emitStatsTick`(:622)/`resampleIn`(:695)/`pullChunk`(:660)<br>`class BridgeSessionManager`(:818):`prepare`(:844)/`stop`(:858)/`stopAll`(:866)/`list`(:821)/`has`(:825)/`**setVolumeDb(deviceId, db): boolean**`(:833,按 deviceId 遍历桥会话表)<br>`bridgeSocketPath` 转出(:875) |
| 关键常量 | `anchorShiftUs` 语义见 `planBridgeAnchor`(:207-209):`anchorUs = firstFrameTsUs + anchorShiftUs`(**只平移内容落点,不动 latencyFrames**)<br>lead 常量来自 `rates.ts`:`BRIDGE_COLD_START_LEAD_US=4.5s`/`BRIDGE_WARM_START_LEAD_US=2.5s`/`BRIDGE_MIN_BUFFER_US=1s`/`ANCHOR_SAFE_LEAD_US=800ms`/`BRIDGE_MAX_HELD_AUDIO_US=45s`<br>stats 周期 `statsIntervalMs ?? 2000`(:615) |
| 状态归属 | 会话内存:`inQueue/outBuf/inBytes`、`aligner/anchors/anchorUs/commandedLeadUs`、`generation`、`firstFrameTsUs`、`streamAborted`、`pausedState`、`deltaSamples`;RAOP 会话对象 `raopSession` |
| 上下游 | 上游:`bridgeServer.ts`(AUDIO/BOUNDARY/HEARTBEAT 回调)、`childMain.ts`(`bridgePrepare`/`bridgeStop`)、`bridgeCalib.ts`(全局位移)、`group/delayCalib.ts`(按组位移,经 `control.ts` 下发)<br>下游:`raop.ts::streamBridge`、`resampler.ts`、`bridgeMath.ts` |
| 失败模式 | ①`aligner` 非空即不再立锚 ⇒ **锚点一次算死**(:498),改 `anchorShiftUs` 必须重建会话(§11.2);②BOUNDARY`{track/seek/rehost}` 只清队重锚(:422-444),**不拆 RAOP 会话**;③欠料 `pullChunk` 补静音(:660-690)→ 宁可静音不断流;④drop 累计(8cb4742 修过)会把重叠算成秒级裁头 = 长时间无声 |

## 9.4 `sessionRuntime.ts`（399 行）

| 项 | 内容 |
|---|---|
| 职责 | 纯推流运行时:**会话起停 / seek / 快照 / `sessionEnded`**,可整体跑在子进程;不碰 DB/DLNA/peer |
| 对外导出 | `class AirplaySessionRuntime`(:132):`cast(a: AirplayCastArgs): Promise<void>`(:149)/`stop(deviceId)`(:272)/`stopAll()`(:304)/`pause(deviceId): boolean`(:311)/`resume(deviceId): boolean`(:320)/`seek(deviceId, seconds): Promise<boolean>`(:339)/`setVolumeDb(deviceId, db): boolean`(:372)/`snapshot()`(:380)/`has`(:140)/`activeIds`(:144)<br>类型:`AirplaySessionMirrorRow`(:51)/`AirplayCastArgs`(:66)/`AirplaySessionEndInfo`(:113)/`AirplayRuntimeHooks`(:124) |
| 关键常量 | `HEALTH_LOG_INTERVAL_MS=15_000`(:19,健康行节流)<br>`HEALTH_WARN_GAP_MS=50`(:20,单包间隔告警,与 §2.4 同值)<br>`STOP_DEADLINE_MS=4_000`(:28,单会话收尾硬顶,>TEARDOWN 2.5s) |
| 状态归属 | `sessions: Map<deviceId, {player, decoder, streamPromise, …}>`(子进程内存) |
| 上下游 | 上游:`childMain.ts`(RPC)、`control.ts`(fork 路径经 RPC);下游:`raop.ts`、`decoder.ts` |
| 失败模式 | ①`setVolumeDb` 只查 native `sessions`(:372-377),**桥会话不在其中** ⇒ 桥占用设备的播中音量到不了 RAOP(见 附录 D-1);②收尾无硬顶 → 子进程被不答 TEARDOWN 的设备挂住 |

## 9.5 `bridgeServer.ts`（397 行）

| 项 | 内容 |
|---|---|
| 职责 | MFAB 帧服务器:**unix socket listener** + 首帧必须 CONFIG + 粘包解码 + AUDIO/BOUNDARY/HEARTBEAT 分发 + 2s 无帧判 stall |
| 对外导出 | `class BridgeServer`(:99):`listen(socketPath)`(:131)/`close()`(:157)/`destroySessions()`(:182)/`stats()`(:126)<br>类型:`BridgeServerOpts`(:34)/`BridgeAudioEvent`(:50)/`BridgeSessionEvent`(:58)/`BridgeServerHandlers`(:63,`onAudio/onSession/onBoundary/onStall/onHeartbeat/onOverflow/log`)/`BridgeServerStats`(:75)<br>`runBridgeServerMain(env)`(:376,独立跑一个 listener,测试/落盘用) |
| 关键常量 | `BRIDGE_STALL_NO_FRAME_MS=2_000`(`rates.ts`,:336 使用)/`BRIDGE_RECEIVE_OVERFLOW_MS=8_000`(:271-277 溢出回调)/检查周期 `checkIntervalMs ?? 500`(:151) |
| 状态归属 | 每个连接一个 `BridgeSession`(configOk/deviceId/token 校验态,见 :205-247) |
| 上下游 | 上游:`bridgeSource.ts`(发送端 connect);下游:`bridgeSession.ts` 的 handlers |
| 失败模式 | ①首帧不是 CONFIG / deviceId 或 token 不匹配 → `rejectSession`(:349),桥侧表现为反复重连;②粘包解析错位(magic/version/len 非法必须立即断连,:213-224);③2s 无帧(stall)→ 停推流等重连(不写静音) |

## 9.6 `discovery.ts`（376 行）

| 项 | 内容 |
|---|---|
| 职责 | mDNS 发现:`_raop._tcp` **造设备表**,`_airplay._tcp` **只打 AP2 能力** |
| 对外导出 | `startAirPlayDiscovery(): void`(:242)/`stopAirPlayDiscovery(): void`(:295)/`rescanAirPlayDevices(windowMs = 2500): Promise<void>`(:325)/`getAirPlayDevices()`(:352)/`getAirPlayDevice(id)`(:360)/`addPersistedAirPlayDevice`(:367)/`removeAirPlayDevice`(:374)/`onAirPlayEvent(cb)`(:70)/`setAirPlayPersist(fn)`(:84)/`normalizeAp2DeviceId(raw)`(:108)/`protoversAtLeast(v, min)`(:117)<br>类型:`AirPlayDevice`(:32)/`AirPlayAp2Info`(:22)/`AirPlayEvent`(:66) |
| 关键常量 | `STALENESS_MS = 90 * 1000`(:53,90s 无 mDNS 刷新才标 unavailable)<br>`AP2_MIN_PROTOVERS = [1, 1]`(:56,与 230 接收器 protovers 实测一致)<br>周期重查 `spinQuery(3000, …)` 每 `30_000`ms(:281-295):直连 HiVi 会忽略同句柄 `browser.update()`,必须靠**新短命 browser** 续 `lastSeen` |
| 状态归属 | 主进程内存 `devices: Map<deviceId, AirPlayDevice>` + `ap2Caps`;持久化(alias/disabled)由 `control.ts::wireAirPlayPersistence` 注入 |
| 上下游 | 上游:插件启动/关闭、`rescanAirPlayDevices`;下游:`control.ts`(设备解析)、renderer discover meta |
| 失败模式 | ①`upsertAp2` 写设备表 → 纯 AP2 广播造出 AP1 死设备(守卫 7.6);②无 A 记录时用 `.local` → 连接必失败(守卫 R16);③进程内存设备表与 DB 不同步 → 重启丢别名 |

## 9.7 `bridgeSource.ts`（353 行）

| 项 | 内容 |
|---|---|
| 职责 | 桥接环**发送端**(跑在 sendspin 侧):unix socket 会合连接、发送队列、背压/硬上限、退避重连 |
| 对外导出 | `computeBridgeBackoffMs(attempt: number, rand: () => number): number`(:35)/`class BridgeSource`(:100):`start`(:134)/`stop`(:142)/`enqueue(frame)`(:156)/`sendNow(bytes)`(:187)/`clearQueue()`(:198)/`stats()`(:204);私有 `drain`(:332)/`handleClosed`(:292)/`scheduleReconnect(forcedDelayMs?)`(:308)/`attach`(:265)<br>类型:`BridgeLinkState = "idle" \| "connecting" \| "live" \| "stalled"`(:23)/`BridgeSourceStats`(:61)/`BridgeSourceOpts`(:76)/`BridgeSocketLike`(:26) |
| 关键常量 | `BRIDGE_ENOENT_PERMANENT_AFTER = 12`(:48,连续 12 次 ENOENT 判永久失败,路径不可能再出现)<br>来自 `rates.ts`:`BRIDGE_QUEUE_HIGH_WATER_BYTES=384KB`/`BRIDGE_QUEUE_HARD_CAP_BYTES=1536KB`/`BRIDGE_BACKOFF_BASE_MS=5_000`/`BRIDGE_BACKOFF_MAX_MS=30_000`/`BRIDGE_PCM_BYTES_PER_SEC=192_000`/`BRIDGE_QUEUE_HIGH_WATER_MS=2_000`/`BRIDGE_QUEUE_HARD_CAP_MS=8_000`<br>为什么 8s:一次窗口化投递只有 1s 内容,8s ≈ 8 个周期仍积压 ⇒ 只能是对端不读(socket 反压),`宁断不错位` |
| 状态归属 | 发送端内存:`queue/queuedBytes/maxQueueMs/backpressureActive/reconnects/state` |
| 上下游 | 上游:`sendspin/bridgeMember.ts::pushAudio`(经 `enqueue`)、`sendBoundary`/`notifyGeneration`;下游:`bridgeServer.ts` listener |
| 失败模式 | ①硬上限触发 → 断连重连(:163-171),日志 `bridge hardCap <ms>ms > <cap>ms,断连重连`;**排查要点:出现即说明对端 8s 没读**,常见于对端推流被 boundary/stall 中止或泵侧一次灌太多;②ENOENT 无限重连 = socket 路径已废而 stop 未走(:48) |

## 9.8 `bridgeChannel.ts`（301 行）

| 项 | 内容 |
|---|---|
| 职责 | MFAB 帧格式:**28 字节头**(magic 4 + ver 1 + type 1 + flags 2 + generation 4 + sequence 4 + tsUs 8 + payloadLen 4)+ 流式解析(粘包/半包安全) |
| 对外导出 | `FRAME_MAGIC="MFAB"`(:30)/`FRAME_VERSION=1`(:31)/`FRAME_HEADER_SIZE=28`(:32)/`MAX_PAYLOAD_BYTES=1MiB`(:34)/`FRAME_TYPE={AUDIO:1,BOUNDARY:2,CONFIG:3,HEARTBEAT:4,STATS:5}`(:36)/`FRAME_FLAG_KEYFRAME=0x0001`(:40)/`FRAME_FLAG_PAUSED=0x0002`(:42)<br>`class FrameDecoder`(:92):`push(chunk): BridgeFrame[]`/`get pendingBytes`<br>`encodeFrame(frame): Buffer`(:58)/`encodeConfig`/`encodeBoundary`(:166)/`encodeAudio`/`encodeHeartbeat`/`encodeStats`/对应解析函数;`interface BridgeFrame`(:43)/`BridgeConfigPayload`(:140) |
| 关键常量 | `BOUNDARY_REASONS = ["track","seek","stop","rehost"]`(:151);`tsUs` **只对 AUDIO 有效**(其余帧恒 0n,:49) |
| 状态归属 | 纯函数 + 解析器缓冲(每个连接一个 `FrameDecoder`) |
| 上下游 | 上游:`bridgeSource.ts`(encode)/`bridgeServer.ts`(decode);下游:对端 |
| 失败模式 | ①magic/ver/type/len 非法必须**立即断连**(错位续读会永久失步);②把 PCM 塞进 JSON/base64 → 守卫 ④ 直接红(带宽与抖动都不可接受) |

## 9.9 `decoder.ts`（266 行）

| 项 | 内容 |
|---|---|
| 职责 | ffmpeg 解码 → **有界 PCM 队列**(预填充 1.5s、上限 10s、背压);**不做响度归一** |
| 对外导出 | `PREFILL_BYTES`(:23)/`MAX_BUFFER_BYTES`(:27)/`RESUME_BUFFER_BYTES`(:28)<br>`degreesToDb(volume: number): number`(:31,0→−144 静音 / 100→0dB)<br>`killDecoder(ff): void`(:47,**SIGKILL**)<br>`buildAirplayAf(): string[]`(:79,只输出段)/`spawnDecoder(input, seekSec?, opts?): ChildProcessWithoutNullStreams`(:102)/`makeProducer(ff): () => Promise<Buffer \| null>`(:161) |
| 关键常量 | `PREFILL_MS = 1500`(:22,吸收抖动)/`MAX_BUFFER_MS = 10_000`(:26,超限 pause stdout 背压)/`RESUME_BUFFER_BYTES = MAX/2`(:28)<br>为什么 1.5s:真机验证的最小可用水位;真正的起播缓冲深度由 sendspin 侧独立控制,两者解耦 |
| 状态归属 | 随会话:ffmpeg 进程 + 队列;无全局态 |
| 上下游 | 上游:`control.ts::startSession`、`sessionRuntime.ts::cast`;下游:ffmpeg(lavfi 输入 / 回环 token URL) |
| 失败模式 | ①解码侧再挂 `loudnorm` → 二次压缩(守卫 7.3);②`-reconnect_streamed` 开着 → 每 20s 从头重播(:124-131 事故记录);③SIGTERM 收不掉卡在阻塞写的 ffmpeg → 僵尸解码器 |

## 9.10 `resampler.ts`（208 行）

| 项 | 内容 |
|---|---|
| 职责 | 48kHz ↔ 44.1kHz **多相 Kaiser 窗重采样**(桥接环唯一用到重采样的地方:RTP 硬要求 44.1k) |
| 对外导出 | `RESAMPLE_TAPS=33`(:20)/`RESAMPLE_GROUP_DELAY_OUT=(33-1)/2=16`(:22)<br>`class PolyphaseResampler`(:55):`process(input: Float32Array): Float32Array`<br>`pcmS16ToFloat(input: Int16Array): Float32Array`(:185)/`floatToPcmS16(input: Float32Array): Int16Array`(:191) |
| 关键常量 | 私有 `KAISER_BETA=6.0`(:25)/`CUTOFF_HZ=19_000`(:28,略低于 22.05k 奈奎斯特,抑制镜像)<br>**147/160 只在 `rates.ts`**(`RESAMPLE_L`/`RESAMPLE_M`),本文件不得内联(守卫 7.7 组③) |
| 状态归属 | 实例:`hist` 历史样本、`histBase/histLen`、累计 in/out 帧数 |
| 上下游 | 上游:`bridgeSession.ts::resampleIn`;下游:RAOP 打包 |
| 失败模式 | ①内联 147/160 或改抽头 → 与 `RESAMPLE_GROUP_DELAY_MS=0.3627` 不一致 ⇒ 桥整体偏移(且极难发现);②有状态但每帧重建实例 → 每帧丢失 group delay 补偿,爆音 |

## 9.11 `childMain.ts`（176 行）

| 项 | 内容 |
|---|---|
| 职责 | 子进程 RPC 分发器:11 个 op + 快照 + 就绪标记 + `bridgePrepare/Stop/Status` |
| 对外导出 | `class AirplayChildController extends ChildRpcHost<AirplayChildToParent, AirplaySnapshot>`(:28):`handleMessage(raw)`/`buildState(): AirplayStateEnvelope`(:71)/`markReady()`;私有 `dispatch(op, p)`(:77) |
| op 清单 | `cast`(:78,桥占用设备**直接拒绝**)/`stopSession`(:87)/`stopAll`(:95)/`hasSession`(:100)/`pause`(:102)/`resume`(:107)/`seek`(:113)/`setVolumeDb`(:119,先 native,`!ok` 回落桥会话表)/`bridgePrepare`(:131)/`bridgeStop`(:136)/`bridgeStatus`(:141) |
| 关键常量 | 无(阈值全在 `rates.ts` 与各自模块) |
| 状态归属 | 持有 `runtime: AirplaySessionRuntime`(:32 附近)与 `bridgeSessions: BridgeSessionManager`(:32) |
| 上下游 | 上游:`child.ts` 消息循环、主进程 `airplaySupervisor.rpc`;下游:`sessionRuntime.ts`、`bridgeSession.ts` |
| 失败模式 | ①op 里 await 设备不答的请求 → 子进程 RPC 挂死(靠各步硬顶 + `forceClose`);②`bridgePrepare` 前不停同设备 native 会话 → 两条链路抢同一台设备(:155);③**`setVolumeDb` 只查 native 会话表**(桥占用设备不在表里且无人接手)⇒ 桥设备音量冻结在起播值(2026-10-26 修复:`!ok` 回落 `bridgeSessions.setVolumeDb`) |

## 9.12 `bridgeMath.ts`（144 行）

| 项 | 内容 |
|---|---|
| 职责 | **时间↔样本换算唯一出处**:RTP 取模、锚点组装、漂移量化、桥启动 lead、发送提前量 |
| 对外导出 | `ntpToRtpMod(ntp: bigint, rate: number, chunkLen: number): number`(:26,**先 `>>> 0` 再 `%`**)<br>`rtpAt(tUs, anchorUs, baseTs, rate): number`(:34)/`audibleAtUs(sampleIndex, anchorUs, rate): bigint`(:41)<br>`groupDelayUs(rate: number): number`(:61,重采样群延迟)<br>`computeBridgeAnchors(opts): BridgeAnchors`(:76,四锚点:baseTs/startTs/headTs/startNtp/anchorUsShifted)<br>`driftCorrection(targetFrames, actualFrames, opts?): DriftPlan`(:113)<br>`bridgeStartLeadUs(bridges: ReadonlyArray<{warm:boolean}>): number`(:132,冷 4.5s / 暖 2.5s 取 max)<br>`sendAtUs(audibleUs: bigint, latencyFrames: number, rate: number): bigint`(:139) |
| 关键常量 | 漂移阈值 `441` 帧(=10ms@44.1k,`driftCorrection` 的 `thresholdFrames` 缺省);冷/暖 lead 取自 `rates.ts` |
| 状态归属 | 纯函数 |
| 上下游 | 上游:`bridgeSession.ts`、`raop.ts`(:525-530 四锚点);下游:无 |
| 失败模式 | ①用 `& 0xFFFFFFFF` 截断 → 边界 −1,352 对齐失效(守卫 ⑫);②换算里出现墙钟 → 锚点被 NTP 回拨带歪(守卫 ①) |

## 9.13 `rates.ts`（128 行）

| 项 | 内容 |
|---|---|
| 职责 | 采样率 / 重采样 / 桥接全部**常量唯一源**(改值只能改这里) |
| 对外导出 | `SENDSPIN_RATE=48000`(:6)/`AIRPLAY1_RATE=44100`(:9)/`AP2_RATES=[48000,44100]`(:12)/`RESAMPLE_L=147`(:19)/`RESAMPLE_M=160`(:21)/`RESAMPLE_GROUP_DELAY_OUT_SAMPLES=16`(:25)/`RESAMPLE_GROUP_DELAY_MS=0.3627`(:28)<br>`BRIDGE_COLD_START_LEAD_US=4_500_000`(:35)/`BRIDGE_WARM_START_LEAD_US=2_500_000`(:37)/`BRIDGE_MIN_BUFFER_US=1_000_000`(:39)/`ANCHOR_SAFE_LEAD_US=800_000`(:54)<br>`BRIDGE_QUEUE_HIGH_WATER_BYTES=384*1024`(:61)/`BRIDGE_QUEUE_HARD_CAP_BYTES=1536*1024`(:63)/`BRIDGE_BACKOFF_BASE_MS=5_000`(:65)/`BRIDGE_BACKOFF_MAX_MS=30_000`(:67)<br>`BRIDGE_PCM_BYTES_PER_SEC=192_000`(:75,48k×2ch×2B)/`BRIDGE_QUEUE_HIGH_WATER_MS=2_000`(:78)/`BRIDGE_QUEUE_HARD_CAP_MS=8_000`(:80)/`BRIDGE_RECEIVE_OVERFLOW_MS=8_000`(:82)/`BRIDGE_HEARTBEAT_INTERVAL_MS=1_000`(:84)/`BRIDGE_STALL_NO_FRAME_MS=2_000`(:86)<br>`RAOP_SAFETY_MS=50`(:89,RAOP 可达安全余量)/`BRIDGE_MAX_HELD_AUDIO_US=45_000_000`(:97)/`BRIDGE_RESUME_REBASE_US=2_000_000`(:100)<br>`PROTOCOL_CAPS: Record<BridgeProtocol, ProtocolCaps>`(:123) |
| 关键常量(为什么) | `ANCHOR_SAFE_LEAD_US=800ms` = 真机验证可用的**最浅**水位(再浅 esp32 就 underrun);`BRIDGE_MIN_BUFFER_US=1s` 是桥的最浅;`RAOP_SAFETY_MS=50`:桥首帧必须 ≥ `now + L/rate + 50ms` 才可能被 RAOP 排上 |
| 状态归属 | 常量 |
| 上下游 | 全链路 import;守卫 7.7 组③ 钉「唯一声明」 |
| 失败模式 | 任何常量在别处内联/重复声明 → 守卫红;真机改一处漏一处 = 半新半旧阈值(最难查) |

## 9.14 `session.ts`（90 行）

| 项 | 内容 |
|---|---|
| 职责 | AirPlay **独立取流凭证**:`/rest/airplay/stream/:token`,落 SQLite,同 `(songId, deviceId)` 未过期**复用 token 仅续期** |
| 对外导出 | `createAirPlaySession(songId: string, deviceId: string, baseUrl: string): { token: string; streamUrl: string; expiresAt: number }`(:29)/`resolveAirPlaySession(token: string): { songId: string; deviceId: string } \| null`(:68) |
| 关键常量 | `AIRPLAY_SESSION_TTL_MS = 30 * 60 * 1000`(:20) |
| 状态归属 | DB `airplay_stream_tokens`(token/song_id/device_id/exp)+ 降级内存表 `memoryTokens`(:65) |
| 上下游 | 上游:`protocolPlayer.ts::playMedia`;下游:`routes/rest/*` 取流 handler、`assertAirPlayStreamAuth` |
| 失败模式 | ①每次都 mint 新 token → 同曲 seek 后 `mediaUri` 变 → tracker 判「换歌」自动 advance(守卫 R22);②只放内存 Map → fork 模式下子进程看不到(<100B 之外的经典坑) |

## 9.15 `protocolPlayer.ts`（88 行）

| 项 | 内容 |
|---|---|
| 职责 | `ProtocolPlayer` 薄适配器:把 `playMedia/stop/pause/resume/seek/setVolume/pollState` 映射到 `control.ts`;**起播即落位** |
| 对外导出 | `createAirPlayProtocolPlayer(deviceId: string): ProtocolPlayer`(:27) |
| 关键常量 | 无(落点换算 `seekMs/1000` 见 :37) |
| 状态归属 | 无(每次调用新建,`playerId = airplay:<deviceId>`) |
| 上下游 | 上游:`player/UniversalPlayer`、`player/QueueController`、`group/protocolPlayer.ts` 的 fanOut;下游:`control.ts`、`session.ts` |
| 失败模式 | ①`playMedia` 里「先起播再 seek」→ 第二次 RECORD 让 HiVi 永久等待(§2.8);②`pollState` 漏 `mediaUri` → 换歌判据对 AirPlay 恒不可达(守卫 R7) |

## 9.16 `deviceState.ts`（87 行）

| 项 | 内容 |
|---|---|
| 职责 | 按设备音量/静音**持久化**(`airplay_device_state`),重启后回吐上次值 |
| 对外导出 | `DEFAULT_AIRPLAY_VOLUME = 80`(:26)/`getAirPlayVolumeState(deviceId): AirPlayVolumeState \| null`(:39)/`saveAirPlayVolumeState(deviceId, patch: {volume?, muted?}): void`(:54)/`deleteAirPlayVolumeState(deviceId): void`(:80)/`interface AirPlayVolumeState`(:28) |
| 关键常量 | `DEFAULT_AIRPLAY_VOLUME=80`(:26,与改造前内存缺省逐字一致 ⇒ 无持久行的旧行为不变) |
| 状态归属 | DB `airplay_device_state`(device_id 主键 / volume / muted / updated_at) |
| 上下游 | 上游:`control.ts::setAirPlayVolume/setAirPlayMuted`(**唯一写口**)、`bridgeSession.ts::pushInitialVolume`(读);下游:无 |
| 失败模式 | ①写死缺省 80 → 重启后所有播放器被强制成 80(§2.10);②删除设备时连带删行 → 设备重新上线即被重置 |

## 9.17 `ipcProtocol.ts`（76 行）

| 项 | 内容 |
|---|---|
| 职责 | 主↔子进程**业务载荷类型**(信封在 `rendererHost/ipcProtocol.ts`) |
| 对外导出 | `AirplaySnapshot`(:22)/`AirplayReadyInfo`(:27)/`AirplayChildEvent`(:36,`sessionEnded` + `AirplaySessionEndInfo`)<br>`BridgePrepareArgs`(:44,**含 `anchorShiftUs?: number`** :55)/`BridgePreparedResult`(:60)/`BridgeStopArgs`(:66)<br>`AirplayHostExtra = never`(:71)/`ParentToAirplayChild`/`AirplayChildToParent`/`AirplayStateEnvelope`(:76) |
| 关键常量 | 无 |
| 状态归属 | 类型 |
| 上下游 | 上游:`supervisor.ts`、`child.ts`、`childMain.ts`;下游:`rendererHost` 信封 |
| 失败模式 | ①在载荷里带 PCM → 守卫 ④(必须二进制 MFAB 帧);②`anchorShiftUs` 字段名改动而 CPU 两侧不同步 → 标定静默失效(值 0) |

## 9.18 `supervisor.ts`（75 行）

| 项 | 内容 |
|---|---|
| 职责 | 子进程宿主接线:心跳/快照/RPC/看门狗/退避重启,业务钩子只两条 |
| 对外导出 | `airplaySupervisor`(:75)/`interface AirplayMirror`(:26)/`interface AirplayHostHooks`(:30,`onSessionEnded`(:34)/`onBridgeChildRestarted`(:37)) |
| 关键常量 | `CHILD_ENTRY = resolveChildEntry(import.meta.url)`(:24,prod=dist/child.js / dev=src/child.ts) |
| 状态归属 | `airplaySupervisor.mirror.sessions: Map<deviceId, AirplaySessionMirrorRow>`(主进程只读镜像) |
| 上下游 | 上游:`control.ts`(`airplaySupervisor.rpc(...)`)、`group/protocolPlayer.ts`(重启钩子);下游:`child.ts` |
| 失败模式 | ①崩溃重启后不重建桥路由 → 泵侧顶着死 socket 无限退避(:60-63 的 `respawn` 钩子就是为此);②把会话态搬进主进程 → 7.98ms 节拍被前端请求打散(§1.2) |

## 9.19 `child.ts`（57 行）

| 项 | 内容 |
|---|---|
| 职责 | 子进程入口:致命兜底 → 装配 `AirplaySessionRuntime` → `mainReady` → 消息循环 |
| 对外导出 | 无(纯入口;`createProcessSend`/`installChildMessageLoop`/`exitChildSoon` 来自 `rendererHost/childBootstrap`) |
| 关键常量 | `LOG_NAME="airplay-child"`(:27)/`LABEL="airplay 子进程"`(:28)/`stop` 后 `exitChildSoon(200)`(:50) |
| 状态归属 | 进程本身 |
| 上下游 | 上游:`supervisor.ts` fork;下游:`childMain.ts` |
| 失败模式 | ①启动期消息先到 → controller 为 null 时**安全丢弃**(:47),不得抛错;②收尾不给自己留下 socket/UDP 端口 → 重启即 EADDRINUSE |

## 9.20 `bridgeCalib.ts`（44 行）

| 项 | 内容 |
|---|---|
| 职责 | **全局** A/V 标定位移 `bridge.avShiftMs`(无组上下文时的回落值;有组上下文一律走 `group/delayCalib.ts`) |
| 对外导出 | `BRIDGE_AV_SHIFT_KEY = "bridge.avShiftMs"`(:22)/`BRIDGE_AV_SHIFT_MAX_MS = 2000`(:23)/`BRIDGE_AV_SHIFT_MIN_MS = -2000`(:24)/`parseBridgeAvShiftMs(raw: string): number`(:27)/`getBridgeAvShiftMs(): number`(:39)/`getBridgeAvShiftUs(): number`(:42) |
| 关键常量 | 范围 ±2000ms;语义「正 = 桥整体延后」 |
| 状态归属 | DB `settings`(5s 缓存) |
| 上下游 | 上游:`routes/api/settings.ts`(`GET/PUT /v1/bridge/av-shift`)、`control.ts::bridgePrepareDevice`(:319 无组上下文分支);下游:`BridgePrepareArgs.anchorShiftUs` |
| 失败模式 | ①只改 settings 不重建桥 → 值不生效(锚点一次算死,§11.2);②误把它当 `latencyFrames` 调小 → 设备 underrun(见 §11.4 铁律) |

## 9.21 `mode.ts`（22 行）

| 项 | 内容 |
|---|---|
| 职责 | fork / in-proc 三开关判定(leaf,零依赖,避免循环依赖) |
| 对外导出 | `isAirPlayForkMode(): boolean`(:15) |
| 关键常量 | `defaultFork: true`(:20);`childEnv=MUSICFLOW_AIRPLAY_CHILD`(:17)/`inprocEnv=MUSICFLOW_AIRPLAY_INPROC`(:18)/`forkEnv=MUSICFLOW_AIRPLAY_FORK`(:19) |
| 状态归属 | 环境变量(VITEST 恒 in-proc) |
| 上下游 | 全模块 import;下游:`rendererHost/mode.ts` |
| 失败模式 | 文档/注释与实际默认值不一致会被误读(本文件头注释已在 2026-10-22 更新为「默认 fork」) |

## 9.22 行为 → 代码反查表（排障入口）

| 可观测行为 / 判据 | 代码坐标 |
|---|---|
| 设备发现(谁把设备加进表) | `discovery.ts::upsert`(:197) / `startAirPlayDiscovery`(:242) / `getAirPlayDevices`(:352) |
| AP2 能力判定 | `discovery.ts::upsertAp2`(:147) → `applyAp2`(:133) → `protoversAtLeast`(:117) |
| 取流 token 复用(同曲 seek 不换 uri) | `session.ts::createAirPlaySession`(:29,复用分支 :44-47);守卫 R22 |
| RTSP 握手三步与预算 | `raop.ts::connect`(:577):ANNOUNCE :626 / SETUP :634 / RECORD :659;预算 `rtspTimeoutFor`(:50) |
| RECORD 的 Audio-Latency → L | `raop.ts` :661-669(`Math.max(audioLatency, sampleRate)`),读:`negotiatedLatencyFrames`(:388) |
| 音频推送(RTP 定速) | `raop.ts::stream`(:807) / `sendChunk`(:728);桥接走 `streamBridge`(:908) |
| 音量 / 静音 | `control.ts::setAirPlayVolume`(:1177,先落库再 DLNA 转发)/`setAirPlayMuted`(:1205);映射 `decoder.ts::degreesToDb`(:31) |
| 桥会话初始音量 | `bridgeSession.ts::pushInitialVolume`(:45,读 `deviceState`) |
| seek 落位(默认重建) | `control.ts::seekAirPlay`(:1072,原地分支在 `AIRPLAY_SEEK_INPLACE=1` 才走 :1072+56 `prepareSeek`);`raop.ts::prepareSeek`(:1019)/`setStartPosition`(:1045) |
| 起播即落位(流转接续) | `protocolPlayer.ts::playMedia`(:31 `seekSec` 派生)→ `control.ts::castToAirPlayDevice`(:826) |
| 双协议互斥(AirPlay 起播前停 DLNA) | `control.ts::yieldSiblingDlnaForAirPlay`(:432),调用点 :501 / :982 |
| 反向互斥 / 收尾守卫(DLNA 不得误杀 AirPlay) | `control.ts::hasActiveAirPlaySessionForHost`(:356)/`stopAirPlaySessionsForHost`(:373) |
| 重启音量保持 | `deviceState.ts::getAirPlayVolumeState`(:39) + `control.ts::volumeStateOf`(:118) + `startAirPlayService`(:1351) |
| 源端收尾(客户端 reset) | `control.ts::stopAirPlaySession`(:404) / `stopAirPlay`(:1058);守卫 R29 |
| 子进程 RPC 超时/挂死 | `supervisor.ts::airplaySupervisor`(:75) → `childMain.ts::dispatch`(:77) → `sessionRuntime.ts::stop`(:272,`STOP_DEADLINE_MS`);兜底 `raop.ts::forceClose`(:1082) |
| 桥接环投递(谁推 PCM 给桥) | `sendspin/server.ts::bridgePushTick`(:830)→`deliverBridgeWindow`(:855);发送端 `bridgeSource.ts::enqueue`(:156) |
| 桥侧出声时刻(锚点) | `bridgeSession.ts::maybeBeginStream`(:496)→`planBridgeAnchor`(:198)→`raop.ts::streamBridge`(:908) |
| 桥代次切换(track/seek/stop/rehost) | `bridgeSession.ts::onBoundary`(:422);发送侧 `bridgeMember.ts::sendBoundary` / `notifyGeneration` |
| 解码归一(为什么这里没有 loudnorm) | `decoder.ts::buildAirplayAf`(:79) + `spawnDecoder`(:102);归一唯一出处 `routes/rest::resolveRequestAf` |
| 桥接 A/V 标定(按成员,v4.8.0) | `sendspin/server.ts::bridgeAnchorShiftUs`(:947)→`group/delayCalib.ts::bridgeAnchorShiftUsOf`→投递窗口/时戳位移(`server.ts:818-820`/`:885-887`/`:908`);桥内 `planBridgeAnchor` 的 `anchorShiftUs` **恒 0**(G13-b);无组上下文兜底仍走 `control.ts::bridgePrepareDevice`→`bridge.avShiftMs` |
| 桥降噪(realigned 刷屏) | `bridgeSession.ts::realignedLogLevel`(:79) |

# 第十部分：桥接环（BridgeRing）时间基准

> 一句话:**桥接环里只有一个时间基准 —— `tsUs`(组内容时间线,µs,host 单调时钟域)。**
> 投递窗口、水位、late-join 回填、对齐器、锚点全部以它为唯一输入;任何偏移(按组的
> Sendspin 延迟、桥 A/V 标定)都**只能作用于成员下发或内容落点**,绝不能改环里的 `tsUs`。
> 本部分逐条给出代码坐标,便于现场对照日志判断「到底哪一层歪了」。

### 10.0 「概念 → 代码符号」对照表（先对表，再读下文）

> ⚠️ 本部分此前使用的 `contentClock` / `contentSec` / `contentEpoch` **旧称，代码中不存在** —— 它们在 `backend/src/` 全库 grep 零命中,
> 是叙述用词、不是代码符号。下表把三个概念逐个映射到真实标识符,后文一律用右列的名字。

| 概念（叙述用词） | 代码符号（真实标识符） | 声明 / 赋值位置 | 含义 |
|---|---|---|---|
| 内容时钟；「0 点 = 桥首帧(pump 首帧)」 | `firstFrameTsUs` | 声明 `airplay/bridgeSession.ts:199`（`BridgeSessionOpts.firstFrameTsUs: bigint`）、字段 `:302`（`private firstFrameTsUs: bigint \| null = null`）、**首次赋值** `:402-403`（`if (this.firstFrameTsUs === null && a.tsUs !== 0n) { this.firstFrameTsUs = a.tsUs;`） | 本代内容的第一个非零 `tsUs`；之后的锚点、`deltaUs` 全部相对它 |
| 锚点（设备侧出声时刻） | `anchorUs = firstFrameTsUs + anchorShiftUs` | `airplay/bridgeSession.ts:209`（`let anchorUs = opts.firstFrameTsUs + BigInt(opts.anchorShiftUs ?? 0);`） | `anchorShiftUs` **现恒 0**(G13-b:补偿唯一落点 = 投递窗口/时戳位移,见第十一部分);`firstFrameTsUs` 是 0 点,`anchorUs` 是 0 点在设备时钟上的落点 |
| 内容位置基线（组时间戳推力基线） | `groupDelivered` / `peakBaseUs` / `jumpUs` | `sendspin/server.ts:1454`（`// 组内时间戳基线 = 本组自身累计交付的内容位置 + 本批游标相对批前峰值的跳变`，实算 `:1454-1463`） | 每编码组按自身累计交付字节打戳,不用共享游标(b93efc1 行为,见 10.2) |
| stats 里的 `w` / `m` / `clock` / `delta` | 真实字段 `ev` / `dev` / `gen` / `state` / `clock:"local-rtp-ntp"` / `queueMs` / `maxQueueMs` / `late` / `realigned` / `driftUs` / `deltaUs` / `deltaP95Us` / `samples` / `anchorUs` / `leadUs` | `airplay/bridgeSession.ts:637-660`（`emitStatsTick` 的 `console.log` JSON） | **没有 `w=` / `m=` 这两个字段**;见 10.6 判据表 |

**判据（两台成员是否齐）**:逐拍比对**两台**的 `deltaUs` / `deltaP95Us` / `queueMs` 三个字段
（**不是** `w` / `m` —— 代码里不存在），差异应落在同一数量级(< 10ms);若一台 `queueMs` 持续爬而另一台平稳,
则不平衡在**投递侧**;若 `queueMs` 都平稳但 `deltaUs` 差 > 20ms,则不平衡在**锚点/标定侧**。

## 10.1 三套时钟,先分清

| 时钟 | 记号 | 出处 | 谁在用 | 能不能被墙钟带歪 |
|---|---|---|---|---|
| **host 单调时钟** | `nowUs()` | `utils/hostClock.ts`(`process.hrtime.bigint()/1000n`,守卫 ⑦ 组①钉死) | 全链路唯一「现在」 | **不会**(NTP 回拨/系统时间调整都影响不到) |
| **组内容时间线** | `tsUs` | `sendspin/server.ts` 的 `pushFrame` 打戳(:1470-1481),`group.timelineBaseUs`(:645) | 成员下发、桥投递窗口、水位、late-join | 不会(纯 host 域推导) |
| **设备 RTP/NTP** | `baseTs` / `startNtp` / `headTs` | `raop.ts` RECORD 回执 + `bridgeMath.computeBridgeAnchors`(:76) | RTP 包头与 SYNC 包 | 不会(`ntpNow()` = `ntpFromHostUs(nowUs())`,守卫 ⑦ 组①) |

**结论**:三套都是 host 单调时钟的派生量,彼此只差常数偏移(锚点、L、标定位移)。

## 10.2 `tsUs` 的生产规则（唯一出处 `sendspin/server.ts::pushFrame`）

| 步骤 | 代码 | 说明 |
|---|---|---|
| ① 组时间戳基线 | :1455-1463 | `peakBaseUs = round(before / 48k)`、`jumpUs = tsUs − peakBaseUs`、`ts = round(groupDelivered / 48k) + jumpUs`。**每编码组按自身累计交付量打戳**,不用共享游标 |
| ② 成员下发 | :1479 | `c.sendAudio(ts + dspDelayUs, data)` —— **按组 Sendspin 延迟只加在这里** |
| ③ 入环 | :1480 | `ring.push({ tsUs: ts, durUs, data, ep })` —— **环里存裸 `ts`,不含 `dspDelayUs`** |
| ④ 逐帧推进 | :1490-1495 | `ts += round(frameSamples / 48k)`;**同一批多帧绝不复用同一 ts**(第 2 帧会被判过期 → 设备吐字节 → underrun) |
| ⑤ 逐出 | :1534-1548 `pruneRecent` | `ts + dur ≤ now − LATE_JOIN_KEEP_PAST_US(1s)` 逐出;总量上限 `LATE_JOIN_RING_MAX_US = 35s` |

**为什么必须按组打戳(b93efc1,别再改回去)**:桥在场时 BLK-01 的 `pcm:100` 虚拟组每 25ms
交付一次、`flac` 每 4096 样本(85.33ms)才交付,共享游标被 pcm 拉成连续步进;flac 若用共享
游标打戳,戳间距在 75/100ms 间振荡(内容恒 85.33ms),esp32 的硬同步阈值只有 5ms ⇒ 真机
`Lost sync 14.68 / 64.7 / 89.7ms` 三元组风暴(桥在场即现、移出即愈)。

## 10.3 「0 点」到底在哪（纠正一个常见误读）

时间线的原点**不是 0,也不是设备时钟**,而是**每次起播/重锚时落定的锚点**:

```
streamEngine.ts:880-903
  anchor = nowUs() + lead          // lead 见下表
  clamped = max(anchor, cursorUs)  // ⚠️ 严格大于上一帧 ts,时间轴永不倒退
  group.timelineBaseUs = clamped
  tsUs = cursorUs = clamped        // 首帧 tsUs 就是它
```

| 组形态 | `lead` | 代码 | 为什么 |
|---|---|---|---|
| 纯桥组(`hasBridges && !hasDirectMembers`) | `max(sendAhead, bridgeStartLeadUs([{warm:false}]))` = 4.5s | `streamEngine.ts:888` / `bridgeMath.ts:132` | 单成员就足够深,深锚收益最大 |
| **混合组**(桥 + 直连 sendspin) | `max(sendAhead, mixedAnchorLeadUsOf(group) ?? BRIDGE_MIXED_GROUP_ANCHOR_LEAD_US)` = 自动 5s(**v4.9.0 起组级可配**) | `streamEngine.ts:921` / `sendspin/constants.ts:111` / `group/delayCalib.ts`(`mixed_anchor_lead_ms`) | 桥会话重启(0xE0)后接收端就绪窗口实测 ≈2~3s,lead 低于窗口 ⇒ 切歌吞开头 100% 复现(1.75s 吞 1~2s / 3s 吞缩短 / 5s 不吞,v4.7.6 定标取 5s);代价 = 切歌全组静默 ~5s ⇒ **v4.9.0 起前端按组调**:`player_groups.mixed_anchor_lead_ms`(NULL/0 = 自动 5000ms,>0 = 用户值,0~30000 步进 100),子进程绕 delayCalib cache 直查 db(cache 无失效广播,结构性陈旧),PUT 后下一首切歌生效、无需重建;纯桥组深锚与非桥分支不变 |
| 无桥 + 预填充开 | `min(sendAhead, ANCHOR_SAFE_LEAD_US)` = 800ms | `streamEngine.ts:891` | 起播延迟与缓冲深度解耦 |
| 其余 / seek 重锚 | `reseedLead ?? aheadUs` | `streamEngine.ts:892` | 保时间轴单调 |

可 grep 的日志锚点(`streamEngine.ts:912`):
`sendspin timeline anchored: base=<µs> lead=<µs>us (sendAhead=<µs>us) frameMs=… frameSamples=…`,
seek 后为 `sendspin timeline RE-anchored after seek: pos=<ms>ms base=…`。

## 10.4 桥投递窗口与水位（`sendspin/server.ts`）

| 概念 | 代码 | 规则 |
|---|---|---|
| 窗口下沿 | `bridgePushTick`(:842) + `BRIDGE_PUSH_FLOOR_US = 1_500_000`(`constants.ts:88`) | `ts' < now + 1.5s` 的帧**丢弃并推水位**(桥来不及排程) |
| 窗口上沿 | `BRIDGE_PUSH_HORIZON_US = 2_500 * 1000`(`constants.ts:85`) | `ts' > now + 2.5s` **顺延**到下一 tick,不投不推 |
| 投递换算 | `deliverBridgeWindow`(:868) | `pushAudio(e.data, e.tsUs − commonSendAheadUs())` —— 桥的对齐器是 `send_ahead=0` 语义,换算后「桥可听时刻 = 设备出声时刻」 |
| 补投周期 | `BRIDGE_PUSH_TICK_MS = 250`(:828) | 1s 宽窗口,每 250ms 投一次,字节平滑 |
| 水位 | `bridgeWatermarks`(:720) | 每桥一份「已投到哪个 ts」;`0n` = 本代次尚未投递 |
| 回填 | `backfillBridge`(:784) | 播中新桥加入:只投窗口内的**当前代次**帧,总量封顶 `BRIDGE_BACKFILL_MAX_US = 6s`(`constants.ts:98`) |
| 代次戳 | `bridgeContentEpoch`(:724) + `notifyBridgeGeneration`(:742) | 换代即 `epoch++` + 清水位 + 停旧代次帧;`ep` 缺失 = 不可信 = 不投 |

**排障口径**:投不出音频先看三件事 —— ①`ep` 是否等于当前 `bridgeContentEpoch`;②水位是否
已经被推过(`ts < lo` 的帧会被水位吃掉,永不补投);③`commonSendAheadUs()` 是否被桥污染
(守卫 ⑦ 组⑧ 钉死「体内不得出现 bridge/lead」)。

## 10.5 桥侧出声：锚点一次性算死

```
bridgeSession.ts:496  maybeBeginStream()
  :498  if (this.aligner !== null) return;      // ← 已经立过锚就不再算
  :500  latencyFrames = max(1, player.negotiatedLatencyFrames)   // RECORD 协商值,不得归零
  :501  plan = planBridgeAnchor({ firstFrameTsUs, latencyFrames, rate, resampled, nowUs, anchorShiftUs })
  :514  this.aligner = new BridgeTimelineAligner(plan.anchorUs, rate)
  :515  this.streamAborted = false
  :518  player.streamBridge(pullChunk, session, plan.anchors, …)
```

`planBridgeAnchor`(`bridgeSession.ts:198`)的完整公式:

```
A  = firstFrameTsUs + anchorShiftUs                     // 标定位移只在这里生效
可达 ⇔ A − L − SAFETY ≥ now                            // L = latencyFrames / rate,SAFETY = 50ms
不可达 ⇒ A = max(now + warmLead(2.5s), A),reAnchored = true   // 更早内容由对齐器 drop 出清
四个锚点 = computeBridgeAnchors({A, L, rate, chunkLen:352, compensateGroupDelay: resampled})
commandedLeadUs = A − now
```

**关键结论(直接影响标定工作流)**:`aligner` 一旦建立,`maybeBeginStream` 直接 return ⇒
**`anchorShiftUs` / `latencyFrames` 在会话存活期间不可能改变**。改标定值必须让桥会话重立锚:

| 触发方式 | 代码 | 代价 |
|---|---|---|
| 组播中 PUT `/v1/groups/:id/delays`(airplayMs 变化且桥在跑) | `routes/api/groups.ts:141-145` → `rebuildBridgeRoutes(id)`(`group/protocolPlayer.ts:99`) | 该组 AirPlay 成员约 1~2s 静音,Sendspin 不受影响 |
| 桥收到 `BOUNDARY{track}` | `bridgeSession.ts:422` → `aligner = null`(:430-433) | 下一次 `maybeBeginStream` 用**当时的** `opts.anchorShiftUs` 重算;但 `opts` 由 `bridgePrepare` 一次下发,会话内不会自刷新 |
| 桥代次 `rehost`(泵重连) | `bridgeMember.ts::onConnected`(:193-217) | 新 generation + 重锚 |

## 10.6 stats 判据（`[airplay-bridge] {ev:"tick"}`，每设备 2s 一行）

代码:`bridgeSession.ts::emitStatsTick`(:622),日志 :640-661。**字段全表**(实测 v4.6.77):

| 字段 | 含义 | 判据 |
|---|---|---|
| `dev` / `gen` / `state` | 设备 / 代次 / 状态(`listening\|connected\|live\|paused`) | `state=live` 才在推流 |
| `clock` | 恒 `"local-rtp-ntp"` | 出现别的值 = 时钟域已被改坏(守卫 ⑦ 组①) |
| `queueMs` / `maxQueueMs` | 出缓冲积压(ms) | 稳态 1~5ms;>25ms 说明泵一侧供料不匀;接近 1000ms 说明整秒积压 |
| `late` | `player.bridgeLateCount`(lead 不足的包数) | 恒 0 才是健康;增长 = 锚点过紧/设备 L 偏小 |
| `realigned` | 对齐动作累计次数 | 稳态不涨(无动作的恒定漂移已降 `debug`,见 `realignedLogLevel`) |
| `driftUs` | 当前对齐残差(µs) | \|drift\| ≤ 1ms;持续 ±几十 ms = 内容与锚点错位 |
| `deltaUs` / `deltaP95Us` / `samples` | 已写入 RAOP 的内容前沿相对 A′ 的超前量(≈ L + 队列 + 在途) | **A/V 同步的权威判据**:两台成员同一时刻的 `deltaUs` 应几乎相同;恒偏 X 就是锚点错 X(与 drift 可区分) |
| `anchorUs` / `leadUs` | 落定锚点 / `commandedLeadUs` | 切歌那次应 ≈ `base + lead`;`leadUs` 稳定 = 未自锚 |

> ⚠️ 旧文档/口头常见的 `w=` / `m=` / `contentClock` 三个名字 **旧称，代码中不存在**
> (全仓 `grep contentClock` 无命中;`stats` 事件名亦为 `ev:"tick"`)。请以本表字段为准。

**「两台成员逐拍相同才算齐」的操作口径**:同一组、同一首歌,分别 grep 两台设备的
`{ev:"tick"}` 行,按时间抖动 ±100ms 内配对比较 `deltaUs` 与 `queueMs`:差值 < 5ms 视为齐;
`deltaUs` 相差一个常量 = 其中一台的锚点/标定不同(纯桥组见 §11)。

## 10.7 五个必踩的坑（已固化在守卫里）

1. **环里的 `tsUs` 不许加任何偏移** —— 加了会把桥投递窗口/水位/late-join 一起带偏(§11.4)。
2. **不许用共享游标给成员打戳** —— 见 §10.2 末尾的 b93efc1 事故。
3. **不许让 `latencyFrames` 归零** —— 它是设备保持深度 + SYNC 广告值(守卫 ⑦ 组②)。
4. **不许在换算里引入墙钟** —— `Date.now()` 出现在 `hostClock`/`clock.ts`/`bridgeMath.ts`/`raop.ntpNow` 即红。
5. **不许把桥集合并进 `members` 或 `commonSendAheadUs`** —— 前者破坏成员语义,后者让全组 +3.7s(MAJ-01)。

# 第十一部分：群组 A/V 延迟补偿（R31，v4.6.77 引入；v4.8.0 起按成员）

> **问题**:同一台机器两种身份(AirPlay 桥 / Sendspin)出声时刻差一个常量。
> 桥的可听时刻 = `startNtp + L_true`,而 `startNtp = A − L_assumed`(我们用 RECORD 回包的
> `Audio-Latency`,缺省 1s)。HiVi(00226CFFA0C0,MUZO 固件)**根本不回 `Audio-Latency`**
> ⇒ `L_true` 协议上不可知 ⇒ 桥整体早/晚 `(L_true − L_assumed)`。Sendspin 侧是按帧头
> `ts − send_ahead` 出声的确定性实现 ⇒ 只能靠**人工标定**把这个常量补掉。
> R31 把这条能力做成**按成员、独立可调**(v4.8.0 起存储为 `player_groups.member_delays_json`,
> 每个成员一格,不再按协议三格)。

## 11.1 语义与存储（**正数 = 该设备更晚出声**）

| 项 | 说明 |
|---|---|
| 存储 | `player_groups.member_delays_json`(text, default "{}"):命名空间成员 id → ms 的 JSON map |
| 键 | `airplay:<deviceId>`(桥投递窗口/时戳位移) / `sendspin:<clientId>`(帧级下发戳偏移) |
| 范围 | ±30000ms / 步进 10ms / 越界钳到边界 / 缺省 0(新组与旧三格**均归零**,v4.8.0 旧列删除不迁移) |
| 读写 | `services/group/delayCalib.ts`(178 行):`getMemberDelays` / `getMemberDelayMs` / `setMemberDelay` / `getTrackLeadMs` / `clampGroupDelayMs` |

范围、解析、缓存语义、DB 迁移、接口与前端入口,**唯一出处是
[group-权威方案文档.md](./group-权威方案文档.md) §6**(坐标:`delayCalib.ts:23-26`、`:51-55`、`:77-100`、`:113+`;
`db/schema.ts` 的 `memberDelaysJson`;`routes/api/groups.ts:113-188`)。本文件只保留
**AirPlay 侧链路**与**铁律** —— 这两处是「改完必须重建/自愈桥」的成因,属 airplay 侧独有。

> ⚠️ 口径**以常量为准**:`GROUP_DELAY_MIN/MAX_MS = ±30000`(`delayCalib.ts:23-24`)。
> 历史「±2000」是过期口径。v4.8.0 前的「三格(airplay/airplay2/sendspin_delay_ms)」与
> 「AP1 内置 300ms 播种」均已删除,不要在任何新代码/文档里引用。

## 11.2 AirPlay 成员侧链路（投递窗口/时戳位移 + 重建/自愈）

```
member_delays_json["airplay:<deviceId>"]
  └─ bridgeAnchorShiftUsOf(groupName, deviceId)          // delayCalib.ts，动态读缓存
       └─ SendspinGroup.bridgeAnchorShiftUs(deviceId)     // server.ts:947-949
            ├─ 补投窗口: lo/hi = now + FLOOR/HORIZON + ahead − shift   // server.ts:818-820 / 885-887
            └─ 投递时戳: 与窗口同一取值, ts' 同加 shift                 // server.ts:908

routes/api/groups.ts:129  PUT /v1/groups/:id/delays  {memberId, ms}
  └─ members.includes(memberId) 校验(越组写入 400 memberNotInGroup)
  └─ setMemberDelay(id, memberId, ms)                    // 内存先更新,再落库
  └─ 仅 memberId 以 airplay: 开头且 after !== before:
       ├─ isBridgeRouteActive(id) → rebuildBridgeRoutes(id)  // 重建该组桥(该组 AirPlay ~1-2s 静音)
       └─ 桥在播但路由登记缺失 → bridgeJoinMember 逐成员兜底自愈(2026-10-27,幂等)
```

**为什么 AirPlay 侧要重建/自愈**:补偿随**桥会话建立**锚定(`maybeBeginStream` 幂等闸门,
`bridgeSession.ts:498`),已建会话不会中途重算;投递窗口/时戳虽是动态读,其位移的完整可听
效果要等下一次会话建立才兑现。Sendspin 成员无此问题(帧级)。

> **铁律(G13-b,别改回去)**:桥内锚点 `anchorShiftUs` **恒 0**。v4.6.77 曾把补偿接在
> `planBridgeAnchor.anchorShiftUs`,真机实锤「锚点也平移 = 双加,对齐器把多出的那份判
> 内容超前整段裁掉」——切歌吞 2 秒、净补偿归零。v4.7.x 起补偿唯一落点 = 投递窗口/时戳位移。

## 11.3 Sendspin 成员侧链路（帧级实时）

- 链路:`sendspinDelayUsOfClient(groupName, clientId)`(delayCalib.ts,动态读)→ `server.ts:1428 sendspinDelayUsOf(clientId)` → 逐拍下发 `:1522 c.sendAudio(ts + …, data)`;迟到回填逐客户端各自偏移(`:1658`)。
- 实时性:PUT 写缓存 ⇒ 下一次 `pushFrame`(约 0.5~1s,取决于设备 `send_ahead`)即按新值打戳,无会话重建。
- **late-join 回填必须同偏移(逐客户端)**:回填不同步会让新成员「一进场就错位、后进门」。
- 完整链路图与环语义见 [group-权威方案文档.md](./group-权威方案文档.md) §6.4。

## 11.4 铁律（导致「AirPlay 被一起带偏」的那条）

> **偏移只作用于「成员下发戳」与「桥内容落点」;`recentByGroup` 里的 `tsUs` 一律不动。**

`ring` 的 `tsUs` 是桥投递窗口(`sendspin/server.ts:842-894`)、水位(`:720`)、late-join 回填
(`:1569-1610`)、对齐器的唯一时间基准。若把 `dspDelayUs` 提前加到 `ts` 上,
`seedLateJoin` 会把延迟算两遍(成员下发 +1 次、回填 +1 次),且桥投递窗口整体平移
⇒ 表现为「调 Sendspin 延迟,AirPlay 反而更糟」。代码里 `ring.push` 明确用裸 `ts`(:1480),
`sendAudio` 才带偏移(:1479),注释也写在同一处。

## 11.5 验收判据（不依赖人耳）

| 步骤 | 期望 |
|---|---|
| ① 未标定(成员值全 0)的同组播放 | 两台设备的 `{ev:"tick"}` 行 `deltaUs` 相差一个**恒定**量(即 `L_true − L_assumed`),`driftUs` 均 ≤ 1ms |
| ② PUT `{memberId:"airplay:<dev>", ms:+X}` 且桥在跑 | 响应 `rebuilt ≥ 1`;日志 `[group][bridge] … bridge-sync` 重新出现;桥侧先 `sessions: stop` 再 `prepare`(同 token)或走 join 自愈 |
| ③ PUT 后重放同一首歌 | 两台 `deltaUs` 差值缩小 \|X\|;调到 0 附近即对齐 |
| ④ 只改 `sendspin:` 成员 | 不重建桥(`rebuilt = 0`),下一批 `pushFrame` 生效;`frame` 戳与 ring `tsUs` 的差 = 新偏移 |
| ⑤ 纯 AirPlay 组 / 纯 Sendspin 组 / 同协议两台 | 各自单独调,互不影响(按成员一格) |
| ⑥ 重启后端 | GET 回读值不变(落库);GET 的 `memberDelays` map 带全部当前值 |

## 11.6 守卫与用例

| 项 | 内容 |
|---|---|
| 单测 | `tests/group/delayCalib.test.ts`(成员级钳制 / 落库回读 / 单成员写 / 单位换算 / 非法 JSON 兜底)、`tests/routes/apiGroupDelays.test.ts`(默认 0 / 越组 400 / 越界钳制 / 单成员更新 / `trackLeadMs` 隐藏口 / 组不存在 404) |
| 静态守卫 | `check-group-invariants.mjs` G7(`tsUs` 不进 ring)/ G10 / G11 / **G13(按成员,含 G13-b 锚点恒 0)**;`check-airplay-bridge.mjs` 组⑧:`commonSendAheadUs` 体内不得出现 bridge/lead |
| 回归风险 | ①`ring.tsUs` 被加偏移;②重建范围写成「全部组」而非 `onlyGroupId`;③只改 Sendspin 成员时也重建桥(白掉 1~2s 静音);④取值口串格(airplay 成员读成 sendspin 格);⑤`parseUserGroupId` 放宽到裸 clientId(设备组会被套上组的偏移) |


# 附录 A：日志锚点速查

| 场景 | 关键字 | 关键字段/判据 |
|---|---|---|
| 起播分段 | `AirPlay 起播分段耗时` | — |
| 握手各步 | `RTSP ANNOUNCE` / `RTSP SETUP` / `RTSP RECORD` | 后接 `<status> <ms>`;`(握手总耗时 <ms>)` |
| RECORD 协商 L | `audio latency: <n> frames -> sync latency <m> frames (<ms>ms)` | **不出现这行 = 设备没回 Audio-Latency**(HiVi/MUZO 现场即如此 ⇒ 必须靠 R31 标定) |
| 互斥 | `双协议互斥` / `互斥:开始` | — |
| 设备闸 | `[AirPlay][gate] <id> 排队 <ms>ms 后开始` | 排队 >1s = 有并发 cast/seek 撞闸 |
| 超时 | `RTSP <method> timeout` / `cast 挂死` | 后者说明硬顶到了,会话已被回收 |
| 音量 | `SET_PARAMETER volume=` / `volume <n> forwarded to DLNA device <id>` | 后者是 LinkPlay 真正生效的那条 |
| 桥初始音量 | `push initial volume: <-x>dB (vol=<n>%) device=<id>` | 每次桥会话建立一行;**复用会话后不再出现属正常** |
| 会话结束 | `sessionEnded` / `IDLE pos=` | `current:false` 的 IDLE 被抑制(不打印) |
| 桥代次 | `[airplay-bridge] {"ev":"gen",…,"reason":"track\|seek\|stop\|rehost"}` | 换代必伴随 `ev:"stale"`(若确有旧帧) |
| 桥锚点 | `[airplay-bridge] {"ev":"anchor",…}` | 看 `scheduledAnchorUs` / `commandedLeadUs` / `latencyFrames` / `reAnchored` |
| 锚点不可达 | `anchor unreachable: … → re-anchor <µs>(丢弃更早内容)` | 桥自己等太久才立锚(首帧过旧) |
| 桥稳态 | `[airplay-bridge] {"ev":"tick",…}` | 判据见 §10.6;A/V 权威字段 `deltaUs` |
| 桥背压/硬上限 | `bridge backpressure <ms>ms > 2000ms` / `bridge hardCap <ms>ms > 8000ms,断连重连` | 后者 = 对端 8s 没读,必然重连 |
| 桥投递 | `bridge-backfill group=… frames=… durUs=…` / `bridge-sync group=… before=… after=…` | 播中加入 / 路由变化 |
| 桥对齐降噪 | `[airplay-bridge] realigned …` | 无动作恒漂移已降 `debug`(WARN 只剩真动作) |
| 组延迟补偿 | `[bridge] A/V 标定位移已更新 ms=<n>`(全局)/ PUT 响应 `rebuilt` | 按组改走 `/groups/:id/delays` |
| 桥子进程重启 | `bridge reconnected, new generation=<n>` / `onBridgeChildRestarted` 触发重建 | 重建日志:`子进程重启重建: x/y 座桥已重锚定` |

# 附录 B：环境变量与端点

| 项 | 值 |
|---|---|
| `MF_CAST_TIMEOUT_MS` | cast 硬顶(默认 30000) |
| `AIRPLAY_CONNECT_BUDGET_MS` | connect 总预算(默认 12000) |
| `MUSICFLOW_AIRPLAY_FORK` | `1` 显式启用子进程模式(**默认已启用**) |
| `MUSICFLOW_AIRPLAY_INPROC` | `1` 强制主进程内装配(排障回落;VITEST 恒 in-proc) |
| `MUSICFLOW_AIRPLAY_BRIDGE` | `0` 关闭整条桥接路径(路由不 prepare、组不挂桥) |
| `AIRPLAY_SEEK_INPLACE` | `1` 才走「原地 FLUSH 换解码器」实验路径(默认 = 完整重建会话) |
| `AIRPLAY_STOP_DEADLINE_MS` | 子进程单会话收尾硬上限(默认 4000) |
| 取流 | `/rest/airplay/stream/:token` |
| 设备表 | `airplay_devices`(DB) |
| 会话凭证 | `airplay_stream_tokens`(DB,TTL 30min,同 song+device 复用) |
| 设备音量态 | `airplay_device_state`(DB,`volume` / `muted`) |
| 组延迟补偿(按成员,v4.8.0) | `player_groups.member_delays_json`(DB,成员 id → ms,±30000ms) |
| 全局标定位移 | `settings['bridge.avShiftMs']`(±2000ms,仅无组上下文兜底) |
| 组延迟接口 | `GET/PUT /rest/api/v1/groups/:id/delays` |
| 全局标定接口 | `GET/PUT /rest/api/v1/bridge/av-shift` |

# 附录 C：本文覆盖的版本变更

| 版本 | 变更 |
|---|---|
| 4.6.52 | 流转接续三层根因修复:起播即落位 / cast 超时不杀进程 / 全链路硬预算 |
| 4.6.53 | 互斥硬上限移入助手内部(修复 R2 守卫计数) |
| 4.6.66 | 流转/seek 落位改走服务端 `?timeOffset=N`(解码器不再对 live FLAC 做 `-ss`,守卫 R28) |
| 4.6.67 | DLNA 停稳窗 + `stopDevice` 反向守卫(流转后 reset 源端不再误杀 AirPlay 输出,守卫 R29;§2.11) |
| 4.6.70 | AirPlay 默认独立子进程(与 sendspin 对齐):RTSP close reject / 收尾 4s 硬顶 / 追赶让出事件循环 / fork 偏移对齐,守卫 R30(§1.2、§2.12) |
| 4.6.7x | 桥接环落地:MFAB 通道 / 可听域窗口化投递 / 组内按组打戳(b93efc1)/ 深锚仅纯桥组 / aligner drop 钳制 / `realigned` 降噪;详见 §9~§10 |
| **4.6.77** | **群组 A/V 延迟补偿(R31)**:`player_groups.airplay_delay_ms` / `sendspin_delay_ms`(±30s,步进 10ms,正=更晚);AirPlay 侧接 `bridgePrepareDevice.anchorShiftUs`(取代全局 `bridge.avShiftMs`,迁移一次性继承),改完只重建**该组**桥;Sendspin 侧帧级实时(`pushFrame` 戳偏移 + `seedLateJoin` 同偏移);接口 `GET/PUT /v1/groups/:id/delays`(响应带 `rebuilt`);**铁律:环里 `tsUs` 一律不动**(§11) |
| 4.6.77 同时 | 混合组锚点 lead 由 `min(sendAhead,800ms)=500ms` 抬到 `BRIDGE_PUSH_FLOOR_US + BRIDGE_PUSH_TICK_MS*1000 = 1.75s`(修「每首歌开头丢 1s」,`sendspin/constants.ts:96`);桥投递恢复 `ts' = ts − sendAhead` 并把窗口边界整体 +sendAhead 搬回原 ts 域(修桥恒晚 500ms + 首帧自锚 2.5s) |
| 4.7.x | 延迟三格化(AP1/AP2/Sendspin 独立格)+ 补偿落点改**投递时戳位移**(桥内锚点恒 0,G13-b,修「锚点双加被对齐器裁掉」)+ join 兜底自愈 + 混合组锚点 lead 抬到 5s(`BRIDGE_MIXED_GROUP_ANCHOR_LEAD_US`,修切歌吞新歌开头) |
| **4.8.0** | **延迟补偿改按成员**:`member_delays_json`(成员 id → ms)取代三格列(旧列 DROP,值不迁移);取消 300ms 播种;取值口 `bridgeAnchorShiftUsOf(groupName, deviceId)` / `sendspinDelayUsOfClient`;PUT 改 `{memberId, ms}`(越组 400);前端改成员弹窗(§11 全节重写) |
| **4.9.0** | **混合组切歌等待按组可配**:`player_groups.mixed_anchor_lead_ms`(可空;NULL/0 = 自动 5000ms,>0 = 用户值,0~30000 步进 100)取代混合组锚点 lead 的全局常量;消费点 `streamEngine` 混合组分支组值优先回退 `BRIDGE_MIXED_GROUP_ANCHOR_LEAD_US`,读值**绕 delayCalib cache 直查 db**(cache 懒加载+写时更新、无失效广播 ⇒ 子进程结构性陈旧);`GET/PUT /v1/groups/:id/delays` 收发 `mixedAnchorLeadMs`,前端群组卡片「切歌等待」弹窗;PUT 后下一首切歌生效、无需重建;纯桥组深锚与非桥分支不变;守卫 G19(+7 条,76→83) |
| **4.9.1** | **删除切歌垫片组值手动口**:`player_groups.track_switch_lead_ms`(幂等 DROP 迁移)+ `getTrackLeadMs`/`setTrackLeadMs`/`trackSwitchLeadUsOf` + API 收发 `trackLeadMs` 全部移除;垫片机制本身(pendingTrackLeadUs 冷/暖动态 + 逐帧消耗)一行不动,动态自动挡不变(默认 0=自动从未生效,前端零引用);守卫相关断言反转为不存在性防复活;与混合组锚点 lead(4.9.0)是两道独立防线,分工注释已补 |
| 未发布(本文同批) | 桥会话音量回落修复(缺陷 **D-1**):`BridgeSession.setVolumeDb`(`bridgeSession.ts:773`)+`BridgeSessionManager.setVolumeDb`(`:833`)+`childMain.ts:119` 的「native 未命中回落桥」——桥占用设备的volume RPC 不再恒落空;回归用例 `tests/airplay/bridgeVolumeRouting.test.ts`(7 个 `it`);缺陷 **D-2**(每首歌无条件 teardown+prepare 桥路由)明确**留待下一轮**,见附录 D |

# 附录 D：已知缺陷 / 待排期（2026-10-26 盘点）

> 只写**代码此刻的真实行为**与影响，不写「本应如何」。修完请回来把该行状态改成「已修（版本/commit）」。
> 判断依据一律是代码坐标，不引用聊天记录。

| # | 现状（代码事实） | 线上影响 | 状态 | 代码坐标 |
|---|---|---|---|---|
| D-1 | 桥占用设备的音量 RPC 曾经只查 native 会话表（`sessionRuntime.ts` 的 `this.sessions`），而桥会话在**另一个**表（`childMain.ts` 的 `bridgeSessions`），且该表没有按 deviceId 下发的入口 ⇒ `setVolumeDb` RPC 对桥占用设备**恒落空** | 桥设备（现场 HiVi）切歌 / 拖音量条 / 进出静音后，音量**冻结在起播值**；`push initial volume` 只在建会话（`bridgeSession.ts:374`）与 RAOP 重连（`:586`）各推一次 | **已修（2026-10-26）**：`BridgeSession.setVolumeDb`（:773）+ `BridgeSessionManager.setVolumeDb`（:833）+ `childMain.ts:119` 的「native 未命中回落桥」；回归用例 `backend/tests/airplay/bridgeVolumeRouting.test.ts`（7 个 `it`） | `bridgeSession.ts:773` / `:818` / `:833`、`childMain.ts:119-129` |
| D-2 | `group/protocolPlayer.ts::playMedia` 每次起播**无条件**先 `teardownBridgeRoute()` 再 `prepareBridgeRoute()`（`:320-324`），即使路由存在、deviceId 集合与 `apOnline` 完全一致、每个设备都 `isBridgeOwned` | 每首歌拆一次桥：① 设备侧 TEARDOWN/SETUP/RECORD 重握手（现场约 1~2s 静音）② 新 token ⇒ 新桥会话 ⇒ 音量走 `pushInitialVolume` 而非「保持当前值」（D-1 修好后不再表现为**音量丢失**，只剩**重建开销**）③ `maybeBeginStream` 的锚点一次性算死（`:498` `if (this.aligner !== null) return`），重建必然重锚 | **已修（v4.7.x 暖复用）**：复用条件 = 路由存在 + deviceId 集合与 `apOnline` 完全一致 + 每个 device `isBridgeOwned`；命中则跳过 teardown/prepare，并打 debug `[group][bridge] <gid>: 复用既有桥路由(切歌不重建)` | `group/protocolPlayer.ts:313`（`playMedia`）、`:320-324`（无条件拆/建：`:321` teardown、`:324` prepare）、`teardownBridgeRoute`(:278)、`prepareBridgeRoute`(:289)、`bridgeSession.ts:498` |

**D-2 与 D-1 的关系（别混）**：D-2 是**性能/重锚**问题，D-1 是**功能**问题（音量落不到设备）。两者均已修复：D-1 见上；D-2 由 v4.7.x「桥路由暖复用」修复（`routeReusable` 判据，`group/protocolPlayer.ts:437-443`，守卫 G13 钉死）——成员集合与桥参数未变时切歌复用既有路由与 token，不再无条件拆建桥。


---

## v4.9.3 增补(方向 A,2026-10-28)

| # | 变更 | 现状(代码为准) | 位置 |
|---|------|------------------|------|
| A-1 | 桥 owner 带组归属 | bridgeOwners 由 deviceId→token 升级为 deviceId→{token,groupId};registerBridgeOwner 增第三参(groupId 缺省 null);新增 bridgeOwnerGroupOf 读取 | airplay/control.ts |
| A-2 | 同 host DLNA 互斥豁免细化(接管语义) | stopAirPlaySessionsForHost 对桥占用设备:归属组仍存在且设备仍是成员(含 bridgePrepare 进行中窗口)⇒ 豁免;组已解散/设备已移出 ⇒ 孤儿桥会话,走 bridgeStopDevice 回收并计入 stopped;无组上下文守旧豁免。MAJ-06 原语义(活跃组桥不杀)不变,孤儿不再永久挡同 host DLNA cast | airplay/control.ts stopAirPlaySessionsForHost;group/protocolPlayer.ts isGroupBridgeSessionAttached(动态 import,避免静态环) |
| A-3 | 桥会话初始音量 = player_groups 落库值 | bridgePrepare RPC 载荷新增 initialVolume(0-100,主进程 prepareBridgeRoute 从 GroupManager 取好下发,子进程不碰 DB);pushInitialVolume 优先用之(0→-144dB),无组上下文回落 airplay_device_state(旧行为);RAOP 重连路径同样带组值。用户裁定语义:流转/起播绝不采用成员设备自身音量 | control.ts bridgePrepareDevice;ipcProtocol.ts BridgePrepareArgs;childMain.ts prepareBridge;bridgeSession.ts(pushInitialVolume/BridgeSessionOpts/两处调用点) |
| A-4 | 纯 AP 组全量走桥后本模块的联动 | 纯 AirPlay 桥组(无 sendspin 成员)同享「活跃组桥会话」豁免 —— 组内对齐由组泵承担,DLNA cast 不再能杀掉组桥会话 | airplay/control.ts;sendspin/index.ts reclaimSendspinOrphans(有桥组不回收) |


---

## v4.9.4 增补(桥 prepare DLNA settle,2026-10-28)

> 仅热补丁(240),未发版。互斥章节补充:**桥路径也走同一 settle 助手**。

| # | 变更 | 现状(代码为准) | 位置 |
|---|------|------------------|------|
| B-1 | 双协议互斥第三入口 | 互斥 settle 原有两个入口(startSession in-proc / castViaChild fork,直连 cast);v4.9.4 起桥 prepare 冷建为第三入口 —— `bridgePrepareDevice` 缺省对同 host DLNA peer 调用**同一个** `yieldSiblingDlnaForAirPlay`(无第二份实现;守卫 R2 的两处 `opts.deviceId` 计数不受影响,桥路径传参为 `deviceId`) | airplay/control.ts |
| B-2 | warm/cold 分流 | 编排侧 prepareBridgeRoute 以「token 是否沿用」为判据传 `settleDlna: !prevSpec`:冷建 settle(等设备切完输入),warm 复用跳过(快路径);流内加入/子进程重启重建走缺省 settle | group/protocolPlayer.ts;airplay/control.ts |
| B-3 | 同组 DLNA 成员豁免 | `dlna:<peer>` 是同一用户组成员(历史遗留组)时不 settle,防组内自杀;经动态 import group/index 判成员 | airplay/control.ts bridgePrepareDevice |
| B-4 | 实证根因 | 240 真机日志:`bridge stream done: 28093 chunks / 230.5s, loss=0` 全程送达但无声 —— 会话建立在 DLNA→AirPlay 输入切换完成之前;直连路径 2026-10-22 已修同款问题(yieldSiblingDlnaForAirPlay 注释段),本次补齐桥路径 | 本文件互斥章节 |

---

## v4.9.4-ex 增补(RAOP now 锚实验,2026-10-28)

> **实验性质**:env `MF_BRIDGE_RAOP_NOW_ANCHOR` 门控(缺省 ON,显式 0/false 关闭回旧路径);仅热补丁(240),未发版。根因定性(240 实证 + 代码考古):MUZO/Linkplay 类固件只支持「到包即播/now 锚」语义,对「SYNC 未来锚 2.3s + 首包延迟 1.25s」的桥会话永不开始渲染;v4.7 时代出声的桥路径即 Phase 3 旧墙钟 stream()(now 锚),Phase 4 四锚点改造后无出声实证。

| # | 变更 | 现状(代码为准) | 位置 |
|---|------|------------------|------|
> **exp2 追记(2026-10-28)**:真机实测 now 锚(偏移 0)下设备抖动缓冲≈0 → 「秒级循环卡顿」。forceNow 锚改为 (缺省 400ms=设备抖动缓冲;非法值回退;显式 0=回到到包即播;应 <L+SAFETY 1050ms 保首包立即发)。对齐器零点仍取首帧 tsUs;WARN 日志带偏移量。
| C-1 | planBridgeAnchor forceNow 分支 | `forceNow: true` ⇒ anchorUs = now(+anchorShiftUs),跳过可达性检查,首包 sendAt(0) = now−L−SAFETY ≤ now ⇒ 立即发;commandedLeadUs=0;锚点四字段照常产出(SYNC 把音频标到「现在」,设备到包即播) | bridgeSession.ts planBridgeAnchor |
| C-2 | 对齐器零点重锚(关键) | forceNow 时 BridgeTimelineAligner 零点取**首帧 tsUs**(内容序)而非 plan.anchorUs(=now):否则泵 lead 段 target−pos ≈ +2.3s > 2s 补静音上限 ⇒ skip 跳段把 startTs 前移,RTP 重新标回未来,now 锚失效(定向测试 bridgeSessionForceNow 钉住两侧行为) | bridgeSession.ts maybeBeginStream |
| C-3 | env 开关 | raopNowAnchorEnabled():未设置=ON,0/false=关闭;仅 RAOP 出口透传(`this.ap2Session === null && …`),AP2 出口路径零改动 | bridgeSession.ts |
| C-4 | 已知代价 | 组 lead 段(~2.3s)相对组时间线**提前播**(MUZO 不缓冲未来锚的必然结果);单成员组无感;混合组同步待实验定论后定最终形态(候选:首传延迟吸收 lead / 组级补偿) | 本节 |
| C-5 | E3 观测性修复 | ① tick JSON 补 silenceChunks/insertedFrames/droppedFrames/skippedFrames 四字段;② deltaUs 改用 plan 落定时刻 chunksOut 快照的**增量**(修 warm-reuse 会话跨 gen 累积的恒偏谬值,240 曾见 35.68s) | bridgeSession.ts emitStatsTick |

> 影响面排查:守卫 ⑮(锚点一次性/对齐器全仓唯一 ctor)⑬(scheduledAnchorUs 字段名)⑯(firstFrameTsUs+anchorShiftUs 落点)全部保持;raop.ts streamBridge 零改动(headTs 每包按 startTs+idx 重算,天然兼容锚点前移)。

---

## v4.9.4-f1 增补(mDNS staleness 与群组桥在线判定,2026-10-28)

> 背景(240 实证):MUZO/HiVi 类接收端**空闲期停止应答 mDNS**,90s staleness(`STALENESS_MS`,discovery 读时判定)会把刚离手几分钟的设备错标 offline → `getOnlineAirplayIds` 剔除 → `prepareBridgeRoute` 静默返回 null(群组 play 11ms 完成、零桥日志,用户视角 =「群组播放器坏了」)。API 视图与 playMedia 同源同规则,矛盾纯系采样时刻差。

| # | 变更 | 现状(代码为准) | 位置 |
|---|------|------------------|------|
| D-1 | F1 快速刷新 | playMedia 起播改走 `getOnlineAirplayIdsTolerant`:组含 airplay 成员但 strict 判定全部离线 ⇒ 先 `rescanAirPlayDevices(300)`(≤300ms 窗,给「空闲静默但仍在网」设备一次应答机会)再判 | group/protocolPlayer.ts |
| D-2 | F1 容错进桥 | 刷新后仍 stale 但 `lastSeen < AIRPLAY_STALE_TOLERANT_MS`(10min,常量唯一出处)⇒ 容错按在线进桥;桥 prepare 的握手预算兜底,失败按 MAJ-07 逐设备回落 solo。`lastSeen ≥ 10min`(真离线,如长期下线成员)照旧剔除,不拖慢起播 | group/protocolPlayer.ts |
| D-3 | F4 会话豁免 | 桥 owner(`isBridgeOwned`)或有活跃投屏会话(`hasActiveSession`,本次从 control.ts 导出)的设备豁免 staleness —— 会话在播 = 在线的事实 | group/protocolPlayer.ts;airplay/control.ts |
| D-4 | F2 路由决策日志 | playMedia 每次起播打一行 `[group][route] <gid> dlna=N spin=N ap=N apDetail=[{id,ageMs,online}…]`(守卫 check-group-invariants ㉓ 钉格式);临时诊断 [diag-v494ex] 已移除 | group/protocolPlayer.ts |

> 语义分工:sync 版 `getOnlineAirplayIds` 仅供 watchdog/leader 判定(零 IO,不拖慢周期路径);起播路径独占 async 容错版。测试:tests/group/airplayOnlineTolerant.test.ts(七用例:fresh 直返/刷新恢复/5min 容错/10min 剔除/双 F4 豁免/disabled 剔除)。

## v4.9.4-e3 增补(桥占用期抑制 DLNA 源端 reset,2026-10-28)

### 症状
主卧(HiVi H5MKII 的 DLNA 身份)流转到含同 host AirPlay 成员(HiVi AirPlay 身份)的群组后,
桥泵一切健康(125.3 包/秒、loss=0、可跑满 240s),**但该设备一点声音都没有**。
同一流转改成 solo 直投(主卧→HiVi 单设备)则正常出声 —— 差别只在「solo 会话」与「桥会话」。

### 根因(240 真机时序实证)
卡片流转链是 `transferFrom(to, from)` + 成功后 `resetPeer(from)`。`resetPeer(主卧)` 会向
**同一台物理设备**下发 SOAP `Stop`(先经 `reset` 路由的 `stopDevice`,再经 `queue.clear()`
内 `player.stop()`),而这两条 Stop 落在桥会话 `RECORD` 之后 0.1~0.2 秒:

```
22:18:22.64  prime silence 10 chunks -> 192.168.10.30:47435   (桥已建会话)
22:18:22.64  sessions: prepare token=a59d7e88... sessions=1
22:18:22.80  [DLNA][Stop] 主卧 发起 tid=4eaf1fe6               ← 卡片 reset 的设备命令
22:18:23.84  [DLNA][Stop] 成功;23.847 再次发起;23.907 成功
22:18:27.53  bridge first packet
```

设备固件的输入仲裁被这两条 Stop 顶回 DLNA:AirPlay 的 RTSP/TCP 仍活着、timing reply 照答、
RTP 全收(loss=0),但音频不渲染。所有出声实例(群组直接播放、源端是 AirPlay 的流转)在
`RECORD` 之后都**没有任何 DLNA 命令**,与该结论完全对应。

### 修法(常开)
`services/airplay/bridgeSettleMarks.ts` 记录「DLNA peer 刚被桥 cold-settle」标记
(TTL 20s、容量 64 LRU,写点在 `control.bridgePrepareDevice` 的同 host settle **成功之后**)。
`routes/api/peers.ts` 的 `/stop` 与 `/reset` 命中标记时:**只做服务端复位,不下发任何设备端
DLNA 命令** —— `stopDevice` 跳过、`queue.clear(peerId, { skipDeviceStop: true })` 跳过
`player.stop()`(否则 clear 内部那条 Stop 会漏出去,exp5b 实测过一轮)。

- 设备端并非完全不停:settle 阶段(桥接管前)已经 Stop 过一次,那次是必要的让位动作;
  被抑制的只是**桥已经接管之后**的重置副作用。
- 应急回滚:容器环境变量 `MF_BRIDGE_RAOP_SUPPRESS_DLNA_RESET_AFTER_BRIDGE=0`(缺省开启)。
- 守卫:`check-airplay-playback-chain.mjs` 的 reset-clear 断言允许带
  `{ skipDeviceStop: suppressDlnaDevice }` 一种带参形态(见 R15 段注释)。

### 排查提示
判断该设备的桥是否"假活":看 tick 是否 deltaUs 稳定、loss=0 但用户无声;再看日志里
`RECORD` 之后有没有 `[DLNA][Stop]`。有 → 命中本坑;没有 → 转去查固件自身状态机。

## v4.9.4-exp3 增补(流转双缺陷,2026-10-28)

### 1. 源端进度:早读从「同设备特例」放宽为「无条件」
`srcPosEarly` 原本只在 `sameDevice(from, to)` 为真时读。判据漏了一种情形:**目标是群组**,
而源端与群内某成员是同 host 双身份设备(主卧 DLNA ↔ HiVi AirPlay)。群组 `playFrom` 的桥
settle 会先把源端 DLNA 停掉 → 晚读恒 0 → 群组从 0 秒开播且不回 seek(用户看到「进度消失、
从头播放」)。

修法:`const srcPosEarly = askPosition ?? await readPeerPositionSeconds(fromPeerId)`
——**在任何 playFrom / detach / 借流之前**无条件定格。红线保持不变:跨设备 DLNA 目标仍是
「先起播再 seek」,`inCastPos` 收紧为 `sameDevice ? srcPosEarly : null`,早读值不得漏进
`startMs`;airplay 目标的 `inCastPos`(读当下值)也不动。

### 2. 成员回流:群组 → 设备 → 群组 往返不再丢成员
`detachFromActiveGroups` 的「显式操控自动摘组」是 cast-to-member 的设计行为,但它会**永久**
从 `memberIds` 删掉成员;此前反向流转(设备 → 该组)不会把它加回来,于是该设备在之后的每次
群组播放里都缺席(症状:群组里某台永远不出声)。

修法:`bridgeSettleMarks` 同款思路的模块内 Map `autoDetachedFromGroup`(bare id → {gid,
memberKey, at},容量 128 LRU)在 `detachFromActiveGroups` 成功摘组后写入;`transfer-from`
目标为 `group` 且源端是 dlna/airplay/sendspin 时,命中同 gid 就把 memberKey
`applyMemberDelta({add})` 加回(不调 `alignGroupMembers`,紧跟的 `playFrom` 会全量重算路由,
把新成员编进桥)。

边界:用户在群编辑里**手动**删的成员没有记录,不会被回流;已在组内则幂等跳过。

### 3. 与 E3 的关系(必须一起看)
流转成功后卡片会 `resetPeer(源端)`;若源端是 DLNA 且刚被桥 settle 过,那两条 SOAP Stop 会
打死刚接管的桥(见「v4.9.4-e3 增补」)。两者共同构成「主卧 → 全屋」的完整修复:
**进度(早读) + 成员(回流) + 出声(E3 抑制)**。

### 4. 验收序列(240 真机口径)
1. 群组→主卧:`POST /peers/dlna:主卧/queue/transfer-from {from:"group:<gid>"}` → 主卧出声;
2. 主卧→群组:`POST /peers/group:<gid>/queue/transfer-from {from:"dlna:主卧"}` → 群组进度接续、
   同 host 的 AirPlay 成员出声;
3. 模拟卡片收尾:`POST /peers/dlna:主卧/reset` → 日志只出现「源端 DLNA 重置跳过设备命令」,
   `RECORD` 之后**不得**再出现 `[DLNA][Stop]`;
4. 往返:群组→HiVi→群组,`GET /v1/groups` 成员表里 HiVi 仍在。


## v4.9.6 增补(垫片窗静音续流 + 消费停滞看门狗,2026-10-29)

**现场**:HiVi(MUZO/Linkplay)在组里播放 ~1 小时后接收端假死——服务端数据面全程健康
(缓冲 1.05s、首包偏差 5-10ms、maxGap≈1s 全被覆盖),但设备零 timing 回复、零重传请求、
`getPlayerStatus` 假播放(`uri=""`、curpos 空走)。只有完整重握手(TEARDOWN → 新
ANNOUNCE/SETUP/RECORD)能唤醒;服务端内部换泵(bridge-server 层重建)无效。

**根因(与 v4.9.5 的歌中饿死不同)**:每次换歌,`onBoundary(track)` 停掉旧 stream →
~2.5-3s 垫片窗(冷垫片 pendingTrackLeadUs 2500 + TTFB)内 **RTP 完全断流**(静音也不发,
实证:每 gen silenceChunks 只 +4~6 块,断流 3s 应 +375 块)→ 设备 1.05s 缓冲放完后真饿
~2s → MUZO 固件「欠载即假死、不自动重缓冲」,反复数次后接收端彻底放弃。

**A. 垫片窗静音续流(根治)**:`RaopPlayer.fillGapSilence({shouldStop,maxMs})` ——
`onBoundary(track/seek/rehost)` 后由会话层(`startGapFiller`)按 8ms 节拍继续发静音块:
seq 连续、时间戳续走旧时间线、**无 SYNC**;结束复位 `started` ⇒ 新流真·首包仍带 0xE0
marker,新流重锚语义**不变**(0xE0 + 新 startTs + 垫片窗照旧)。`maybeBeginStream` 起新流
前 `stopGapFiller()` 收尾(仅 filler 在跑时 await,保持无 filler 时的同步语义);maxMs 8s
封顶,下一首真不来就回到旧断流行为。可听间隙不变(仍是静音),变的只是 RTP 包不断。
仅 RAOP 出口;AP2 不启用。开关 `MF_BRIDGE_RAOP_GAP_FILL`(缺省 ON,0/false 关)。
守卫:测试桩/旧 player 无 `fillGapSilence` 方法时静默跳过。

**B. 消费停滞看门狗(兜底)**:设备**主动**信号(NTP timing 请求、重传请求,都是设备发起)
在推流中停摆超阈值 ⇒ 判接收端假死 ⇒ 自动 `reconnectRaop()`(完整新 RECORD,等待新代次
首帧重锚)。纯判据 `livenessWatchdogShouldFire`(暂停/AP2/未连接/重连中一律不触发),
挂在 stats tick(2s)上。开关 `MF_BRIDGE_RAOP_LIVENESS_WATCHDOG`(缺省 ON)、阈值
`MF_BRIDGE_RAOP_LIVENESS_MS`(缺省 120000,下限 30000)。

**为什么不取消垫片窗**:切歌垫片(冷 2500/暖 800)是 HiVi 0xE0 就绪窗口的实测定案,
与「FLUSH/排空/aligner 续走」三条被真机否决的捷径无关 —— 本增补不消除可听间隙、
不续走内容、不动 aligner,只在窗内让 RTP 不断流。

---

## v4.9.7 增补(看门狗缺省关闭 + 重连互斥门 + 结束原因,2026-10-29)

**现场(240 实测)**:一首 365.1s 的曲子 `bridge stream done: 45739 chunks / 365.1s`
**全程健康播完**,但紧接其后的 36 秒里设备完全无声,日志呈 6 轮循环:

```
05:33:00.204  liveness watchdog: 设备主动信号已停 ≥120s ⇒ 判假死,自动完整重握手
05:33:00.219  bridge stream done: 45739 chunks / 365.1s     ← 该曲健康播完
05:33:00.388  anchor gen=43000129                            ← 新流起在 oldPlayer 上
05:33:00.705  raop reconnected(新 RECORD)
05:33:00.708  bridge stream break: sendChunk false destroying=true
05:33:00.708  bridge stream done: 40 chunks / 0.3s           ← 刚起 0.3s 即被掐死
05:33:00.708  raop reconnect in 5491ms (attempt 1, stream ended)
... 重复 6 轮,共 ~36s,直到 onBoundary 换代把流起在正确实例上才恢复
```

**根因(三个缺陷叠加,v4.9.6 新引入其中两条)**:

1. **B 的判据对主力设备结构性失效**(v4.9.6 引入)。`lastDeviceSignalAt` 只认设备**主动**
   发起的两类包:ctrl 重传请求、NTP timing 请求。HiVi/MUZO(2017 固件)在**曲目后半段
   正常播放时就会停止发送 timing 请求** —— 240 实证该机 3s 一次的心跳(20 次/分钟)在
   05:31、05:32 两个整分钟**完全消失**,而同一段该曲数据面 `deltaUs` 稳、`driftUs=0`、
   包流未断。于是**每首歌播到 120s 必被误判假死一次**。用户观察到的「播放一会就没声」
   就是这个 120s 定时器。

2. **`reconnectRaop()` 掐死刚起的新流**(v4.9.6 之前已有,被 1 引爆)。它的
   `await player.connect()` 是一个真实的时间窗口(实测 ~320ms),窗口内
   `maybeBeginStream` 因 `streamAborted` 被复位而在 **oldPlayer** 上起了新流;connect
   返回后无条件 `oldPlayer.forceClose()` ⇒ 把刚跑 0.3~0.6s 的新流连根掐断。

3. **`.then()` 不区分结束原因**(v4.9.6 之前已有,是放大器)。`streamBridge()` 结束时
   一律 `scheduleRaopReconnect("stream ended")`,而 `pullChunk()` 返回 null 的条件是
   `closed || streamAborted` ⇒ **曲目播完必然等于「断流」** ⇒ 每首歌播完都触发一次重连,
   与 2 组成死循环的闭环。

**修复(三处,互相独立)**:

- **B 缺省关闭**。`raopBridgeLivenessWatchdogEnabled()` 改为只有
  `MF_BRIDGE_RAOP_LIVENESS_WATCHDOG=1|true` 才开(原缺省 ON)。理由:判据在这台设备上
  误报率 100%,而它想捕获的真·假死可由用户切歌 / 整组 play 恢复(已实证)。代码与
  纯判据 `livenessWatchdogShouldFire` 全部保留,供将来有可靠判据时复用。
- **重连互斥门**。新增 `raopReconnectInFlight`:`reconnectRaop()` 全程置位(含
  `await connect()` 窗口),`maybeBeginStream()` 在门内直接 return,并把起流推迟到
  下一帧 AUDIO 自然触发。重连重入也由同一道门挡掉(内层早退**不得**在 finally 复位
  外层门)。`oldPlayer.forceClose()` 另加守卫 `if (this.player === player)`。
- **结束原因上报**。`streamBridge()` 返回 `BridgeStreamEndReason`
  (`producer` | `send` | `destroy` | `stopped`),`.then()` **只在 `send` 时重连**
  —— 即仅 `sendChunk` 返 false(设备侧真断开)才算断流;`producer`(曲目播完/上层停流)、
  `destroy`、`stopped` 一律不重连,交 onBoundary 换代处置。

**验证**:`tests/airplay/bridgeReconnectGate.test.ts`(3 条)钉死「门内不起流」「门内重入
不新建 player 且不复位外层门」「门关闭后恢复可起流」;`raopGapFill.test.ts` 同步改为
断言看门狗缺省 OFF。240 热补丁后实测 `WATCHDOG=[]`、liveness 日志 0 条、
`deltaUs≈1060ms`、`driftUs=0`、`silenceChunks=0`。

**A 保留**:垫片窗静音续流(gap-fill)已实证有效(换歌瞬间 282 chunks / 2251ms 盖满
2.5s 垫片窗),缺省仍 ON,本次不动。

---

## v4.9.8 增补(看门狗判据换成 ctrl 重传请求停摆,2026-10-29)

**现场(240 实测 15:43 CST)**:v4.9.7 修复后播放一直正常,15:43 一次换歌后整段无声。
服务端数据面**全程健康**(deltaUs≈1060ms、driftUs=0、gap-fill 正常、无 reconnect 无掐流),
设备 timing 请求每 3s 照答、DLNA 假会话清掉后仍无声、音量确认已下发(60%)。分水岭证据:

```
失聪前那首(134s):loss 增量 3315  ← 设备在收包、在持续请求重传
失聪后那首(292s):loss 增量 0     ← 整整 292s 一次重传请求都没有
```

**根因**:warm-reuse 长会话(13:44 起续用 4h+、15 次换歌)的 **audio RTP 通道死亡** ——
control/timing UDP 仍活,但音频流进不了设备,固件连重传请求都停发(正常 ~10/s)。
整组 stop→play(完整重握手 TEARDOWN→ANNOUNCE/SETUP/RECORD)立即救活 —— 与 v4.9.6
定案的「真·假死只有完整重握手能救」一致,但这次的活性信号不是 timing,而是 **ctrl
重传请求**。

**修复**:v4.9.6 的 B(消费停滞看门狗)判据源从「设备主动信号停摆」(合流 timing+ctrl,
`lastDeviceSignalAt`)换成 **ctrl 重传请求停摆**(新字段 `lastCtrlSignalAt`,只在 ctrl
通道 0x55 重传请求分支刷新):

- 正常收包时 ctrl 请求持续活跃(240 实证每首增量 1314~3315 次,≈10/s)⇒ 不会误报;
- audio 通道死亡后归零 ⇒ 5 分钟静默(缺省 `MF_BRIDGE_RAOP_LIVENESS_MS=300000`)触发
  `reconnectRaop()` 自动完整重握手;
- timing 信号不再参与判据(MUZO 正常播放会停发 timing,结构性不可靠 —— v4.9.7 的教训);
- 残余误报面=长期零丢包的完美 UDP 链路(2.4G 125 包/s 现实中不存在),误报代价是一次
  reconnect(~1-2s),远小于通道死亡无人理睬;
- 缺省恢复**开启**(`MF_BRIDGE_RAOP_LIVENESS_WATCHDOG` 缺省 ON,0/false 关)。

**保留**:v4.9.6 A(gap-fill)、v4.9.7 三修复(看门狗缺省关→本版换判据后恢复开/重连
互斥门/结束原因上报)全部在位。v4.9.7 关看门狗是因为旧判据误报;v4.9.8 换判据后恢复
开启,不是回退。

## v4.10.0 增补(看门狗判据换 timing 心跳 + 优雅退出 TEARDOWN + 失声根因取证与 B/C/D 方案入档,2026-10-30)

### 1. 看门狗判据第三次换源:ctrl(300s) → timing 心跳(lastTimingAt,45s)

- v4.9.8 判据(ctrl 重传请求停摆 300s)被 2026-10-29 10:03–10:48 的**十连炸**证伪:间隔精确 300s 共 10 次,
  而同期 `timing reply` 每分钟稳定 17~21 条(心跳完全健康)。重传请求是**丢包驱动**信号,流越干净越不发,
  ctrl 静默 300s ≠ audio 通道死亡 ⇒ 纯误杀,每次 9~14s 静音。
- 新判据 = **timing(NTP) 心跳停摆 ≥45s**(`raop.ts` 的 `lastTimingAt`,timeSocket 收包即刷新)。
  240 实测健康期恒为 20 次/分钟(每 3s 一次),跨换歌不断流;会话内最大间隔仅 6.0s(4611 包/9 会话/≈4.1h pcap 实测)。
  开关 `MF_BRIDGE_RAOP_LIVENESS_WATCHDOG` 缺省 ON,阈值 `MF_BRIDGE_RAOP_LIVENESS_MS` 缺省 45000(下限 30000),
  纯判据 `livenessWatchdogShouldFire` 与熔断 `livenessBreakerActive`(10min 内 ≥2 次 ⇒ 停 30min)保留。
- ⚠️ 熔断器当前**结构性失效**:`livenessFireAt` 挂在 session 实例上,每次触发都重建 session ⇒ 历史清零 ⇒
  永远攒不到 2 次(十连炸即为证据)。修复入下文 B/C/D-C,本版**未改**。

### 2. 优雅退出补 TEARDOWN(重启后设备挂死会话的根治)

- 根因(2026-10-29 20:54 tcpdump/4515 实证):容器重启只发 ANNOUNCE/SETUP/RECORD,TEARDOWN=0。原因链:
  `supervisor.stop()` → `rpc("stop")` → 子进程 dispatch 无 "stop" 分支 ⇒ 抛错 ⇒ `killChild("SIGKILL")`;
  真正停桥会话的 `onStop()` 从未被调用。设备(MUZO)对「服务器突然消失」不做清理,接收端挂在死会话上,
  新进程握手虽 200 但不切会话 ⇒ 不出声、不发 timing,只能靠显式 TEARDOWN 重置。
- 修法(`src/index.ts` `gracefulShutdown()`):退出前走「组/端级 transport stop」——真机上被反复验证会
  下发 TEARDOWN 的同一条路(用户点停止/组级 stop 后设备立刻能重新接管),再退进程。

### 3. 「偶发失声」根因取证(2026-10-30,240 线上 pcap+日志闭环)

- **方法论两坑(先对齐再取证)**:① `docker logs -t` 打 UTC、`tcpdump -r` 打本地 CST,混用会得出完全相反
  的结论(本次曾据此误判「看门狗误杀」,对齐后反转);② `timing reply` 日志无 deviceId/端口,多台 AirPlay
  成员的回包混在一条序列里,用它量「心跳静默」是脏数据,必须走 pcap(host 过滤,UDP 载荷过滤用 `udp[4:2]=40`)。
- **换歌断流基线**:128 次换歌,旧流 DONE → 新流 anchor 的无 RTP 窗口**中位 3.78s**(p90 13.45s),而设备
  音频延迟缓冲 `latencyFrames=44100`≈1.0s ⇒ **每次换歌都必然欠载**。
- **因果链**:换歌欠载 → 设备进入「等流」态并停发 NTP(约 12.5% 概率不自行恢复)→ 45s 后看门狗
  TEARDOWN+新 RECORD(**纯断音 14s**,握手本身仅 497ms)→ 重连瞬间泵把 10.6s 预填充一口气灌入 →
  `[bridge-server] overflow backlog=8025ms` → 桥会话被自己打死(`reason=closed`)→ 再等 ~6s rehost,
  `staleFrames=385200`(8.7s 内容被丢)。两次事件 backlog 都精确顶到 8025ms。
- 现行 timing 判据的 4 次触发(10-29 13:07/14:37、10-30 04:09/04:21)**全部紧跟换歌**(新流首包距触发
  28.4~68.9s)。完整证据链见 `docs/AirPlay播放中断-根因排查与已排除方向.md`。

### 4. B/C/D 方案(2026-10-30 用户拍板入档,**代码未实施**,实施时须同步 group/sendspin 两份权威文档)

- **B(恢复分级)**:心跳静默先「原地重锚续流」(不拆会话、不停 RTP),无效再升级新 RECORD;RECORD 后泵
  **从当下续投**,禁止把预填充水位(10611ms 档)一次性灌入(直接消掉二次崩的 ~6s)。
- **C(兜底)**:熔断器上提到**设备级**(不随 session 销毁);阈值 45s→15s(自然上限 6s 的 2.5 倍,实测无
  10~45s 区间样本)——每次事件失声从 ~45s 压到 ~15s。
- **D(观测)**:`timing reply` 加 deviceId+端口;看门狗日志加 quietMs/thresholdMs;桥 tick 加
  「距上次上行心跳 ms」。
- **A(治本,单列待实施)**:换歌不断流——新流 anchor 抢在旧流排空前,或跨轨同一 RTP 时间线补静音,
  把 3.78s 断流压到 0。

## v4.10.1 增补:S1/S3 容器重建僵死会话自愈(TEARDOWN 探测)——2026-10-30 用户拍板并验收

### 1. 事故与根因链(接 v4.10.0 增补)

容器重建后,MUZO 固件保留对**旧容器**的半开 RTSP 会话;新容器对同一设备
ANNOUNCE/SETUP 即 `read ECONNRESET`。旧行为:prepareBridgeRoute 失败 → 该设备
回落 solo cast(同一条握手必挂)= 「在组里但无声且状态正常」,唯一救法是人工
stop → 等 10s → play(2026-10-30 16:30 实测一次成功:ANNOUNCE 331ms → SETUP 155ms
→ RECORD 20ms,握手总耗时 507ms)。

### 2. S1:握手失败自动 TEARDOWN 探测 + 退避重试(代码已实施)

- **新模块 `backend/src/services/airplay/raopProbe.ts`**(主进程编排):
  - `raopProbeDevice(deviceId)`:RPC `raopProbe` 到 airplay 子进程;**host/port 必须
    主进程查好随载荷下发**(子进程 discovery 注册表恒空,不能按 deviceId 反查,
    与 bridgePrepareDevice 同一契约)。
  - `retryBridgePrepareWithProbe`:重试梯 = probe → 退避 → 重试完整握手,
    两档 **5s/15s**(每档重试前各 probe 一次);probe 不可达立即放弃,不空耗 20s。
  - `isBridgeHandshakeDeviceError`:只认设备类连接失败(ECONNRESET/ECONNREFUSED/
    ETIMEDOUT/EHOSTUNREACH/EPIPE/socket hang up/连接超时);AP2 凭据缺失等语义
    错误不重试(必复现)。
  - 测试钩子 `setBridgePrepareRetrySleepForTest` / `resetBootProbeStateForTest`。
- **`raop.ts` 加 `raopTeardownProbe(host, port)`**:纯协议一次性连接(不复用
  RaopPlayer,不建 UDP、不加密协商):OPTIONS → TEARDOWN(**无 session 也发**,
  设备回 454/451 无害),OPTIONS 不答(TCP 活但 RTSP 层哑)按不可达处理。
  子进程 `childMain.ts` 加 `raopProbe` RPC 分支。
- **落点**:`group/protocolPlayer.ts` prepareBridgeRoute catch 分支 —— 仅设备类
  失败走重试梯,救回则进桥(`[bridge-prepare] retry#N` 日志),救不回才 MAJ-07
  回落 solo cast。
- **⚠️ 实测双刃剑**:HiVi 实测 blind TEARDOWN(无 session)**回 200 = 真杀当前
  会话**——这就是它清僵死会话的原理,也意味着绝不能碰有合法会话的设备(S3 防误杀)。

### 3. S2:优雅退出验证 + stop_grace_period(运维侧,已落地 240)

- 240 host 预挂 tcpdump 实抓容器重启:`TEARDOWN rtsp://192.168.10.30:4515/6277954418`
  **带 session id** —— v4.10.0 gracefulShutdown 的 TEARDOWN 链路确认工作。
- compose 显式 `stop_grace_period: 30s`(默认 10s 可能掐断逐会话 TEARDOWN;
  容器 StopTimeout=30 已确认)。

### 4. S3:boot clear-probe(代码已实施)

- `index.ts` isAirPlayEnabled 块内 `scheduleBootClearProbes()`:**12s 首轮 +
  45s 兜底轮**。
- 提前依据:`loadPersistedAirPlayDevices()` 启动即恢复持久化清单,不等 mDNS;
  子进程 fork ~3s。实测 boot 后 15s 完成全部探测。
- **防误杀三原则**(45s 兜底可能清掉用户刚建立的合法会话——用户拍板前指出):
  ① 首轮探测过的设备记入 `bootProbedDevices`,兜底轮(`onlyUnprobed=true`)只补
  集合外的 mDNS 迟到设备;② 每台探测前查 `isBridgeOwned`(import control.js,
  无环:control 不引 raopProbe),活跃桥会话两轮都跳过并记入已确认;
  ③ 清单为空(发现未完成)整轮跳过。
- 首跑实录(2026-10-30):HiVi .30:4515 TEARDOWN=200(真清掉会话)、MUZO
  .230:5000 TEARDOWN=451(无会话无害)、3 台持久化无效地址(host=:0)正确跳过。

### 5. 部署铁律(本次新增)

**compose recreate 会重置容器文件系统**(非挂载的 /app/backend 回到镜像内容)
⇒ 热补丁顺序必须是 **recreate → tar 注入(`cat tgz | docker exec -i musicflow
tar xzf - -C /app/backend`)→ restart**;先注入后 recreate 补丁会丢。
