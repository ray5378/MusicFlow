# MusicFlow：改造现有 AirPlay 模块实现 AirPlay 1/2 + Sendspin 桥接同步

## 文档关系（先读这一块）

> **本文件的角色**：**历史方案（调研 + 落地方案），不是事实来源**。它记录 MA 权威做法精要、MusicFlow 改造前的现状盘点、三条病根（为什么必须这么改），以及六轮复核/两轮终审推翻的结论索引。**落地与否一律以文首「落地状态总表」和三份权威文档为准**；本文的行号、字段名、Phase 编号可能已过期。

**5 份相关文档（都在 `docs/`，链接可直接点开）**

| 文档 | 角色 | 一句话用途 |
|---|---|---|
| [airplay-权威方案文档.md](./airplay-权威方案文档.md) | 权威现状 | AirPlay/RAOP 协议正确做法、airplay 子进程、桥接环（帧格式/锚点/stats）与 AirPlay 侧守卫 |
| [sendspin-权威方案文档.md](./sendspin-权威方案文档.md) | 权威现状 | Sendspin 协议链路、FLAC 链路、ESPHome 设备端配置、多房间组与组泵 |
| [group-权威方案文档.md](./group-权威方案文档.md) | 权威现状 | 群组数据模型与生命周期、选歌硬约束、出流双路、组成员、延迟补偿 |
| [AirPlay1-2与Sendspin桥接-最终实施方案.md](./AirPlay1-2与Sendspin桥接-最终实施方案.md) | **历史方案（Phase 计划）** | 决策定案 D1~D9、四条「为什么」、阶段落地表、AP2 契约 |
| [AirPlay1-2与Sendspin桥接落地方案.md](./AirPlay1-2与Sendspin桥接落地方案.md) | **历史方案** | 桥接的调研与落地方案：MA 精要、MusicFlow 现状盘点、三条病根 |

**硬口径**：**历史方案文档不再作为事实来源；任何冲突以三份权威文档为准。** 历史方案文档只保留「为什么这样设计」与「当时踩了什么坑 / 推翻了什么」两类价值 —— 其中的 Phase 条目、行号、字段名一律可能过期。

**三份权威文档的分工边界（排障时先按这张表定位文档）**

| 问题域 | 归属文档 |
|---|---|
| 协议（RTSP / RAOP / AP2 报文、Sendspin 帧与握手配对）、airplay 子进程模型、桥接环（28B 帧 / 锚点公式 / `stats` 判据） | [airplay-权威方案文档.md](./airplay-权威方案文档.md) |
| 设备协议（Sendspin 连接 / 编码协商 / 预填充水位 / pacing / 音量）与组泵（`SendspinGroup.pushFrame`、`pcm:100` 编码组、晚加入回填） | [sendspin-权威方案文档.md](./sendspin-权威方案文档.md) |
| 组成员与命名空间、生命周期状态机、选歌推进硬约束、出流双路（组泵 / AirPlay 桥）、延迟补偿、组验收判据与失败速查 | [group-权威方案文档.md](./group-权威方案文档.md) |

---

## 落地状态总表（群组 / 组播 / 混合组 / 组成员 / 延迟补偿）

> 判定时间 **2026-10-26**，基线 `6c13bd6`（含 v4.6.77 = `0ed0892`）。三态口径：`✅ 已落地`／`⏳ 待排期`／`⊘ 已裁定例外`。
> 本表是 [实施方案](./AirPlay1-2与Sendspin桥接-最终实施方案.md) 同名表的**子集**（同一批代码事实），只列与「桥接落地路径」直接相关的条目；
> 组成员准入、`setMembers` allowlist 例外、守卫挂 CI 等条目**只在实施方案那张表维护**，此处不重复以免漂移。

