# MusicFlow：改造现有 AirPlay 模块实现 AirPlay 1/2 + Sendspin 桥接同步

> 调研基准：MA master `7dfa5d8`（2026-10-23，230 `/workspace/MA`）；**已完成六轮复核**。第六轮（2026-10-25 深夜）逐行核对时钟域、`send_ahead` 语义、RAOP latency、音量路径、GroupSink 使用面、背压、群组生命周期和验收资产，修正了前五轮遗留的四类架构错误。
> 目标：以**现有 `backend/src/services/airplay/` 模块为底座**补齐 AirPlay 2 发送端，并让 AP1/AP2 成员被 Sendspin 组时间线驱动，实现跨协议同步播放。
> 验收环境：230 全模拟（假 Sendspin 设备 + AP2 接收端床 + shairport-sync AP1 接收端），无需真实音箱。
>
> **本文第六轮结论以文末「附录 C」为最终口径**；正文中与之冲突的旧表述已就地改写。开发执行细节见《AirPlay1-2与Sendspin桥接-最终实施方案.md》。

---

## 0. 结论摘要

1. **MA 的权威答案**：AirPlay 不自己承担同步，而是把每台 AirPlay 设备注册为 **Sendspin 的外部客户端**（`player@_bridge` 桥角色），由 Sendspin 组时间线统一调度，AirPlay 只当输出口。
2. **我们已有的天然接缝**：`airplay/raop.ts` 里已定义 `PcmProducer = () => Promise<Buffer|null>` 与 `stream(producer, session)`——发送端是「拉」PCM 的，桥接只需替换 producer 的供给方，不必重写 RAOP 协议栈。
3. **我们真正的缺口（三轮复核后的定稿版，按严重度排序）**：
   - **采样率不一致**：sendspin 泵 `48000` vs airplay RAOP `44100` ⇒ 直接桥接会**变调 8.8%**（3.1-(2)）。**AP1 接收端不支持 48k（shairport-sync 3.3.8 二进制内无 `48000` 字符串）⇒ 桥接必须内建 48k→44.1k 有理数重采样，这是硬需求不是选配**；
   - **RAOP 自带墙钟时间线**：`stream()` 是 `wallStart + idx*chunkDurMs` 自推循环，必须交出驱动权——这是 BridgeRing 病根的同构结构，也是 Phase 2 真难点（3.2）；
   - **跨进程 PCM 通路缺失（第三轮复核新增，第五轮修正拓扑）**：raop.ts 在 airplay 渲染子进程、组泵在 **sendspin 渲染子进程**（两者同属 rendererHost 托管），现有 JSON IPC 序列化不可用，必须新增二进制通路（3.3）；
   - **组成员强类型 `Set<SendspinConnection>`**：桥接成员无 WS。第六轮复核后**不再建议改 `members` 类型**，改为并行 `bridges` 集合 + `pcm:100` 编码组投递（3.1-(1c)）；
   - **时间轴口径错误（第六轮新增）**：旧方案把 Sendspin 时间戳换算成 Unix ms 再交给 RAOP，但 Sendspin 用 `process.hrtime` 单调微秒、RAOP 用 `performance.now` 单调毫秒，二者既不同源也不是 Unix 时间；且 RAOP `latencyFrames` 被错误要求归零。现统一为 host-monotonic µs，并把 latency 纳入 RTP↔NTP 映射（3.2）；
   - `airplay/ap2/` 是**空目录**，discovery 只记录能力标记（`AirPlayAp2Info`），**没有 AP2 发送端**（realtime 与 buffered 已拆成两个独立阶段）。
   
   **反而的利好**：`pushFrame` 本就是 per-member（按 codec+gain 分组）独立编码，`PcmEncoder` 现成，且 `ringFor` 晚加入回填已有 ⇒ 桥接的"供给口"不需要新建，只需接通。
4. **路线**：不动 RAOP 协议栈、不引入外部二进制做生产路径；新增 `AirPlaySender` 统一接口（RAOP 实现已有 / AP2 新写），上层换成 Sendspin 组时间线驱动。

### 0.1 🔴 编号口径（MAJ-02：跨文档指代必须统一）

第七轮终审发现：本文与《最终实施方案》的 **D 编号指向不同决策**，同时在线时任何人引用 "D2/D4" 都会指向错的东西。

| 本文旧写法 | 旧含义 | 《最终实施方案》里的真实编号 | 正确含义 |
|---|---|---|---|
| "D2（已拍板，跨进程通路）" | 跨进程通路 | **D3** | 数据面与所有权 |
| "D4 修正（音量）" | 音量 | **D5** | 音量 |

**定案：决策编号只在《最终实施方案》§1 定义**，本文一律写成「见实施方案 §1 · D3 / D5」，不再自造 D 编号。

### 0.2 阶段口径（MAJ-03：两套 Phase 编号会让人排期对不上）

本文的阶段划分（0/1/2a/2b/3/3.5/4/5a/5b/6）是**调研视角**；《最终实施方案》（0~8）是**开发执行视角**，两者出口条件曾经错位（本文 P2a 就要求"两边出声"，实施方案到 P3 才做组泵出声）。

**定案：阶段编号与退出判据以《最终实施方案》§8 为唯一口径。** 映射表：

| 本文 | 最终实施方案 | 说明 |
|---|---|---|
| Phase 0 基线可观测 | P0 | 验收链门禁 |
| Phase 1 速率契约+重采样 | P1 | 时钟 + 重采样 + 纯函数 |
| Phase 2a-0 跨进程管道 | P2 | 通道与 bridge session 骨架 |
| Phase 2a 桥接出口出声 | **P3** | 实施方案在 P3 才接组泵 |
| Phase 2b 时间线映射 | P4 | 锚点/对齐/无 ack |
| Phase 3 对齐与音量 | P4 | 已并入 P4（音量走设备侧，无独立阶段） |
| Phase 3.5 生命周期与背压 | P5 | |
| Phase 4 节流/热复用/恢复 | P5 | |
| Phase 5a AP2 realtime | P6b（6a 为凭据门禁） | |
| Phase 5b AP2 buffered+PTP | P7 | |
| Phase 6 守卫与测试 | P8 | |

---

## 1. 调研来源

| 来源 | 路径/版本 | 用途 |
|---|---|---|
| MA 桥接实现 | `music_assistant/providers/airplay/sendspin_bridge.py`（1808 行） | 锚点/对齐/节流/热复用全套语义 |
| MA 桥角色基类 | `providers/sendspin/bridge_role.py`（`BridgePlayerRole`） | 外部客户端如何接 PushStream、上报 lead/min_buffer |
| MA 桥生命周期管理 | `providers/sendspin/bridge_manager.py`（`SendspinBridgeManagerBase`） | derived-transport 边、provider 通用化 |
| MA 假 Sendspin 设备 | `providers/_demo_sendspin_clients/device.py`（295 行） | **模拟器蓝图**（沿用其客户端接法） |
| MA Sendspin 播放会话 | `providers/sendspin/playback.py`（`SendspinPlaybackSession`，含 join catchup） | 组泵与晚加入追赶 |
| cliairplay | `/opt/mf-airplay/cliairplay` v0.5.9 | AP1/AP2 协议参数、计时口径对照 |
| AP2 接收端源码 | `/tmp/ap2recv/`（含 `ap2/`、`pairing/`、`airplay1.py`） | **AP2 发送端的协议参考实现**（反向） |
| aiosendspin | `/root/ssvenv` 内 10.2.1（与 MA 锁定同版本） | 假 Sendspin 设备运行时 |

---

## 2. MA 权威方案精要

### 2.1 架构（一句话）

> Sendspin 组时间线是唯一同步权威；AirPlay 只是输出口。桥成员**永远以 join 身份加入**，从不设定时间线。

```
Sendspin 组 pump（唯一时间线）
   ├─ 真 Sendspin 设备（WebSocket player@v1）
   └─ 桥接成员（player@_bridge 角色）── on_audio_chunk ──▶ AirPlay CLI stdin ──▶ 音箱
```

- 注册：`register_external_player(hello, on_stream_start=...)`，client_id 由 **MAC 派生**（便于协议 linking，把 SendspinPlayer 与 AirPlayPlayer 挂成 derived-transport 父子边）。
- 角色声明：`supported_roles=[BRIDGE_ROLE_ID, "player@v1"]`，PCM 44.1k/16/2，`buffer_capacity=1000`，支持 VOLUME/MUTE。
- 音频不走 WebSocket，直接回调 `on_audio_chunk` → 写 CLI stdin。

### 2.2 同步四件套（照抄语义即可，附行号）

| 机制 | 实现位置 | 语义 |
|---|---|---|
| **① 锚点 ack 回映射** | `_anchor_stream()` L886-1029 | START 下 `join=True`；**不以命令时刻为准，而以 binary ack 的实际调度时刻为准**：回映射到组时间线得 `_drop_until_us`，之前的块丢弃、之后的按字节偏移写入；若 ack 更早则补静音（`skipped_us` 为负） |
| **② 字节偏移对齐** | `_align_chunk()` L1518-1565 | `target_frames = (chunk.timestamp_us - _drop_until_us) * rate / 1e6`；空洞补静音、重叠裁头；漂移 >1ms 记 warning 并重对齐 |
| **③ stdin 节流 ≤8s** | `_cli_writer()` L1580-1645 | 按「已写字节数 + 墙钟」算设备领先量，超 `MAX_DEVICE_BUFFER_SECONDS=8.0` 就 sleep——晚加入的追赶积压**逐渐喂**，绝不倾倒 |
| **④ CLI 热复用** | `_can_reuse_stream_warm()` L531 / `_on_stream_start` L559 | 流尾保活 `BRIDGE_WARM_GRACE_SECONDS=4.0`，seek/下一首走 flush-refill 免冷启；冷启 lead = 晚加入余量 + 2s 连接预算，热启只需余量 |

**① 的精确公式（逐行取自 `_anchor_stream`，照抄时按这个来）**：
```python
readiness, ready_at_unix_ms = await stream.wait_clock_ready(timeout=CLOCK_READY_TIMEOUT)
sendspin_now_us = server.clock.now_us();  unix_now = cli_clock_time();  now_ms = int(unix_now*1000)

first_chunk_unix_ms = sendspin_audible_instant_to_unix_ms(_drop_until_us, sendspin_now_us, unix_now)
anchor_ms = max(now_ms + AIRPLAY_LATE_JOIN_MIN_HEADROOM_MS, first_chunk_unix_ms)   # 2500ms 余量
if ready_at_unix_ms:
    anchor_ms = max(anchor_ms, ready_at_unix_ms + AIRPLAY_CLOCK_READY_LEAD_MS)      # +500ms
if warm:                                                                            # 热复用追加两条
    if stream.warm_lead_ms > 0:
        anchor_ms = max(anchor_ms, now_ms + stream.warm_lead_ms - min(0, adjust_ms) + SPLICE_LEAD_MARGIN_MS)
    if stream.flushed_head_unix_ms > 0:
        anchor_ms = max(anchor_ms, stream.flushed_head_unix_ms - adjust_ms + SPLICE_LEAD_MARGIN_MS)
commanded_ms = anchor_ms + adjust_ms          # sync_adjust 只进命令,不进组时间线
acked_adjusted = await stream.start(commanded_ms, join=True)
acked_timeline_ms = acked_adjusted - adjust_ms          # ★ 先减回去
anchor_us  = unix_ms_to_sendspin_audible_instant(acked_timeline_ms, ...)
skipped_us = anchor_us - self._drop_until_us            # 负 = ack 更早 ⇒ 之后会补静音
self._drop_until_us = anchor_us                         # ★ 双语义:既是"该丢到哪",又是"锚点"
self._queued_frames = 0; self._applied_shift_seconds = 0.0; self._absorbing_shift = False
```
关键语义（文档原版遗漏）：
- `_drop_until_us` **一个变量两种含义**：既是"丢弃到此为止"的游标，又是当前锚点。全部对齐逻辑都挂在它上面。
- `sync_adjust` **进命令、不进组时间线**（`commanded = anchor + adjust`，ack 回来再 `- adjust` 换算回组时间线）。
- `warm` 分支的两条 `max` 是**热复用正确性的核心**：接收端只服从「落在已 flush 头部之后」的指令，负 adjust 会吃掉 lead 所以要 `- min(0, adjust)` 补回。
- `STALLED` 时**仍然锚定**（只告警）——比"晚加入者被丢弃"宽松，因为这里停播会直接掐掉音箱。

配套机制：
- **lead/缓冲上报**：`set_timing(*, required_lead_time_ms, min_buffer_ms)`（**keyword-only、无默认值**，`bridge_role.py:154`）→ PushStream 据此调度首块（桥自己声明启动延迟与抖动需求）。
- **re-anchor 吸收**：`_absorb_playout_shift()` L1411——CLI 断粮后自行推迟 playout 的 `cumulative_shift_seconds` 要折叠回锚点映射，否则设备永久落后。
- **held 上限**：锚未定时最多 hold `MAX_HELD_AUDIO_US=45s` / 4000 块，防「锚点永不落地」。
- **重投递预算**：每新流重置传输恢复预算；传输丢失只由**已锚定**的流判定，防双进程互踩。

### 2.3 AirPlay 1 vs AirPlay 2 计时

| 维度 | AirPlay 1（RAOP） | AirPlay 2 |
|---|---|---|
| 时钟 | 无 receiver 时钟（`ClockReadiness.NOT_APPLICABLE`），NTP 口径 | PTP（需绑 UDP 319/320）或 NTP；`--protocol airplay2-compat` 走 auth-setup+RAOP |
| 认证 | 无 / 可选加密 | HAP pair-setup（PIN）+ 加密 RTSP + 二进制 plist SETUP |
| 音频 | ALAC-raw（可 AES） | ALAC（24bit 用 0x80000/0x200000），ChaCha20-Poly1305 |

MA 的两条硬规则（我们应继承）：
1. **一个 Sendspin 组绝不混两种计时源**（`resolve_shared_ptp` L1705）：组内已定 PTP/NTP 则后来者随大流；无人定过才问守护进程。
2. 守护进程在 spawn 窗口内未就绪 → **整组静默降级 NTP**（不等待，因为桥的 lead 已固定，等待会把锚点推过已调度的音频）。

### 2.4 常量速查（第五轮逐行核对，行号为精确值）