| 条目 | 状态 | 证据 |
|---|---|---|
| 出流分派：在线 sendspin>0 且在线 AirPlay>0 ⇒ AirPlay 走桥；纯 AirPlay ⇒ 旧逐设备 cast；流内不切路由 | ✅ 已落地 | `group/protocolPlayer.ts:313-343` |
| 组成员准入（拒 `dlna:`+裸 id+`group:`+`local:`+重复+非字符串） | ✅ 已落地 | `group/index.ts:361-385` `assertMembersAvailable`；两入口都调用，但**只校验「相对现有成员新出现的部分」**：`setMembers` 校验 `newOnes`（`:227-228`）、`applyMemberDelta` 校验 `added`（`:251-260`），`createGroup` 仍全量（`:167`）。**历史成员不拖累本次提交**——否则组里剩 ≥1 个历史 DLNA 成员时加减任何成员都 400、≥2 个时逐个删也清不干净 ⇒ 组被永久锁死；提交列表本身的结构/重复校验由入口显式做（`setMembers:221-226`） |
| `detachFromActiveGroups` 纳入 airplay（摘组不再 no-op，不留孤儿桥成员） | ✅ 已落地 | `routes/api/shared.ts:651-665` |
| 桥成员音量走 `setAirPlayVolume`/`setAirPlayMuted`，桥占用时 native 音量回落桥会话表 | ✅ 已修复（本批） | `airplay/childMain.ts:119-130` → `bridgeSession.ts:773-778` |
| 桥路由泄漏：全成员 cast 失败先 `teardownBridgeRoute()` 再抛 | ✅ 已修复（本批） | `group/protocolPlayer.ts:346-361`（`:354` 先拆、`:360` 再抛原始错误） |
| 背压：高水位告警 + hardCap 断连重连 | ✅ 已落地 | `airplay/bridgeSource.ts:163-180`（`bridge hardCap … 断连重连`） |
| 混合组起播 lead 1.75s（原 500ms 丢开头） | ✅ 已落地 | commit `1b2a57b`；[group-权威方案文档.md](./group-权威方案文档.md) §7.1 |
| 组 A/V 延迟补偿 ±30000ms / 步进 10ms / AirPlay 侧重建桥、Sendspin 侧帧级 | ✅ 已落地（v4.6.77） | commit `0ed0892`；`services/group/delayCalib.ts:20-23`；`GET/PUT /v1/groups/:id/delays`；详见 [group-权威方案文档.md](./group-权威方案文档.md) §6 |
| 每首歌无条件拆建桥路由 | ⏳ 待排期 | `group/protocolPlayer.ts:320-324` |
| `/rest/airplay/stream/:token` 无首字节上界 | ⏳ 待排期 | 取流 handler 无首字节超时 |
| `sessionRuntime.seek` 无 deadline | ⏳ 待排期 | `services/airplay/sessionRuntime.ts:339-360` |
| 成员前缀常量散落 ≥8 处未收敛 | ⏳ 待排期 | `sendspin/peer.ts:664`、`QueueController.ts:34-37`、`playTarget.ts:74` |
| 「组播（multicast）」出流 | ⊘ 已裁定例外 | 本仓无组播路径（组泵逐成员 WS + 桥逐设备 RAOP） |
| AP2 发送端 | ⏳ 未接入生产链路 | **`airplay/ap2/` 15 文件 3067 行：已实现并有 7 个协议级 QA 用例直接覆盖**（`tests/airplay/ap2*.qa*.test.ts`），但 `control.ts` / `childMain.ts` 无静态引用、无 flag 入口 ⇒ AP2 设备仍走 `raop` |

---

## 0. 结论摘要

1. **MA 的权威答案**：AirPlay 不自己承担同步，而是把每台 AirPlay 设备注册为 **Sendspin 的外部客户端**（`player@_bridge` 桥角色），由 Sendspin 组时间线统一调度，AirPlay 只当输出口。桥成员**永远以 join 身份加入，从不设定时间线**。
2. **我们已有的天然接缝**：`airplay/raop.ts` 已有 `PcmProducer = () => Promise<Buffer|null>` 与 `stream(producer, session)`——发送端是「拉」PCM 的，桥接只需替换供给方，不必重写 RAOP 协议栈。
3. **真正的缺口（三轮复核后的定稿版，均已解决，详见 §3）**：① 采样率 48000 vs 44100（**AP1 接收端不支持 48k** ⇒ 必须内建有理数重采样，是硬需求不是选配）；② RAOP `stream()` 自带墙钟时间线，必须交出驱动权；③ 跨进程 PCM 通路缺失（JSON IPC 不可用）；④ 组成员强类型 `Set<SendspinConnection>`（不改型，加并行集合）；⑤ 时间轴口径错误（旧方案用 Unix ms + 把 `latencyFrames` 归零）；⑥ `airplay/ap2/` 当时是空目录。
4. **利好**：`pushFrame` 本就按 `(codec,gain)` 分组独立编码，`PcmEncoder` 现成，`ringFor` 晚加入回填已有 ⇒ 桥接的「供给口」不需要新建，只需接通。
5. **路线**：不动 RAOP 协议栈、不引入外部二进制做生产路径；新增 `AirPlaySender` 统一接口（RAOP 实现已有 / AP2 新写），上层换成 Sendspin 组时间线驱动。