**`sendspin_bridge.py` 顶部（L79-142）**：
```
MAX_DEVICE_BUFFER_SECONDS = 8.0      # 设备领先上限（节流阈值）      L79
BRIDGE_WARM_GRACE_SECONDS = 4.0      # 流尾保活窗口                  L85
BRIDGE_COLD_CONNECT_BUDGET_MS = 2000 # 冷启连接预算                  L90
BRIDGE_COLD_START_LEAD_MS = AIRPLAY_LATE_JOIN_MIN_HEADROOM_MS + BRIDGE_COLD_CONNECT_BUDGET_MS  # =4500  L98
BRIDGE_WARM_START_LEAD_MS = AIRPLAY_LATE_JOIN_MIN_HEADROOM_MS   # =2500          L99
BRIDGE_MIN_BUFFER_MS = 1000          # 持续供给下限                  L106
MAX_HELD_AUDIO_US = 45_000_000       # 锚未定时 hold 上限            L112
MAX_HELD_CHUNKS = 4_000              # 同上（块数上限）              L116
BRIDGE_TRANSPORT_RECOVERY_GUARD_SECONDS = 30.0   # 恢复预算守卫      L135
BRIDGE_REJOIN_ATTEMPT_DELAYS = (5, 30)           # 重投递退避（秒）  L142
```
**`airplay/constants.py`**：
```
AIRPLAY_LATE_JOIN_MIN_HEADROOM_MS = 2500    # 晚加入余量              L116
AIRPLAY_CLOCK_READY_TIMEOUT_MS = 2500       # 时钟就绪等待            L129
AIRPLAY_CLOCK_READY_LEAD_MS = 500           # 时钟就绪提前量          L136
AIRPLAY_SPLICE_LEAD_MARGIN_MS = 150         # 热重锚余量              L214
AIRPLAY_LATE_JOIN_RING_MIN_SECONDS = 12.0   # 原生晚加入环形缓冲      L233
```

### 2.5 ⚠️ 格式契约：MA 桥角色的音频格式（复核新增，落地前必须定死）

MA `bridge_role.py` L38-43：
```
BRIDGE_SAMPLE_RATE = 44100; BRIDGE_BIT_DEPTH = 16; BRIDGE_CHANNELS = 2   # PCM s16le
```
`AudioChunk.data`（`aiosendspin/server/roles/base.py:69`）语义：**「Transformed audio bytes (PCM or encoded, depending on transformer)」**——即 server 按每个客户端声明的格式**独立 transform** 后再投递。所以 MA 的 bridge 收到的是 **44.1k/16/2 的裸 PCM**，可以直接写 CLI stdin。

---

## 3. MusicFlow 现状盘点（改造基线）

| 文件 | 现状 | 桥接中的角色 |
|---|---|---|
| `airplay/raop.ts` | AP1 发送端，`PcmProducer` + `stream(producer, session)`，`sendChunk()` 编码 ALAC-raw | **RAOP 实现**（保留） |
| `airplay/decoder.ts` | ffmpeg 解码 → 有界 PCM 环形队列（prefill 1500ms / 上限 10s / 背压） | 改为可选供给源（非桥接时仍用它） |
| `airplay/mode.ts` | 默认 fork 子进程（`MUSICFLOW_AIRPLAY_*`） | 保持不变 |
| `airplay/childMain.ts` / `sessionRuntime.ts` / `supervisor.ts` | 子进程 RPC：cast/stop/pause/resume/seek/setVolumeDb | 新增 bridge 相关 op |
| `airplay/discovery.ts` | 已有 `_airplay._tcp` 能力收集 `ap2?: AirPlayAp2Info`（仅标记） | 供 AP2 协议选择 |
| `airplay/ap2/` | **空目录** | **本方案要填实** |
| `sendspin/constants.ts` | `WS_PORT=38927`、`WS_PATH=/sendspin`、mDNS `_sendspin-server._tcp` | 模拟器连接地址 |
| sendspin 组泵 | `ug:<groupId>` 共享 pump + 单时间线 | **同步权威** |
| `sendspin/encoding.ts` | `SendspinCodec = "opus" \| "flac" \| "pcm"`；**已实现纯 JS `PcmEncoder`（F32→s16le，零延迟，L876-890）**；`SAMPLE_RATE=48000`、`CHANNELS=2`、`FLAC_BIT_DEPTH=16`（L31-35） | **桥接的供给口已现成**（见 3.1） |
| `sendspin/streamEngine.ts` | 注释 L4：`SendspinGroup.pushFrame` **对每个成员独立编码 opus/flac/pcm 后下发** | per-member transform == MA 的 transformer |
| `sendspin/server.ts` | `sinkHealthOf()` / `sinkRecoveryLevel` / `lastBufferedAmount` / sink 自愈（L124-906） | 面向 WS 客户端；桥接成员需适配上报 |

### 3.1 🔴 复核新发现：两条改写方案的硬事实

**（1）供给口比预想的好得多——不用碰 PcmWindow、不用解 FLAC（已逐行求证）**

`pushFrame`（`server.ts:1128`）的实现是**按 `(codec, gain)` 分组、每组独立编码一次**：
```ts
// ---- 分组:同 (codec, gain) 的成员共享一次编码 ----
for (const c of this.members) { const key = this.encoderKey(c.codec, c.appliedGain()); ... }
for (const [key, g] of groups) {
  const enc = this.encoderForGroup(g.codec, g.gain);
  chunks = await enc.encode(this.scalePcm(pcm, g.gain));
  for (const c of g.members) c.sendAudio(ts, data);   // 同组共享字节
}
```
配套：`encoderKey = \`${codec}:${gain}\``（L782）、`encoderForGroup` 带**编码器自愈**（`isHealthy()===false` 就换新，L785-792）。

⇒ 桥接成员声明 `codec=pcm` 就能拿到**自己的独立 PCM 流**，与 MA `BridgePlayerRole` 同构。原设想的「PcmWindow 挂钩」「桥接侧解 FLAC」两条路**作废**。

**（1b）✅ 晚加入回填机制现成，比 MA 还省事**

`ringFor(key)`（L1218）为**每个编码组**维护一份「未来还没播的音频」环形缓存，`pruneRecent` 按 `LATE_JOIN_KEEP_PAST_US` / `LATE_JOIN_RING_MAX_US` 逐出；新成员加入时 L1302 逐条 `c.sendAudio()` 回填。且 `flushAnnounceFor`（L626）已修好「先宣告后给货会留空窗、设备丢弃该流」的真机坑（2026-09-24）。

⇒ airplay 桥接成员只要 codec=pcm，**自动获得独立 ring + 晚加入补齐 + 正确宣告时序**。MA 需要自己实现 `_held_chunks`/`_queued_frames`，我们直接复用。

**（1c）🔴 但成员是强类型 `Set<SendspinConnection>`——这是真实改造点**

```ts
export class SendspinGroup {
  members = new Set<SendspinConnection>();     // server.ts:580
}
export class SendspinConnection {
  private ws: WebSocket;                       // L1477 强绑 WS
  sendAudio(tsUs: bigint, codecData: Uint8Array): void  // L2378 走 ws.send
}
```
`index.ts:154` 注释也明说：**「组 pump 的成员是 `SendspinGroup.members` 里的 conn 对象」**。

桥接成员没有 WS 连接，所以**不能直接塞进 `members`**。第六轮逐条核对 `SendspinGroup` 对成员的全部使用面后，前稿的「抽一个 5 方法 GroupSink 然后改 `Set`」被否决：真实使用面还包括 `clientWantsStream`、`sendJson`、`sendPlayerCommand`、`legacy`、`muted`、`sinkHealth`、`lastBufferedAmount`、`announceStream`、`syncStaticDelayTo`，以及 `broadcastGroupState` 会把成员 ID 暴露给真实设备。把这些都塞进一个宽接口，会同时污染状态上报、音量分发、sink 自愈和 51 个 sendspin 测试文件。

**定案：并行 `bridges` 集合，`members` 原样不动。**

```ts
class SendspinGroup {
  members = new Set<SendspinConnection>();          // 不动
  bridges = new Map<string, AirPlayBridgeMember>(); // 新增
}
```

`pushFrame` 仍然按 `(codec,gain)` 给真实成员编码；另**必须先在入口补一个虚拟 `pcm:100` 组**，再把这组字节同样投给每个 bridge：

- bridge 不进 `server/state` 的成员列表；
- bridge 不参与 legacy/`stream/clear` 判定；
- bridge 不参与 WS `sinkHealth`；
- **bridge 启动 lead 只喂 `streamEngine.anchorLead`，绝不并入 `commonSendAheadUs()`**（见 3.2 第 3 条 MAJ-01）；
- bridge 晚加入回填直接复用 `ringFor("pcm:100")`，不另建 ring；
- **只有 bridge、没有真实成员时，`pcm:100` 组必须仍能让 `deliveredPeak` 正常推进** —— ⚠️ 这句话是**要求**不是现状（前稿误写成现状）。

> **🔴 BLK-01（第七轮实锤）：这是"要求"而非"已成立"，旧稿写错了。**
> `pushFrame` 的编码分组**只遍历 `this.members`**（`server.ts:1129-1140`）。组内若没有 `codec=pcm 且 gain=100` 的真实成员，`groups` 里**根本没有 `"pcm:100"` 这一项** ⇒ 循环体不进 ⇒ 桥拿不到一个字节；且 `deliveredPeak` 不推进 ⇒ `return 0` ⇒ `streamEngine` 判「编码器零产出」（`STALL_GRACE_US=500ms` 降级、默认 5000ms 后**放弃本曲提前切歌**）。
>
> 因此必须显式插入（不能靠"将来自动会有"）：
> ```ts
> if (this.bridges.size > 0 && !groups.has(this.encoderKey("pcm", 100))) {
>   groups.set(this.encoderKey("pcm", 100), { codec: "pcm", gain: 100, members: [] });
> }
> ```
> 空 `members` 不影响正确性：内层 `for (const c of g.members)` 自然空转，而 `sum`/`bytes`/`ring.push` 照常发生。单测：`members=∅` + 1 bridge ⇒ `pushFrame` 返回 `>0` 且 bridge 收到字节。

> `appliedGain()` 仍恒 100（见实施方案 §1 · D5），不会有额外 gain 编码组。桥接不改变现有编码分组行为。

**（2）🔴 采样率冲突——照抄必炸，且是旧 BridgeRing 故障的同类口径坑**

| 侧 | 采样率 | 位深 | 声道 | 出处 |
|---|---|---|---|---|
| sendspin 组泵 PCM | **48000** | 16（s16le） | 2 | `encoding.ts:31` |
| airplay RAOP 期望 | **44100** | 16 | 2 | `raop.ts:25` |
| MA bridge role | 44100 | 16 | 2 | `bridge_role.py:38` |

直接把泵的 PCM 灌给 RAOP ⇒ **播放速度 ×1.088、音调升高 8.8%**（48000/44100）。这不是「2 倍速」那种一眼看出的错误，而是**慢性的、听起来像磁带跑快点**的故障，极难靠耳朵定位。

> 历史教训同源：旧 BridgeRing 就是「写 48000 帧/s vs clock 88346/s（44100×2）」两套口径打架。本次必须在代码里**只留一个速率常量**，禁止两侧各写各的。

**两条解法（必须在 Phase 1 前拍板，第四轮已用证据定案）**：

| 方案 | 做法 | 代价 / 风险 |
|---|---|---|
| ~~A. RAOP 直出 48k~~ **（已证伪）** | `raop.ts` 的 `opts.sampleRate` 本就可配（L319 `opts.sampleRate ?? SAMPLE_RATE`、L512 fmtp 用 `this.opts.sampleRate`）→ 桥接路径传 48000 | **AP1 不成立**：shairport-sync 3.3.8 二进制内 `44100` 出现 9 次、`48000` **0 次**；MA 自身基础 PCM 也恒 `sample_rate=44100`（`constants.py:352`），48k 只出现在 `AIRPLAY_HIRES_SAMPLE_RATES=[(44100,24),(48000,24)]` 的 **24bit hires 特例**里。RAOP 的 ANNOUNCE fmtp 速率由接收端能力决定，AP1 实现基本写死 44100 |
| **B. 重采样到 44.1k（AP1 必选）** | 桥接成员把泵的 48k PCM 重采样为 44.1k 再进 RAOP；**用有理数多相 FIR（147/160 = 44100/48000）**，不用 ffmpeg 二次转码 | 通用、无额外进程；代价=一个 O(32) 抽头/样本的卷积（≈2.8M MAC/s/声道，可忽略）+ **0.3627ms 群延迟**（17.41 输入帧，见 Phase 1 算式）；风险=比例或滤波器写错会变成「变速/混叠」，FFT 用例可秒判 |

**定案（按协议分档，不再二选一）**：
- **AP1/RAOP：强制 44.1k**，桥接侧必须重采样（B），`raop.ts` 的 `opts.sampleRate` 恒 44100；
- **AP2：48k 可选**（AP2 支持 44.1/48），Phase 5 按接收端 SETUP 协商结果二选一，协商失败回落 44.1k；
- 无论哪档，**样本↔字节↔时间的换算与重采样只允许在 `resampler.ts` 一处实现**，两侧不得各写各的。

### 3.2 🔴🔴 RAOP `stream()` 本身就是「墙钟自推」——与旧 BridgeRing 同构，Phase 2 的真实工作量在此

原方案写「`raopSender.ts`：薄封装现有 `raop.ts`（`stream(producer)` → 改 push 模式）」。**这句话严重低估了改造量。** 实际实现（`raop.ts:754-800`）：

```ts
const wallStart = performance.now();
this.startNtp = ntpNow();
let idx = 0;
while (this.streaming && !this.destroying) {
  const target = wallStart + idx * chunkDurMs;      // ★ 自己算的墙钟时间线
  const delay = target - performance.now();
  if (delay > 0) await sleep(delay);
  else { this.stats.reanchors++; ... }               // 落后就立刻发（追赶）
  const buf = await producer();                      // 拉
  ...sendChunk(...); idx++;
}
```

`idx` 单调递增 ⇒ 内容位置完全由「已发包数」决定，与 sendspin 时间线**毫无关系**。这正是旧 BridgeRing 双时间线打架的同款结构——只是换了个位置。