---

## 1. 调研来源

| 来源 | 路径/版本 | 用途 |
|---|---|---|
| MA 桥接实现 | `music_assistant/providers/airplay/sendspin_bridge.py`（1808 行） | 锚点/对齐/节流/热复用全套语义 |
| MA 桥角色基类 | `providers/sendspin/bridge_role.py`（`BridgePlayerRole`） | 外部客户端如何接 PushStream、上报 lead/min_buffer |
| MA 桥生命周期管理 | `providers/sendspin/bridge_manager.py`（`SendspinBridgeManagerBase`） | derived-transport 边、provider 通用化 |
| MA 假 Sendspin 设备 | `providers/_demo_sendspin_clients/device.py`（295 行） | **模拟器蓝图**（沿用其客户端接法） |
| MA Sendspin 播放会话 | `providers/sendspin/playback.py`（含 join catchup） | 组泵与晚加入追赶 |
| cliairplay | `/opt/mf-airplay/cliairplay` v0.5.9 | AP1/AP2 协议参数、计时口径对照（黄金参考） |
| AP2 接收端源码 | `/tmp/ap2recv/`（含 `ap2/`、`pairing/`、`airplay1.py`） | **AP2 发送端的协议参考实现**（反向） |
| aiosendspin | `/root/ssvenv` 内 10.2.1（与 MA 锁定同版本） | 假 Sendspin 设备运行时 |

---

## 2. MA 侧参照（外部事实，本仓代码无法证伪）

### 2.1 架构一句话

```
Sendspin 组 pump（唯一时间线）
   ├─ 真 Sendspin 设备（WebSocket player@v1）
   └─ 桥接成员（player@_bridge 角色）── on_audio_chunk ──▶ AirPlay CLI stdin ──▶ 音箱
```

注册走 `register_external_player(hello, on_stream_start=...)`，`client_id` 由 MAC 派生（便于把 SendspinPlayer 与 AirPlayPlayer 挂成 derived-transport 父子边）；角色声明 `supported_roles=[BRIDGE_ROLE_ID, "player@v1"]`；**音频不走 WebSocket**，直接回调 `on_audio_chunk` → 写 CLI stdin。

### 2.2 四条可照抄的机制

| 机制 | 实现位置 | 语义（我们采纳的部分） |
|---|---|---|
| ① 锚点 ack 回映射 | `_anchor_stream()` L886-1029 | **不以命令时刻为准，而以设备 ack 的实际调度时刻为准**：回映射到组时间线得 `_drop_until_us`，之前的内容丢弃、之后的按字节偏移写入；`_drop_until_us` 一个变量双语义（既是丢弃游标又是当前锚点）。`sync_adjust` **进命令、不进组时间线**（`commanded = anchor + adjust`，ack 回来再 `- adjust`） |
| ② 字节偏移对齐 | `_align_chunk()` L1518-1565 | `target_frames = (chunk.timestamp_us − _drop_until_us) * rate / 1e6`；空洞补静音、重叠裁头；漂移 >1ms 记 warning 并重对齐（阈值只在 `_queued_frames` 非零、非 shift 吸收中时生效，`L1546`） |
| ③ stdin 节流 ≤8s | `_cli_writer()` L1580-1645 | 按「已写字节 + 墙钟」算设备领先量，超 `MAX_DEVICE_BUFFER_SECONDS=8.0` 就 sleep —— 晚加入的追赶积压**逐渐喂**，绝不倾倒 |
| ④ CLI 热复用 | `_can_reuse_stream_warm()` L531 / `_on_stream_start` L559 | 流尾保活 `BRIDGE_WARM_GRACE_SECONDS=4.0`，seek/下一首走 flush-refill 免冷启；冷启 lead = 晚加入余量 + 2s 连接预算 |