**桥接必须做的改造（不是加个开关）**：
1. **换驱动源**：发送时刻与内容位置都改由 chunk 的 `timestamp_us`（sendspin 可听时刻）决定，废除 `wallStart + idx*chunkDurMs` 自推。
2. **支持位置跳变**：晚加入要「丢弃前 N 个 chunk」、seek 要「重置 `idx`/`baseTs`」。`raop.ts` 实际有**四个**锚点：`baseTs`（RECORD 时固定，`positionSec` 靠它算）、`startTs`（seek 时重锚）、`headTs`（每包推进）、`startNtp`。桥接必须**四个一起写**——只改 `startTs` 会让 `positionSec = ts2ms((headTs − baseTs) >>> 0)` 立刻变成垃圾，而且**不报错**。同时桥接路径**禁止**调用 `raop.seek()`（它把 `startTs` 拉回 `baseTs + seekSec*rate` 而 `startNtp` 不动 ⇒ 映射崩，这是 2026-10-21「拖动后彻底无声」的成因）。
3. **延迟必须分三层，不能“谁归零”**：`raop.ts` 的 `latencyFrames` 是**接收端播放保持深度**（`:289` 初值 = `SAMPLE_RATE`；`:615` RECORD 返回 `Audio-Latency` 时取 `Math.max`），SYNC 包用 `headTs - latencyFrames`；`sendAhead` 是服务端发送/启动提前量。二者不是同一层，不能把 `latencyFrames` 归零。
   - **启动 lead**：冷启 4500ms / 热启 2500ms，覆盖 RAOP 连接、RECORD、首包映射。**只喂 `streamEngine` 的 `anchorLead`，不进 `commonSendAheadUs()`**（见下）。
   - **持续缓冲**：桥成员的 `minBufferMs=1000`，给组泵持续供应下限。
   - **接收端 latency**：保留 `latencyFrames`，并纳入 RTP↔NTP 映射：`startNtp = NTP(A - latencyUs)`，其中 `A` 是首样本可听时刻。这样首包实际可听 = `(A - L) + L = A`。
   - **🔴 第七轮改正（MAJ-01）**：**启动 lead 绝不能并进 `commonSendAheadUs()`**。原因：音频帧头是 9 字节（1B type + 8B 时间戳），**不含 `send_ahead`**（`server.ts:2380-2382` 注释原文，且历史上多塞 4B 曾导致全部无声）；真实设备判断过期用的是**它自己的**默认 800ms。并进去 ⇒ 全组时间戳被推后 4.5s 而设备仍按 800ms 判 ⇒ `delta` 恒 +3.7s，**会把一台正常工作的 ESP32 打坏**。而且 `computeCommonSendAhead` 用 `max(minBuffer, requiredLead)` 合并两个语义，一旦并入 4500，「热启 2500 / 持续 1000」永远不可能出现。
   - `computeCommonSendAhead`（`group.ts:76`）**保持原样**，桥成员只上报 `minBufferMs=1000`；启动 lead 由 `streamEngine` 的 `bridgeStartLeadUs()` 单独提供。`commonSendAheadUs()` 的三个消费者（锚点、`seedLateJoin`、播报）全部不变。
   - **旧方案的错误**：把“链路延迟只从 sendAhead 上报、RAOP latency 归零”当成去重。正确的是三层各自存在、各司其职：启动 lead 管这次起播提前多少，sendAhead 管持续发送节奏，latency 管设备缓冲多深以及 RTP 映射偏移。
4. **`startNtp` 语义**：`raop.ts` 现有注释已记下真机坑——seek 重建会话后 `startTs` 被重锚到内容位置，SYNC 的 NTP 必须映射到当前播放头，否则接收端会把音频当成未来 N 秒才播。桥接的 `startNtp` 不是简单“现在”，而是 `NTP(A - L)`；`A` 由首帧时间戳与最小启动余量共同决定。
5. **统一时钟（第六轮新增）**：`sendspin/clock.ts` 的 `nowUs()` 是 `process.hrtime.bigint()/1000`；`raop.ts` 的 `ntpNow()` 当前是 `performance.now()` 毫秒。两者跨进程不可互换，更不是 Unix 时间。必须新增 `utils/hostClock.ts`，`raop.ntpNow = ntpFromHostUs(nowUs())`，禁止 `Date.now`/Unix 进入锚点链。

> **结论**：Phase 2 的工作量主要不在「接一个 PCM 供给」，而在**把 RAOP 的时间线驱动权交给 sendspin**。建议 Phase 2 拆成 2a（`AirPlaySender` 接口 + 桥接 PCM 供给能出声，仍用原墙钟循环）与 2b（换驱动源 + 跳变支持 + 延迟归属），2b 才是真正难点。

### 3.3 🔴🔴 跨进程 PCM 通路——文档此前完全遗漏的架构问题

> **第五轮拓扑修正（重要）**：第三轮写成「组泵在主进程」是**错的**。`sendspin/` 目录下同样有 `mode.ts`/`supervisor.ts`/`child.ts`/`childMain.ts`，`supervisor.ts` 头注释明写「把 sendspin 运行时（WS 38927 + 解码/编码/推流 + mDNS + 拨号 + 6053 桥）fork 到子进程」。实际是**三进程拓扑**：
>
> ```
> 主进程（路由/DB/调度，不跑节拍）
>   ├─ sendspin 渲染子进程（GroupPump、pushFrame、ringFor、SendspinGroup）
>   └─ airplay 渲染子进程（raop.ts、RTP 7.98ms 节拍）
> ```
> 所以 PCM 是 **sendspin 子进程 → airplay 子进程**（不经主进程）。这反而强化了结论：连「主进程中转」这条偷懒路都不存在。

**两侧都在 fork 子进程里**（`airplay/mode.ts`：生产默认 fork，2026-10-22 把默认值从 in-proc 翻成 fork——真机实锤「主进程事件循环被前端请求/批量任务占住时 RTP 7.98ms 节拍被打散，reanchors 抬升、maxGap 达 2s、听感断音」；`sendspin/mode.ts` 同构，sendspin 节拍 25ms）。

⇒ 桥接要求 sendspin 子进程把 48k/16/2 立体声 PCM（**≈192KB/s/成员**）喂给 airplay 子进程。MA 的对应做法是在核心进程里直接写 CLI 子进程的 **stdin 二进制管道**——等价于我们需要的「子进程→子进程二进制 PCM 通道」，且**会合点需要显式设计**（我们两端都是自己的进程，没有现成 stdin 管道）：推荐 airplay 子进程 `listen` 一个 unix socket（Windows 用 named pipe），路径按 `deviceId` 派生（如 `/tmp/mf-apbridge-<deviceId>.sock`），sendspin 子进程 `connect`；socket 路径与协议由主进程通过 RPC 下发给两侧（主进程是唯一知道「谁加入哪个组」的地方）。

**现有 IPC 此路不通**：`airplay/ipcProtocol.js` 与 sendspin 同名模块都走 `process.send` JSON 序列化——Buffer 会被序列化成 `{type:'Buffer',data:[...]}`（每样本一个数字），192KB/s×N 成员的 JSON 化 CPU 开销不可接受。

**三条候选通路（已拍板，D2）**：

| 方案 | 做法 | 评价 |
|---|---|---|
| **① net 二进制管道（选定）** | airplay 子进程 listen、sendspin 子进程 connect（unix socket / named pipe），长度前缀帧传 PCM | 与 MA 的 CLI stdin 同构；实现简单；每成员一次拷贝，192KB/s 可忽略；子进程崩溃互不连坐 |
| **② RAOP 会话迁 worker_threads** | worker 模式跑 RAOP 会话，SAB 环形缓冲零拷贝 | **否决**：违反 `check-renderer-host.mjs` R1/R2（守卫只认 rendererHost fork 形态），且要改通用层 |
| ③ 桥接模式降级 in-proc | RAOP 会话留在 sendspin 子进程 | **否决**：两个节拍循环挤在一个事件循环里，重蹈 2026-10-22 覆辙 |

**附带动因**：桥接模式下「发送节拍」的要求其实**变松了**——3.2 的驱动权移交后，RAOP 的正确性取决于 **RTP 时间戳 ↔ NTP 锚点映射**（SYNC 负责对齐），发送本身只要「不早于节流上限、不晚于可听时刻」即可（MA 的 ≤8s 节流就是这个语义，不是 7.98ms 精确节拍）。所以通路方案不需要实时级精度，①的普通管道足够。但**进程隔离不可放弃**（RAOP 网络栈崩溃不能连坐 sendspin 子进程）——in-proc 回退要写进守卫。

**帧格式（第六轮定案，替换旧的 `[len][ts][pcm]`）**：

```
0  magic "MFAB" (4)
4  version=1 (u8)
5  type 1=AUDIO 2=BOUNDARY 3=CONFIG 4=HEARTBEAT 5=STATS (u8)
6  flags (u16)
8  generation (u32)
12 sequence (u32)
16 tsUs (i64，仅 AUDIO)
24 payloadLen (u32，上限 1MiB)
28 payload
```

- 只有长度和 ts 的旧帧无法在 seek/切歌后区分旧流，必须在头里带 `generation`，airplay 侧只接受当前代次。
- `BOUNDARY` 的 payload 说明 `track/seek/stop/rehost`；新代次在发送边界前先自增。
- `CONFIG` 携带 `deviceId/protocol/rate/channels/format/sessionToken`，不做隐式约定。
- TCP 保证字节完整，但仍要校验 magic/version/长度，防止错位后继续解析垃圾。

**背压（第六轮定案）**：`sendAudio()` 是同步 `void`，不能在写阻塞时“暂停该成员的组泵投递”。每桥独立有界队列 + 独立 drain：

- 高水位 2s（384KB）只告警；
- 硬上限 8s（1.5MB）⇒ 关闭 socket、标记 stalled、5s/30s 退避重连；不阻塞组泵、不丢最旧帧继续播。
- 丢帧继续播会产生“时间戳连续但内容有洞”，被对齐逻辑当空洞补静音，听感是随机静音，比明确断开更难排查。

---

## 4. 落地方案（阶段化）

### Phase 0 · 基线可观测（0.5 天）
- 目标：先把「有没有出声/领先多少/有没有 reanchor」量化出来，后面每阶段都有判据。
- 改动：
  - `airplay/` 新增 bridge 统计打点（对齐 MA `[airplay-bridge] stats` 口径）：每 2s 一行 `w/m/clock/delta`。
  - 落盘开关 `MUSICFLOW_AIRPLAY_PCM_OUT=<path>`：发送端写出的 PCM 同步落盘（用于互相关）。
- 验收：`[airplay-bridge] stats` 稳定输出；单设备 cast 能落出非静音 PCM。

> **复核后的顺序调整（重要）**：原方案把「AP2 发送端（3~5 天、最大工程量）」放在 Phase 1。但 **AP2 协议栈与「同步机制」是完全正交的两件事**——AP2 只是换一个输出口，锚点/对齐/节流/热复用对 AP1、AP2 一视同仁。把协议放前面，会让整套同步语义被阻塞在最难的一块后面，且无法早期证伪。
> **新顺序**：先用**现成的 RAOP(AP1)** 跑通同步四件套（价值最高、可早期证伪），AP2 后置为独立阶段。

### Phase 1 · 采样率契约 + 重采样器 + 音源解耦（1~1.5 天）
- **定案（第四轮修正，不再是 A/B 实测）**：AP1 **强制 44.1k**，桥接侧内建 48k→44.1k 重采样；AP2 48k 可选（Phase 5 协商，失败回落 44.1k）。
- 新增 `airplay/resampler.ts`：有理数多相 FIR，L=147 / M=160（44100/48000），每相 32 抽头 Kaiser(β=8) 窗 sinc，截止≈21kHz；跨帧保留 N 抽头历史状态；**群延迟 0.3627ms**（算式：32×160=5120 抽头 → 5120/2=2560 上采样样本 → 2560/147=17.41 输入帧 → 17.41/48000=0.3627ms，由锚点吸收；旧稿"16 输入帧≈0.33ms"是拿错分母）。**不用 ffmpeg**（额外进程 + 缓冲延迟 + 口径分裂）。
- `PcmProducer`（pull，L258）升级为 `PcmSource`（双模）：
  - `LoopbackSource`（现状：decoder → 44.1k 回环流，非桥接路径）
  - `BridgeSource`（新增：由 Sendspin 组 codec=pcm 成员供给 48k → resampler → 44.1k）
- 速率常量与换算点收敛到单处，并加静态守卫。
- 验收：单设备播放不回退（守卫全绿）；重采样器单测（1000Hz→1000Hz 偏差 ≤0.5%；15kHz 幅度损失 ≤1dB；23kHz 输入衰减 ≥40dB 抗混叠；160N 输入帧恰好产出 147N 输出帧，10 分钟零漂移）。

### Phase 2a · 桥接出口抽象 + 出声（1.5~2 天）
- **接口不再是 `start(anchorUnixMs)`**。第六轮已证伪：RAOP 会话和锚点都在 airplay 子进程，sendspin 无法跨进程 await 一个设备 ack；`anchorUnixMs` 的时钟域也不成立。改为 airplay 侧 `bridgePrepare/ bridgeStop / bridgeSetVolume / bridgeStatus` 控制面 + 首帧驱动锚点：
  ```ts
  // airplay/childMain.ts 新增 RPC（PCM 绝不走 JSON IPC）
  bridgePrepare(deviceId: string, socketPath: string, token: string, protocol: "raop"|"ap2")
  bridgeStop(deviceId: string, token: string)
  bridgeSetVolume(deviceId: string, volume: number)
  bridgeStatus(deviceId: string)
  ```
  锚点由 airplay 侧在收到首帧 AUDIO 后自行决定，写进实际 RTP/NTP 映射。没有 `ackedUnixMs`；报告字段叫 `scheduledAnchorUs`。
- **前置子阶段 2a-0：跨进程 PCM 通路**（见 3.3）：28B 帧头 + net 二进制管道；airplay 侧 listen，sendspin 侧 connect，路径/token 由主进程 RPC 下发。
- 组侧接入（见 3.1-(1c)）：**不改 `members`**；新增 `bridges`，`pushFrame` 投 `pcm:100`，复用 `encoderForGroup` 与 `ringFor("pcm:100")` 晚加入回填。**启动 lead 只喂 `streamEngine.anchorLead`，不进 `commonSendAheadUs()`**（MAJ-01）。
- **分派规则（流开始时快照）**：在线 Sendspin 成员 >0 且在线 AirPlay 成员 >0 ⇒ AirPlay 走桥接；纯 AirPlay ⇒ 旧逐设备 cast。流内不切路由；下一首重新评估。这样避免“播到一半增加/删除成员”导致双重会话。
- **生命周期补齐（第六轮新增）**：`alignGroupMembers` 的 AirPlay 分支要按当前路由选择 `bridgeAttach` 或旧 `rejoinMembersAirplay`；`detachFromActiveGroups` 必须纳入 AirPlay（当前只处理 dlna/sendspin），否则 solo 操控会与组桥接抢会话；`getGroupLeader` 可能是 AirPlay，桥接路由下状态必须改从 sendspin 泵派生；`fanOut` 对桥接成员的 stop/pause/resume/seek/setVolume 不得再走 solo cast。
- 本阶段允许暂时不判同步，但**不能沿用旧墙钟循环假装出声**：bridge 会话必须已经走 RTP↔NTP 映射骨架，Phase 4 只是把锚点精度/对齐补全；否则同一段代码要重写两遍。
- 验收：假 Sendspin 设备 + **AP1 接收端**同组，**两边都出声且 PCM 落盘非静音**；无第二个 AirPlay 会话；纯 AirPlay 组旧 cast 回归不变。

### Phase 2b · 时间线映射与发送节拍（2~3 天，**真正难点**，见 3.2/3.3）
- 废除 `wallStart + idx*chunkDurMs` 在 bridge 路径的使用；新增独立的 `streamBridge()`，不要与 native `stream()` 混用。
- 锚点：`A = max(now + headroom, firstFrame.tsUs)`；`startTs = rtp(A)`；`startNtp = NTP(A - latencyUs)`；首包 `headTs = startTs`。
- 发送节拍：`sendAt = audibleAt - latencyUs - safetyMs`；不收到 PCM 就立即倾倒。迟到包计入 `latePackets`，不得改回锚点掩盖。
- 位置跳变：`generation` 自增；airplay 侧只接受当前代次；seek/rehost 走新映射或新会话，禁止续用旧 `startTs`。
- **延迟归属**：`latencyFrames` 保留并进锚点公式；`sendAhead` 只影响组泵启动/发送，不减第二次。
- 验收：假 Sendspin 设备 + AP1 接收端同组，互相关 **Δ ≤ 20ms**；`quality≥0.2`；再跑变调用例 11。

### Phase 3 · 对齐与音量（2 天）
- `bridgeMath._align_chunk`：`targetFrames = round((tsUs - A) * rate / 1e6)`；`queuedFrames` 与目标差 >0 补静音、<0 裁头；>1ms 记 `realigned`。
- **音量定案（第六轮推翻旧稿）**：当前 `offloadsVolume()` 恒 true、`appliedGain()` 恒 100，PCM 是 unity；响度 100% 由设备输出级负责。桥成员复用 `setAirPlayVolume` / `setAirPlayMuted`（现有 DB 持久化、同机 DLNA 转发、RAOP `SET_PARAMETER` 回落）。**禁止** `scalePcm` 数据缩放 + RAOP 音量钉死的旧方案。
- **sink 语义**：桥成员不参与 WS `sinkHealth`；它有自己的 `stalled/overflow` 状态，不得让 WS 自愈逻辑误判。
- 验收：日志 `scheduled anchor=... late=... content shifted ±Xms`；调音量只改响度，不改 Δ。

### Phase 3.5 · 群组生命周期与背压（1.5~2 天）
- 流内成员变化、solo 脱组、leader 状态、子进程崩溃、队列 hardCap、重连退避。
- 验收：连续 seek 3 次、播中加入/摘除、杀子进程、压队列，均无残留会话和随机静音。

### Phase 4 · 节流 / 热复用 / 恢复（1~2 天）
- ③ 节流 ≤8s、④ 保活 4s + flush-refill、re-anchor 吸收。
- 验收：连续 seek 3 次无冷启；人为断粮后 Δ 自行收敛。

### Phase 5 · AP2 发送端（拆成两个独立阶段，不能混为一谈）
- **Phase 5a：realtime + NTP（3~5 天）**
  1. HAP pair-setup / pair-verify，凭据落 `hap_credentials`（DB 当前只有列/迁移，没有业务读写，需定义消费与验证契约）。
  2. auth-setup + 二进制 plist SETUP + 加密 RTSP（HKDF 派生密钥）。
  3. ALAC 封装 + ChaCha20-Poly1305；24bit 走 0x80000/0x200000。
  4. realtime stream type 96（实测口径，见实施方案注①），RTP/UDP，NTP 计时；`--protocol airplay2-compat` 也要覆盖。
- **Phase 5b：buffered + PTP（3~5 天，独立）**
  1. buffered stream type 103，RTP/TCP；buffered 依赖 PTP，不能把“先 NTP、PTP 以后再说”套上去。
  2. 共享 PTP daemon，组内不混 NTP/PTP；spawn 窗口未就绪不能简单降级 NTP。
  3. AP2-only discovery：当前只允许 `_raop` 创建设备，`_airplay` 仅补能力；若要 AP2-only，必须同步改 discovery、测试和守卫。
- 验收：与 `cliairplay` 对同一 AP2 接收端 A/B，**Δ 按 RTP 头到达时刻口径**（抓 UDP 明文 RTP 头得 `(arrival, rtp_ts)`，各自以 RECORD 响应时刻归一，比对同一 `rtp_ts` 偏移的到达差 ≤20ms；**禁用床 `out.pcm` 做互相关——该文件过了 bed 的 `AudioResampler(48000)`，带 12/11 膨胀**）；SETUP 协商速率写日志，不假定 48k；`clock_ready`/`exchanges` **不作为判据**（cliairplay 在 `timing=ntp`+realtime 下结构性不发 NTP 探测，日志 `[CLOCK] host clock realtime`；cliairplay 真出声改用 `[STATUS] playing` + 床侧落盘帧数 ≥ 期望 95% 判定）；Apple 设备的 NTP realtime 静音矩阵单独记录。
  - **✅ 2026-10-25 实测（`/tmp/ab/ab_rtp_lead.py`）**：Δ=−13.16ms（锚=**SETUP 响应**到达（原 `RECORD` 锚已弃用：床侧 `SETUP(stream)` 开销 461.8–465.7ms 占该区间 98.4%，测不出我方，见注④-补）、量=首包，≤20ms PASS）；排程保真 slope 1.000000±5e-5、残差 RMS 0.32–0.53ms、三段窗截距极差 ≤0.7ms、0 丢 0 乱；Δ 可分解为床侧 `SETUP(stream)` 463–487ms（±12ms，与 sender 无关）+ cli 两次 housekeeping `SET_PARAMETER`（47.86ms）+ cli `warm_lead_ms=600` 预灌（我方无）。**`≤5ms` 只适用于斜率/线性度，不适用于绝对起播时刻**。🔴 **`首包到达时刻差` 不是排程保真判据** —— 它测的是「谁先开始发首包」。QA 实测 cli 的 `SETUP响应→首包` **随 `START_OFFSET_MS` 整体平移**：offset 0 → 47.9ms、120 → 43.1–43.9ms、**1500 → 939.9 / 945.9ms（两场吻合）**、**3000 → 2433.3ms**（1500→3000 使该区间 +1487ms ≈ 1500ms）⇒ cli 在等自己的计划起播时刻，**43ms 只在 offset ≤120 成立、不能当 cli 特性引用**。排程保真只看同一 `rtp_ts` 偏移的到达时刻差。待办：首包 `marker=1` 对齐 cli（我方 0）。

### Phase 6 · 守卫与测试（1 天）
- 静态守卫：新增 `check-airplay-bridge.mjs`，钉住以下唯一表达式（同名字符串出现在两处会让守卫失效，必须钉唯一式）：
  1. `ntpNow()` 必须由 `ntpFromHostUs(nowUs())` 派生（防有人回退到 `performance.now()`）；
  2. 锚点链里不得出现 `Date.now(` / `new Date(`；
  3. 报告字段名必须是 `scheduledAnchorUs`，不得出现 `acked`；
  4. `latencyFrames` 不得被赋 0 / 不得被 `Math.min(..., 0)` 之类钳掉；
  5. bridge 路由下 `ANCHOR_SAFE_LEAD_US` 钳制必须被绕过；
  6. `bridges` 不得被并入 `members`（防回归到改型方案）；
  7. 背压队列必须有 hardCap 分支与退避 `(5000, 30000)`；
  8. 节流常量（`MAX_DEVICE_BUFFER_SECONDS` 等）不得被改小；
  9. 热复用不得退化成「先起播后 seek」。
- **🔴 速率唯一源守卫（最高优先级）**：速率按协议分档（AP1=44100 强制 / AP2=48000 可选），禁止两侧各自硬编码；**重采样与换算点（样本↔字节↔时间）只允许在 `resampler.ts` / `bridgeMath.ts` 一处实现**。这条直接对应旧 BridgeRing 事故。
- 单测：锚点映射 / 对齐 / 节流 / 热复用 / 背压五组纯函数测试（对齐 MA 可测性设计：这些都做成纯函数，不依赖 socket）。
- **互相关脚本自检入 CI**：`cc_align.py` 的 137ms 自检（见 5.3）应作为独立脚本进 CI，防止有人重新引入 `np.correlate` 假峰位。

---

## 5. 测试验证方案（230 全模拟验收）

### 5.1 模拟器清单与启动方法

#### A. 假 Sendspin 设备（推荐，无需真实 ESP32）
230 已装 `aiosendspin 10.2.1`（`/root/ssvenv`）。新建 `/root/fake_sendspin.py`：

```python
#!/usr/bin/env python3
"""假 Sendspin 设备：连 MusicFlow 服务端，收音频落盘 + 打印时间线，用于同步验收。
用法: /root/ssvenv/bin/python /root/fake_sendspin.py --name FAKE-1 --out /root/fake1.pcm
"""
import argparse, asyncio, hashlib, sys, time
from aiosendspin.client import SendspinClient
from aiosendspin.models.core import DeviceInfo
from aiosendspin.models.player import ClientHelloPlayerSupport, SupportedAudioFormat
from aiosendspin.models.types import AudioCodec, Roles
from aiosendspin.noise.keys import Identity
from aiosendspin.noise.trust_store import FileClientPairingStore

async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=38927)   # MusicFlow WS_PORT
    ap.add_argument("--name", default="FAKE-SENDSPIN-1")
    ap.add_argument("--out", default="/root/fake1.pcm")
    ap.add_argument("--probe", action="store_true", help="只打印首块元信息，不落盘")
    a = ap.parse_args()

    # 固定种子 ⇒ client_id 稳定，便于服务端配对/分组记忆
    seed = hashlib.sha256(f"musicflow-fake:{a.name}".encode()).digest()
    identity = Identity.from_private_bytes(seed)
    store = await FileClientPairingStore.open(f"/root/fake_{a.name}.json")

    client = SendspinClient(
        identity, a.name, [Roles.PLAYER],
        pairing_store=store,
        device_info=DeviceInfo(product_name="FakeSendspin", manufacturer="MusicFlow"),
        player_support=ClientHelloPlayerSupport(
            supported_formats=[SupportedAudioFormat(
                codec=AudioCodec.PCM, channels=2, sample_rate=48000, bit_depth=16)],
            buffer_capacity=1024 * 1024,
            supported_commands=[],
        ),
        required_lead_time_ms=250.0, min_buffer_ms=250.0,
    )

    f = open(a.out, "wb")
    first = {"seen": False}

    # 🔴 第六轮实锤修正：aiosendspin 10.2.1 的收流回调是「四参数」
    #    callback(timestamp_us, payload, audio_format, send_ahead)
    #    - timestamp_us 是服务端时钟上的「可听时刻」（client.py:1328 原文
    #      "when this audio should play"）
    #    - send_ahead 只是发送提前量，原文 "Never affects when the chunk plays"
    #    旧稿写的 on_chunk(chunk) 单参数会在首个音频块到达时直接 TypeError。
    def on_chunk(timestamp_us, payload, audio_format, send_ahead) -> None:
        if a.probe:
            print("[probe] ts=", timestamp_us, "bytes=", len(payload),
                  "fmt=", audio_format, "send_ahead=", send_ahead, flush=True)
            return
        pcm = getattr(audio_format, "pcm_format", None)
        rate = int(getattr(pcm, "sample_rate", 48000) or 48000)
        channels = int(getattr(pcm, "channels", 2) or 2)
        bit_depth = int(getattr(pcm, "bit_depth", 16) or 16)
        frame_bytes = max(1, channels * (bit_depth // 8))
        dur = int(round(len(payload) / frame_bytes / rate * 1_000_000))
        if not first["seen"]:
            first["seen"] = True
            print(f"[first] ts={timestamp_us} dur={dur} bytes={len(payload)} "
                  f"fmt={getattr(audio_format, 'codec', '?')}/{rate}/{bit_depth}/{channels} "
                  f"send_ahead={send_ahead}", flush=True)
        f.write(payload)

    def on_stream_start(*a_, **k_) -> None:
        print(f"[stream-start] {time.time():.3f}", flush=True)

    client.add_audio_chunk_listener(on_chunk)
    client.add_stream_start_listener(on_stream_start)
    print("client_id =", identity.peer_id, flush=True)
    await client.connect(f"ws://{a.host}:{a.port}/sendspin")
    try:
        while True:
            await asyncio.sleep(1)
    finally:
        f.close()

asyncio.run(main())
```

启动（230）：
```bash
# ① 先探针：确认能连上并收到首块（不落盘）
/root/ssvenv/bin/python /root/fake_sendspin.py --name FAKE-1 --probe
#    期望输出：client_id = <uuid> → [first] ts=... dur=... bytes=... fmt=pcm/48000/16/2 send_ahead=...
# ② 正式收流
/root/ssvenv/bin/python /root/fake_sendspin.py --name FAKE-1 --out /root/fake1.pcm
```
配对：若服务端未开放免配对接入，先在服务端对该 `client_id` 走配对窗（`/rest/api/v1/sendspin/pairing/start|code`）批准一次；成功后 `fake_<name>.json` 会记住凭据。

> **⚠️ 复核标注（2026-10-25 更新为已验证）**：本脚本已在 **240 生产容器**（v4.6.74/8d7a0ff）上真实连上并收流：`[first] ts=742556162177 dur=25000 bytes=4800 fmt=PCM/48000/16/2`，落盘 15.8s / peak 26131 / RMS −17.1 dBFS / nonzero 99.98%。脚本 sha256 已变更为含 `--unpaired` 与 48k 宣告的新版。
>
> **但"配对"这一环未通过**：服务端 `onClientHello` 无条件发 `{activities:["playback"], active_roles}`，而未配对会话（sentinel PSK）结构上只准 `{pairing}` ⇒ aiosendspin 判 `pairing_required` 并**立即 goodbye**（不等待配对窗）；`pairServer.start()` 又要求"客户端已连接" ⇒ REST 配对无窗口可打。本轮改用 `client.set_unpaired_access(enabled=True)`（`--unpaired`）直连，**只验数据面**。
>
> 该缺口已在《240 开工前验证报告》§3 P0-1 记为待修；真机 sendspin-cpp 客户端行为不同，所以 ESP32 能配对成功。
>
> **✅ 第六轮实锤修正（原稿是错的，会导致首块直接崩）**：
> 1. **回调签名是四参数**：`callback(timestamp_us, payload, audio_format, send_ahead)`，见 `aiosendspin/client/client.py:1324` 的 `add_audio_chunk_listener` 文档与 `:1328`「`server_timestamp_us` = when this audio should play」。旧稿 `def on_chunk(chunk)` 单参数 + `getattr(chunk,"data")` 的写法**在首个音频块到达时必然 TypeError**，`--probe` 也救不了（异常发生在回调里）。已按真实签名重写并部署到 `/root/fake_sendspin.py`。
> 2. **`send_ahead` 不是播放时刻**：官方文档原文「Never affects when the chunk plays」，它只影响「什么时候该发出去」。验收比对**只能用 `timestamp_us`**，把它当播放时刻会引入整段 lead 的系统偏差。
> 3. **`duration_us` 不是回调入参**：必须由 `audio_format.pcm_format` 的 `sample_rate/channels/bit_depth` 自行换算（`frame_bytes = channels × bit_depth/8`）。`audio_format` 结构见 `client/models.py:138` → `audio/format.py:48`。
> 4. **`output_delay` 另算**：客户端 `compute_play_time()`（`client/connection.py:2090`）会在 `timestamp_us` 基础上再减设备自己的 `output_delay`。假设备无输出级，`output_delay=0`，因此 `timestamp_us` 即等效可听时刻。
>
> **✅ 第三轮复核两处修正**：
> 1. **`sample_rate` 必须宣告 48000**（原稿写 44100 是错的）：服务端 pushFrame 编码分组键只有 `(codec, gain)`，`announcedSampleRate` 仅在 hello 时记录+打日志（`server.ts:1578/2023`），**不存在按设备宣告速率的变换——服务端永远按 48k 下发**。宣告 44100 会造成脚本自身口径与服务端行为矛盾。**第五轮已同步修正 230 上的 `/root/fake_sendspin.py:45`（sample_rate=48000）**，不再只是"文档说改了"。
> 2. **握手方向已确认兼容**：sendspin 规范即「拨入连接中服务端=Noise initiator、客户端=responder」（aiosendspin `noise/driver.py:131` `run_handshake_server` 是 initiator、客户端连接走 `run_handshake_client` L472；与我们 `server.ts` 头注释「Noise initiator 恒为服务端」一致）。假设备方向无冲突，剩配对流程（`/rest/api/v1/sendspin/pairing/start|code`）待实测。