配套：`set_timing(*, required_lead_time_ms, min_buffer_ms)` 是 **keyword-only 且无默认值**（`bridge_role.py:154`）；`_absorb_playout_shift()`（L1411）把 CLI 断粮后的累计 playout 位移折叠回锚点；锚未定时最多 hold `MAX_HELD_AUDIO_US=45s` / 4000 块；传输恢复预算每流重置，且只由**已锚定**的流判定（防双进程互踩）。

### 2.3 常量（MA 侧原始值，我们只借数值不照抄结构）

| 常量 | 值 | 位置 |
|---|---|---|
| `MAX_DEVICE_BUFFER_SECONDS` / `BRIDGE_WARM_GRACE_SECONDS` | 8.0 / 4.0 | `sendspin_bridge.py:79` / `:85` |
| `BRIDGE_COLD_CONNECT_BUDGET_MS` / `BRIDGE_COLD_START_LEAD_MS` / `BRIDGE_WARM_START_LEAD_MS` | 2000 / 4500（=2500+2000）/ 2500 | `:90` / `:98` / `:99` |
| `BRIDGE_MIN_BUFFER_MS` | 1000（持续供给下限） | `:106` |
| `MAX_HELD_AUDIO_US` / `MAX_HELD_CHUNKS` | 45_000_000 / 4_000（锚未定时 hold 上限） | `:112` / `:116` |
| `BRIDGE_TRANSPORT_RECOVERY_GUARD_SECONDS` / `BRIDGE_REJOIN_ATTEMPT_DELAYS` | 30.0 / (5, 30) | `:135` / `:142` |
| `AIRPLAY_LATE_JOIN_MIN_HEADROOM_MS` / `AIRPLAY_CLOCK_READY_TIMEOUT_MS` / `AIRPLAY_CLOCK_READY_LEAD_MS` / `AIRPLAY_SPLICE_LEAD_MARGIN_MS` | 2500 / 2500 / 500 / 150 | `airplay/constants.py:116` / `:129` / `:136` / `:214` |

### 2.4 格式契约（MA 桥角色，落地前必须定死）

`bridge_role.py:38-43`：`BRIDGE_SAMPLE_RATE = 44100 / BRIDGE_BIT_DEPTH = 16 / BRIDGE_CHANNELS = 2`。
`AudioChunk.data`（`aiosendspin/server/roles/base.py:69`）语义是「**Transformed audio bytes**」——server 按每个客户端声明的格式**独立 transform** 后再投递。所以 MA 的 bridge 收到的是 **44.1k/16/2 裸 PCM**，可直接写 CLI stdin；这与我们「桥成员声明 `codec=pcm` 就拿到自己的独立 PCM 流」同构。

### 2.5 AirPlay 1 vs AirPlay 2 计时

| 维度 | AirPlay 1（RAOP） | AirPlay 2 |
|---|---|---|
| 时钟 | 无 receiver 时钟（`ClockReadiness.NOT_APPLICABLE`），NTP 口径 | PTP（需绑 UDP 319/320）或 NTP；`--protocol airplay2-compat` 走 auth-setup+RAOP |
| 认证 | 无 / 可选加密 | HAP pair-setup（PIN）+ 加密 RTSP + 二进制 plist SETUP |
| 音频 | ALAC-raw（可 AES） | ALAC（24bit 用 0x80000/0x200000），ChaCha20-Poly1305 |

MA 两条硬规则（我们继承）：① **一个 Sendspin 组绝不混两种计时源**（`resolve_shared_ptp` L1705，组内已定 PTP/NTP 则后来者随大流）；② 守护进程在 spawn 窗口内未就绪 ⇒ **整组静默降级 NTP**（不等，因为桥的 lead 已固定，等待会把锚点推过已调度的音频）。

---

## 3. 三条病根（本文的「为什么」，全部已落地）

### 3.1 采样率双口径：48k 灌给 44.1k = 变调 8.8%