#### B. AirPlay 2 接收端床（N 台独立实例）
```bash
# 起 3 台（端口 7200/7201/7202，PCM 落盘 /root/ap2bed/ap2-N/out.pcm）
/root/ap2_bed.sh start 3
/root/ap2_bed.sh status     # 确认 7200/7201/7202 LISTEN
```
**四步起床铁律（漏一步就会「端口在但音频管线已废」）**：
1. 按 pid 文件 kill 旧接收端（`ap2_bed.sh stop` 的 pid 会过期）；
2. `pkill -9 -f 'ap2venv/bin/pytho[n] -c'`（清泄漏的 multiprocessing 子进程，可累积到 200+ 把 load 打满）；
3. `ap2_bed.sh start 3`；
4. 确认端口 LISTEN。
> 每个会话结束必须**整床重启**：接收端每服务过一场会话就不可靠；只杀子进程不重启无用。

#### C. AirPlay 1 接收端
- 现成：`/tmp/ap2recv/ap2/airplay1.py`（**第四轮复核修正**：在 `ap2/` 子目录下，`/tmp/ap2recv/airplay1.py` 不存在）；
- 或 shairport-sync（第四轮复核已确认：`/usr/bin/shairport-sync` 在位、`snd_aloop` **已加载**，AP1 床可直接用；若换环境需 `lsmod | grep snd_aloop`，否则 ALSA 报 `-19 No such device`）。

#### D. cliairplay 手动对照（v0.5.9，协议/计时黄金参考）
```bash
mkfifo /tmp/cmd1
/opt/mf-airplay/cliairplay --protocol airplay2 --cmdpipe /tmp/cmd1 --latency 600 \
    --clock-offset-ns 0 127.0.0.1 7200 < /root/ref.pcm
# --clock-offset-ns：给同一组的所有进程相同偏移，可人为对齐/错开时钟做敏感性测试
# --protocol auto|raop|airplay2|airplay2-compat  ← 与自研发送端做 A/B 对照
```

### 5.2 验收用例矩阵

> **MAJ-04 改正**：旧表用例 1/4/6 仍以 **AP2 为桥接对象**（`ap2bed/ap2-1/out.pcm`），与"AP1 先行、AP2 后置到 P6b"的顺序冲突。**桥接验收一律以 AP1 为对象**；AP2 用例在 P6b 之后启用，且单独标注。

| # | 场景 | 步骤 | 判据 |
|---|---|---|---|
| 1 | **AP1 单设备出声**（先行对象） | 起 shairport AP1 床 → cast | `arecord` 抓到的 `/root/ap1_cap_44.pcm` peak>1000 且 rms_dbfs>-40 |
| 2 | AP1 抓取链自检 | 不放音，`arecord -d 5` | 文件存在且长度 = 5s×44100×4B（证明链路可用） |
| 3 | 自研 vs cliairplay A/B | 同一 AP1 接收端各投一次**同一份 44.1k 宽带源** | 两份 PCM 互相关 `\|Δ\| ≤ 5ms`（这是唯一能实证 `A−L` 假设的判据） |
| 4 | **跨协议同组同步** | 假 Sendspin + AP1 入同一组播放，源用**宽带** | `fake1_44.pcm` 与 `ap1_cap_44.pcm` 互相关 `\|Δ\|≤20ms` **且** `quality≥0.2`；`stats` 的 `p95(\|delta\|)≤20ms` |
| 5 | 起播对齐 | 读 `scheduledAnchorUs` 与 `commandedLeadUs` 日志 | 落点与源端定格值之差 ≤50ms；`commandedLeadUs` 冷启 ≈4500ms / 热启 ≈2500ms（**不得**被 `ANCHOR_SAFE_LEAD_US=800ms` 钳到 800） |
| 6 | 晚加入 | 播放中加入第二台 AP1（**seek 之后 ≥3s 再加入** —— `g.close()` 清 `recentByGroup`，seek 刚结束那几秒 ring 为空，必然 `seedLateJoin=0`，属设计行为） | 落后量 ≤8s，且 **10s 内收敛到 `\|Δ\|≤20ms`**；不得积压倾倒 |
| 7 | seek 热复用 | 播放中 seek 3 次 | 每次出现**新 generation + 新 `scheduledAnchorUs`**；旧代次丢弃计数 >0；`bridges.size` 不变；Δ 保持 ≤20ms |
| 8 | 下一首 | 连续切 3 首 | `reanchor` 计数不抬升；Δ 保持 ≤20ms（"无断音"必须落成这两个量化值） |
| 9 | 断粮恢复 | 人为阻塞音源 3s | **10s 内 `\|Δ\|` 单调降到 ≤20ms**；`re-anchored ... later` 出现 |
| 10 | 时钟失联 | 关掉接收端时钟响应 | **锚点日志在 3 个 sync 周期内持续输出且 `late=0`**（不停播）——不能只看"还在响"，那可能是在放旧缓冲 |
| 11 | **变调/速率检测** | 投 **1kHz 正弦**，对落盘 PCM 做 FFT 测基频 | 偏差 ≤0.5%；48k/44.1k 冲突会表现为 **+8.8%**，耳朵几乎听不出但 FFT 一测即中 |
| 12 | 多桥并发 | AP1×1 + AP2×2 + 假 Sendspin×1 同组 30min | RSS 增长 <20MB；每桥 `maxQueueMs<2000`；`late=0` |
| 13 | **AP2 出声**（P6b 之后启用） | 起 AP2 床 → 桥接 | 落盘非静音、速率按 SETUP 协商值 |
| 14 | **切歌预取语义不变**（🔴 用户硬约束，实施方案 §3.6） | 桥接组连播 ≥3 首（第二首起应命中预取+判完整路径） | 每首切歌前有预取/完整性判定日志；不完整源出现 `markUnplayable`→跳过/组内换源；与纯 sendspin 组同源同数据下行为一致（无第二条选歌路径） |

> **🔴 BLK-03：用例 4/3 的 Δ 必须用宽带源，不能用 1kHz 正弦。**
> 1kHz 的周期是 **1ms**，两份正弦的互相关在 lag 轴上以 1ms 为周期重复，`argmax` 只能锁定到 1ms 的整数倍集合中的一个（且极易锁在错误倍数），`quality` 几乎恒 ≈1（等于没有质量门）。用正弦测 20ms 级 Δ = 用只能分辨模 1ms 的尺子去量 20ms，是本文反复强调要避免的假证据。
> **1kHz/15kHz/23kHz 正弦只保留给用例 11（基频/抗混叠）。**
> 宽带源生成：
> ```bash
> ffmpeg -f lavfi -i "anoisesrc=d=120:c=pink:r=48000:a=0.5" -ac 2 -ar 48000 /root/src_wide_48k.wav
> # 或 MLS / 线性 chirp 20Hz→20kHz/30s（单峰更尖锐）
> ```

> **🔴 BLK-04：AP1 的"设备实际播放 PCM"只能用 `arecord` 抓，不能用发送端落盘。**
> | 链 | 命令 | 能否用于 Δ 判据 |
> |---|---|---|
> | 接收端真抓 | shairport 输出 `hw:Loopback,0` → `arecord -D hw:Loopback,1 -f S32_LE -r 44100 -c 2 -d <N> /root/ap1_cap_44.pcm` | ✅ 只有这条可以 |
> | 发送端落盘 | `MUSICFLOW_AIRPLAY_PCM_OUT=<path>` | ❌ 测的是"进程间管道+重采样链"，Δ 恒≈0，是"必过"的假判据 |
>
> 230 已具备条件：`lsmod | grep -c snd_aloop` = 4，shairport 在位。`arecord` 必须 `-r 44100`（与 shairport 实际输出一致）。

> 互相关必须用**尾窗**（文件头量到的是会话起始时刻差，是假证据）；两侧必须**先同速率**——`fake1.pcm` 是 48k（服务端恒 48k 下发），AP1 落盘恒 44.1k，必须先统一。
>
> **🔴 第六轮实锤：`np.correlate` 直接算不可用，必须 FFT + wrap-aware lag**。实测旧写法 `lag = argmax(c) - (len(b)-1)` 对 2s@48k 数据给出 **−2862.98ms**（真值 **+137ms**）：FFT 卷积是**循环序列**，负 lag 落在尾部需要 wrap。改正后 FFT 与 `np.correlate` 两条路径均输出 `137.0ms`。且 10s×48k 直接 `np.correlate` 是 O(n²)，量级不可接受。

**基频判据脚本（用例 11）**：
```python
import numpy as np
a = np.fromfile('/root/ap1_cap_44.pcm', dtype='<i2').astype(float)
w = a[-44100*5:]                       # 尾 5s
sp = np.abs(np.fft.rfft(w * np.hanning(len(w))))
f = np.fft.rfftfreq(len(w), 1/44100)
peak = f[np.argmax(sp)]
print('peak_hz = %.2f  dev_%% = %.2f' % (peak, (peak/1000.0 - 1) * 100))   # 源用 1000Hz
```
> 判据口径：源 1000Hz 时，**未重采样**直接 48k 灌 44.1k 会得到 **1088Hz（+8.8%）**；带 147/160 重采样后 AP1 落盘应为 **1000Hz（≤0.5%）**。AP1 落盘速率恒 44.1k；AP2 床按会话协商速率取 RATE。
>
> **抗混叠补充**：源投 23kHz（高于 44.1k 的 22.05k Nyquist），AP1 落盘在 23kHz 处幅度应**衰减 ≥40dB**（不衰减 ⇒ 重采样实为裸抽取，会听到金属味混叠）；同时投 15kHz，幅度损失 ≤1dB。

### 5.3 量化判据与命令

> **🔴 2026-10-25 实测后必读（三条口径，错一条结论就废）**
>
> 1. **`ap1_cap_44.pcm` 是 S32_LE，不是 S16**：shairport 启动日志 `alsa: output format chosen is "S32"`，`arecord` 必须 `-f S32_LE`。用 S16 抓/读同一份数据会得到 **全 0**（S16 视图只取每样本高 16 位）。所以下面所有读 AP1 文件的地方都要 `<i4` 并除以 2³¹。
> 2. **互相关前必须降混单声道**：RAOP/sendspin 落盘都是交织立体声，1 frame = 2 sample。把交织序列当单声道直接相关，lag 单位是 sample 而不是 frame，换算会**恰好差 2 倍**（实测 137 ms 被测成 274 ms）。
> 3. **必须先冻结快照再比**：若一侧仍在写入或两者长度差 > 1 s，两侧"最后 10 s"不是同一时间段，会相关到重复段落 —— 实测出现过 **−950 ms 假峰位且 quality 仍 0.935**，极具欺骗性。
>
> ⇒ **口径唯一实现见 `backend/scripts/cc_align.py`（已落盘 230 `/root/cc_align.py`，sha256 `0eeab508…`），它内置上述三条 + 三项自检。** 下面手写脚本仅作原理示意。

```bash
# ① PCM 非静音检查（AP1 用接收端真抓，BLK-04；注意 AP1 是 S32）
/root/ssvenv/bin/python -c "
import numpy as np
for p,dt,full in [('/root/ap1_cap_44.pcm','<i4',2**31),('/root/fake1.pcm','<i2',2**15)]:
    a=np.fromfile(p,dtype=dt)
    if a.size==0: print(p,'EMPTY'); continue
    print(p,'peak',int(np.abs(a).max()),'rms_dbfs',
          round(20*np.log10(max(1e-12,(a.astype(float)**2).mean()**0.5/full)),1))"
```

```bash
# ② 两份 PCM 尾窗互相关（对齐判定）
#    🔴 NIT-01 定案：只保留一份实现 —— backend/scripts/cc_align.py
#    本文与《最终实施方案》都改成引用，不再各自内联（上一版已出现 seed=1/7、容差 0.1/0.5 两种参数）
/root/ssvenv/bin/python /workspace/MusicFlow/backend/scripts/cc_align.py \
    /root/fake1_44.pcm /root/ap1_cap_44.pcm 44100
# 期望首行：[selftest] OK  delta=137.0 ms  quality=1.000
# 末尾：    delta_ms = <x>   quality = <q>   JUDGE: PASS|FAIL
```

该脚本必须内置以下 5 条（缺一条都不算合格）：

1. **137ms 自检**：构造 `a` 比 `b` 晚 137ms，输出必须 `+137.0`（容差 0.5ms）；不过则 `sys.exit(1)`。
2. **wrap-aware lag**：`lags = np.arange(n); lags = np.where(lags > n//2, lags - n, lags)`。
3. **质量门**：`quality ≥ 0.2`，否则 `FAIL`。
4. **窄带源检测（BLK-03）**：统计 lag 轴上所有 1ms 整数倍处的 `quality`，若 ≥2 个点同时 >0.99 ⇒ 打印「源不适用（窄带/周期信号），请用宽带源」并退出，**不出 Δ**。
5. **尾窗**：默认最后 10s。

> **判据口径**：`|delta_ms| ≤ 20`（同协议/同采样率按 ≤5ms）且 `quality ≥ 0.2` 才算通过。**自检不过就说明脚本本身坏了，此时任何 delta 数字都不能当证据**（第六轮就是这么发现 −2862ms 假峰位的）。
>
> **尾窗选择**：必须取**最后 10s**。取文件头量到的是「会话起始时刻差」，不是同步误差——这是历史上被反复误读的假证据。
>
> **⚠️ `aresample` 会污染 Δ**（MIN-08）：若用 `ffmpeg -af aresample=44100:filter_size=64` 统一速率，该滤镜自身有群延迟，会直接加进 Δ。必须先用脉冲测出并扣除；**更优做法**是让假 Sendspin 侧直接落盘 44.1k，让重采样不进入比较链。

### 5.4 失败排查路径

| 症状 | 优先查 |
|---|---|
| 会话建了但无声 | 落盘 PCM 是否非零 → 供给链（组泵→bridgeChannel）是否真在喂；再看 bridge 队列是否已进 hardCap 断连 |
| 有声但明显偏移 | `scheduledAnchorUs` 与 `commandedLeadUs` 两条日志；确认 `startNtp = ntpFromHostUs(A − latencyFrames/rate)` 而不是 `A` 本身 |
| **声音正常但"跑调/偏快"** | **优先查采样率**（48k 灌给 44.1k ⇒ +8.8%）。用 FFT 用例 11 直接测基频，别靠耳朵 |
| **桥接成员恒定晚于组内其他成员** | ① `commandedLeadUs` 是否被 `ANCHOR_SAFE_LEAD_US=800ms` 钳死（bridge 路由必须绕过 `streamEngine.ts:846`）；② **不要**去找"哪一层多算了一次"——`latencyFrames` 是接收端缓冲深度，必须保留并进锚点公式（见 3.2 第 3 条）；③ **也不要**把 lead 并进 `commonSendAheadUs()`，那会让全组 +3.7s |
| seek 后错位/重建会话 | `generation` 是否随**二元组 `epoch * 1_000_003 + timelineReseed`** 递增（**只用 `epoch` 会漏 rehost** —— `rehost()` 全文不碰 `epoch`，只 `timelineReseed++`；反之只用 `timelineReseed` 会漏 seek）；`bridges.size` 是否被 `g.close()` 误清；保活窗内应 flush-refill 而非重建 |
| 组内两台互相漂 | 是否混用计时源：`nowUs()`=host 单调 µs、`ntpNow()`=同一 host 时钟换算；一旦有人混入 `Date.now()`/Unix，`stats` 里两台 `clock` 就对不上 |
| 偶发静音、日志 STALLED | 时钟未就绪仍锚定属预期；若持续无声再查接收端时钟响应 |

---

## 6. 风险与遗留

1. **🔴 采样率口径冲突（最高风险，第四轮已定案）**：sendspin 泵 **48000**、airplay RAOP **44100**，且 **AP1 接收端只支持 44.1k**（shairport-sync 3.3.8 二进制无 `48000`；MA 基础 PCM 也恒 44.1k）。⇒ **AP1 必须重采样**（48k→44.1k，有理数 147/160 多相 FIR），AP2 可 48k。用 FFT 用例 11 + 抗混叠用例 + 静态守卫钉死单一换算源。
2. **🔴 双速率口径是历史坑的直系后代**：旧 BridgeRing 就是「写 48000 帧/s vs clock 88346/s（44100×2）」两套口径打架。本次除「不得用 LoopbackSource」外，**再加一条「样本↔字节↔时间的换算只允许一处实现」**。
3. **🔴 RAOP 自带墙钟时间线（已升级为独立风险，详见 3.2）**：`stream()` 用 `wallStart + idx*chunkDurMs` 自推，与 BridgeRing 病根同构。桥接必须交出驱动权 + 支持位置跳变 + 定案延迟归属，**这是 Phase 2 的真正难点，不是"薄封装"**。
4. **🔴 时钟域不统一（第六轮新增，最易被忽略）**：sendspin 的 `nowUs()` 是 `process.hrtime.bigint()/1000`（host 单调 µs）；RAOP 的 `ntpNow()` 原本用 `performance.now()`（**另一个进程**的单调 ms）。两者既不同源、也都不是 Unix 时间。⇒ 必须新增 `utils/hostClock.ts` 作为唯一换算源，`ntpNow() = ntpFromHostUs(nowUs())`；锚点链一律禁 `Date.now()`/Unix。若沿用旧 `start(anchorUnixMs)` 设计，跨进程比出来的 lead 会随机偏移数百 ms 到数秒。
5. **🔴 组成员强类型（定案：不改类型，加并行集合）**：`members: Set<SendspinConnection>` 被 `broadcastGroupState`/`syncVolume`/`sinkHealth`/`legacy`/`clearPlayback`/`finishPlayback`/晚加入 ring 及 51 个测试文件依赖，且 `sendAudio` 走 `ws.send`（`server.ts:580/1477/2378`）。⇒ **不改 `members`**，新增 `bridges: Map<deviceId, AirPlayBridgeMember>`，仅在 `pushFrame` 的 `pcm:100` 编码组并行投递。**启动 lead 只喂 `streamEngine.anchorLead`，不进 `commonSendAheadUs()`**（第七轮 MAJ-01 改正）。**per-member 编码本身已逐行求证成立**，不用再验。

> **第七轮新增的 4 条（都已写进实施方案，此处只留索引）**
>
> **5b. 🔴 `pcm:100` 组在"只有桥、没有真实 pcm 成员"时**根本不会存在**（`pushFrame` 分组只遍历 `members`）⇒ 桥拿不到字节 + `deliveredPeak` 不推进 + `return 0` ⇒ 5s 后被判零产出**放弃本曲**。必须在 `pushFrame` 入口补虚拟 `pcm:100` 组（实施方案 §2.1 BLK-01）。**这是"要求"，不是"现状"**——前稿把它写成了现状，是错的。
>
> **5c. 🔴 把 bridge lead 并进 `commonSendAheadUs()` 会打坏真实设备**：音频帧头是 9 字节、**不含 `send_ahead`**（`server.ts:2380-2382` 有历史事故注释），设备用自己的默认 800ms 判过期。并进去 ⇒ 全组时间戳 +4.5s、设备按 800ms 判 ⇒ `delta` 恒 **+3.7s**；且 `computeCommonSendAhead` 的 `max(minBuffer, requiredLead)` 会让「热启 2500 / 持续 1000」永久失效（MAJ-01）。
>
> **5d. 🔴 `baseTs` 必须一起写**：`positionSec = ts2ms((headTs − baseTs) >>> 0)`。只改 `startTs/headTs/startNtp` 而留 `baseTs`，进度会变垃圾**且不报错**（MAJ-09）。
>
> **5e. 🔴 时钟纪元改 host 后 `ntp2ts` 会越 2^32**：44.1k 下 `2^32/44100 ≈ 27.05h`。现靠 `(headTs−startTs)>>>0` 的模运算侥幸自洽，但 `RTP-Info` 会把 13 位十进制发给接收端。必须显式 `>>> 0` + `sec=100_000` 单测（MAJ-10）。
6. **🔴 背压（第六轮新增）**：`sendAudio(): void` 是同步的，**不能**用它"暂停组泵"来实现背压——会拖死整个组。必须每桥独立有界队列：高水位 2s（384KB）告警，硬上限 8s（1.5MB）关 socket、标 stalled、按 `(5s, 30s)` 退避重连。**禁止丢最旧帧继续播**：那会造成「时间戳连续但内容有洞」，听感是随机静音，且互相关还能测出"很小"的 delta，最难排查。
7. **🔴 双会话所有权（第六轮新增）**：桥接成员与「solo cast 到同一台 AirPlay 设备」会争同一个 RAOP 会话。必须在流开始时**快照路由**（在线 Sendspin >0 且在线 AirPlay >0 ⇒ bridge，否则 legacy cast），流内不切路由，下一首重评估；并且 `detachFromActiveGroups` 当前 `if (kind !== "dlna" && kind !== "sendspin") return;` **漏了 airplay**，`alignGroupMembers` 的 airplay 分支也要纳入。
8. **代码债别踩**：`group.ts:101` 还有个同名 `SendspinGroup`（成员是 `Set<string>`，**无人 import 的死代码**）。实际生效的是 `server.ts:577` 那个。改代码/写守卫时务必认准文件，别改错副本。另：`index.ts` 里 `groupPlay` 已带 `bridge?: {devices,host,port,minSendAheadUs?}`，但 `childMain.ts` 的 `case "groupPlay"` 与 `playGroupCore()` **都没消费它**——是可编译但无效的半成品，必须接完或删净，否则会给人"已经实现"的错觉。
9. **AP2 必须拆两个阶段（第六轮修正）**：realtime stream type 96（RTP/UDP + NTP，实测口径见实施方案注①）与 buffered type 103（RTP/TCP + **依赖 PTP**）是两套工程。不能把「先 NTP、PTP 以后再说」套到 buffered 上。另：当前 discovery 只允许 `_raop` 创建设备、`_airplay` 仅补能力，若要 AP2-only 设备必须同步改 discovery + 测试 + 守卫。
10. **验收链目前是空的（当前唯一环境级阻塞）**：假 Sendspin 设备已修好四参数回调、`--probe` 通过，但**未验证连服务端/配对/收流**（230 无 38927/46400 监听）。**Phase 0/2 开工前必须打通**，否则「Δ≤20ms」无从测量。
11. **PTP 需要特权端口**（UDP 319/320）：AP2 realtime 阶段组内统一走 NTP 即可；进入 buffered/PTP 阶段必须「整组同源」，且 spawn 窗口未就绪时不能简单降级 NTP。
12. **模拟器泄漏**：AP2 床每会话泄漏满 CPU 子进程，会逐步拖垮 230（历史 load 曾到 100+），必须按 5.1-B 的四步起床。症状表现为「组位置恒 0 / 握手 30s / 矩阵偶发 FAIL」——**别去查协议**，先整床重启。
13. **🔴 跨进程 PCM 通路**：raop.ts 在 airplay 渲染子进程、组泵在 **sendspin 渲染子进程**（三进程拓扑，第五轮修正），现有 JSON IPC 序列化 Buffer 不可用；通路已拍板 net 二进制管道（airplay 侧 listen / sendspin 侧 connect，路径由主进程 RPC 下发），in-proc 回退写进守卫（详见 3.3）。
14. **🟡 互相关速率对齐（第三轮复核新增）**：fake1.pcm=48k、AP2 床落盘速率随会话协商，速率不一致直接互相关是假证据——必须先重采样对齐（见 5.2）。
15. **🟡 服务端无按设备速率变换（第三轮复核记录为已知限制）**：sendspin 组内若混入 44.1k-only 的真设备，现有服务端不支持降采样（恒 48k 下发）——与桥接无关，但同属速率契约盲区，守卫一并覆盖。
16. **🟡 无 ack 语义（第六轮新增）**：自研 RAOP 没有 cliairplay 的 `[STATUS] started` 回报。字段必须叫 `scheduledAnchorUs`（"我要求它在这个时刻播"），**不得**写成 `acked ... off the commanded instant`——那是把"命令"当"确认"，历史上直接导致过误判同步已达成。
17. **🟡 `hap_credentials` 是空壳（第六轮新增）**：DB 有列、有幂等迁移（`db/index.ts:469`、`:752` 起），但**没有任何业务读写**。AP2 配对要落库，必须先定义消费与验证契约（写入时机、验证方式、失效清理），否则配对"成功"只写在内存里，重启即失。

---

## 7. 附录：关键索引

**MA 源码（230 `/workspace/MA`）**
- `music_assistant/providers/airplay/sendspin_bridge.py`：锚点 L886 / 对齐 L1518 / 节流 L1580 / 热复用 L531 / re-anchor 吸收 L1411 / 组 PTP 决策 L1705
- `sendspin_bridge.py:165` `sendspin_audible_instant_to_unix_ms` / `:192` `unix_ms_to_sendspin_audible_instant`：**只迁移「距 now 的偏移」**，且要求 `sendspin_now_us` 与 `unix_now` 背靠背采样——这是我们 `hostClock` 换算的参考语义
- `sendspin_bridge.py:215` `device_buffer_ahead_seconds` · `:79` `MAX_DEVICE_BUFFER_SECONDS` · `:85` `BRIDGE_WARM_GRACE_SECONDS` · `:90/98/99/106/112/116/135/142` 其余桥接常量
- `music_assistant/providers/sendspin/bridge_role.py`：外部客户端角色、`set_timing`（keyword-only 无默认，`:154`）
- `music_assistant/providers/sendspin/bridge_manager.py`：生命周期与 derived-transport
- `music_assistant/providers/_demo_sendspin_clients/device.py`：假设备蓝图（模拟器即源于此）

**MusicFlow 源码（本轮复核取证点）**
- `sendspin/server.ts:1128` `pushFrame`（按 `(codec,gain)` 分组独立编码）· `:782` `encoderKey` · `:785` `encoderForGroup`（含编码器自愈）
- `sendspin/server.ts:580` `members = Set<SendspinConnection>` · `:1472` `SendspinConnection`（`ws` 强绑）· `:2378` `sendAudio`
- `sendspin/server.ts:1218` `ringFor` + `pruneRecent`（晚加入回填）· `:626` `flushAnnounceFor`（先给货后宣告的坑）
- `sendspin/server.ts:1429` `sendAheadInputOf` · `:1578/:2023` `announcedSampleRate`（**仅记录，无按速率变换** ⇒ 服务端恒 48k 下发）
- `sendspin/server.ts:724` `offloadsVolume()` 恒 `true` · `:737` `appliedGain()` 恒 `100`（**PCM 是 unity，响度全交设备侧**，第六轮核实）
- `sendspin/server.ts:815` `commonSendAheadUs()`（bridge lead 的并入点）
- `sendspin/group.ts:76` `computeCommonSendAhead`（全组取 max；报 0 回落缺省——桥接成员延迟上报的接入点）
- `group/protocolPlayer.ts:160` airplay 成员「逐设备独立 cast」现状（桥接分派规则的改造点）· `:19` `splitGroupMembers` 三桶 · `pollState`/`getGroupStatus` 的 `leader.kind === "airplay"` 读 solo 会话（改 leader 来源时必须同步）
- `routes/api/shared.ts` `detachFromActiveGroups`（`kind !== "dlna" && kind !== "sendspin"` 就 return ⇒ **漏 airplay**）· `:668` `alignGroupMembers` 的 airplay 分支
- `sendspin/childMain.ts` `case "groupPlay"` 只消费 `members/group/item/seekPositionMs`，**不消费 `p.bridge`**；`playGroupCore()` 无 bridge 参数（半成品残留）
- `sendspin/streamEngine.ts:376` `private epoch = 0`（`:360` 注释「每次 play 自增」；`:532` `play()` 自增、`:1179` `stop()` 自增）· `:1291` `timelineReseed++`（**只在 `rehost()` 内，且 rehost 不碰 `epoch`**）· `:813` 重锚分支（`firstFrame || timelineReseed !== consumedReseed`，**代次钩子的唯一落点**）· `:846` `ANCHOR_SAFE_LEAD_US` 钳制（bridge 路由必须绕过）· `:1028`/`:1082` 是预填充使能门与曲末排空量，**不是** lead 钳制 · `:759` `while (running && epoch === myEpoch)`（**禁止给 rehost 加 `epoch++`**，否则移交变停播）
- `airplay/mode.ts` **默认 fork**（2026-10-22 翻默认：主进程 RTP 节拍会被事件循环打散）⇒ 跨进程 PCM 通路的由来（3.3）
- `sendspin/mode.ts` / `sendspin/supervisor.ts` / `sendspin/child.ts`：**组泵同样在渲染子进程**（`supervisor.ts` 头注释：WS 38927 + 解码/编码/推流 + mDNS + 拨号 + 6053 桥 fork 到子进程）⇒ 三进程拓扑的由来（第五轮修正）
- `sendspin/group.ts:47` `DEFAULT_MIN_BUFFER_MS = 800` · `sendspin/constants.ts:63/65/67` `LATE_JOIN_MARGIN_US=100ms` / `LATE_JOIN_KEEP_PAST_US=1s` / `LATE_JOIN_RING_MAX_US=35s`
- `airplay/raop.ts:28` `CHUNK_LEN=352`（=7.98ms@44.1k）· `:29` `PCM_BYTES_PER_CHUNK=1408` · `:289` `latencyFrames=SAMPLE_RATE` · `:615` `max(audioLatency, sampleRate)`
- `airplay/raop.ts:70` `ntpNow()` 用 `performance.now()`（**本轮证伪旧锚点链的关键**）· `:772` `startNtp = ntpNow()` · `:661` timing reply · `:917` `writeNtp` · `:876` `setVolumeDb()`（`SET_PARAMETER`，fire-and-forget）
- `db/index.ts:469` `hap_credentials`（192hex；`:752` 起为 2026-10-23 幂等加列迁移，**无业务消费**）
- `sendspin/constants.ts:2-4` `WS_PATH=/sendspin` · `WS_PORT=38927` · `LEGACY_WS_PORT=8928`
- 配对路由：`routes/api/sendspin.ts:299` `POST /v1/sendspin/pairing/start` · `:316` `POST /v1/sendspin/pairing/code`
- `airplay/ipcProtocol.js` JSON IPC（`process.send` 序列化 Buffer ⇒ **不可承载 PCM**）
- `sendspin/server.ts:1-8` 头注释「Noise initiator 恒为服务端」——与 aiosendspin 规范/客户端方向一致（第三轮复核确认）
- `sendspin/encoding.ts:31` `SAMPLE_RATE=48000` · `:876` `PcmEncoder`（F32→s16le 零延迟）
- `airplay/raop.ts:25` `SAMPLE_RATE=44100` · `:258` `PcmProducer` · `:754` `stream()`（墙钟自推循环）
- `sendspin/group.ts:101` 同名 `SendspinGroup` **死代码**（实际生效的是 `server.ts:577`）
- `airplay/ap2/` **空目录**（AP2 发送端尚未开始，Phase 5a/5b）