| 侧 | 采样率 | 位深 | 声道 | 出处 |
|---|---|---|---|---|
| sendspin 组泵 PCM | **48000** | 16（s16le） | 2 | `sendspin/encoding.ts:31` |
| airplay RAOP 期望 | **44100** | 16 | 2 | `airplay/raop.ts:25` |
| MA bridge role | 44100 | 16 | 2 | `bridge_role.py:38` |

直接把泵的 PCM 灌给 RAOP ⇒ 播放速度 ×1.088、音调升高 8.8%。**这不是一眼能看出的错误，而是「磁带跑快点」式的慢性故障**，耳朵几乎定位不到，FFT 一测即中（1088Hz vs 1000Hz）。

- **为什么不能「让 RAOP 直出 48k」**：`raop.ts` 的 `opts.sampleRate` 本就可配（`:319`、`:512` fmtp 用它），但 AP1 接收端不成立 —— `strings /usr/bin/shairport-sync | grep -c 44100` = 9、`48000` = **0**；MA 自身基础 PCM 也恒 44.1k（`constants.py:352`），48k 只出现在 24bit hires 特例。
- **定案**：AP1 强制 44.1k + 桥侧 147/160 有理数多相 FIR（每相 32 抽头，群延迟 **0.3627ms** = 5120/2/147/48000）；AP2 按 SETUP 协商 48k 优先、失败回落；**样本↔字节↔时间换算与重采样只允许在 `resampler.ts` / `bridgeMath.ts` 一处**。
- **历史同源**：旧 BridgeRing 就是「写 48000 帧/s vs clock 88346/s（44100×2）」两套口径打架 ⇒ 本次铁律「速率/换算单点」。

### 3.2 RAOP `stream()` 本身就是墙钟自推 —— 驱动权必须交出

旧稿写「`raopSender.ts`：薄封装现有 `stream(producer)` 改成 push 模式」，**严重低估改造量**。实际实现（`raop.ts:754-800`）：

```ts
const wallStart = performance.now();
this.startNtp = ntpNow();
let idx = 0;
while (this.streaming && !this.destroying) {
  const target = wallStart + idx * chunkDurMs;   // ★ 自己算的墙钟时间线
  ...
  const buf = await producer();                  // 拉
  ...sendChunk(...); idx++;
}
```

`idx` 单调递增 ⇒ 内容位置完全由「已发包数」决定，与 sendspin 时间线无关。**这与旧 BridgeRing 双时间线打架是同款结构，只是换了个位置。**

必须做的三件事（已完成）：

1. **换驱动源**：发送时刻与内容位置都由 `tsUs` 决定，废除 `wallStart + idx*chunkDurMs`。桥走独立的 `streamBridge()`，与 native `stream()` 物理分离。
2. **支持位置跳变**：四个锚点 `baseTs`/`startTs`/`headTs`/`startNtp` **必须一起写**（只改 `startTs` 会让 `positionSec` 变垃圾且不报错）；桥路径**禁止**触发 `prepareSeek()` / `setStartPosition()` / cast 的 `seekSec`（`raop.ts` 上**没有** `seek()` 方法）——它们把 `startTs` 重锚而 `startNtp` 不动，这是 2026-10-21「拖动后彻底无声」的成因。
3. **延迟分三层，谁也不归零**：`latencyFrames`（接收端保持深度，`raop.ts:289` 初值、`:615` 取 `max(audioLatency, sampleRate)`）进锚点公式 `startNtp = NTP(A − L)`；启动 lead（4500/2500）只进 `streamEngine.anchorLead`；`minBufferMs=1000` 进 `commonSendAheadUs`。
   **旧方案的错误**是把「链路延迟只从 sendAhead 上报、RAOP latency 归零」当去重 —— 正确是三层各自存在：lead 管这次起播提前多少，sendAhead 管持续发送节奏，latency 管设备缓冲深度及 RTP 映射偏移。

> 详细推演见 [AirPlay1-2与Sendspin桥接-最终实施方案.md](./AirPlay1-2与Sendspin桥接-最终实施方案.md) §2.1~§2.3，实现级坐标见 [airplay-权威方案文档.md](./airplay-权威方案文档.md) §10。

### 3.3 跨进程 PCM 通路 —— 旧方案完全遗漏的架构问题

**三进程拓扑**（第三轮曾误写成「组泵在主进程」）：