**新增文件（🔴 NIT-04：目录结构以《最终实施方案》§6.1 为准，本文同步）**
- `backend/src/utils/hostClock.ts`：`nowUs()` / `ntpFromHostUs()`（唯一时钟换算源）
- `backend/src/services/airplay/rates.ts`：`SENDSPIN_RATE=48000` / `AIRPLAY1_RATE=44100` / `AP2_RATES` / `PROTOCOL_CAPS`
- `backend/src/services/airplay/resampler.ts`：147/160 多相 FIR，跨帧状态，群延迟 0.3627ms
- `backend/src/services/airplay/bridgeMath.ts`：锚点、样本映射、漂移、latency 补偿（纯函数）
- `backend/src/services/airplay/bridgeChannel.ts`：28B 帧编解码 + 有界队列 + 背压
- `backend/src/services/airplay/bridgeServer.ts`：airplay 子进程侧 listen
- `backend/src/services/airplay/bridgeSession.ts`：RAOP 会话与锚点
- `backend/src/services/airplay/bridgeSource.ts`：有界 PCM 队列 + stalled/overflow
- `backend/src/services/sendspin/bridgeMember.ts`：`AirPlayBridgeMember`（并行 `bridges` 集合元素）
- `backend/scripts/check-airplay-bridge.mjs`：14 条守卫（见实施方案 §9）
- `backend/scripts/cc_align.py`：唯一互相关脚本（137ms 自检 + wrap-aware + 窄带源检测）

**aiosendspin 10.2.1（假设备与时间戳语义的权威口径）**
- `client/client.py:1324` `add_audio_chunk_listener` 四参数 · `:1328` `server_timestamp_us` = when this audio should play · `send_ahead` 不影响播放时刻
- `client/connection.py:2090` `compute_play_time()` = `client_time − output_delay`
- `client/models.py:138` `AudioFormat{codec, pcm_format, codec_header}` · `audio/format.py:48` `{sample_rate, bit_depth, channels, sample_type}`
- `server/roles/base.py:68-73` `AudioChunk`（服务端视角，与客户端回调参数不是同一个东西）

**MA 源码补充（第三轮复核，第六轮修正结论）**
- `sendspin_bridge.py:1030-1048` `_on_volume_change`/`_on_mute_change`：**MA 音量走设备侧转发**（`airplay_player.volume_set`），不做 PCM 数据缩放；`:462` `sync_role_volume_state` 防设备侧音量反馈回环。
  > **第六轮修正**：我们组泵本来就是 `offloadsVolume()` 恒 `true`、`appliedGain()` 恒 `100`，**PCM 已经是 unity**。因此「`scalePcm` 数据缩放 + RAOP 音量钉死」的旧方案**作废**，改为直接复用 `setAirPlayVolume` / `setAirPlayMuted`（与 MA 同路），无需二选一。
- `sendspin_bridge.py:1050` `_on_bridge_stream_end`：stream end → CLI 保活 4s 宽限窗，新流 flush-refill；显式 stop 立即拆（与 2.2-④ 一致，已核准）。

**230 资产**
- `/opt/mf-airplay/cliairplay`（v0.5.9，协议/计时参考）
- `/tmp/ap2recv/`（AP2 + AP1 接收端源码，AP2 发送端反向参考）
- `/root/ap2_bed.sh`（AP2 接收端床 start/stop/status）
- `/root/ssvenv`（aiosendspin 10.2.1，假 Sendspin 设备运行时）
- MusicFlow sendspin：`WS_PORT=38927`、`WS_PATH=/sendspin`

---

## 8. 附录 B：第五轮事实核对清单（逐条对源，防止同类低级错误）

> 每一行都是「打开源文件/实机命令核实」，不是推断。**改方案前必须先过这张表**；任何新断言都要能填进「依据」列。

| 断言（此前文档里写过的） | 核对结果 | 依据 |
|---|---|---|
| AP1/RAOP 可直出 48k | ❌ **错**。AP1 接收端只认 44.1k，必须重采样 | `strings /usr/bin/shairport-sync \| grep -c 44100`=9、`48000`=0；MA `constants.py:352` 基础 PCM 恒 44100 |
| MA 桥角色 44.1k/16/2 | ✅ 对 | `bridge_role.py:38-40` |
| 组泵在主进程（第三轮） | ❌ **错**。sendspin 也有 mode/supervisor/child/childMain，泵在渲染子进程 | `sendspin/supervisor.ts:3` 头注释「fork 到子进程」；`sendspin/mode.ts` |
| 桥成员不填 lead 回落 1000ms | ❌ **错**。实测 `DEFAULT_MIN_BUFFER_MS = 800` | `sendspin/group.ts:47` |
| `hap_credentials` 在 db/index.ts:468 | ❌ 偏 1 行，实际 469 | `db/index.ts:469`（`:752` 起迁移） |
| MAX_DEVICE_BUFFER_SECONDS 在 L~88 | ❌ 实际 L79（其余常量行号同样修正） | `sendspin_bridge.py:79/85/90/98/99/106/112/116/135/142` |
| `set_timing(required_lead_time_ms, min_buffer_ms=1000)` | ❌ 实为 keyword-only 且无默认值 | `bridge_role.py:154` |
| 假设备脚本已宣告 48000 | ❌ 文档改了但**实机脚本没改**（第五轮已修） | `/root/fake_sendspin.py:45` 现为 48000 |
| `_cli_writer()` 不存在 | ❌ 误判（我的 grep 漏了 `async`），实际存在 | `sendspin_bridge.py:1580-1645` |
| 对齐漂移告警阈值 >1ms | ✅ 对（且要求 `_queued_frames` 非零、非 shift 吸收中） | `sendspin_bridge.py:1546` |
| CHUNK_LEN=352、1408 B/包、7.98ms | ✅ 对 | `raop.ts:28-29`；352/44100×1000=7.98ms |
| 48000/44100 = +8.84%；192KB/s；147/160 | ✅ 对 | 算术：1.0884、48000×2×2、44100/48000 |
| MA `sendspin_bridge.py` 1808 行、`device.py` 295 行 | ✅ 对 | `wc -l` |
| aiosendspin 10.2.1、cliairplay v0.5.9 | ✅ 对 | `pip show`、二进制 banner（`--version` 不支持） |
| AudioChunk = `data` + `timestamp_us` | ⚠️ **只在服务端视角成立**；**客户端回调是四参数**，不是 `AudioChunk` 对象（第六轮实锤） | `aiosendspin/server/roles/base.py:68-73`（服务端）；客户端见 `client/client.py:1324` 与附录 C #15 |
| 握手：服务端 Noise initiator / 客户端 responder | ✅ 对 | `noise/driver.py:131/207`、`client/connection.py:472` |
| 配对路由 `/v1/sendspin/pairing/start|code` | ✅ 对 | `routes/api/sendspin.ts:299/316` |
| AP2 床端口 7200 起、`/tmp/ap2recv` + `ap2venv` | ✅ 对 | `/root/ap2_bed.sh:13-16` |
| AP1 参考实现路径 | ❌ 原写 `/tmp/ap2recv/airplay1.py`，实际在 `ap2/airplay1.py` | `ls /tmp/ap2recv/ap2/` |
| 晚加入常量 | ✅ 补值：`LATE_JOIN_MARGIN_US=100ms`、`KEEP_PAST=1s`、`RING_MAX=35s` | `sendspin/constants.ts:63/65/67` |

---

## 9. 附录 C：第六轮事实核对清单（最终口径）

> **纪律**：本表每一行都必须能填出「依据」（命令输出 / `文件:行`）。填不出来的断言一律降级为「未验证」，不得进设计。
> 第六轮的实际产出不是"又看了一遍"，而是**证伪了四类架构错误**——它们都已写进正文，这里留档防止回潮。

### C.1 已被证伪、必须按新口径执行（🔴 高危）

| # | 旧断言（前五轮方案里写的） | 核对结果 | 依据 |
|---|---|---|---|
| 1 | RAOP `ntpNow()` 与 Sendspin `nowUs()` 可直接换算 | ❌ **错**。`ntpNow()` 用 `performance.now()`（毫秒，本进程单调）；`nowUs()` 用 `process.hrtime.bigint()/1000`（微秒，本进程单调）。**两个不同进程的单调时钟，既不同源也不是 Unix 时间** | `airplay/raop.ts:70-75`（`:75 const ms = performance.now()`）；`sendspin/clock.ts:21-22` `export const nowUs = (): bigint => nowUsOverride ? nowUsOverride() : BigInt(hrtime.bigint() / 1000n)`（**MIN-02：不是 `sendspin/time.ts`，该文件不存在**） |
| 2 | 桥接接口设计成 `AirPlaySender.start(anchorUnixMs)` | ❌ **错**。① 时钟域不成立（见 #1）；② RAOP 会话和锚点都在 airplay 子进程，sendspin 侧**无法跨进程 await 一个设备 ack**。改为 `bridgePrepare/bridgeStop/bridgeSetVolume/bridgeStatus` 控制面 + **首帧驱动锚点** | 三进程拓扑（`airplay/mode.ts` 默认 fork、`sendspin/supervisor.ts` 头注释）；`raop.ts:772` `this.startNtp = ntpNow()` 在 `stream()` 内部 |
| 3 | 为去掉"双层延迟"要把 `latencyFrames` 归零 | ❌ **错**。`latencyFrames = Math.max(audioLatency, sampleRate)` 是**接收端播放保持深度**，写进 RECORD 的 `Audio-Latency`，并进 SYNC 包（`headTs − latencyFrames`）。归零会让接收端无缓冲可播。正确做法：保留，并进锚点公式 `startNtp = ntpFromHostUs(A − L)` | `raop.ts:289`（`latencyFrames = SAMPLE_RATE`）、`:615`（`max(audioLatency, sampleRate)`）；单测 `tests/airplay/raopPlayer.test.ts:473`「rtptime 字段 = headTs − latencyFrames」、`:985`「SYNC 的 rtp_timestamp_latency 字段 = headTs − latencyFrames」**已锁定该语义** |
| 4 | 音量用组泵 `scalePcm` 数据缩放 + RAOP 音量钉死 | ❌ **错**。`offloadsVolume()` 恒 `true`、`appliedGain()` 恒 `100`，**PCM 本来就是 unity**（源码注释：采样永远满幅，响度 100% 由设备输出级负责）。改成复用 `setAirPlayVolume`/`setAirPlayMuted` | `sendspin/server.ts:724` `offloadsVolume(_c) { return true; }`、`:737` `appliedGain(_c) { return 100; }`（注释原文「恒 unity:采样永远是满幅,**响度 100% 由设备输出级负责**」） |
| 5 | 让桥接成员进 `members: Set<SendspinConnection>`（或把 `GroupSink` 改型） | ❌ **不采纳**。`members` 的真实使用面：`clientWantsStream` / `sendJson` / `sendPlayerCommand` / `legacy` / `muted` / `sinkHealth` / `lastBufferedAmount` / `announceStream` / `syncStaticDelayTo` / `broadcastGroupState`，且 `broadcastGroupState` 会把成员 `client_id` 下发（桥成员会污染组状态）。改型波及 51 个测试文件。⇒ 并行 `bridges: Map<deviceId, AirPlayBridgeMember>`，只在 `pushFrame` 的 `pcm:100` 编码组投递 | `server.ts:580` `members = new Set<SendspinConnection>();`；`server.ts:1128` `pushFrame` 分组逻辑；`server.ts:815` `commonSendAheadUs()` |
| 6 | 跨进程帧格式 `[len][ts][pcm]` | ❌ **不够**。seek/切歌后无法区分旧流，会出现"新流已锚定、旧流缓冲还在灌"。⇒ 28B 头：`magic "MFAB"(4) / version(1) / type(1) / flags(2) / generation(u32) / sequence(u32) / tsUs(i64) / payloadLen(u32)` | 代次必须是**二元组** `epoch * 1_000_003 + timelineReseed`：`epoch` 覆盖 seek/track（`play()`/`stop()` 各增一次），`timelineReseed` 只覆盖 `rehost()`（`:1291`）——单用任一个都会漏（BLK-02 + 复验 R1） |
| 7 | 背压用"暂停投递"实现 | ❌ **不可行**。`sendAudio(): void` 是同步签名，不能 await、不能暂停组泵（会拖死整组）。⇒ 每桥有界队列：高水位 2s 告警，硬上限 8s 断连，`(5s, 30s)` 退避重连。**禁止丢最旧帧** | `server.ts:2378` `sendAudio`；MA 对应策略 `sendspin_bridge.py:79` `MAX_DEVICE_BUFFER_SECONDS`、`:85` `BRIDGE_WARM_GRACE_SECONDS`、`:1580` `_cli_writer` 的 `ahead > MAX_DEVICE_BUFFER_SECONDS` 节流 |
| 8 | AP2 一期就能"先 NTP、PTP 以后再说" | ❌ **错**。realtime（type 96，RTP/UDP，NTP）与 buffered（type 103，RTP/TCP，**依赖 PTP**）是两套工程 | MA `sendspin_bridge.py:1705` 组 PTP 决策分支；AP2 stream type 语义 |

### C.2 第六轮新发现的既有代码缺口（实现时必须一并处理）