```
主进程（路由/DB/调度，不跑节拍）
  ├─ sendspin 渲染子进程（GroupPump、pushFrame、ringFor、SendspinGroup）
  └─ airplay 渲染子进程（raop.ts、RTP 7.98ms 节拍）
```

两侧都在 fork 子进程里：`airplay/mode.ts` 生产默认 fork（2026-10-22 翻默认，真机实锤「主进程事件循环被占 ⇒ RTP 7.98ms 节拍被打散、reanchors 抬升、maxGap 2s、听感断音」）；`sendspin/supervisor.ts` 头注释同构（WS 38927 + 解码/编码/推流 + mDNS + 拨号 + 6053 桥 fork 到子进程）。

⇒ PCM 是 **sendspin 子进程 → airplay 子进程**（≈192KB/s/成员），**不经主进程**。连「主进程中转」这条偷懒路都不存在。

- **现有 IPC 此路不通**：`airplay/ipcProtocol` 与 sendspin 同名模块都走 `process.send` JSON 序列化，Buffer 会变成 `{type:'Buffer',data:[...]}`（每样本一个数字）。
- **三条候选，已拍板 D3**：① net 二进制管道（选定，airplay listen / sendspin connect，路径与协议由主进程 RPC 下发）② RAOP 会话迁 worker_threads（**否决**：违反 `check-renderer-host.mjs`，守卫只认 rendererHost fork 形态）③ 桥接降级 in-proc（**否决**：两个节拍挤一个事件循环，重蹈 2026-10-22）。
- **附带动因**：驱动权移交后，RAOP 正确性取决于 RTP↔NTP 映射（SYNC 负责对齐），发送只要「不早于节流上限、不晚于可听时刻」，所以普通管道足够；但**进程隔离不可放弃**（RAOP 网络栈崩溃不能连坐 sendspin 子进程）。
- 帧格式（28B）与背压口径见 [AirPlay1-2与Sendspin桥接-最终实施方案.md](./AirPlay1-2与Sendspin桥接-最终实施方案.md) §2.5。

### 3.4 顺带澄清的两条「供给口」结论（当时是利好，现已进代码）

- **供给口现成**：`pushFrame`（`server.ts:1128`）按 `(codec, gain)` 分组、每组独立编码一次（`encoderKey` `:782`、`encoderForGroup` 带编码器自愈 `:785-792`）⇒ 桥成员声明 `codec=pcm` 就拿到自己的独立 PCM 流。原设想的「PcmWindow 挂钩」「桥侧解 FLAC」两条路**作废**。
- **晚加入回填现成**：`ringFor`（`:1218`）按编码组维护未来音频，`pruneRecent` 按 `LATE_JOIN_KEEP_PAST_US`（1s）/ `LATE_JOIN_RING_MAX_US`（35s）逐出；`flushAnnounceFor`（`:626`）已修好「先宣告后给货留空窗、设备丢弃该流」的真机坑 ⇒ 桥自动获得独立 ring + 补齐 + 正确宣告时序，比 MA 自己实现 `_held_chunks` 省事。
- **但成员是强类型**：`members = new Set<SendspinConnection>()`（`server.ts:580`），`SendspinConnection` 强绑 `ws`（`:1477`），`sendAudio` 走 `ws.send`（`:2378`）。前稿「抽 5 方法 GroupSink 然后改 Set」被否决（真实使用面还含 `clientWantsStream`/`sendJson`/`sendPlayerCommand`/`legacy`/`muted`/`sinkHealth`/`lastBufferedAmount`/`announceStream`/`syncStaticDelayTo`，且 `broadcastGroupState` 会把成员 id 下发给真实设备，波及 51 个测试文件）⇒ **并行 `bridges`，`members` 原样不动**。

---

## 4. 失败排查路径（交付前的老清单，仍然有效）

| 症状 | 优先查 |
|---|---|
| 会话建了但无声 | 落盘 PCM 是否非零 → 供给链（组泵→bridgeChannel）是否真在喂；再看 bridge 队列是否已进 hardCap 断连 |
| 有声但明显偏移 | `scheduledAnchorUs` 与 `commandedLeadUs` 两条日志；确认 `startNtp = ntpFromHostUs(A − latencyFrames/rate)` 而不是 `A` 本身 |
| **声音正常但跑调/偏快** | **优先查采样率**（48k 灌 44.1k ⇒ +8.8%）。用 FFT 测基频，别靠耳朵 |
| **桥成员恒定晚于组内其他成员** | ① `commandedLeadUs` 是否被 `ANCHOR_SAFE_LEAD_US=800ms` 钳死（桥路由必须绕过 `streamEngine.ts:846`）；② 不要去找「哪一层多算了一次」——`latencyFrames` 必须保留并进锚点公式；③ 也不要把 lead 并进 `commonSendAheadUs()`（全组 +3.7s） |
| seek 后错位/重建会话 | `generation` 是否随二元组 `epoch * 1_000_003 + timelineReseed` 递增（只用 `epoch` 漏 rehost，只用 `timelineReseed` 漏 seek）；`bridges.size` 是否被 `g.close()` 误清；保活窗内应 flush-refill 而非重建 |
| 组内两台互相漂 | 是否混用计时源：`nowUs()` 与 `ntpNow()` 必须同源；一旦混入 `Date.now()`/Unix，`stats` 里两台 `clock` 就对不上 |
| 偶发静音、日志 STALLED | 时钟未就绪仍锚定属预期；持续无声再查接收端时钟响应 |

---

## 5. 风险与遗留（只列仍然成立的）

1. **采样率口径**：AP1 强制 44.1k + 147/160 重采样；换算单点由守卫钉死（旧 BridgeRing 的直系后代）。
2. **双会话所有权**：桥成员与 solo cast 抢同一 RAOP 会话 ⇒ 流开始时快照路由、`detachFromActiveGroups` 纳入 airplay、`stopAirPlaySessionsForHost` 跳过桥。**已落地**，守卫必守。
3. **背压**：`sendAudio()` 同步，不能用它停组泵；每桥有界队列 + hardCap 断连 + `(5s,30s)` 退避；**禁止丢最旧帧**（会造「时间戳连续但内容有洞」，互相关还能测出「很小」的 delta，最难查）。
4. **无 ack 语义**：自研 RAOP 没有 `[STATUS] started`。字段只能是 `scheduledAnchorUs`（「我要求它在这个时刻播」），**不得**写成 `acked ... off the commanded instant` —— 历史上因此误判同步已达成。
5. **AP2 必须拆阶段**：realtime（type 96，RTP/UDP+NTP）与 buffered（type 103，RTP/TCP+**依赖 PTP**）是两套工程；PTP 需特权端口 UDP 319/320，组内必须同源。**现状**：realtime 与 HAP 凭据已实现（15 文件 3067 行 + 7 个 QA 用例），但**未接入生产链路**（`control.ts` 无引用、无 flag 入口）；buffered/PTP 未开始。
6. **`hap_credentials` 消费契约**：DB 有列与幂等迁移（`db/index.ts:469`、`:752` 起），写入时机/验证/失效清理已定义为 Phase 6a 门禁（`ap2/hapCredentials.ts` 是切分唯一出处，192hex = 64 LTPK + 128 LTSK）。
7. **模拟器泄漏**：AP2 床每会话泄漏满 CPU 子进程（历史 load 100+），症状是「组位置恒 0 / 握手 30s / 矩阵偶发 FAIL」——**别查协议**，先按手册 §3.2 四步整床重启。
8. **代码债**：`sendspin/group.ts:101` 有同名 `SendspinGroup` 死代码（成员是 `Set<string>`、无人 import），实际生效的是 `server.ts:577`；写守卫时认准文件。

---

## 6. 附录：权威坐标索引

**MA 源码（230 `/workspace/MA`）**

- `providers/airplay/sendspin_bridge.py`：锚点 L886 / 对齐 L1518 / 节流 L1580 / 热复用 L531 / re-anchor 吸收 L1411 / 组 PTP 决策 L1705；`:165` 与 `:192` 是「距 now 的偏移」双向换算（要求两侧背靠背采样）；`:79/:85/:90/:98/:99/:106/:112/:116/:135/:142` 常量
- `providers/sendspin/bridge_role.py`：外部客户端角色、`set_timing`（keyword-only 无默认，`:154`）
- `providers/sendspin/bridge_manager.py`：生命周期与 derived-transport
- `providers/_demo_sendspin_clients/device.py`：假设备蓝图