| # | 缺口 | 影响 | 依据 |
|---|---|---|---|
| 9 | `detachFromActiveGroups` 只处理 `dlna`/`sendspin`，`airplay` 直接 `return` | AirPlay 成员「摘组」变 no-op，桥上会留下孤儿成员 | `routes/api/shared.ts`：`if (parsed.kind !== "dlna" && parsed.kind !== "sendspin") return;` |
| 10 | `groupPlay` 的 `bridge?` 参数在 `index.ts` 声明了但没人消费 | 看着"已实现"，实际完全无效（可编译的空壳） | `sendspin/index.ts:759` `bridge?: { devices: string[]; host: string; port: number; minSendAheadUs?: number }`；`childMain.ts` 的 `case "groupPlay"` 只取 `members/group/item/seekPositionMs`；`playGroupCore()` 签名无 bridge |
| 11 | 预填充路径把首帧 lead 钳到 `min(aheadUs, 800ms)` | 桥成员上报 4500ms 冷启动 lead 会被**截成 800ms** ⇒ 起播必晚 3.7s | `streamEngine.ts:136` `ANCHOR_SAFE_LEAD_US = 800_000`；`:846` `? Math.min(aheadUs, ANCHOR_SAFE_LEAD_US)`；`:848` `const lead = BigInt(Math.max(anchorLead, FIRST_FRAME_LEAD_US))` |
| 12 | `leader.kind === "airplay"` 时读的是 **solo 会话** | 桥上组位置/状态来自错误的会话源 | `group/protocolPlayer.ts` `pollState` / `getGroupStatus` 的 airplay 分支 |
| 13 | `airplay/ap2/` 是**空目录** | AP2 从零开始，不是"补几行" | `ls backend/src/services/airplay/ap2/` 无输出 |
| 14 | `hap_credentials` 只有列 + 迁移，**无任何业务读写** | AP2 配对凭据无处落库，重启即失 | `db/index.ts:469`、`:752` 起幂等加列；全仓 grep 无消费者 |

### C.3 已验证成立（可放心依赖）

| # | 断言 | 依据 |
|---|---|---|
| 15 | Sendspin 音频回调是**四参数** `(timestamp_us, payload, audio_format, send_ahead)` | `aiosendspin/client/client.py:1324` |
| 16 | `timestamp_us` 语义 = **这块音频应当播放的时刻** | `client/client.py:1328`，原文 "when this audio should play" |
| 17 | `send_ahead` **不影响播放时刻**，只是发送提前量 | 同上，原文 "Never affects when the chunk plays" |
| 18 | 客户端最终播放时刻还要再减 `output_delay` | `client/connection.py:2090` `compute_play_time()` = `client_time − output_delay` |
| 19 | `audio_format.pcm_format` 提供 `sample_rate/bit_depth/channels`（可用来自算 duration） | `client/models.py:138`、`audio/format.py:48` |
| 20 | MA 时钟换算只迁移「距 now 的偏移」，要求两侧背靠背采样 | `sendspin_bridge.py:165` `sendspin_audible_instant_to_unix_ms`、`:192` `unix_ms_to_sendspin_audible_instant`；`cli_clock_time()` = `RawMonotonicClock + CLI_CLOCK_OFFSET_NS` |
| 21 | `set_timing` 是 keyword-only 且**无默认值** | `bridge_role.py:154` |
| 22 | 服务端恒 48k 下发，无按设备宣告速率的变换 | `server.ts:1578/:2023` 仅记录 `announcedSampleRate`；编码分组键只有 `(codec, gain)` |
| 23 | AP1 接收端只支持 44.1k，必须重采样 | `strings /usr/bin/shairport-sync` 数 44100 = 9 处、48000 = 0 处；MA `constants.py:352` |
| 24 | 互相关必须用 FFT + wrap-aware lag（`np.correlate` 直算给出假峰位 −2862.98ms，真值 +137ms） | 本轮实测：修正后 FFT 与 `np.correlate` 两条路径均输出 `137.0 ms` |
| 25 | 假 Sendspin 脚本已按四参数重写并部署 | `/root/fake_sendspin.py`，sha256 `0c4e88a5014d1694269328f82e683e7aeaabcb42e11f4fc649dc7a457258ce06`，`py_compile` 通过，`--probe` 输出 `client_id` |
| 26 | AP2 接收端床可用（7200 端口） | `/tmp/ap2recv/ap2-receiver.py` 已从 `/root/ap2bed/ap2-2/` 反解恢复为 1484 行；`ap2_bed.sh start 1` → `LISTEN 192.168.10.230:7200`，日志 `mDNS: service registered` |
| 27 | 验收分析环境就绪 | `/root/ssvenv` numpy 2.5.4 |

### C.4 明确「未验证 / 环境阻塞」（不得当成已达成）

| # | 项 | 状态 | 说明 |
|---|---|---|---|
| 28 | 假 Sendspin 设备**真实连上服务端 → 收流** | ✅ **已验证（2026-10-25，用 240）** | 240 容器 v4.6.74/8d7a0ff 上实测：`[first] ts=… dur=25000 bytes=4800 fmt=PCM/48000/16/2`，落盘 15.8s、peak 26131、RMS −17.1 dBFS、nonzero 99.98%。**但配对未通过**（见 #28b），用 `--unpaired` 绕过 |
| 28b | 假设备**正规配对**（pairing code 流程） | 🔴 **不可达（服务端缺口 P0-1）** | `onClientHello` 无条件发 `{activities:["playback"]}`，未配对 sentinel 会话只准 `{pairing}` ⇒ aiosendspin 判 `pairing_required` 立即 goodbye；`pairServer.start()` 又要求客户端在线 ⇒ 无窗口。真实 sendspin-cpp 行为不同故能配对 |
| 28c | **AP1 接收端真抓链** | ✅ **已验证** | shairport 输出 `S32`/`44100`/`hw:Loopback,0`；`arecord -f S32_LE` 得 peak_i32 22.6M（−39.56 dBFS）、nonzero 1.0、分段 RMS 起伏 12.3 dB。**`-f S16_LE` 会得到全 0**（已修正文档命令） |
| 28d | **Δ 测量链端到端** | ✅ **已验证** | 同歌并行投 sendspin + AP1，`cc_align` 得 Δ=−7461.4 ms 且在 20/30/45s 三窗口完全一致（quality 0.497/0.693/0.769） |
| 29 | AP2 发送端 | 🔴 **未开始** | `airplay/ap2/` 空目录 |
| 30 | `hap_credentials` 的写入/验证/失效契约 | 🔴 **未定义** | 只有 DB 列与迁移 |
| 31 | AP2 接收端 `/info` 响应 | 🟡 **不可用** | 发送端就绪探针应以 RTSP `OPTIONS`/`SETUP` 为准，不要依赖 `/info` |
| 32 | Apple 真机（AP2 realtime 静音矩阵） | 🟡 **未测** | 需单独记录，Apple 设备 NTP realtime 有已知静音面 |
| 33 | AP2 buffered/PTP 组同步 | 🟡 **未测** | Phase 5b 之后才有被测对象 |

> **复核纪律（写给下一轮）**：改本文前先过一遍 C.1 的 8 条；任何一条被"优化"回去，就等于把已经踩过的坑重踩一遍。C.4 里没打勾的项，本文一律不得写成"已实现"。

---

## 10. 附录 D：第七轮终审（red team）结论

> 完整报告：`审查报告-AirPlay桥接终审-2026-10-25.md`（305 行）。抽查事实 34 条：✅26 / ❌4 / ⚠️4；问题分级 4 Blocker / 10 Major / 11 Minor / 5 Nit。
> **结论**：架构骨架**全部成立**，可照实现；但**验收链本身是断的**（4 条 Blocker 有 3 条落在"能不能证伪"），且 seek / 摘除最后一个 Sendspin 两个高频生命周期的机制与源码不一致。

### D.1 被终审推翻的（本文与实施方案都已改）

| 编号 | 问题 | 影响 |
|---|---|---|
| BLK-01 | `pushFrame` 分组只遍历 `members` ⇒ 只有桥时 `pcm:100` 组不存在 | 桥拿不到字节；`return 0` ⇒ 5s 后放弃本曲 |
| BLK-02 | seek **不经过** `timelineReseed`（唯一自增在 `rehost()`）；seek 走 `seekCore→playGroupCore` 完整重建且不传 bridge | 照旧稿写：seek 后桥不换代次、旧锚点配新时间戳 ⇒ 静音/错位 |
| BLK-03 | 1kHz 正弦周期 1ms，无法测 20ms 级 Δ；`quality` 恒≈1 | 判据"必过"的假绿 |
| BLK-04 | AP1「设备实际播放 PCM」无定义；发送端落盘算 Δ 恒≈0 | 同上，且是最危险的一类 |
| MAJ-01 | bridge lead 并入 `commonSendAheadUs()` | 真实 sendspin 设备恒定 +3.7s，并让三层延迟永久失效 |
| MAJ-09 | 漏 `baseTs` | `positionSec` 变垃圾且不报错 |
| MAJ-10 | 时钟纪元改 host 后 `ntp2ts` 越 2^32（27h） | uptime >27h 后靠模运算侥幸自洽 |
| MAJ-05 | socket 路径 `sun_path` 108B 上限 | 旧命名约 133B ⇒ 每台桥都 bind 失败 |
| MAJ-06 | `stopAirPlaySessionsForHost` 会连带杀掉桥会话 | DLNA cast 一次就把桥打断 |
| MAJ-07 | prepare 失败 ⇒ 设备既不 bridge 也不 cast 且无提示 | 最糟的可用性状态 |
| MAJ-08 | `delta` 无定义 | "稳定"不可断言，用例 4/6 不可执行 |
| MAJ-02/03/04 | D 编号跨文档错位、两套 Phase 编号、验收仍以 AP2 为对象 | 排期与引用对不上 |

### D.2 终审明确「不要改回去」的 14 条

并行 `bridges`（不改 `members`）· `latencyFrames` 不归零 · `A−L` 是唯一补偿点（`send_ahead` 不再减第二次）· `hostClock` 唯一时钟源 · net unix socket + 28B 帧（不用 JSON/worker/in-proc）· 帧头带 `generation` · 丢帧禁令 + hardCap 断连 + 退避 · `sendAudio` 保持同步 `void` · 无 ack（字段名 `scheduledAnchorUs`）· AP1 强制 44.1k + 147/160 有理数 FIR（不用 ffmpeg）· 路由流开始时快照 · AP2 拆 realtime/buffered 且 Phase 6 不动 discovery · 互相关 FFT + wrap-aware + 137ms 自检 · `pcm:100` 复用 `encoderForGroup`/`ringFor`。

> 这 14 条每一条都对应过一次或多次已被证伪的旧方案。任何人"简化"它们都会重踩坑。

### D.3 仍未验证 / 阻塞（不得当成已实现）

| 项 | 状态 | 说明 |
|---|---|---|
| 假 Sendspin 真实连服务端→配对→收流 | 🔴 未验证 | 230 无 38927/46400 监听。**Phase 0 门禁** |
| AP1 抓取链（`arecord`） | 🔴 未搭 | 模块已加载，命令未执行过 |
| `cc_align.py` | 🔴 未落盘 | 需进 `backend/scripts/` 并注册 CI |
| AP2 发送端 | 🔴 未开始 | `airplay/ap2/` 空 |
| `hap_credentials` 消费契约 | 🔴 未定义 | 只有列与迁移；已提为 Phase 6a 门禁 |
| 接收端把 SYNC offset4 解释为"当前播放头 RTP" | ⚠️ 仅推导未实测 | 唯一实证手段 = 与 `cliairplay` 同源 A/B（Δ≤5ms） |
| Apple 真机 AP2 realtime 静音矩阵 | 🟡 未测 | 无真机 |
| AP2 buffered/PTP | 🟡 未测 | P7 之后才有被测对象 |

### D.4 复验（第二轮）结论

> 报告：`审查报告-AirPlay桥接终审-复验-2026-10-25.md`（99 行）。7 处修法：3 PASS / 3 部分成立 / **1 FAIL**，**未引入新 Blocker**。总判 **可进入 Phase 1 开发**。

| 编号 | 级别 | 结论 |
|---|---|---|
| **R1** | Major（**事实错误，主理人引入**） | ❌ 我写的"`rehost()` 经 `stop()` 自增 `epoch`"**不成立**：`:1270-1299` 全文无 `this.epoch`、不调 `stop()`，只 `timelineReseed++`。后果：借流移交时桥不重锚。且**绝不可给 rehost 加 `epoch++`**（会让 `:759` 的 `while(...epoch===myEpoch)` 立刻退出，移交变停播）。⇒ 代次改**二元组 `epoch * 1_000_003 + timelineReseed`**，钩子挂 `:813` 重锚分支 |
| R2 | Major | `coldStart` 无来源 ⇒ `CONFIG` 回执带 `warm`，`bridgeStartLeadUs()` 取各桥 max，无回执按 cold |
| R3 | Minor | 本文 Phase 1 与 §3.1 表的 `0.33ms` 与 `:783` 的 `0.3627ms` 不一致 ⇒ 已统一 |
| R4 | Minor | 截断/对齐**顺序**未写 ⇒ 必须先 `>>> 0` 再 `% CHUNK_LEN`（`2^32 % 352 = 224`，顺序反了残 32）；`& 0xFFFFFFFF` 在 `0xFFFFFFFF` 处得 −1，破坏对齐 |
| R5 | Minor | "禁止 `raop.seek()`" 指向**不存在的方法** ⇒ 改 `prepareSeek()` / `setStartPosition()` / cast `seekSec` |
| R6 | Minor | owner 字段落点未给（`ActiveSession` @ `sessionRuntime.ts:82`）；旁路 `protocolPlayer.ts:54` 需守卫断言 |
| R7 | Minor | BOUNDARY 语义边界未写 ⇒ 只清队列+换代次、不 TEARDOWN；钩子挂投递路径不用定时器 |
| R8 | Nit | Phase 0 出口需重排（起服务→旧 cast 投 AP1→arecord→假设备）；`cc_align.py` 提前到 P0；晚加入用例加"seek 后 ≥3s" |

**复验确认成立、开发时别动**：`encoderKey("pcm",100)` → `"pcm:100"` ✓；虚拟组在五处后续环节全无害（`scalePcm(100)` 直接返回原数组、零拷贝）✓；`baseTs` **只有** `positionSec` 与 `seekStartTs` 两处消费（无第三处）✓；`sun_path[108]` + `ENAMETOOLONG` 已 header/man 证实，实测路径 26B 余 82B ✓；`shairport-sync.conf:8 output_device="hw:Loopback,0"` **真实存在**，`arecord -D hw:Loopback,1` 正是对侧 ✓。

⚠️ 两条实现注意：① 虚拟组会进 `meterBytes`，**只有桥**时 `encodedBytesPerSec` = 192KB/s（正是期望值）；② `raopPlayer.test.ts:116/335/627/967` 有 4 处硬编码 `anyP.baseTs`，改锚点语义要**同一 commit** 同步。