**本仓代码（改造前取证点，行号可能已漂移；以函数名为准）**

- `sendspin/server.ts`：`pushFrame` `:1128`（分组独立编码）、`encoderKey` `:782`、`encoderForGroup` `:785`、`members` `:580`、`SendspinConnection` `:1472`、`sendAudio` `:2378`、`ringFor` `:1218`、`flushAnnounceFor` `:626`、`commonSendAheadUs` `:815`、`offloadsVolume` `:724` 恒 true、`appliedGain` `:737` 恒 100、`announcedSampleRate` `:1578/:2023`（**仅记录、无按速率变换 ⇒ 服务端恒 48k 下发**）
- `sendspin/group.ts:76` `computeCommonSendAhead`（全组取 max）、`:47` `DEFAULT_MIN_BUFFER_MS=800`、`:101` 同名死代码
- `sendspin/streamEngine.ts`：`:376` `epoch`、`:532`/`:1179` 自增、`:1291` `timelineReseed++`（仅 rehost）、`:813` 重锚分支（代次钩子唯一落点）、`:846` lead 钳制、`:759` 推流循环
- `sendspin/encoding.ts:31` `SAMPLE_RATE=48000`、`:876` `PcmEncoder`；`sendspin/constants.ts:63/65/67` 晚加入常量、`:2-4` `WS_PATH=/sendspin`、`WS_PORT=38927`
- `airplay/raop.ts`：`:25` `SAMPLE_RATE=44100`、`:28-29` `CHUNK_LEN=352`/`1408B`、`:70` `ntpNow()`（旧用 `performance.now()`）、`:258` `PcmProducer`、`:289` `latencyFrames`、`:615` 取 max、`:754` `stream()` 墙钟自推
- `airplay/mode.ts` 默认 fork；`airplay/ap2/`（15 文件 3067 行，未接线）
- `group/protocolPlayer.ts:138` `splitGroupMembers` 三桶、`:343` 逐设备 cast 现状；`routes/api/shared.ts` `detachFromActiveGroups`（`kind !== "dlna" && !== "sendspin"` 就 return，**改造前漏 airplay**）
- `db/index.ts:469` `hap_credentials`、`:752` 幂等迁移；`routes/api/sendspin.ts:299/316` 配对路由
- aiosendspin 10.2.1：`client/client.py:1324` 四参数回调、`:1328` `server_timestamp_us` = when this audio should play、`send_ahead` = Never affects when the chunk plays；`client/connection.py:2090` `compute_play_time()` 再减 `output_delay`；`client/models.py:138` / `audio/format.py:48` 格式结构

**230 资产**：`/opt/mf-airplay/cliairplay`（v0.5.9）、`/tmp/ap2recv/`（AP2 + AP1 接收端源码）、`/root/ap2_bed.sh`、`/root/ssvenv`（aiosendspin 10.2.1）

---

## 7. 事实核对纪律（六轮复核的产出不是「又看了一遍」）

> 任何新断言都必须能填出「依据」（命令输出 / `文件:行`）；填不出来的降级为「未验证」，**不得进设计**。

**「已被本仓代码证伪、不得再写回去」的 8 条清单不在本文维护** —— 见
[AirPlay1-2与Sendspin桥接-最终实施方案.md](./AirPlay1-2与Sendspin桥接-最终实施方案.md) §0（每行「旧设计 → 被什么推翻 → 现在的做法」）。
那 8 条与本文 §3 的三条病根是同一批事实的两种表述，两处并存必然漂移。

三条「文档说已改、实机没改」的教训（仍然有效，值得单独记）：

1. `hap_credentials` 行号偏 1（`:468`→`:469`）—— 凭记忆写行号必错，必须当场 grep。
2. MA 常量行号整体偏移（`MAX_DEVICE_BUFFER_SECONDS` 实际 L79，不是 L88）。
3. `/root/fake_sendspin.py` 的 `sample_rate=44100`：**文档改了脚本没改** → 结论：文档里的「已修」必须附一次实机 `grep`/`py_compile` 输出。

> 原始终审/复验/开工前验证报告已归档：`docs/archive/`（索引见 `docs/archive/README.md`）。
