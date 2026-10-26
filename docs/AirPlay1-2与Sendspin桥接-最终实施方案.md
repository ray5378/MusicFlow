# MusicFlow AirPlay 1/2 × Sendspin 桥接：最终实施方案（开发执行版）

> 基线：MusicFlow `8d7a0ff`（2026-10-24；文档定稿 2026-10-25）；MA master `7dfa5d8`（230 `/workspace/MA`）。
> 本文是第六轮逐行复核 + **第七轮 red-team 终审**后的**唯一开发口径**。旧版中的 `anchorUnixMs`、`latencyFrames` 归零、`scalePcm` 音量、单一 `GroupSink` 替换 `Set<SendspinConnection>` 等设计已证伪，全部作废。
> 第七轮终审记录见《审查报告-AirPlay桥接终审-2026-10-25.md》；本文已按该报告修入 4 条 Blocker 与 10 条 Major。
> 环境：开发/模拟验收在 230；真机回归在 240。

---

## 0. 第六轮审计结论

### 0.1 已证伪的旧设计（不得再按旧稿实现）

| 旧设计 | 证伪依据 | 新口径 |
|---|---|---|
| `sender.start(anchorUnixMs)` | RAOP 的 `ntpNow()` 用 `performance.now()`，是 airplay 子进程的单调毫秒域；Sendspin 的 `nowUs()` 用 `process.hrtime.bigint()/1000`，是另一套单调微秒域；两者都不是 Unix 时间。`buildServerTime()` 发送的是 `nowUs()` | 统一 host-monotonic µs 时钟；RAOP 的 NTP 直接由同一时钟构造；禁止 Unix/Date.now 参与锚点 |
| `latencyFrames` 归零 | `latencyFrames` 是接收端播放保持深度，不是 Sendspin 启动 lead。RECORD 返回更大的 `Audio-Latency` 时还会抬高；现有测试已锁定不能归零。归零会破坏 RTP↔NTP 映射，造成恒定偏移或欠载 | **保留 `latencyFrames`**，并把它纳入锚点公式：`startNtp = NTP(anchorUs - latencyUs)` |
| `D4 = scalePcm 数据缩放` | 当前 `offloadsVolume()` 恒 true、`appliedGain()` 恒 100，PCM 恒 unity；响度 100% 由设备输出级负责 | 桥接成员同样走设备侧音量：`setAirPlayVolume` / `setAirPlayMuted`；PCM 不缩放 |
| `members: Set<SendspinConnection>` 改成 `Set<GroupSink>` | 真实使用面远超原接口：`clientWantsStream`、`sendJson`、`sendPlayerCommand`、`legacy`、`muted`、`sinkHealth`、`lastBufferedAmount`、`announceStream`、状态上报、晚加入 ring 等。大范围改型会威胁 51 个 sendspin 测试文件 | **保留 `members` 原样**；新增独立 `bridges: Map<string, AirPlayBridgeMember>`，只在 `pushFrame` 的 `pcm:100` 编码组中并行投递 |
| 三进程里由 sendspin 子进程调用 `AirPlaySender.start()` 并等待 ack | `AirPlaySender` 与 RAOP 会话都在 airplay 子进程，跨进程无法 await 同一对象；原方案未定义调用者、ack 返回路径、流代次 | **airplay 子进程持有 bridge session**，收到首帧后自行决定锚点并启动；sendspin 只送 PCM 与边界帧，不问 ack |
| 帧格式 `[u32 len][i64 tsUs][payload]` | 缺协议版本、帧类型、流代次、序号；seek/切歌后的旧帧可能污染新流 | 28 字节头：magic/version/type/flags/generation/sequence/tsUs/payloadLen |
| `sendAudio(): void` 返回 false 就“暂停该成员投递” | `sendAudio` 是同步接口，无法暂停 `pushFrame`；组泵不能为单个 AirPlay 成员停摆 | 每桥独立有界队列 + 独立 drain；溢出按策略断开并重连，不阻塞组泵 |
| Phase 2b 后再做锚点/节流 | 锚点和节流是发送驱动的组成部分，先做“旧墙钟出声”再做“时间线移交”会重写同一段代码两遍 | 先建立正确的 bridge session 骨架，再一次性接入锚点/节流；出声验证用不含同步判据的中间态 |
| Phase 5 “先 NTP，PTP 以后再说” 可覆盖 AP2 buffered | AP2 buffered stream（type 103）依赖 PTP；NTP 只适用于 realtime stream（type **96**，注①）。MA 还记录部分 Apple 接收端在 NTP realtime 下无声 | Phase 6 只做 AP2 realtime+NTP；buffered+PTP 独立 Phase 7，另立验收门禁 |

### 0.2 第六轮已完成的实机修复

| 项 | 状态 | 证据 |
|---|---|---|
| AP2 接收端入口 | **已修复** | `/tmp/ap2recv/ap2-receiver.py` 原为 0 字节；从 `/root/ap2bed/ap2-2/ap2-receiver.py` 反解 PI/端口后恢复为 1484 行，`py_compile` 通过 |
| AP2 床可启动 | **已验证** | `ap2_bed.sh start 1` 后 7200 LISTEN，日志 `mDNS: service registered` / `serving on 192.168.10.230:7200`。**注**：接收端 `GET /info` 当前不响应 🟡 —— 不影响，发送端就绪探针改用 RTSP `OPTIONS`/`SETUP`，不以 `/info` 为判据 |
| 假 Sendspin 回调 | **已修复并上传 230** | aiosendspin 10.2.1 实际签名 `callback(timestamp_us, payload, audio_format, send_ahead)`；`/root/fake_sendspin.py` 已改四参数，sha256 `0c4e88a5...`，`--probe` 可构造 client |
| NumPy | **已安装** | `/root/ssvenv` 内 numpy 2.5.4，可运行 FFT/互相关脚本 |
| 假设备真实配对收流 | **未验证** | 230 无 38927/46400 监听，当前无 MusicFlow 服务；Phase 0 仍是门禁 |
| AP2 发送端 | **未实现** | `airplay/ap2/` 为空目录；cliairplay 只有二进制，不能作为源码参考 |

**纪律**：本文所有“已验证”必须对应一条命令或文件行；没有证据的写“待验证”。源码行号会漂移，以符号名为主、行号为辅。

> **注①（Phase 6b 批 4 实测校正，2026-10-25）：AP2 realtime stream type = 96，不是 102。**
> 依据（可复跑）：`sed -n '1,30p' /tmp/ap2recv/ap2/connections/stream.py` → `REALTIME = 96` / `BUFFERED = 103`；我方 `ap2Stream.ts` 按 96 发 `/stream` 时床侧 `Stream.__init__` 进入 `AudioRealtime` 并落盘解码（30s 双音实测），非 96 会走 buffered 分支。早期文档写的 102 无任何实现或接收端源码支撑，已全量更正为 96。**RAOP（AP1）与 AP2 realtime 共用 96，区别只在 `encryption` 与音频封装**（RAOP=`none`，AP2 realtime=`alac-chacha`），因此 `streamType` 不能单独区分协议。
> ⚠️ 代码侧现状：`backend/src/services/airplay/ap2/ap2Stream.ts:38` 已是 `AP2_REALTIME_STREAM_TYPE = 96`；但 `backend/src/services/airplay/rates.ts:102/108` 的文档型协议矩阵仍写着 `streamType: 102`（该字段全仓零引用、纯文档性质），**待批量修正为 96**（已登记为 6b 收尾小项）。

### 0.3 第七轮终审（red team）修正索引

> 终审报告：`审查报告-AirPlay桥接终审-2026-10-25.md`（305 行，抽查事实 34 条：✅26 / ❌4 / ⚠️4）。
> 结论：**架构骨架全部成立**（并行 `bridges`、`latencyFrames` 不归零、`(A−L)+L=A` 数学自洽、单一 host 时钟、net 二进制通路、hardCap 断连），但**验收链本身是断的**，且 seek / 摘除最后一个 Sendspin 两个高频生命周期的机制与源码不一致。

| 编号 | 问题一句话 | 本文修在哪 |
|---|---|---|
| BLK-01 | `pushFrame` 分组只由 `members` 构建 ⇒ 只有桥时 `pcm:100` 组不存在，返回 0 → 5s 后放弃本曲 | §2.1、§6.2、§8 P3、§9⑨ |
| BLK-02 | seek 不经过 `timelineReseed`（只在 `rehost()` 自增）；seek 走完整重建且不传 bridge | §4.3、§5.4、§6.2、§8 P5、§9⑩⑪ |
| BLK-03 | 1kHz 正弦周期 1ms，无法测 20ms 级 Δ；`quality` 恒≈1 | §8 Phase 0、§10.2（窄带源检测） |
| BLK-04 | AP1「设备实际播放的 PCM」无定义；发送端落盘算 Δ 恒≈0 | §8 Phase 0（arecord 抓取链）、§10.1 |
| MAJ-01 | 把 bridge lead 并进 `commonSendAheadUs()` 会让全组时间戳 +3.7s，并让 D4 三层永久失效 | §3.4、§6.2、§8 P3、§9⑧ |
| MAJ-02 | 两份文档 D2/D4 指代不同决策 | 《落地方案》§0 加映射表 |
| MAJ-03 | 两套 Phase 编号并存且出口错位 | 《落地方案》§4 加映射表 |
| MAJ-04 | 验收矩阵仍以 AP2 为桥接对象；`cc_align.py` 未落盘 | §6.1、§10.2 |
| MAJ-05 | socket 路径 `sun_path` 108B 上限，旧命名必超 | §4.1 |
| MAJ-06 | 桥会话会被 `stopAirPlaySessionsForHost` 连带杀掉 | §5.5、§9 |
| MAJ-07 | prepare 失败 ⇒ 设备既不 bridge 也不 cast，且无提示 | §4.1（degraded 降级） |
| MAJ-08 | `delta` 无定义 ⇒ "稳定"不可断言 | §10.5 |
| MAJ-09 | 漏了 `baseTs` ⇒ `positionSec` 变垃圾且不报错 | §3.3 |
| MAJ-10 | 时钟纪元改 host 后 `ntp2ts` 越过 2^32 | §3.3、§8 P1、§9⑫ |

Minor/Nit 已直接修入正文：群延迟 0.3627ms 与符号（MIN-01）、`nowUs` 真实位置 `sendspin/clock.ts`（MIN-02）、`:289` 是初值不是 max（MIN-03）、协议四档枚举（MIN-04）、队列按 48k 口径（MIN-05）、曲末排空副作用（§3.4 末）、判据补阈值（MIN-07）、阈值分档（MIN-08）、`stopSession` 波及面（§5.5）、Phase 6a（MIN-10）、多桥并发（§11 #12b）、互相关单一实现（NIT-01）、AP2 `/info` 表述合并（NIT-02）、守卫合并（NIT-03）、目录以本文为准（NIT-04）、基线日期（表头，NIT-05）。

### 0.4 复验（第二轮）修正索引

> 复验报告：`审查报告-AirPlay桥接终审-复验-2026-10-25.md`（99 行）。7 处修法：3 PASS / 3 部分成立 / 1 FAIL，**未引入新 Blocker**。
> 总判：**可进入 Phase 1 开发**；R1 必须进 Phase 3 门禁，其余可在实现前顺手改。

| 编号 | 级别 | 问题 | 修在哪 |
|---|---|---|---|
| **R1** | Major（**事实错误，主理人引入**） | 我写"`rehost()` 经 `stop()` 自增 `epoch`"不成立 —— `:1270-1299` 全文无 `this.epoch`、不调 `stop()`，只自增 `timelineReseed`。后果：借流移交时桥不重锚。**且绝不可给 rehost 加 `epoch++`**（会让 `:759` 的 `while(...epoch===myEpoch)` 立刻退出，移交变停播） | §4.3（代次改二元组 + 钩子挂 `:813`）、§5.2 rehost 行、§5.4 seek、§9⑪ |
| R2 | Major | `coldStart` 全文只出现一次、无来源 | §3.4（`CONFIG` 回执带 `warm`，`bridgeStartLeadUs()` 取各桥 max，无回执按 cold） |
| R3 | Minor | 落地方案 `0.33ms` 与本文 `0.3627ms` 不一致 | 落地方案 §3.1 表 B、Phase 1 |
| R4 | Minor | 截断/对齐**顺序**未写、`& 0xFFFFFFFF` 是陷阱 | §3.3（先 `>>> 0` 再 `% CHUNK_LEN`；`2^32 % 352 = 224 ⇒ 顺序反了残 32`） |
| R5 | Minor | "禁止 `raop.seek()`" 指向**不存在的方法** | §3.3、§5.4、§6.2（改 `prepareSeek()` / `setStartPosition()` / cast `seekSec`） |
| R6 | Minor | owner 字段落点未给、旁路未封 | §5.5（`ActiveSession` 加 `owner`；封 `protocolPlayer.ts:54`） |
| R7 | Minor | BOUNDARY 语义边界未写 | §4.3（只清队列+换代次，不 TEARDOWN；`notifyGeneration` 挂投递路径不用定时器） |
| R8 | Nit | Phase 0 出口顺序、`cc_align.py` 应提前到 P0、晚加入用例限定 | §8 Phase 0、§11 #9 注 |

**复验确认成立、开发时不要动**：`encoderKey("pcm",100)` 确实产出 `"pcm:100"`；注入空 `members` 的虚拟组在 `flushAnnounceFor`/`scalePcm(100)`（`g>=1` 直接返回原数组，零拷贝）/`deliveredByGroup` 基线/`ringFor`/`pruneRecent` 五处**全无害**；`before` 插前插后等价（`groups.set` 不碰 `deliveredPeak`）；`baseTs` **只有** `positionSec` 与 `seekStartTs` 两处消费（**无第三处**）；`sun_path[108]` 与 `ENAMETOOLONG` 均已 header/man 证实，路径实测 26B、余 82B；`shairport-sync.conf` 的 `output_device="hw:Loopback,0"` **真实存在**，`arecord -D hw:Loopback,1` 正是对侧。
>
> ⚠️ 复验还提示两条实现注意：① 虚拟组会进 `meterBytes` 计量，**只有桥**时 `encodedBytesPerSec` 变 192KB/s（这正是想要的，原来会回落成猜值）；② `raopPlayer.test.ts:116/335/627/967` 有 4 处硬编码 `anyP.baseTs`，改锚点语义要在**同一 commit** 同步。

---

## 1. 决策定案

| # | 决策 | 定案 | 推翻条件 |
|---|---|---|---|
| D1a | AP1 采样率 | 强制 44100；airplay 子进程内 48k→44.1k 有理数多相 FIR（L=147/M=160） | 有 AP1 设备实测接受 48k 且证明未内部重采样 |
| D1b | AP2 采样率 | 以 SETUP 协商为准；48k 优先，失败回落 44.1k。不得把“AP2 必 48k”写死 | 接收端 `/info` 与 SETUP 能力矩阵实测推翻 |
| D2 | 时钟与时间戳 | **host-monotonic µs 是唯一内容时间轴**。Sendspin `tsUs` = 首样本应可听时刻。RAOP NTP 由同一 host 时钟构造 | 跨机播放（非本方案范围） |
| D3 | 数据面与所有权 | 三进程：主进程只编排；sendspin 子进程产 PCM；airplay 子进程持有 bridge session、重采样、对齐、节流、RAOP 输出。PCM 不经主进程 | 管道吞吐实测不足 |
| D4 | 延迟分层 | 启动 lead、持续缓冲、接收端 latency **三层分离**。桥成员上报 cold 4500ms / warm 2500ms / 持续 1000ms；RAOP `latencyFrames` 保留并进锚点公式 | 接收端实测要求不同 lead，按设备矩阵调整常量 |
| D5 | 音量 | 设备输出级音量，PCM unity。复用 `setAirPlayVolume` / `setAirPlayMuted` | 用户要求 PCM 独立增益（会与设备音量相乘，需另设计） |
| D6 | 分派与生命周期 | 每个“播放流”开始时快照路由：在线 Sendspin 成员 >0 且在线 AirPlay 成员 >0 ⇒ AirPlay 走桥接；纯 AirPlay ⇒ 旧逐设备 cast。流内不切路由 | 实测需要无缝热切换 |
| D7 | AP2 | 后置且拆分：realtime+NTP 先做；buffered+PTP 单列。AP2-only 发现需同步改 discovery/测试/守卫 | 有必须 buffered 的设备 |
| D8 | 锚点“ack” | 自研 RAOP 无设备级 START ack。**禁止伪造 ack**。对外只报告“本地实际写入的 RTP↔NTP 映射”；字段名 `scheduledAnchorUs`，不叫 `acked` | 引入可读取设备确认的协议路径 |
| D9 | 灰度 | `MUSICFLOW_AIRPLAY_BRIDGE=1` 默认关；flag 关 = 完整旧路径 | 无 |

---

## 2. 目标架构

```
主进程（路由 / DB / 组归属 / 会话编排；不传 PCM，不跑节拍）
  │  bridgePrepare(deviceId, socketPath, sessionToken)
  │  bridgeStop(deviceId, sessionToken)
  │  groupPlay(..., bridge:{sockets:[...]})
  ▼
┌───────────────────────────────────────────────┐   ┌──────────────────────────────────────────────┐
│ sendspin 渲染子进程（25ms 泵 / WS 38927）       │   │ airplay 渲染子进程（RAOP 7.98ms 节拍）        │
│                                               │   │                                              │
│ SendspinGroup                                 │   │ BridgeServer（每 session 一个 listener）      │
│  ├─ members: Set<SendspinConnection>（不动）   │   │   └─ BridgeSession                           │
│  └─ bridges: Map<deviceId, BridgeMember>       │   │        ├─ 帧解析 / generation / 有界队列      │
│       ├─ 独立有界队列                           │   │        ├─ 重采样 48k→44.1k                    │
│       ├─ 帧头 + 序号 + generation               │   │        ├─ 时间线对齐（补静音/裁头）            │
│       └─ net 客户端 ──────────────────────────┼──▶│        ├─ RTP↔NTP 锚点                        │
│                                               │   │        └─ RaopSender（bridge 驱动路径）       │
│ pushFrame → 编码组 pcm:100 → 同时投递 bridge   │   │                                              │
└───────────────────────────────────────────────┘   └──────────────────────────────────────────────┘
```

### 2.1 为什么不把 bridge 塞进 `members`

`SendspinGroup.members` 的语义是“真实 WebSocket 设备集合”，被以下路径直接使用：

- `broadcastGroupState`：`members.map(m => ({client_id:m.clientId}))` 会把 AirPlay 设备暴露成 Sendspin 组员。
- `syncVolume` / `syncVolumeTo`：会调用 `sendPlayerCommand`，桥成员没有 WS 命令通道。
- `sinkHealth` / `lastBufferedAmount`：基于 WS `bufferedAmount`，桥成员没有这个字段。
- `keepStreamForLegacy` / `clearPlayback` / `finishPlayback`：会调用 `sendJson("stream/clear"|"stream/end")`。
- 晚加入 `ringFor`：按 `(codec,gain)` 编码组共享，直接塞入桥成员会改变组语义。
- 51 个 sendspin 测试文件大量以 `SendspinConnection` 的字段/方法构造桩。

因此采用**并行 bridge 集合**：

- `members` 完全不动，旧路径零行为变化。
- `pushFrame` 在编码组循环里额外把 `pcm:100` 的字节投给每个 bridge。
- bridge 不参与 `server/state` 的成员列表、不参与 legacy 判定、不参与 WS sink 自愈。
- bridge 的启动 lead **只在 `streamEngine` 的 `anchorLead` 里用**，**绝不并入 `commonSendAheadUs()`**（原因见 §3.4）。
- bridge 的晚加入回填复用 `ringFor("pcm:100")`，不新建一套 ring。

#### 🔴 BLK-01：必须先在 `pushFrame` 入口补一个虚拟 `pcm:100` 组

`pushFrame` 的编码分组**只遍历 `this.members`**（`server.ts:1129-1140`）：

```ts
for (const c of this.members) {                 // ← 只有真实 WS 成员
  const gain = c.appliedGain();
  const key = this.encoderKey(c.codec, gain);   // "pcm:100"
  ...
}
```

由此产生两个必然后果（第七轮终审实测）：

1. **组内没有任何 `codec=pcm 且 gain=100` 的真实成员时，`groups` 里根本没有 `"pcm:100"` 这一项** ⇒ 循环体不进入 ⇒ 桥拿不到一个字节。
2. **`deliveredPeak` 靠组的 `sum` 推进**（`server.ts:1189-1205`）；无组 ⇒ `peak === before` ⇒ `return 0`。
3. `return 0` 会被 `streamEngine` 判为「编码器零产出」：`STALL_GRACE_US=500_000` 后降级推进，`maxSilentDegradeUs()` 默认 5000ms 后直接 `编码器持续零产出…放弃本曲提前切歌`（`streamEngine.ts:225`、`:929-936`）。

⇒ **强制实现（写进守卫）**：`pushFrame` 在建完 `groups` 之后、进入循环之前插入

```ts
// 桥接解耦：桥成员不是 WS 成员，但 pcm:100 组的编码必须照常发生，
// 否则「只有桥、没有真实 pcm 成员」时本函数返回 0 → 上游判零产出 → 放弃本曲。
if (this.bridges.size > 0 && !groups.has(this.encoderKey("pcm", 100))) {
  groups.set(this.encoderKey("pcm", 100), { codec: "pcm", gain: 100, members: [] });
}
```

这带来一个必须同时满足的性质：**`pcm:100` 组的编码/`ringFor`/`deliveredPeak` 推进与"是否存在真实成员"完全解耦**。因为 `g.members` 为空时，内层 `for (const c of g.members) c.sendAudio(...)` 自然不执行，而 `sum`/`bytes`/`ring.push` 仍照常发生 —— 桥的投递点就挂在这个组的循环体里（见 §6.2）。

> **回归用例（必须进单测）**：`members = ∅` + 1 个 bridge 时调用 `pushFrame`，断言 ① 返回值 `> 0`；② 该 bridge 收到字节；③ `ringFor("pcm:100")` 长度增长。这条用例不通过，Phase 3 的"出声"必然是假绿。

这样只改 `pushFrame`、`clearPlayback`、`finishPlayback`、组创建/销毁几处，风险远小于改 `members` 类型。

---

## 3. 时钟、锚点与发送公式

### 3.1 统一时钟

新增 `backend/src/utils/hostClock.ts`：

```ts
import { hrtime } from "node:process";

export const nowUs = (): bigint => BigInt(hrtime.bigint() / 1000n);

/** host-monotonic µs → 32.32 NTP。epoch 任意，只消费差值。 */
export function ntpFromHostUs(us: bigint): bigint {
  const sec = us / 1_000_000n;
  const rem = us % 1_000_000n;
  const frac = (rem << 32n) / 1_000_000n;
  return (sec << 32n) | frac;
}
```

- `sendspin/clock.ts` 的 `nowUs` 改为从 `utils/hostClock.ts` re-export；保留 `setNowUsOverride` 仅供测试。
- `airplay/raop.ts` 的 `ntpNow()` 改为 `ntpFromHostUs(nowUs())`；删除 `performance.now()` 版本。
- 同一宿主机上 `process.hrtime.bigint()` 跨进程同源（Linux `CLOCK_MONOTONIC`；Windows QPC），因此 sendspin 的 `tsUs` 与 RAOP 的 NTP 可直接比较。
- **禁止**在锚点链路使用 `Date.now()` / `Unix ms` / `performance.now()`。它们只允许用于日志耗时和 UI 时间戳。

### 3.2 时间戳语义（已核实）

aiosendspin 10.2.1 `client.py:1328` 明确：

> `server_timestamp_us`: Server timestamp when this audio should play.
> `send_ahead`: ... **Never affects when the chunk plays.**

因此：

- `tsUs` 是**首样本应可听的 host-monotonic 时刻**。
- `send_ahead` 只表示服务端提前多久发出，不参与播放时刻计算。
- `compute_play_time()` 会再减去设备 `output_delay`，那是设备自身输出链路延迟；手机/ESP32 的 `output_delay` 与 AirPlay 接收端 latency 是两套独立量。

### 3.3 RAOP 锚点公式（四个字段，不是三个）

定义：

- `A`：本次 bridge 流的**可听锚点**（host µs），对应第一个被写入的样本。
- `L`：`latencyFrames / sampleRate`（接收端播放保持深度）。
- `B`：RECORD 后选定的 RTP base（32 位回绕安全，实际只用局部差值）。
- `rtp(t) = B + round((t - A) * rate / 1e6)`。

设置（**四个字段必须一起写**）：

```ts
baseTs   = B;                       // 🔴 漏了这个，positionSec 立刻变垃圾（见下）
startTs  = B;                       // 本次流内容起点
headTs   = B;                       // 每发一包按真实样本数推进
startNtp = ntpFromHostUs(A - L);    // 关键：映射时刻比可听时刻早一个 L
```

> **🔴 MAJ-09：`baseTs` 不能忘。** `raop.ts` 实际有四个锚点字段（`:272-284`）：`headTs` / `startTs` / `startNtp` / `baseTs`。进度是这样算的（`:694-695`）：
> ```ts
> this.headTs = (this.headTs + CHUNK_LEN) >>> 0;
> this.positionSec = ts2ms((this.headTs - this.baseTs) >>> 0, this.opts.sampleRate) / 1000;
> ```
> RECORD 时 `baseTs = startTs = headTs`（`:598-603`，三者同一个数）。桥接若只改 `startTs` 而把 `baseTs` 留在 RECORD 的值，`(headTs − baseTs)` 会指向完全错误的内容位置 ⇒ `getAirPlayStatus`、进度上报、曲末判断全部错乱。
>
> **同时禁止**在 bridge 路径上触发 RAOP 侧的位置重锚。⚠️ **注意：`RaopPlayer` 上并没有 `seek()` 方法**（别把守卫写成 `raop.seek()`，那样永远匹配不到）。真实入口是三个：
> - `prepareSeek()`（`raop.ts:842`，唯一调用者 `control.ts:1015`）
> - `setStartPosition()`（`raop.ts:868`，调用者 `control.ts:456`、`sessionRuntime.ts:161`）
> - `sessionRuntime.cast()` 的 `seekSec` 通道
>
> 这三个都会把 `startTs` 重锚成 `baseTs + seekSec*rate` 而 `startNtp` 不动（`:846`、`:869` 的 `seekStartTs(baseTs, …)`），映射当场崩掉 —— 这正是 2026-10-21 那次「拖动进度后彻底无声」的成因，`raop.ts:274-283` 的注释里写着原始日志（`31.08 seconds ahead` / `crazy time interval of -30.08 seconds`）。
>
> **与现有路径不冲突**：bridge 会话由 `bridgePrepare` 建，不走 cast 链；组 seek 走 `fanOut("seek")`（`group/protocolPlayer.ts:181`），§5.4 的 fanOut 跳过已覆盖。

为什么是 `A - L`：

- `sendSync()` 当前公式是 `ntp = startNtp + (headTs - startTs)/rate`（`:731-733`）。
- 接收端把该 SYNC 当作“当前播放头”的 RTP/NTP 对，并在 RTP 头再减去 `latencyFrames`（`:727`，offset 4 = `headTs − latencyFrames`）。
- 因此首包 `headTs` 的可听时刻 = `ntp(headTs) + L = (A - L) + L = A`。
- 若把 `startNtp` 写成 `A`，首包会恒定晚 `L`（约 1s）。
- 若把 `latencyFrames` 归零，接收端保持深度被破坏，会欠载/抖动。

> **这条推导的成立前提（缺一不可，都是第七轮补的）**：
> 1. `baseTs` 与 `startTs` 同域同值（上一段 MAJ-09）；
> 2. 四个锚点在同一 32 位模域（见下 MAJ-10）；
> 3. RECORD 的 `headTs -= headTs % CHUNK_LEN` 向下对齐（`:600`）会引入 **0~7.98ms** 偏斜，且 `startNtp` 取的是**对齐前**的 `ntp0`（`:603`）—— 桥接覆盖锚点时四个字段要按同一套算术重算，不能只替换其中两个。
> 4. 接收端确实把 offset 4 的 `rtp_timestamp_latency` 解释为“当前播放头 RTP”。**这条目前只有推导、没有实测**（230 上 `/tmp/ap2recv/ap2/airplay1.py` 未实现 sync 包处理，shairport 只有二进制）。**唯一能证伪它的手段是与 `cliairplay` 同源 A/B**：cliairplay 不做 `A−L` 补偿，若我们的映射错了一整个 `L`，A/B 会直接暴露 ≈1s 的差。见 §10.4。

> **🔴 MAJ-10：改成 host 时钟后必须显式 `>>> 0`。** 原 `ntpNow()` 用 `performance.now()`，纪元是**进程运行时长**（通常几小时）；改成 `hrtime` 后纪元变成**机器开机时长**。`ntp2ts()` 是 `Number(((ntp >> 16n) * BigInt(rate)) >> 16n)`（`:93-95`），**没有做 32 位截断**：
> - 44.1k 下 `2^32 / 44100 ≈ 97391s ≈ 27.05h`；48k 下 ≈ 24.9h。
> - 越界后 `RECORD` 写进 `RTP-Info: rtptime=<13 位十进制>`（`:604`）会发一个 >2^32 的数给接收端，靠对方按 uint32 截断才"没事"。
> - 现有代码靠 `(headTs − startTs) >>> 0` 的**模运算**侥幸自洽（本报告已验算：`((S+352) mod 2^32 − S) mod 2^32 = 352` ✓），但这是**隐式不变量**，桥接新写的 `rtp(t) = B + round(...)` 必须落在**同一个模域**，否则立刻错。
>
> ⇒ 实现要求：
> 1. **顺序写死**：先截断、再对齐。
>    ```ts
>    let headTs = ntp2ts(ntp0, this.opts.sampleRate) >>> 0;   // ① 先 ToUint32
>    headTs -= headTs % CHUNK_LEN;                             // ② 再对齐到 352 整数倍
>    this.baseTs = this.startTs = this.headTs = headTs;        // ③ 三者同值
>    ```
>    顺序反了会残 32：`2^32 % 352 = 224`，实测"先对齐后截断"残 **32**（对齐被破坏）、"先截断再对齐"残 **0** ✓。
> 2. **只能用 `>>> 0`，不能用 `& 0xFFFFFFFF`**：`ntp2ts` 返回非负数，但 `&` 是 ToInt32 —— 在 `0xFFFFFFFF` 处 `>>> 0` 得 `4294967295`、`& 0xFFFFFFFF` 得 **`-1`**；负数会让 `headTs % CHUNK_LEN` 得负余数，352 对齐当场失效。
> 3. 桥接的 `B` 明确取 `B = 上面三步之后的 headTs`。
> 4. **补单测**：把 `setNowUsOverride` 推到 `sec = 100_000`（>27h）跑完整 RECORD + `sendChunk` + `sendSync`，断言 `positionSec` 与 `elapsedTs` 仍正确、`headTs % 352 === 0`。

发送节拍：

```ts
audibleAt(t) = A + (sentSamples / rate) * 1e6;
sendAt(t)    = audibleAt(t) - L - SAFETY_MS;
```

- 发送器在 host 墙上等到 `sendAt(t)` 再写包；不得收到 PCM 就立即倾倒。
- `SAFETY_MS` 建议 50ms，吸收 25ms 泵抖动和 socket 调度。
- 当 `sendAt(t)` 已过期：记 `latePackets`，追发但不改 RTP 映射；连续过期说明 lead 不足，重锚或报警。
- 当 `A - L - SAFETY < now`：本次锚点不可达。取 `A = max(now + warmLead, firstFrameTs)`，跳到该时刻对应内容（丢弃更早的帧），不得把第一条迟到帧硬塞成开始。

### 3.4 启动 lead / 持续缓冲 / 接收端 latency

| 层 | 值 | 从哪进系统 | 作用 |
|---|---|---|---|
| 冷启动 lead | 4500ms | **只进 `streamEngine` 的 `anchorLead`**（`bridgeStartLeadUs()`） | 覆盖 RAOP 连接 + RECORD + 首包映射时间 |
| 热启动 lead | 2500ms | 同上 | 已连接会话 flush-refill，省去连接预算 |
| 持续 min buffer | 1000ms | bridge 成员的 `minBufferMs`（进 `commonSendAheadUs`） | 组泵持续供应下限 / 晚加入目标 |
| RAOP 接收端 latency | 默认 1s，RECORD 可抬高 | `raop.ts` 内部 | 设备缓冲保持，**进锚点公式，不进组 lead** |
| 预填充 buffer | 现有配置（默认 3s） | streamEngine | 组泵尽快灌满设备缓冲，不等于启动 lead |

#### 🔴 MAJ-01：启动 lead **不得**并入 `commonSendAheadUs()`

旧稿写的是「bridge 上报 `{requiredLeadTimeMs: 4500|2500, minBufferMs: 1000}`，lead 单独并入 `commonSendAheadUs()`」。**这条必须废掉**，理由有三，全部有源码依据：

1. **帧头里根本没有 `send_ahead`。** `sendAudio` 的头是 **9 字节**（1B type + 8B 微秒时间戳），`server.ts:2380-2382` 注释原文：「帧头 = 9B(**不含 send_ahead**)。⚠️ 曾经这里多塞 4B send_ahead(13B 头)，设备把其当成 FLAC 数据前 4 字节 → 全无声」。真实设备判断"这包过没过期"用的是**它自己**的默认值（未协商时 800ms，`server.ts:1271-1272`）。
2. **所以并进去以后，全组时间戳被整体推到 4.5s，设备仍按 800ms 判** ⇒ `delta = (ts − 设备自己的 send_ahead) − now` 恒等于 **+3.7s**。`commonSendAheadUs()` 的源码注释（`server.ts:813-814`）明确要求它必须与帧头里的值**同源**，否则「设备会立刻判已过期 → underrun」。**照旧稿实现，会把一台正常工作的 ESP32 打坏。**
3. **`computeCommonSendAhead` 把两个语义合并成一个数**（`group.ts:76-92`：`lead = Math.max(minBuffer, requiredLead)`）。一旦并入 4500，`max` 恒取 4500 ⇒「热启 2500 / 持续 1000」这两个档位**永远不可能出现**，D4 的三层分离自动失效。

⇒ **定案（写进守卫）**：

```ts
// group.ts 的 computeCommonSendAhead 保持原样，桥成员只上报 minBufferMs=1000。
// 启动 lead 是"这一次起的锚点提前量"，不是"本组公共 send_ahead"，两者不能混。

// 🔴 R2：冷/热是 airplay 侧的事实（只有它知道该设备有没有"已完成 RECORD、
//    可直接 flush-refill"的会话），所以不能由 sendspin 侧猜。
//     来源链：airplay 侧 bridgePrepare 的 CONFIG 回执带 warm:boolean
//            → BridgeMember 存 this.warm
//            → 本函数取所有桥的最大值（保证最慢那台也够用）
//            → 未收到回执前一律按 cold（保守）
bridgeStartLeadUs(): number {
  if (this.bridges.size === 0) return 0;
  for (const b of this.bridges.values()) {
    if (!b.warm) return 4_500_000;      // 任一台是冷启 ⇒ 整组按冷启取
  }
  return 2_500_000;                     // 全部热启
}
```

- `CONFIG` 帧的 payload 扩展为 `{deviceId, protocol, rate, channels, format, sessionToken, warm: boolean}`；`warm=true` 的含义严格限定为"该设备存在可复用的、已完成 RECORD 的 RAOP 会话"。
- **只影响 `anchorLead`，不影响 `commonSendAheadUs()`。**

`commonSendAheadUs()` 的 3 个消费者（`streamEngine.ts:835` 锚点、`server.ts:1272` `seedLateJoin` 晚加入目标、`playerCore.ts:875` 播报）**全部不变**；桥的启动 lead 只作用在下面这一处。

必须同时修改 `streamEngine.pushLoop` 的预填充钳制：

```ts
const hasBridge = this.group.hasBridges?.() === true;
const anchorLead = hasBridge
  ? Math.max(aheadUs, bridgeStartLeadUs())            // 不能用 800ms 截断
  : (prefillEnabled() ? Math.min(aheadUs, ANCHOR_SAFE_LEAD_US) : (reseed ? reseedLead : aheadUs));
```

否则桥成员上报 4500ms 仍会被 `ANCHOR_SAFE_LEAD_US=800_000` 截成 800ms，这是旧方案"上报即获得冷启动窗口"不成立的原因。

> **`ANCHOR_SAFE_LEAD_US` 的三个消费点已全部核验**（第七轮）：
> - `:846` `Math.min(aheadUs, ANCHOR_SAFE_LEAD_US)` —— **这一处是真正的钳制**，必须按上面的三元分支绕过；
> - `:1028` `targetUs > ANCHOR_SAFE_LEAD_US` —— 是预填充**使能门**，不是钳制，不动；
> - `:1082` `(cursorUs − nowUs() − ANCHOR_SAFE_LEAD_US) / 1000` —— 是**曲末排空量**，不是钳制。但它会让 bridge lead=4.5s 时的曲末等待从 ~3s 变成 ~3.7s+（切歌静默变长）。**这个副作用接受并在 Phase 5 记录**；若用户反馈切歌间隙变长，再改为按 `bridgeStartLeadUs()` 计算。

> **回归用例（必须进单测）**：纯 sendspin 组 + 1 台 bridge 同时在线，真实设备侧 `delta = (ts − 800ms) − now` **不得**出现常数 +3.7s 偏移。这条用来防止有人后来又把 lead 并进 `commonSendAheadUs()`。

### 3.5 无 ack 的诚实语义

自研 RAOP 没有 cliairplay 的 `[STATUS] started` 输出。桥接不得伪造：

```ts
type BridgeAnchorReport = {
  scheduledAnchorUs: bigint;   // 实际写进 startTs/startNtp 的 A
  commandedLeadUs: bigint;
  latePackets: number;
  mapping: "local-rtp-ntp";
};
```

日志字段写 `scheduled anchor=... late=...`，不写 `acked ... off the commanded instant`。MA 的 ack 对齐只作为算法参考，不能把 cliairplay 的行为当成我们已有能力。

---

### 3.6 🔴 硬性约束：切歌预取/完整性判定语义不变（用户锁定，不可协商）

桥接群组的选歌与推进路径必须与现有 sendspin 群组**完全一致**：

- **第一首**：直接起播（现行 head-wait/TTFB 行为不变）。
- **第二首起每首**：必须预下载进内存并经 `prefetchCache.judgePrefetchedBuffer` 完整性判定；不完整 ⇒ `markUnplayable`（TTL 5min）⇒ 跳过/组内换源（上限 3）。
- **桥（AirPlay 成员）只是组泵 PCM 的旁路接收者**：预取、判完整、跳过、换源全部发生在上游（streamEngine/prefetchCache），桥不得参与、更不得引入绕过这些逻辑的第二条选歌路径。Phase 2 的通道层（bridgeChannel/bridgeServer/bridgeMember）不得包含任何选歌/预取语义。
- 落点：Phase 3 的 `pushFrame` 桥接投递是纯数据面；出口判据见 Phase 3 清单中「切歌预取语义不变」条目。

---

## 4. 数据面协议

### 4.1 会合

- 每设备每流一个 socket。**路径必须短**：Linux `sockaddr_un.sun_path` 上限 **108 字节**，超了 `bind(): ENAMETOOLONG`，而且是"每台桥都建不起来"这种全量故障。
  - ❌ 不要写 `os.tmpdir()/mf-apbridge-<deviceId>-<sessionToken>.sock`：deviceId 若是 36 字符 UUID、token 若用 64 hex ⇒ 约 **133 字节，必然失败**。
  - ✅ 定为 `<tmpdir>/mfab/<11 字符 base36 hash>.sock`（hash = `sha1(deviceId + ":" + token)` 取前 11 位）。`deviceId` 与 `token` 只进 `CONFIG` payload，**不进文件名**。
  - `bridgePrepare` 前断言 `Buffer.byteLength(socketPath) < 100`，否则直接抛。
  - Windows 用 `\\.\pipe\mfab-<hash>`。
- airplay 子进程 `listen`，sendspin 子进程 `connect`。
- 主进程生成 `sessionToken`，先后下发：
  1. airplay `bridgePrepare(deviceId, socketPath, token, protocol)` → 返回 `listening:true` **且必须带握手结果**（见下）。
  2. sendspin `groupPlay(..., bridge:{sockets})` → 子进程连接并启动泵。
- **`prepare()` 的返回值必须描述握手，不能只报 `listening`**：
  ```ts
  type PreparedBridge = {
    listening: true;
    handshake: { announce: number; setup: number; record: number };  // RTSP 状态码
    rate: number;                       // SETUP 协商结果，写日志，不假定 48k
    latencyFrames: number;              // RECORD 的 Audio-Latency（可能被抬高）
    socketPath: string;
  };
  ```
  只有 `announce/setup/record` 全 2xx 才算 `PreparedBridge`；否则返回 `{ok:false, reason}`。

#### MAJ-07：单侧失败的降级路径（必须有用户可见结果）

D6 规定"流内不切路由"，但 prepare 失败**发生在流已经开始之后**。照旧稿（"该设备不加入 bridge 路由，记录 `bridgeUnavailable`"）会得到最糟的结果：这台设备**既不 bridge 也不 cast**，用户在组里看得见它、它不出声、且没有任何提示。

定案：`bridgePrepare` 失败 ⇒ **该设备本流回落 solo cast**（`createAirPlayProtocolPlayer` 逐设备 cast，起点编进 `cast.startMs`），并在组状态里标 `degraded: {deviceId, reason}`。互斥由 §5.5 的 owner token 保证（bridge 失败时 token 未写入，cast 入口可正常抢）。

- 若**全部** AirPlay 设备都 prepare 失败 ⇒ 整组退回 `legacy-cast` 路由（等同 D6 的 legacy 分支），状态标 `route=legacy-cast(degraded)`。
- 三种结果都必须能在状态接口里区分：`bridge` / `legacy-cast` / `degraded`。**不允许"设备在组里但无声且状态正常"这种状态存在。**

### 4.2 帧格式（28 字节头，小端）

```
offset  size  field
0       4     magic = "MFAB"
4       1     version = 1
5       1     type: 1=AUDIO 2=BOUNDARY 3=CONFIG 4=HEARTBEAT 5=STATS
6       2     flags (bit0=keyframe / 保留)
8       4     generation (u32，每流/每次 seek 自增)
12      4     sequence (u32，同一 generation 内自增)
16      8     tsUs (i64，仅 AUDIO 有效)
24      4     payloadLen (u32，上限 1 MiB)
28      N     payload
```

- `AUDIO` payload：`s16le / 48000 / 2ch`。
- `CONFIG` payload：UTF-8 JSON `{deviceId,protocol,rate:48000,channels:2,format:"s16le",sessionToken}`。
- `BOUNDARY` payload：UTF-8 `{reason:"track"|"seek"|"stop"|"rehost"}`；`generation` 为新值。
- `HEARTBEAT`：接收端 2s 未收到任何帧即视为 stalled。
- 头长与 payload 长度均校验；非法 magic/version/长度立即断连，避免错位解析。

### 4.3 流代次与 seek（🔴 第七轮改正 + 复验修正：代次是 `(epoch, timelineReseed)` 二元组）

- 每次「新建播放上下文」都递增 `generation`：新歌起播、seek、rehost、bridge 重连。
- airplay 侧只接受当前 generation；旧帧直接丢弃，不参与对齐。

#### 为什么不能只用 `timelineReseed`

旧稿写的是「`streamEngine` 在 `reseed` 分支（`this.timelineReseed !== consumedReseed`）调用 `group.bridgeTimelineReset?.("seek")`」。**这条是错的**，实测依据：

- `timelineReseed` 全仓**只有一处自增**：`streamEngine.ts:1291`，位于 `rehost()`（泵移交）内。
- `seek()`（`streamEngine.ts:1213-1234`）**只写** `positionMs` / `reportedFloorMs` / `pendingSeekMs`，**从不碰** `timelineReseed`。
- seek 的真实路径是 `seekCore` → `pump.stop()` + `playGroupCore(...)` 走**完整重建**（`playerCore.ts:649-712`；`playGroupCore` 在 `:376-395` 内 `pump.stop()` → `pump.armSeek()` → `g.close()`），并且这条路径**不传 bridge 参数**（`playGroupCore` 是 6 参：`srv, groupName, memberIds, item, onPlayFailed, seekPositionMs?`）。

⇒ 照旧稿实现，**seek 后桥接既不换代次也不重新注册**，旧锚点配新时间戳 ⇒ 静音或错位。

#### 也不能只用 `epoch`（复验 R1 抓到的坑）

`streamEngine.ts:376` 有 `private epoch = 0`，`:360` 注释「epoch = 每次 play 自增，使旧的推流循环失效」，自增点：

- `:532` `const myEpoch = ++this.epoch;`（`play()` 入口）
- `:1179` `this.epoch++;`（`stop()`，注释"软停止…供 stop/切歌打断"）

seek 走 `playGroupCore → pump.stop()`（+1）→ `pump.play()`（+1），**必然换代** ✓。track 切换同理 ✓。

**但 `rehost()` 完全不自增 `epoch`** —— `:1270-1299` 全文无 `this.epoch`、不调 `stop()`，只做 `prev.timelineBaseUs=0n` → `this.group=next` → `timelineReseed++`。我上一版写"`rehost()` 经 `stop()` 自增 `epoch`"是**事实错误**，复验已证伪（`awk 'NR>=1260&&NR<=1305 && /epoch/'` 输出为空）。

⇒ 后果：借流移交（`handoverCore → transferPumpTo/rehost`）时桥看不到代次变化 ⇒ **不重锚，旧 `A` 配新组 `timelineBaseUs`** ⇒ 流转后永久错位。

#### 定案：二元组 + 单一钩子

```ts
// streamEngine.ts 新增只读访问器。
// 乘法混合而非加法：避免 epoch + timelineReseed 在两者交替自增时撞出同一个和
// （epoch=2,reseed=0 与 epoch=1,reseed=1 都会得 2）。1_000_003 取大于
// timelineReseed 实际取值范围的质数。
get generation(): number { return this.epoch * 1_000_003 + this.timelineReseed; }
```

**钩子只放一处**：`streamEngine.ts:813` 的现有重锚分支（一行判断都不用改）：

```ts
if (firstFrame || this.timelineReseed !== consumedReseed) {
  // 这里同时持有 myEpoch 与 this.group，天然覆盖 seek / track / rehost 三种情形，
  // 且避免 server.ts ↔ streamEngine.ts 的反向依赖（SendspinGroup 不持有 srv/pump）。
  this.group.notifyBridgeGeneration?.(this.epoch * 1_000_003 + this.timelineReseed);
  ...
}
```

`bridgeMember` 侧只在**投递路径**比对，不用定时器：

```ts
// sendspin/bridgeMember.ts —— 由 notifyBridgeGeneration 直接调用，不做反查
notifyGeneration(gen: number): void {
  if (gen === this.lastGeneration) return;
  this.lastGeneration = gen;
  this.clearQueue();                 // BOUNDARY 语义=清队列+换代次，不 TEARDOWN
  this.sendBoundary("track", gen);
}
```

- **🔴 禁止给 `rehost()` 加 `this.epoch++`**：`:759` 的推流循环是 `while (this.running && this.epoch === myEpoch)`，自增会让它立刻退出，把"移交"变成"停播"。
- `bridges` 的**生命周期独立于 pump**：`pump.stop()` 与 `g.close()` 都**不得**清 `bridges`（`g.close()` 只清 `encoders` + `recentByGroup`，`server.ts:1375-1382`）。只有显式 `bridgeStop` / `stopGroupCore` 才清（两者是不同函数：`playGroupCore` 在 `:356`、`stopGroupCore` 在 `:413`）。
- 这是 BLK-02 的核心：**如果按旧稿把清桥挂在 `stopGroupCore` 上，seek 会把整条桥丢掉。**
- `clearPlayback` 发 `BOUNDARY(track)`；`finishPlayback` 发 `BOUNDARY(stop)`（保留热复用窗口）。二者在 `playGroupCore` 里按 `canKeepStream()` 必发其一（`playerCore.ts:387-392`），可作为代次之外的**辅助确认信号**，但不是代次源。

#### 🔴 BOUNDARY 的语义边界（R7，必须写死）

`BOUNDARY` **只做两件事**：清队列 + 换代次。**绝不 TEARDOWN RAOP 会话**。

- 重锚只发生在"收到新代次的首帧 AUDIO"那一刻（`onFrame` 里判 generation）。
- `syncGeneration()` 挂在**投递路径**（`pushFrame` → `bridgeMember.sendAudio` 前），**不得**用定时器轮询。原因：seek 走 `stop()`（+1）→ `play()`（+1），一次 seek `epoch` 跳 2；走投递路径时两次自增之间没有帧，桥只看到最终值 ⇒ **只发 1 次 BOUNDARY**；若用定时器会发 2 次，虽然"只清队列+换代次"也安全，但会额外丢一批好帧。
- 正因为 BOUNDARY 不拆会话，"一次 seek 发两次"才无害 —— 这是上一条的前提，不要颠倒因果。
- `rehost()`（泵移交）**不自增 `epoch`**（`:1270-1299` 全文无 `this.epoch`、不调 `stop()`，只做 `prev.timelineBaseUs=0n` → `this.group=next` → `timelineReseed++`）。所以**代次不能只看 `epoch`**，必须同时看 `timelineReseed`：

```ts
// 代次 = (epoch, timelineReseed) 二元组。任一变化都是新流。
get generation(): number { return this.epoch * 1_000_003 + this.timelineReseed; }
```

> 用乘法混合而非加法，避免 `epoch + timelineReseed` 在两者交替自增时撞出同一个和（`epoch=2,reseed=0` 与 `epoch=1,reseed=1` 都会得 2）。`1_000_003` 取大于 `timelineReseed` 实际取值范围的质数。
>
> **🔴 禁止给 `rehost()` 加 `this.epoch++`**：`:759` 的推流循环是 `while (this.running && this.epoch === myEpoch)`，自增会让它**立刻退出**，把"移交"变成"停播"。这是复验明确警告的陷阱。

- **重锚钩子的落点不是定时器，也不是 `bridgeMember` 自己反查 pump**，而是 `streamEngine.ts:813` 的重锚分支：
  ```ts
  if (firstFrame || this.timelineReseed !== consumedReseed) {   // ← 现有判断，一行不改
    // 这里同时持有 myEpoch 与 this.group，一次覆盖 seek / track / rehost
    this.group.notifyBridgeGeneration?.(this.epoch * 1_000_003 + this.timelineReseed);
    ...
  }
  ```
  这样做的三个好处：① 覆盖 rehost（`timelineReseed` 变）；② 覆盖 seek/track（`epoch` 变）；③ 不需要 `server.ts ↔ streamEngine.ts` 的反向依赖。

> **Phase 5 验收（可 grep）**：每次 seek 后日志必须出现 **新 generation + 新 `scheduledAnchorUs`**，且旧 generation 的帧被丢弃计数 `> 0`。两者缺一即 FAIL。

### 4.4 背压与溢出

`sendAudio()` 同步入队，立即返回：

```
BridgeMember:
  queue: Array<Uint8Array>   // 仅存已编码帧
  queuedBytes: number
  highWater = 2s * 192KB/s = 384KB
  hardCap   = 8s * 192KB/s = 1.5MB
```

- socket `write()` 返回 false：停止 drain，等 `drain` 事件；队列继续接受。
- `queuedBytes > highWater`：日志 `bridge backpressure`，统计 `maxQueueMs`。
- `queuedBytes > hardCap`：判定该桥 stalled：
  1. 关闭 socket，标记 `stalled`。
  2. 不阻塞组泵；其余成员继续。
  3. 按 5s / 30s 退避重连；重连成功发新 generation，airplay 侧重新锚定。
- 禁止丢最旧帧继续播放：时间戳连续但内容有洞，会让对齐逻辑误判为“空洞补静音”，听感是随机静音，比明确断开更难查。
- airplay 侧另有 8s PCM 队列；收到超过 8s 的数据直接断连并报 `overflow`，让 sendspin 侧重连，而不是无限堆积。
- **阈值口径必须统一（MIN-05）**：两侧都按**输入速率 48k** 计量（即重采样**前**的字节数），不用 44.1k 口径。48k 下 8s = 1,536,000B；若接收侧误用 44.1k 口径（8s = 1,411,200B）会比发送侧早 124KB 触发断连，表现为"发送侧还没到 hardCap、接收侧已经 overflow"。更稳的写法是**用"秒"而不是"字节"做阈值**，字节数只用于日志。
- 重连退避加 **±20% 抖动**：N 台设备同时掉线时，固定 5s 会造成 N 条同步重连。

### 4.5 重采样与对齐

- airplay 侧收到 48k PCM 后：
  1. `Resampler` 48k→44.1k（AP1）；AP2 协商 48k 则直通。
  2. 按 `tsUs` 计算目标样本号：`targetFrames = round((tsUs - A) * rate / 1e6)`。
  3. 对齐参照 = **已追加输出流的内容前沿**（含 outBuf 常驻 pending；实现见 `bridgeSession.ts` 的 `BridgeTimelineAligner`）。⚠️ Phase 4 修正（QA 已独立验证成立）：不能用字面的「已写入 RAOP 的样本数 queuedFrames」——启动 lead 期 RAOP 尚未消费、pending 常驻累积，按字面口径每帧都会假触发全量校正（补静音方向=静音洪水、裁头方向=丢内容，两方向都崩）。
  4. `drift > 0` 补静音（上限 2s，超过改 skip 不物化静音）；`drift < 0` 裁头（丢弃输出样本，RTP 时间戳自洽无需跳帧）；漂移 >1ms 记 `realigned`。群延迟 0.3627ms 由 `bridgeMath.groupDelayUs` 补偿（48k 直通协议零补偿）。
- 重采样器群延迟：**0.3627ms**，不是 0.33ms。算式（MIN-01）：
  - 每相 32 抽头 × 160 相 ⇒ 原型滤波器 5120 抽头；
  - 群延迟 = 5120 / 2 = 2560 个**上采样**样本；
  - 折算输入帧 = 2560 / 147 = 17.41 帧；
  - 时间 = 17.41 / 48000 = **0.3627ms**。
  - 旧稿"16 输入帧≈0.33ms"是拿错分母（当成 32 抽头/2=16 输入帧），差 10%。虽然小，但它是**常数系统偏差**，会吃掉同步预算。
- 符号方向必须写死：**`A` 定义为「写进 `startNtp` 的映射锚点」**，补偿方向是 `A += 0.3627ms`（把锚点后移，使内容经重采样后的实际出声点落在目标上）。若把 `A` 定义成"内容首样本应可听时刻"，符号就是反的 —— 实现时最容易在这里写反，必须用单测钉住。
- 单测：输入一个脉冲，经重采样后应落在 `A + 0.3627ms`（容差 ±1µs）。
- 时间↔样本换算只在 `bridgeMath.ts`；重采样只在 `resampler.ts`；速率常量只在 `rates.ts`。

---

## 5. 群组生命周期与分派

### 5.1 路由快照

每个“播放流”开始时（`playMedia` 或自然切歌）计算：

```ts
type GroupRoute = "legacy-cast" | "bridge";
const spinOnline = getOnlineSendspinIds(groupId);
const apOnline = getOnlineAirplayIds(groupId);
const route = bridgeEnabled && spinOnline.length > 0 && apOnline.length > 0 ? "bridge" : "legacy-cast";
```

- 路由写入 `QueueController` 的组会话状态，保存 `route`, `sessionToken`, `bridgeDevices`。
- 同一流内不切换路由；`playMedia`、seek、next track 重新评估。
- “含 Sendspin”指**当前在线**成员，不是配置里曾经加入过的成员。

### 5.2 流内成员变化

| 事件 | bridge 路由下行为 | legacy 路由下行为 |
|---|---|---|
| 加入 AirPlay | `bridgePrepare` + 从 pump 当前/未来 ring 回填；不 `rejoinMembersAirplay` | 旧 `rejoinMembersAirplay`，起点编进 cast |
| 摘除 AirPlay | `bridgeStop(device)`；若该设备是 leader，状态改从 pump 派生 | `stopAirPlay` |
| 加入 Sendspin | 泵加入直播沿；若当前是 legacy 路由，**本流不切**，下一首切 bridge | 旧 `sendspinGroupJoin` |
| 摘除最后一个 Sendspin | **泵继续跑**（bridge 是 sink）；本流保持 bridge，避免双重会话。**⚠️ 这条依赖 §2.1 的虚拟 `pcm:100` 组**：没有它，`pushFrame` 会返回 0 → 5s 后被判零产出 → 放弃本曲 | 泵停止；AirPlay 继续 solo cast 到本流结束 |
| 显式 solo 操控 AirPlay 成员 | 先从组摘除：`bridgeStop` + `detachFromActiveGroups`（**后者必须先补 airplay 分支**，见下）再执行 solo cast | 先摘组，再 solo cast |
| solo cast 到**同 host 的另一台**设备 | **不得**被 `stopAirPlaySessionsForHost` 连带停掉（见 §5.5） | 同左 |
| sendspin 子进程崩溃 | airplay 侧 socket 断开 → 停 bridge 会话；supervisor 重启后重新 prepare/attach | 无影响 |
| airplay 子进程崩溃 | sendspin 桥成员 stalled；重启后重建 socket，新 generation | 旧 cast 会话丢失 |
| **主进程重启** | 启动时先清理 `mfab/*.sock` 残留（否则首个流 `EADDRINUSE`），再让两侧重新 prepare | 同左 |
| **桥设备离线（mDNS down / TEARDOWN）** | 不等重连：立刻 `bridgeStop`，清空该桥队列，标 `offline`；设备重新上线后按"加入 AirPlay"处理 | `available=false`，不 cast |
| **桥设备重连（设备级）** | 必须**重建 RAOP 会话**（新 ANNOUNCE/SETUP/RECORD ⇒ 新 `baseTs`/`startNtp`），不是复用旧 session。热复用窗口只适用于**同一会话内**的换曲 | — |
| **组解散** | `stopGroupCore` 之外还有 `stopAll`、airplay 服务关闭、进程退出三条路径，**四条都要** `bridgeStop` + `unlink` socket | — |
| **rehost（泵移交）** | 只自增 `timelineReseed`（**不碰 `epoch`**）⇒ 桥必须靠代次二元组里的 `timelineReseed` 分量发现自己该重锚；重锚在新组首帧按 `next.commonSendAheadUs()` 重立 | — |
| **leader 变更** | `raiseGroupLeader` 换人时**不得**重发 solo cast（重发会与 bridge 抢设备）；状态仍从泵派生 | 按 `memberIds` 顺序重取 leader |
| **切歌（跨源）** | 换 songId 且 `canKeepStream()` 为 false ⇒ 走 `finishPlayback` 而非 `clearPlayback`；bridge 必须知道这个差别（前者拆会话、后者保留热复用窗口） | 同左 |

> **`detachFromActiveGroups` 必须先补 airplay 分支**（`routes/api/shared.ts:651-652`）：
> ```ts
> if (parsed.kind !== "dlna" && parsed.kind !== "sendspin") return;   // ← airplay 直接 return
> ```
> 不改这一行，AirPlay 成员"摘组"就是个 no-op，桥上留孤儿成员。补法：允许 `airplay`，并按 §5.5 追加 `bridgeStop` + `stopAirPlay`。

### 5.3 状态与 leader

当前 `getGroupLeader()` 按成员顺序可能返回 AirPlay；`pollState`/`getGroupStatus` 在 leader 是 AirPlay 时读 solo 会话。桥接路由下这是错的：

- 新增 `bridgeRouteOf(groupId)`。
- 若路由是 `bridge`，无论 leader 是什么 kind，`pollState`/`getGroupStatus` 一律从 `sendspinGroupPoll` 派生位置、时长、播放态。
- `getAirPlayStatus` 只用于设备可用性/音量显示，不用于桥接路由下的进度。
- 禁止在桥接路由下同时存在该设备的 solo cast 会话。

### 5.4 传输命令

`fanOut` 当前把 DLNA + AirPlay 一起逐设备调用。桥接路由下：

- `playMedia`：AirPlay 不逐设备 cast，改由组泵 + bridge 覆盖。
- `stop`：`spinOp(stop)` 停泵；随后 `bridgeStop` 全部成员，再清路由。
- `setVolume`：`spinOp(setVolume)` + 对每个桥成员调用 `setAirPlayVolume(deviceId, vol)`；静音同理。桥成员 PCM 保持 unity。
- `fanOut` 对 bridge 路由下的 AirPlay 成员返回 `fulfilled=0`（有意跳过），避免重复 cast。

#### `seek`（🔴 第七轮改正）

- 只发 `spinOp(seek)`，**不做任何 bridge 专属动作**。
- 代次由二元组 `(epoch, timelineReseed)` 自动推进（`seekCore → playGroupCore → pump.stop()/play()` ⇒ `epoch` +2），钩子在 `streamEngine.ts:813` 的重锚分支，`bridgeMember.notifyGeneration()` 收到即清队列 + 换代次（§4.3）。
- **禁止**在 seek 路径上：① 触发 RAOP 位置重锚 —— 具体是禁 `prepareSeek()` / `setStartPosition()` / cast 的 `seekSec` 通道（**不是** `raop.seek()`，该方法不存在）；② 清理 `bridges`（`g.close()` 只清编码器与 ring）；③ 重建 RAOP 会话（同一首歌应 flush-refill）。
- 旧稿"`timelineReseed` 触发 bridge 新 generation"作废。

#### `pause` / `resume`（🔴 第七轮补，旧稿只写"音频自然停/续"，不成立）

桥接路径**没有走 `raop.stream()`**，所以"自然停/续"这个说法没有实现基础（`stream()` 里 pause 停的是 `idx` 推进，桥接路径不存在这个循环）。

定案：

- `pause`：`spinOp(pause)` 停泵 ⇒ 桥端 2s 内没有新帧。桥**不写静音**、**不发 FLUSH**、**不动 `headTs`**，只把"未收到帧"计为正常暂停（区别于 stalled：暂停期不计入 `latePackets`，也不触发退避重连）。
- `resume`：`spinOp(resume)` 恢复泵。桥把 **`epoch` 未变**的恢复当作"继续"：直接用原来的 `A`/`B` 继续写，`drift` 由 `tsUs` 自然重新对齐（暂停期间内容时间戳是连续推进的，不是墙钟）。
- 若暂停时长 > `MAX_HELD_AUDIO_US`（45s），恢复时按"锚点不可达"处理（§3.3 末段）：重新取 `A = now + warmLead`，跳到该时刻对应内容。
- **已知副作用（接受并记录）**：RAOP 接收端自身有约 `L`（默认 1s）的缓冲，暂停后可能还响 ≤1s。这是接收端行为，不是我们能通过协议消除的；不要为了"立刻静音"去发 FLUSH（FLUSH 会重建会话，代价远大于 1s 余音）。

### 5.5 会话所有权

`sessionRuntime` 增加：

```ts
type SessionOwner = { kind: "native" } | { kind: "bridge"; token: string };
```

- `bridgePrepare` 创建会话时写 `owner={kind:"bridge", token}`。
- 旧 `cast` 入口若发现同 device 已有 bridge owner 且 token 不同，拒绝并返回 `session-owned-by-bridge`。
- `stopSession` 必须带 token；token 不匹配不得关闭别人的会话。
- airplay 子进程重启：主进程清空 owner 表，不假设旧会话仍存在。

#### 🔴 MAJ-06：必须与「同 host 全停」互斥逻辑划清界限

现有 `stopAirPlaySessionsForHost(host)`（`airplay/control.ts:302-329`）会遍历该 host 的**全部** active session 并逐个 `stopAirPlaySession`，它被 DLNA 双协议互斥调用。**如果桥会话登记进同一张 `sessionRuntime` 表而不加区分：**

- 用户 cast 一台 DLNA 设备 ⇒ `stopAirPlaySessionsForHost` 把**同一 host 上的桥会话一起杀掉**；
- 反向：桥起播 ⇒ DLNA 侧的互斥判定被误触发。

⇒ 定案：

1. `SessionOwner.kind === "bridge"` 的会话**不得**被 `stopAirPlaySessionsForHost` 停掉，也**不得**触发 DLNA 侧 stop。它只能被 `bridgeStop(deviceId, token)` 或组销毁停掉。
2. DLNA 互斥判定只统计 `kind === "native"` 的会话。
3. **字段落点（R6）**：`owner` 目前**不存在**——`sessionRuntime.ts:82` 的 `interface ActiveSession` 没有 owner/token 字段，`sessions = Map<string, ActiveSession>`（`:133`）按 deviceId 索引。补法：
   ```ts
   interface ActiveSession {
     ...
     owner: SessionOwner;    // 新增，创建时缺省 {kind:"native"}
     token?: string;
   }
   // 判定（是一设备一会话，所以判断很自然）
   const canStop = sessions.get(deviceId)?.owner.kind !== "bridge";
   ```
4. **允许停桥会话的调用者（无需过滤，别误伤）**：`control.ts:1275`（服务关停全停）、`control.ts:1245`（mDNS byebye 强停）、`routes/api/airplay.ts:96/116`（REST 手停）—— 都是"设备/用户显式停"。
5. **唯一要封的旁路**：`airplay/protocolPlayer.ts:54` 的 `stop()` → `stopAirPlay(deviceId)`。它只能经组 `fanOut` 到达，§5.4 已覆盖；守卫要额外断言「bridge 路由下不得直接调用 `createAirPlayProtocolPlayer(...).stop()`」。
6. 守卫断言：`stopAirPlaySessionsForHost` 的实现里必须出现 `owner.kind !== "bridge"` 过滤（钉唯一表达式）。

#### `stopSession` 加 token 的波及面（MIN-09，必须一起改）

现有 `stopSession(deviceId)` **无 token 参数**，直接按 deviceId 停。要改签名，必须同步这些调用点（均已实测存在）：

| 文件 | 位置 | 说明 |
|---|---|---|
| `airplay/childMain.ts` | `:66-72` | 子进程 dispatch 的 `stopSession` |
| `airplay/control.ts` | `:327` `stopAirPlaySession`、`:946` `stopAirPlay`、`:302` `stopAirPlaySessionsForHost` | 三者都要透传可选 token |
| `airplay/control.ts` | `:1065` `setAirPlayVolume`、`:1093` `setAirPlayMuted` | 桥成员音量走这两条，也要带 owner 校验 |
| `airplay/ipcProtocol.ts` | — | 新增字段 |
| 测试 | `tests/airplay/*` | 桩需支持新字段 |

**兼容策略**：token 设为**可选参数**，缺省 = 旧语义（按 deviceId 停）。这样旧调用点不改也不会崩，桥路径显式带 token。

---

## 6. 文件级改动清单

### 6.1 新增

| 文件 | 职责 |
|---|---|
| `backend/src/utils/hostClock.ts` | host-monotonic µs、NTP 转换、测试 override |
| `backend/src/services/airplay/rates.ts` | `SENDSPIN_RATE=48000`、`AIRPLAY1_RATE=44100`、`AP2_RATES=[48000,44100]` |
| `backend/src/services/airplay/resampler.ts` | 147/160 多相 FIR，跨帧状态，群延迟 |
| `backend/src/services/airplay/bridgeMath.ts` | 锚点、样本映射、漂移、latency 补偿，纯函数 |
| `backend/src/services/airplay/bridgeChannel.ts` | 28B 帧编解码、socket 双端、generation/seq、队列 |
| `backend/src/services/airplay/bridgeServer.ts` | airplay 子进程 listener、session 注册、帧分发 |
| `backend/src/services/airplay/bridgeSession.ts` | 单设备 bridge 会话：队列、重采样、对齐、RAOP 驱动、音量 |
| `backend/src/services/airplay/bridgeSource.ts` | 有界 PCM 队列 + stalled/overflow 策略 |
| `backend/src/services/sendspin/bridgeMember.ts` | sendspin 侧桥成员：队列、socket、generation、lead 上报、统计 |
| `backend/src/services/airplay/ap2/realtime/` | Phase 6 AP2 realtime，不填 buffered |
| `backend/scripts/check-airplay-bridge.mjs` | 守卫，见第 9 节 |
| `backend/scripts/cc_align.py` | **唯一**互相关脚本（FFT + wrap-aware + 137ms 自检 + quality 判据），进 CI；文档只引用不复制 |

### 6.2 修改

| 文件 | 改动 | 约束 |
|---|---|---|
| `sendspin/server.ts` | `SendspinGroup` 增加 `bridges`；**`pushFrame` 入口补虚拟 `pcm:100` 组（§2.1 BLK-01）**；在该组循环体里投递 bridge；`clearPlayback`/`finishPlayback` 发 boundary；`encodedBytesPerSec` 仅 bridge 时按 PCM | 不改 `members` 类型；**`commonSendAheadUs` 不动**（MAJ-01）；不改 `group.ts` 同名死代码 |
| `sendspin/streamEngine.ts` | bridge 路由绕过 800ms 锚点钳制（`:846`）；新增只读 `get generation()` 暴露 `epoch`；**不新增 `bridgeTimelineReset`**（BLK-02） | 非 bridge 路径行为零变化；`epoch` 的自增点不改 |
| `sendspin/playerCore.ts` | `playGroupCore` / `playCore` 接收 `bridge` 参数并注册；**`seekCore` 的重建路径必须透传 bridge**；`stopGroupCore`/`stopAll` 清 bridge | ⚠️ `playGroupCore` 内的 `g.close()` **不得**清 bridge（BLK-02）；现有 `sendspinGroupPlay` 的 bridge 参数已存在但未消费，必须接完，不能留半成品 |
| `sendspin/index.ts` | fork/in-proc 两条路径都透传 bridge；删除指向不存在 `group/airplayBridge.ts` 的注释 | in-proc 不得静默丢弃（当前 `:772-777` 就是丢弃） |
| `sendspin/childMain.ts` | `groupPlay` 消费 `p.bridge`；新增 `bridgeAttach`/`bridgeDetach`/`bridgeStatus` | 只接受主进程下发的 socket，不自行发现 AirPlay |
| `airplay/childMain.ts` | 新增 `bridgePrepare`/`bridgeStop`/`bridgeSetVolume`/`bridgeStatus`；`stopSession` 增可选 `token` | PCM 不走 JSON IPC |
| `airplay/ipcProtocol.ts` | 新 op 的类型与校验 | sessionToken 必填；`stopSession` 的 token 可选（缺省=旧语义） |
| `airplay/raop.ts` | `ntpNow` 改 hostClock；**四个锚点同域且先截断后对齐**（MAJ-10）；新增 `streamBridge(source, session, anchor)`；旧 `stream()` 保留给 native | 两条驱动物理分离；`latencyFrames` 不归零；bridge 路径禁 `prepareSeek()`/`setStartPosition()`/cast `seekSec`（**无 `seek()` 方法**） |
| `airplay/sessionRuntime.ts` | session owner、bridge 起停、流代次 | native/bridge 互斥 |
| `airplay/control.ts` | `setAirPlayVolume`/`setAirPlayMuted` 可作用到 bridge 会话；**`stopAirPlaySessionsForHost` 必须跳过 `owner.kind==="bridge"`**（MAJ-06）；`stopSession`/`stopAirPlay` 透传可选 token | 复用现有 DB/同机 DLNA 转发/RAOP 回落 |
| `group/protocolPlayer.ts` | 路由快照、fanOut 跳过 bridge AirPlay、状态从泵派生 | `splitGroupMembers` 三桶不动；leader 变更不得重发 cast |
| `routes/api/shared.ts` | `alignGroupMembers` 识别 bridge 路由；**`detachFromActiveGroups` 纳入 airplay**（`:651-652`） | 不改变旧 cast 参数顺序 |
| `player/QueueController.ts` | `rejoinMembersAirplay` 仅 legacy 路由；bridge 路由走 attach | 不重复 cast |
| `discovery.ts` + `tests/airplay/discoveryAp2.test.ts` + 守卫 | Phase 7 若要 AP2-only 才改；Phase 6 不改 | 当前 `_raop` only 是锁定行为 |

---

## 7. 核心接口

### 7.1 sendspin 侧

```ts
// MIN-04：协议必须四档。airplay2-compat（auth-setup + RAOP）既不是纯 RAOP
// 也不是 AP2 realtime/buffered，缺这一档就无法据此选速率/时钟/加密路径。
export type BridgeProtocol = "raop" | "ap2-realtime" | "ap2-buffered" | "ap2-compat";

export type BridgeSocket = {
  deviceId: string;
  socketPath: string;
  protocol: BridgeProtocol;
  coldLeadMs?: number;    // 默认 4500，只喂 streamEngine 的 anchorLead
  warmLeadMs?: number;    // 默认 2500，同上
  minBufferMs?: number;   // 默认 1000，这个才进 commonSendAheadUs
};

/** 每种协议的能力映射，实现放在 rates.ts，禁止散落 */
export const PROTOCOL_CAPS: Record<BridgeProtocol, {
  rate: number;                 // AP1/compat 恒 44100；ap2-realtime 以 SETUP 为准
  clock: "ntp" | "ptp";
  encryption: "none" | "alac-chacha";
  streamType: 96 | 103;   // 96=RAOP 与 AP2 realtime 共用（实测口径，注①）; 103=AP2 buffered
}> = {
  "raop":         { rate: 44100, clock: "ntp", encryption: "none",        streamType: 96  },
  "ap2-compat":   { rate: 44100, clock: "ntp", encryption: "none",        streamType: 96  },
  "ap2-realtime": { rate: 48000, clock: "ntp", encryption: "alac-chacha", streamType: 96  },
  "ap2-buffered": { rate: 48000, clock: "ptp", encryption: "alac-chacha", streamType: 103 },
};

export interface BridgeMemberStats {
  deviceId: string;
  state: "connecting" | "live" | "stalled" | "closed";
  generation: number;
  queuedBytes: number;
  queuedMs: number;
  maxQueueMs: number;
  droppedConnections: number;
  lastTsUs: bigint | null;
}

export interface BridgeMember {
  readonly deviceId: string;
  readonly generation: number;
  sendAudio(tsUs: bigint, pcm: Uint8Array): void;
  boundary(reason: "track" | "seek" | "stop" | "rehost"): void;
  stats(): BridgeMemberStats;
  close(): void;
}
```

`SendspinGroup` 新方法：

```ts
addBridge(bridge: BridgeMember): void;
removeBridge(deviceId: string): void;
hasBridges(): boolean;
bridgeStartLeadUs(): number;
bridgeTimelineReset(reason: string): void;
bridgeReplayLateJoin(deviceId: string): number;
```

### 7.2 airplay 侧

```ts
export type PreparedBridge = {
  deviceId: string;
  token: string;
  protocol: "raop" | "ap2";
  socketPath: string;
  state: "listening" | "connected" | "anchored" | "stalled" | "closed";
};

export interface AirPlayBridgeSession {
  prepare(): Promise<PreparedBridge>;
  onFrame(frame: BridgeFrame): void;
  setVolume(volume: number): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  stop(token: string): Promise<void>;
}
```

锚点只在 `onFrame` 收到第一帧有效 AUDIO 时确定；不存在 `start(anchorUnixMs)` 外部调用。

---

## 8. 分阶段实施

> 每阶段出口：单测 + 守卫 + 日志证据。守卫与源码同 commit。无法运行的验收明确标 BLOCKED，不得写成已通过。

### Phase 0 · 验收链（门禁，0.5~1 天）

> **2026-10-25 已用 240 生产容器实测（数据面通过）**。完整证据与复现命令见
> `AirPlay桥接-240开工前验证报告-2026-10-25.md`。

已实测完成：

- 240 容器 `musicflow` **v4.6.74 / 8d7a0ff**（正是本文基线），`/ping` 200，46400 + 38927 监听；230→240 双端口 `nc -z` 通。
- **假 Sendspin 真实连上 240 并收流**：`[first] ts=742556162177 dur=25000 bytes=4800 fmt=PCM/48000/16/2`；落盘 15.8s、peak **26131**、RMS −17.1 dBFS、nonzero **99.98 %**。`send_ahead` 实测为 **0**，印证 MAJ-01（它不是播放时刻语义）。
- **AP1 接收端抓取链打通**：shairport 日志确认 240 的 RAOP 会话到达（`rtsp.c:1057 Connection 1: SETUP … from 192.168.10.240`），输出 `alsa: output format chosen is "S32"` / `output speed 44100` / `output_device = "hw:Loopback,0"`。
- **`cc_align.py` 落盘**（230 `/root/cc_align.py`），三项自检通过；真实音乐上 137ms 实测 **−137.0 ms（quality 0.984）**、同源同长 **0.0 ms（quality 1.000）**。
- **端到端 Δ 测量链闭环**：同一首歌并行投给 sendspin + AP1，Δ = **−7461.4 ms**，且 **20 / 30 / 45s 三窗口数值完全一致**（quality 0.497 / 0.693 / 0.769）。这个量级与「AirPlay 整曲缓冲 TTFB 6–30s vs sendspin 25ms 流式」吻合 —— 正是桥接要压到 ≤20ms 的那段差。

新增阻塞（🔴 只影响真机新设备配对，不阻塞 Phase 1）：

- **P0-1 配对时序死锁**：`onClientHello` 无条件发 `server/activate{activities:["playback"]}`，而未配对会话（sentinel PSK）结构上只准 `{pairing}` ⇒ aiosendspin 判 `pairing_required` 并**立即 goodbye**（不等待配对窗）；`pairServer.start()` 又要求"客户端已连接" ⇒ REST 配对没有可打的窗口。真实 ESP32（sendspin-cpp）收到该 reason 后行为不同，所以能配对 —— 问题只在 aiosendspin/标准 Python 客户端暴露。修法见验证报告 §3 P0-1。

出口（**顺序不能换**，R8：`arecord` 要有音源就必须先有服务 + 一次 cast）：

1. ✅ 服务 `/ping` 200 —— **用 240 替代**（230 无服务，这是本轮消灭的环境阻塞）。
2. ✅ **用旧 cast 路径**投一台 AP1（`MUSICFLOW_AIRPLAY_BRIDGE=0`）造出音源。
3. ✅ `arecord -D hw:Loopback,1 -f S32_LE -r 44100 -c 2 -d 5 /root/ap1_cap_44.pcm` ⇒ 文件长度 = 5×44100×**8**B（S32 双声道），`peak_i32 > 1000`。（BLK-04）
   - 🔴 **格式已由实测修正**：shairport 的 ALSA 输出是 **S32_LE**，用 `-f S16_LE` 读同一份数据会得到 **全 0**（S16 只看每样本高 16 位，音乐低电平下多为 0）。这不是"没声音"，历史上「Loopback 只能采到 peak 935」也是同一原因。
   - 抓之前先 `cat /proc/asound/card0/pcm0p/sub0/hw_params` 确认确实是 `44100`：shairport 配置未显式写采样率，若实际跑 48k，用 `-r 44100` 会量出假象。
4. ⚠️ 假设备 `client_id` 收到 `[stream-start]` 与 `[first]`、落盘 peak > 1000 —— **✅ 已达成（peak 26131）**，但**配对未通过**（本轮用 `--unpaired` 只验数据面）。
5. ✅ AP2 床 1 台 LISTEN（7200 + mDNS registered）。
6. ✅ **`cc_align.py` 落盘并自检通过**（`[selftest] OK delta=137.0 ms` / 反向 −137.0 / stereo 137.0）。
7. ⬜ **两类测试源就位**（🔴 BLK-03）：宽带源 + 1k/15k/23k 正弦。本轮用**真实歌曲**代替，**不能算完成**——歌曲有重复段落，会制造假峰位。
8. ⬜ 对 1kHz 正弦跑一次 `cc_align.py`，确认它**拒绝出 Δ**（窄带源检测生效）。

#### 🔴 BLK-04：AP1「设备实际播放的 PCM」从哪来（旧稿缺失）

旧稿 §10.2 直接读 `/root/ap1_cap_44.pcm`，但**全文没有定义它怎么产生**，且 230 上该文件不存在。更危险的是：落地方案 Phase 0 定义的 `MUSICFLOW_AIRPLAY_PCM_OUT=<path>` 是**发送端**写出的 PCM —— 那测的是"进程间管道 + 重采样链"，**与设备什么时候真的出声无关**，用它算 Δ 会恒≈0，是"必过"的假判据。

定案（两条链，用途严格分开）：

| 链 | 命令 | 用途 | 能否用于 Δ 判据 |
|---|---|---|---|
| **接收端真抓** | shairport-sync 输出到 `hw:Loopback,0`；`arecord -D hw:Loopback,1 -f S32_LE -r 44100 -c 2 -d <N> /root/ap1_cap_44.pcm` | 设备侧实际播放内容 | ✅ **只有这条可以** |
| **发送端落盘** | `MUSICFLOW_AIRPLAY_PCM_OUT=<path>` | 排查管道/重采样是否正确 | ❌ **禁止**用于 Δ |

- 230 已具备条件：`lsmod | grep -c snd_aloop` = 4（模块已加载），shairport-sync 在位（pid 常驻）。
- 🔴 **`-f S32_LE` 是实测结论，不是选择**：shairport 启动日志 `audio_alsa.c:528 alsa: output format chosen is "S32"`。用 S16 读会得到全 0（实测 nonzero_ratio 0.0 / peak 0），因为 S16 视图只取每样本高 16 位。分析侧按 `<i4` 读、除以 2³¹ 得 dBFS。
- `-r 44100` 必须与 shairport 实际输出一致（实测 `output speed chosen is 44100`），否则量出来是假象。
- 🟡 **电平口径**：shairport `ignore_volume_control is 0` ⇒ RAOP 音量直接作用于输出。实测 AP1 侧 peak −39.56 dBFS，比源侧 −17.1 dBFS 低 22 dB。互相关是尺度无关的、不受影响，但**绝对电平判据（`peak > 1000`）必须按抓取档位设阈值**；跨用例比较前应把设备音量固定到同一档位，或在分析侧统一归一化。
- Phase 0 出口 4 就是"这条链能出非静音数据"的机械证明。

#### 🔴 BLK-03：1kHz 正弦**不能**用来测 Δ

旧稿 Phase 0 只准备了一份「1kHz 正弦，双声道，120s」，然后在 §10.2 用它做互相关测 Δ。**数学上不成立**：

- 1kHz 的周期是 **1ms**，两份正弦的归一化互相关在 lag 轴上以 1ms 为周期重复；
- `argmax` 只能锁定到 1ms 的整数倍集合中的一个，且极易锁在错误的倍数上；
- `quality` 几乎恒 ≈1（全都被判"可信"），等于没有质量门。

⇒ 这就成了"用一个只能分辨模 1ms 的尺子去量 20ms"，正是本文反复强调要避免的假证据。

定案：**两类源，用途不许混**。

```bash
# ① Δ 测量专用：宽带源（三选一，推荐 MLS 或 chirp）
#    - 白噪：无周期性，互相关单峰最干净
#    - MLS：单峰极尖锐，抗噪最好
#    - 线性 chirp 20Hz→20kHz / 30s：单峰且可同时测频响
ffmpeg -f lavfi -i "anoisesrc=d=120:c=pink:r=48000:a=0.5" -ac 2 -ar 48000 /root/src_wide_48k.wav
# ② 基频/抗混叠专用（保留原用途）：1kHz 与 15kHz 正弦、23kHz 抗混叠探针
ffmpeg -f lavfi -i "sine=frequency=1000:duration=120:sample_rate=48000" -ac 2 /root/src_1k_48k.wav
ffmpeg -f lavfi -i "sine=frequency=15000:duration=30:sample_rate=48000" -ac 2 /root/src_15k_48k.wav
ffmpeg -f lavfi -i "sine=frequency=23000:duration=30:sample_rate=48000" -ac 2 /root/src_23k_48k.wav
```

| 源 | 用于 | 禁止用于 |
|---|---|---|
| 宽带（白噪/MLS/chirp） | 互相关 Δ（§10.3） | 基频判据（没有单一基频） |
| 1kHz / 15kHz / 23kHz 正弦 | 基频偏差、抗混叠衰减（§10.4） | **Δ**（周期 1ms，峰位不可辨） |

- 互相关脚本必须加一条硬断言：若在 lag 轴的多个 1ms 倍数上 `quality` 同时 > 0.99 ⇒ 直接报「源不适用」并退出，不许出 Δ 数字。

**Phase 0 未过，不进入 Phase 3。**

### Phase 1 · 时钟 + 重采样 + 纯函数（1~1.5 天）

- `hostClock.ts`、`raop.ntpNow` 切换、`sendspin/clock` re-export。
- `rates.ts`、`resampler.ts`、`bridgeMath.ts`。
- 单测：
  - `ntpNow` 与 `nowUs` 同源：两次采样差与 `process.hrtime` 差 < 100µs。
  - 160000 输入帧 → 147000 输出帧；10min 累计误差 0 帧。
  - 1kHz 偏差 ≤0.5%；15kHz 损失 ≤1dB；23kHz 衰减 ≥40dB。
  - **锚点四字段一致性（MAJ-09）**：给定 `A/L/rate`，`baseTs=startTs=headTs=B` 且 `startNtp=ntpFromHostUs(A−L)` 时，首包可听时刻 = `A` ±1 sample；同时断言 `positionSec` 从 0 开始。
  - **32 位模域（MAJ-10）**：`setNowUsOverride` 推到 `sec = 100_000`（>27h）跑完整 RECORD + `sendChunk` + `sendSync`，`positionSec` 与 `elapsedTs` 仍正确；`baseTs/startTs/headTs` 均 `<= 0xFFFFFFFF`。
  - **重采样群延迟（MIN-01）**：脉冲经 147/160 重采样后落在 `A + 0.3627ms`（±1µs），符号方向断言（防"A 的定义写反"）。
  - 漂移：+10ms 空洞补 441 帧；-10ms 重叠裁 441 帧。

### Phase 2 · 跨进程 channel + airplay bridge session（1~1.5 天）

- 28B 帧编解码、net 双端、generation/seq、有界队列、断连重连。
- airplay `bridgePrepare` listener；sendspin `bridgeMember` 连接。
- 该阶段不接组泵：手工用测试程序向 socket 写 5s PCM，airplay 侧落盘/发声，验证通道与重采样链。
- 出口：10 万随机帧往返字节一致；kill 任一端后重连成功；连续 192KB/s×3 10min RSS 增长 < 10MB；AP1 落盘 44.1k 非静音。

### Phase 3 · 组泵出声（1.5~2 天）

- `SendspinGroup.bridges`；**`pushFrame` 入口补虚拟 `pcm:100` 组（§2.1 BLK-01）**；`pcm:100` 组循环体内投递 bridge。
- **`commonSendAheadUs()` 不动**；启动 lead 只进 `streamEngine.anchorLead`（§3.4 MAJ-01）。
- `playGroupCore`/`childMain` 接通 bridge 参数；主进程 `prepare` 顺序。
- 路由快照、fanOut 跳过、状态从泵派生。
- 出口（全部可机械验证）：
  - 纯 Sendspin 组回归全绿（51 个测试文件）。
  - **`members = ∅` + 1 bridge 时 `pushFrame` 返回 > 0，且 bridge 收到字节**（BLK-01 正向用例，缺此不通过）。
  - **组内真实成员全是非 pcm 编码（如 flac）时，桥仍收流**（证明解耦成立）。
  - 假 Sendspin + AP1 同组，两边落盘非静音。
  - 本阶段**不判同步 Δ**，只判"有声 + 无重复会话"。
  - **🔴 切歌预取语义不变（§3.6 用户硬性约束）**：桥接组连播 3 首，第二首起逐首出现预取+完整性判定路径；与纯 sendspin 组同源同数据下 `markUnplayable`/判死日志行为一致（不存在绕过 judgePrefetchedBuffer 的第二条选歌路径）。第一首直接起播的行为不变。
  - flag 关：纯 AirPlay 组旧 cast 完全一致（`MUSICFLOW_AIRPLAY_BRIDGE=0` 与 `1` 两种模式下，纯 AirPlay 组的 RTSP 报文序列 diff 为空）。
  - **纯 sendspin 组 + 1 台 bridge 时，真实设备侧 `delta` 不得出现常数 +3.7s 偏移**（MAJ-01 回归）。
  - 同一 deviceId 的 airplay 会话计数恒 == 1。

### Phase 4 · 时间线映射 + 对齐 + 无 ack 语义（2~3 天）

- RAOP bridge 驱动路径：RTP↔NTP 映射、发送节拍、`latencyFrames` 补偿（四锚点，§3.3）。
- `bridgeMath` 全量、补静音/裁头、漂移日志。
- `scheduledAnchorUs` 报告，不伪造 ack。
- 出口（全部可机械验证）：
  - **Δ 用宽带源**（§8 Phase 0），互相关脚本先过 137ms 自检（打印 `[selftest] OK delta=137.0`）。
  - 同组互相关 `|Δ| ≤ 20ms` **且** `quality ≥ 0.2`。
  - **与 `cliairplay` 同源 A/B 的 Δ ≤ 5ms**（🔴 这是唯一能实证 `A−L` 假设的判据：cliairplay 不做 `A−L` 补偿，若我们映射错了一整个 `L`，A/B 会直接暴露 ≈1s 的差）。
  - `[airplay-bridge] stats` 两台成员 `clock` 同源；`delta` 按 §10.5 的定义计算，`p95(|delta|) ≤ 20ms` 且无单调漂移（斜率 ≤ 1ms/10s）。
  - 首包 `sendAt` 不早于 `A-L-safety` 超过 5ms；`latePackets=0`。
  - AP1 落盘基频 1kHz ±0.5%（用 1kHz 正弦，不用宽带源）。

### Phase 5 · 生命周期 / 背压 / 热复用（1.5~2 天）

- 代次源 = `epoch`（§4.3）；seek/track/rehost **不重建 bridges**，只切 generation。
- 队列高/低水位、hardCap 断连、5s/30s 退避（带 ±20% 抖动）。
- 加入/摘除成员、solo 脱组、leader 状态、子进程崩溃、设备离线/重连、主进程重启残留清理。
- 出口（全部可 grep）：
  - **连续 seek 3 次：每次日志出现新 generation + 新 `scheduledAnchorUs`，且旧 generation 帧丢弃计数 > 0**（BLK-02 核心判据）。
  - **流转/rehost 一次：也必须出现新 generation + 新锚点**（R1 —— 这条专门防"只用 epoch"的漏判；`rehost` 只动 `timelineReseed`，二元组必须覆盖到）。
  - seek 后 `bridges.size` 不变（证明 `g.close()` 没把桥清掉）。
  - 播放中加/摘 AirPlay，不产生第二个 airplay 子进程会话（`session 数 == 桥设备数`）。
  - 杀 airplay 子进程：≤6s 重建并重新锚定，Δ 回到 ≤20ms；杀 sendspin 子进程：airplay 侧无残留播放。
  - 队列压到 hardCap：状态机序列必须是 `live→stalled→connecting→live`（可 grep），不出现"继续播但随机静音"。
  - 暂停/恢复：暂停期不计 `latePackets`，恢复后 Δ 回到 ≤20ms。

### Phase 6 · AP2 realtime + NTP（3~5 天）

**拆 6a 门禁 + 6b 实现（MIN-10：旧稿自相矛盾 —— 凭据契约写"待定义"，出口却要求配对全跑通，而"只在内存里的配对成功"重启即失，A/B 无法复现）**

- **Phase 6a · 凭据契约（0.5 天，未完成不进 6b）**
  1. 写入时机：pair-setup/M1-M4 成功即写；pair-verify 失败不写。
  2. 存储形态：`hap_credentials`（`db/index.ts:469`，192hex）—— 明确一设备一行、按 deviceId 唯一、`accessoryLTPK`（64 hex）/`controllerLTSK`（**128 hex** = 64 字节 Ed25519 LTSK）的切分（⚠️ 修正原稿「各 64 hex」笔误：64+64=128≠192 自相矛盾，64+128=192 才自洽；唯一出处 `airplay/ap2/hapCredentials.ts`，6b 禁止自行 substring）。
  3. 验证方式：重启进程后能免 PIN 重连（**可机械验证**）。
  4. 失效清理：设备被删除 / verify 连续失败 N 次 ⇒ 清行并回到配对窗。
  5. 迁移兼容：`db/index.ts:752-761` 已有幂等加列，确认无需二次迁移。
- **Phase 6b · 实现**
  - HAP pair-setup/verify（消费 6a 的契约）。
  - auth-setup、二进制 plist SETUP、加密 RTSP、ALAC + ChaCha20-Poly1305。
  - realtime stream type 96（实测口径，注①），RTP/UDP，NTP 计时。
  - 出口：① 6a 的"重启免 PIN"通过；② 与 cliairplay 对同一 AP2 接收端 A/B，Δ≤20ms —— **判据口径见下方「注②」（2026-10-25 批 4 实测校正，原文的"互相关"与 `clock_ready/exchanges` 判据已作废）**；③ AP2 SETUP 协商速率写进日志（`rate=<int>`），不假定 48k。

> **注②（Phase 6b 批 4 床侧实测校正，2026-10-25）：cliairplay 在 `timing=ntp` + realtime 下永不发 NTP 探测，`clock_ready state=cold exchanges=0` 是结构性的，不是缺陷。**
> 三重证据：① 床侧 NTP 应答器已实现且自证能答（UDP/TCP、48B/32B、同连接连发 3 次均 `origin_echo=True`，`/tmp/ab/ntp_selftest.txt`），但 cliairplay 整场播放后 `ntp.log` **只有一行 up 记录、零请求**；② `--debug 9` + tcpdump（`not port 7200 and less 200`，84 包）中发往 timing 端口的包 **0 个**；③ 二进制串交叉验证：`ap2_clock_verify_arm` 只在 `ap2_send_sync_packet_ptp`（PTP 锚）路径被调用，NTP 模式从不 arm，首行日志 `[CLOCK] host clock realtime` ⇒ realtime 用宿主时钟、不与接收端对时。
> 因此：
> - **判据去掉 `clock_ready`/`exchanges`**；cliairplay"真出声"的存在性判据改为 `[STATUS] playing` 出现且床侧落盘帧数 ≥ 期望时长 95%（本场实测 14.5s 连续、逐秒 RMS 4481±20、无静音）。
> - **A/B 不得用床 `out.pcm` 做逐字节/低延迟互相关**：该文件已过床的 `AudioResampler(48000)`，带 12/11 膨胀与帧填充（即批 4 已定量的那个偏差源）。正确口径 = **UDP RTP 头（`seq`/`timestamp`/`ssrc` 明文，是 AAD 不受加密影响）的到达时刻序列**：抓包得 `(arrival, rtp_ts)`，以各自 **RECORD 响应时刻**归一，比对同一 `rtp_ts` 偏移的到达时刻差 ≤20ms。
> - 床侧 `buffered` 在本床退化为 realtime（日志 `native AP2 forced (buffered request on NTP timing)`）；PTP 路也走不通——床侧**无任何 PTP 实现**（`ptp_port/ptp_proc` 从未使用，`ap2/` 下无 ptp 模块）。
> - **床源码行号以「实例副本」为准（QA 复核订正，2026-10-25）**：运行态是 `/root/ap2bed/ap2-1/ap2/connections/audio.py`（1030 行），**不是** `/root/ap2_bed/`（那是主副本 `/tmp/ap2recv`）。`AudioResampler` 构造 **554-558**、`self.resampler.resample(frame)` 调用 **617**（原记 616，差 1）；`sample_rate` 由 420/425-438 映射（48000 分支在 436）。`RTPRealtimeBuffer` class **180**、`deque(maxlen=self.BUFFER_SIZE)` **197-199**、`appendleft` **221-223**、`pop()` 取**右端**（= 最旧 = 下一个该播）⇒ 满载时淘汰的正是下一个该播的包，成立。

> **注③（Phase 6b A/B 实测结论，2026-10-25）：`≤5ms` 不能挂在「绝对起播时刻」上；实测 Δ=−13.16ms（≤20ms PASS），且「`A−L` 错一整个 L」被反证排除。**
> 工具：`/tmp/ab/ab_rtp_lead.py`（纯 stdlib，自实现 pcap 解析 + RTP ts 32bit 解卷绕 + 最小二乘 + 三段窗 + seq 丢乱序）+ `ab_run.sh`。**无需解密**（`seq/ts/ssrc` 在明文头）。抓包必须 `-i any`（两端都在 230，走 lo，`-i ens2` 抓不到自发自收）。
> 实测（rate=44100，各 1503–2018 包，0 丢 0 乱）：

| 场次 | 首包−RECORD | ready→首包 | 截距 lead | slope | drift | 残差RMS | 三段窗 |
|---|---|---|---|---|---|---|---|
| cli S0（尽快发） | 515.95 | 47.86 | 415.55※ | 0.999999 | −0.0001% | 0.34 | 427.7/415.6/415.3 |
| cli S+1500ms | 1409.23 | 945.94 | 1408.83 | 0.999998 | −0.0002% | 0.32 | 1408.8/1408.9/1408.9 |
| cli S+3000ms | 2907.01 | 2433.31 | 2907.04 | 0.999998 | −0.0002% | 0.32 | 2907.1/2907.1/2906.9 |
| ours r1 | **502.79** | **13.49** | 499.16 | 1.000049 | +0.0049% | 0.53 | 499.4/499.5/498.8 |
| ours r2 | 534.10 | 35.24 | 519.69 | 0.999938 | −0.0062% | 0.53 | 520.4/520.3/520.3 |

> ※ cli S0 的截距被拉偏 ~100ms：`START` 已过期 ⇒ cli 把预灌的 600ms 一次性补齐，头 500ms 音频挤在 48ms 内发完（最小到达间隔 0.062ms），头段 arrival-vs-ts 非线性。**该场只能用「丢头 2s 稳区拟合」或「精确首包」两条路**。
> - **判据拆分（已写入验收矩阵 6b 行）**：① 严格——排程保真 `|slope−1|≤5e-5`、残差 RMS≤1ms、三段窗截距极差≤1ms、零丢乱序（三家全 PASS）；② 宽松——起播对齐，锚=**SETUP 响应**到达（原 `RECORD` 锚已弃用：床侧 `SETUP(stream)` 开销 461.8–465.7ms 占该区间 98.4%，测不出我方，见注④-补）、量=首包，`|Δ|≤20ms`（`502.79 − 515.95 = −13.16ms` PASS）。
> - **Δ 的可分解来源（无一项是映射错误）**：床侧 `SETUP(stream)` 处理 **463–487ms（逐场抖 ±12ms）**决定 lead 绝对量级，与 sender 无关；cli 在 stream-ready 后还发 volume + metadata 两个 `SET_PARAMETER`（+468/+515ms，吃掉 47.86ms），我方中间无 housekeeping（13.49/35.24ms）；cli 有 `warm_lead_ms=600` 预灌、我方无（结构性设计差异）；我方自身 r1/r2 复现性 ±31ms。
> - **`A−L` 错一整个 L 的反证**：若错 L≈1000ms，截距会整体平移 ±1000ms、三段窗 Δ 会是 1000ms 级；实测 slope 1.000000±5e-5、drift ≤0.006%、残差 0.32–0.53ms、三段窗极差 ≤0.7ms。
> - **待办（协议保真）**：cli 每场**首包 `marker=1`**，我方 `marker=0` —— 真机可能敏感，建议对齐（`rtpAudio.ts`）；我方「ready→首包」13.49 vs 35.24ms 的 22ms 抖动值得单独看一眼（理论应 <5ms）。
> - 打点说明：AP2 的 RTSP 在 pair-setup 后被 HAP 加密（pcap 无明文 `RECORD`），故在床 `do_RECORD` 入口加 µs 打点写 `rtsp_anchor.log`（同机同 `CLOCK_REALTIME`、对两个 sender 对称）；**该打点恒定晚于报文到达 +0.65ms**（用 S1500/S3000 两场残差都是 +0.65ms 证明）。配对 RECORD 时**不能加容差**，否则会把紧随的 `SETUP(stream)` 误认成 RECORD。

> **注④（首包延迟抖动归因，2026-10-25）：30ms 极差在我方，但不在设备侧、也不在 socket/重采样/首次 pull —— 落在「SETUP 响应上线 → 我方 `await request()` 感知到」这一段。**
> 工具：`MUSICFLOW_AP2_TRACE=1` 门控埋点（`ap2/ap2Trace.ts`，缺省零开销：门控常量模块加载期求值、`if (this.trace)` 短路、不建 observer/定时器、不写文件）+ `/tmp/ab/ab_rtp_lead.py` 抓包劈段。

| 可疑点 | 实测 | 判决 |
|---|---|---|
| #1 设备侧 accept（`await timing.connect()`） | 0.62–1.30ms，极差 0.68ms | **排除**（量级小且稳定） |
| #2 首次 `pull()` | 33–62µs，`pullWaitMs` 恒 0 | **排除** |
| #4 `await import("node:dgram")` / #7 `createSocket("udp4")` | 0.23–0.52 / 0.54–0.98ms | **排除** |
| #3 事件循环（`dCallerSched` 0.21–0.38ms；`loopDelayP50` ≈ −0.33…−0.46ms 是 `setTimeout(wait)` 的 ms 截断导致平均早醒，不影响 `nextAt` 累加，drift ≈ +0.0001%、rate_meas ≈ 44099.9） | 无异常 | **排除** |
| **段① head_gap（响应上线 → 我方感知）** | **4.6–9.5ms；冷启动场反推 26–30ms** | **真凶**：`rtspClient.exchange()` 的 `await new Promise(r=>setTimeout(r,10))` 轮询网格 + tsx 按需转译/GC 造成的定时器回调拖延 |

> - 埋点窗口内总共只有 4.13–7.39ms（极差 3.26ms），而 ready→首包 可达 36.6ms ⇒ 大头在窗口之外；同代码同床每场整床重启，5 场 ready→首包 = 6.23 / 13.49 / 32.51 / 35.24 / 36.58ms，**极差 30.35ms ⇒ 抖动在我方，不是设备侧**。
> - 方案甲（把 `sink`/`sender` 构造挪到 `timing.connect()` 之前）极差 27.66ms、**没收窄，已结案**（且整体变冷，`dSocketUs` 从 0.54–0.98 涨到 0.78–3.12ms）。
> - 🔴 **这条直接影响 6b 判据**：我方 lead 自带 ±30ms 方差，而 6b 起播对齐判据是 `|Δ|≤20ms` ⇒ 判据会被自己的启动抖动随机打穿。因此 **`rtspClient.exchange()` 必须改成 `HttpFramer` 出帧即 resolve（按 CSeq 配对，保留 8s 超时兜底）**，改完再复测 A/B 三场定案；A/B 取样也不应用 `npx tsx` 冷启动（应走编译产物或先跑一场预热）。
> - 坑：`ab_run.sh` 不能用 `SKIP_BED=1` 自己重启 —— 会跳过 `rtsp_anchor.log` 截断，锚点取到上一场，lead 直接算成 2678437 ms。

> **注④-补（事件驱动改造完成 + QA 独立复核订正，2026-10-26，commit `7b8c49b`）：改造在代码层消掉了 10ms 量化台阶，但「端到端极差 30.35ms → 3.5ms」这个表述**不成立**（跨口径 + 挑样本），正确表述见下表。**
>
> - 改造内容：`rtspClient.exchange()` 从模块级轮询函数改为类内事件驱动 —— `pending: Map<CSeq>` 在途表 + `feed()` 抽干 framer 后立即 `dispatch()`（响应按 CSeq 严格配对，对不上只 debug 丢弃、绝不猜）+ 超时只留单次 `setTimeout` 兜底。**成功路径零定时器。** `destroy()` / `emitClose()` 均先 `rejectPending` 再拆连接。
> - 🔴 **QA 复核纠正两处（原稿错误，已作废）**：
>   1. 「改造前 5 场 trace `totalUs` = 6230 / 13490 / 32510 / 35240 / 36580」**不是 trace 数据**，而是 pcap 的 `fit.lead_first_stream_ms`（依次来自 `yi_2.json` / `j_ours_r1.json` / `yi_3.json` / `j_ours_r2.json` / `yi_1.json`）。全部 23 条 trace 记录的 `totalUs` 值域里**没有这 5 个数**。
>   2. 因此拿它们与改造后的 trace 值（8130 / 4609 / 7054）比极差是**跨口径**；且改造前样本从 j(2 场) + yi(3 场) 里挑，同期同 harness 的 tp 批（15.532 / 9.675 / 15.022）与 ja 批（38.942 / 32.277 / 11.283）被排除 —— 只取 tp 三场极差只有 5.86ms，取 j+yi 恰好凑出 36.58 / 6.23 两端。
> - **同口径真实对照（QA 独立复算）**：
>
> | 口径 | 改造前 | 改造后 | 判决 |
> |---|---|---|---|
> | trace `totalUs`（进程内，SETUP 响应 → 首包发出） | 6 场正常样本 4130–7391µs，极差 **3261µs**（ja 批 19496 / 22129 是 `dTimingUs` 2445 / 4864µs 的 timing 通道异常场，单列排除） | 4609–8130µs，极差 **3521µs** | **无差异**（改造后并未更优） |
> | pcap `lead_first_stream_ms`（机外，SETUP 响应 → 首包到达） | 11 场 6229–38942µs，极差 **32713µs**（8/11 场 > 11ms） | 5971 / 8458 / 10008µs，极差 **4037µs** | 改造后更集中；但改造前样本跨多个时段与负载（tp 三场极差仅 5.86ms），**不能排除负载条件差异的贡献** |
> | pcap − trace（内核发送 + 抓包落地差） | 3.6–16.8ms | 1.36–1.90ms | 改造后明显变小 |
>
> - **当前能支持的结论**：改造在代码层确实消掉了一个结构性的 10ms 量化台阶（`setTimeout(r,10)` 已从实现移除；单测「到达即 resolve」实测 0.163–0.287ms）。但**端到端可测改善尚未与负载条件差异区分开**，不能宣称「抖动降 8.6 倍」。定案需要**同机同时段交替 A/B**（用 `b1303a8` 与 `7b8c49b` 两版 dist 交替各跑 3 场），**尚未做**。
> - **区间定义已核实**：`ap2Trace.ts:162` `totalUs = tFirstSendUs − tSetupRespUs`；`ap2Stream.ts:277 markSetupResp(nowUs())`（SETUP(stream) 响应到达）/ `:407 markFirstSend`（判据 `sentPackets > before`）。两种口径都从「SETUP 响应到达」起算、**都排除了床侧 SETUP 开销**（与 QA 复核一致）；区别只在 trace 是进程内时刻、pcap 含内核发送与抓包落地。
> - 🔴 **口径订正一**：`RECORD → 首包` **被床侧主导**，不能作为我方抖动判据（QA 独立证实）。
>   - ours 三场 = 478.440 / 472.098 / 471.785 ms，其中床侧 `SETUP(stream)` 处理 = 465.731 / 466.127 / 463.327 ms（占 **97.9–98.7%**），我方只占 5.97–10.01 ms。
>   - **床侧 ~462ms 的根因（QA 读源码定位）**：`/root/ap2bed/ap2-1/ap2-receiver.py:1332` 用 `multiprocessing.set_start_method("spawn")` ⇒ 每个子进程都是**新解释器 + 重新导入床的 `__main__`（av / numpy / pyaudio 等重依赖）**；`recv.log` 里 30+ 条 ALSA 枚举错误与 `jack server is not running` 连接失败。微基准：空子进程 `start()` 仅 0.9ms、子进程就绪 46.4ms；重依赖导入是数百 ms 量级，两个子进程（`Control` + `AudioRealtime`）即 460ms 量级。⚠️ 未埋点做精确分摊，**只能定性**。
>   - 注：自报的「床侧 465.731 / 464.261 / 461.759」以 `t_stream_req` 起算；按 `t_record` 起算应为 468.432 / 466.127 / 463.327（差 1.6–2.7ms），结论不变。
> - 🔴 **口径订正二**：`首包到达时刻差` **不是排程保真判据**。它测的是「谁先开始发首包」。
>   - QA 实测 cli 的 `SETUP响应→首包` **不是固定 43ms，而是随 `START_OFFSET_MS` 整体平移**：offset 0 → 47.865ms；120 → 43.881 / 43.122ms；**1500 → 939.890 / 945.943ms（两场独立吻合，Δ6.05ms）**；**3000 → 2433.314ms**。offset 1500→3000 使该区间 **+1487.4ms ≈ 1500ms** ⇒ cli 确实在等自己的计划起播时刻。
>   - 所以「cli 固定 43ms」只在 offset ≤120 成立，**不能当 cli 的特性引用**；且 cli#2/#3 把 offset 改成 +120 ⇒ 与 2026-10-25 的 A/B（同为 +1500）**不可比**，Δ=−29.8 ~ −36.5ms 混入了计划偏移。
>   - 排程保真只看「**同一 `rtp_ts` 偏移的到达时刻差**」。方法论成立（cli 的 RTP 时间轴锚在 `START_UNIX_MS`，首包到达随 offset 整体平移，只有按 `rtp_ts` 对齐才消得掉）；但 2026-10-25 的 Δ=−13.16ms / slope 1.000000±5e-5 / 残差 0.32–0.53ms **本轮未独立复现**（那次用的是工程师脚本，按复核要求不复用）。
> - 🔴 **锚点 `A` 与本次改造无关（QA 代码级证实，比我原先的推断更准确）**：
>   - **`A` 不是 RECORD 响应时刻**：`bridgeSession.ts:169` `let anchorUs = opts.firstFrameTsUs;` —— A = 桥上行的**首帧 AUDIO 帧 `tsUs`**（内容时间线）。
>   - `raop.ts:649-656` 的 `ntp0` / `headTs` / `baseTs` / `startNtp` 是在**发 RECORD 之前**取的本地时钟；RECORD 响应只用来读 `Audio-Latency` **头数值**（`raop.ts:665-670`），**不取时刻**。
>   - AP2 realtime 的 RTP ts 是纯帧计数（`rtpAudio.ts:63-90` `ts = (ts + samplesPerFrame) >>> 0`）；`Date.now()` 只用于 pump 节拍 `nextAt`（`ap2Stream.ts:391`）与 trace 埋点，不进 RTP 时间戳。
>   - ⇒ 响应被更早感知 0–10ms（甚至 100ms）都**不会移动 A 或 RTP 时间轴**，与 sendspin 组 `tsUs` 的对齐不受影响；`BridgeTimelineAligner`（阈值 441 帧 ≈ 10ms，`bridgeSession.ts:82/96`）**无需介入**。
>   - 补充：`git show --stat 7b8c49b` = 仅 `rtspClient.ts`(+185) + 两个测试文件，`raop.ts` / `bridgeSession.ts` / `streamEngine.ts` **零改动**。
> - 方法学：QA 用独立路径复算（自写 stdlib pcap 解析器 + tcpdump 直取时刻 + 逐字段重算 json），**未复用**工程师的 `ab_rtp_lead.py` / `rt_sum.py` / `rt_run.sh`。

> **注⑤（「4.4% 偏差」作废 + 床侧现象重新归因，2026-10-25 复算）：两个现象必须分开陈述，不能合成一个数，且「4.4%」无法由任何 artifact 复现。**
> 工具：`/tmp/ap2recv/fft_peak.py`（纯 stdlib，N=65536 + Hann + 抛物线插值，bin 0.73Hz）、`resamp_probe.py`（采样率组合穷举）+ 我方 RTP dump 独立解密解码口径（不经 Resampler）。

| 量 | 实测值 | 测量方法 | artifact |
|---|---|---|---|
| (a) 结构性**帧数**膨胀 | **+9.0909%（精确 12/11，每包 352→384 帧）** | 床 out.pcm 帧数 ÷ 我方发出帧数 | `bed_out_44c.pcm` 1,442,688 帧 vs `manifest44c.json` 3757×352=1,322,464 |
| (a') 床输出数据率 | **48kHz**（按 48k 解释主峰对得上源 440/1000，按 44.1k 对不上） | 同一 PCM 两档 FFT 对照 | 同上 |
| (a'') 时长守恒 | 30.056s @48k vs 源 30.0s（**+0.19%**） | 帧数÷采样率 | 同上 |
| (b) **实测 FFT 主峰偏移** | **−0.222%（440 轴）/ −0.227%（1000 轴），两峰同步** | 双音 FFT 主峰比 | `bed_out_44c.pcm` vs `in44c.pcm` |
| (b') 我方自身链路偏移 | **≈0（+0.001%/−0.001%）** | RTP dump 独立解密 + ALAC 手工交织解码后 FFT | `rtp44c.dump` → `dec44b.pcm` |
| (c) 床输出周期污染 | **+124.99Hz 强边带（=48000/384），比载波强约 7dB** | 主峰旁最强谱线间隔（564.005−439.012 / 1122.727−997.744） | 同上 |
| (d) 床写出率 | 44.1k 场 **100.23%**；**48k 直通场 36.36%** | out 帧数 ÷ 理论 resample 帧数 | `bed_out_44c.pcm` / `bed_out_48d.pcm` |
| (e) 48k 直通场 FFT | 460.00 / 1040.00（vs 源 440/1000 → +4.55%/+4.00%，**两峰不同步**） | 同 (b) | `bed_out_48d.pcm` |

> - **9.09% 是"帧数膨胀"，不是"音调偏移"**：它同时把数据率从 44.1k 提到 48k，**时长守恒** ⇒ 根本不产生音调偏移 —— 这正是实测只有 −0.22% 的原因。两者**量纲不同，不能相减**，「差的那 9.3 个百分点」不存在。
> - **「4.4%」作废**：最接近的两个数是 `√(12/11)−1 = +4.4466%` 与 `(48000/44100−1)/2 = +4.4218%`，都像把 12/11 做了开方/折半，**无任何实测对应**。
> - **「30s 只写出 34%」属于 48k 直通场（本次 36.36%），不是 44.1k 场（100.23%）**：deque 满载淘汰是**另一个独立缺陷**，重采样反而改变了排空节奏、让 44.1k 场避开了满载。**两者不要写进同一句**。且 48k 直通场丢包 64% 后频谱已破坏（两峰不同步），**不能用来做频率判据**。
> - (c) 的 384 帧**不是标准 resample 行为**（`44100→48000` 标准输出是 383/384 抖动，凑不出恒定 384）⇒ 床是每包恒定补到 384 帧，周期性补帧正好产生 125Hz 边带。**这是失真，不是音调偏移，单列**。
> - 结论方向不变：**床侧缺陷，我方链路偏移 ≈0**；但我方判据从此改用「RTP dump 独立解密解码 vs 源」口径（注②/注③），不采用床 out.pcm。

- 若目标设备只支持 buffered，Phase 6 不能宣称 AP2 完成。

### Phase 7 · AP2 buffered + PTP（独立，3~5 天）

- buffered stream type 103，RTP/TCP，PTP 时钟。
- 共享 PTP daemon，组内绝不混 NTP/PTP；spawn 窗口未就绪整组降级策略需重新评估（buffered 不能无 PTP）。
- AP2-only 发现：修改 `discovery.ts` 只允许 `_raop` 的规则，并同步测试/守卫。
- Apple 接收端 NTP realtime 无声问题建矩阵：设备型号 × 协议 × 计时源 × 结果。
- 出口：buffered 单设备 A/B、组内 PTP 同源、无 NTP 回退混用。

### Phase 8 · 守卫与收尾（1 天）

- `check-airplay-bridge.mjs` 注册 CI。
- CHANGELOG、灰度说明、回滚开关。

---

## 9. 守卫矩阵

| 守卫 | 保护 |
|---|---|
| `check-renderer-host.mjs` | 禁自建 fork/worker/in-proc；bridge 仍在两个 renderer 子进程 |
| `check-airplay-playback-chain.mjs` | PLAYING 时序；与源码同 commit 适配 |
| `check-airplay-dlna-mutex.mjs` | AirPlay↔DLNA 互斥；**bridge 会话必须被排除在 `stopAirPlaySessionsForHost` 之外**（MAJ-06） |
| `check-airplay-decode-af.mjs` | 不得新增 af 归一点 |
| `check-airplay-rtsp-line.mjs` | RTSP 请求行不变 |
| `check-airplay-stream-auth.mjs` | `/rest` 鉴权豁免不变 |
| `check-airplay-ap2-discovery.mjs` | Phase 6 不改发现规则；Phase 7 才允许改 |
| **`check-airplay-bridge.mjs`（新）** | 见下，14 条 |

`check-airplay-bridge.mjs` 的断言清单（每条都钉**唯一表达式**，同一字符串出现在两处会让守卫失效）：

| # | 断言 | 对应问题 |
|---|---|---|
| ① | `tsUs`/RAOP 锚点链不得出现 `Date.now`/`performance.now`/Unix | 时钟域 |
| ② | `latencyFrames` 不得被赋 0 或 `Math.min(...,0)` | 已证伪旧设计 |
| ③ | **常量唯一源 + 取值钉死**（合并原③⑧，NIT-03）：`rates.ts` 必须含 `SENDSPIN_RATE=48000`/`AIRPLAY1_RATE=44100`；`147/160`、`4500_000/2500_000/1000_000`、`384*1024`/`1536*1024`、`800_000`、`0.3627` 各只出现一次且值不变；换算只在 `bridgeMath.ts`，重采样只在 `resampler.ts` | 速率/常量漂移 |
| ④ | PCM 不得走 JSON IPC | 通路 |
| ⑤ | 不得有 `start(anchorUnixMs)` 旧接口 | 时钟域 |
| ⑥ | bridge 路由 `fanOut` 必须跳过 solo cast | 双会话 |
| ⑦ | `members` 不得被改成宽泛 `Set<any>`，也不得被 `bridges` 并入 | 组语义 |
| ⑧ | `commonSendAheadUs()` 实现里**不得出现** bridge/lead 相关标识（MAJ-01 回归防线） | 全组 +3.7s |
| ⑨ | `pushFrame` 必须含虚拟 `pcm:100` 组补偿（BLK-01） | 桥收不到字节 |
| ⑩ | `playGroupCore`/`g.close()` 路径**不得**出现清 `bridges` 的调用（BLK-02） | seek 丢桥 |
| ⑪ | bridge 代次必须取自**二元组** `epoch * 1_000_003 + timelineReseed`（`get generation()`），且**不得**在 `rehost()` 里出现 `this.epoch++` | 代次漏 rehost |
| ⑫ | RAOP RECORD 后四个锚点必须同域：`baseTs` 出现在赋值列表里；顺序必须是「先 `>>> 0` 再 `% CHUNK_LEN`」；**不得**出现 `& 0xFFFFFFFF` | MAJ-09/10 |
| ⑬ | 不得伪造 `acked` 字段；报告字段名必须是 `scheduledAnchorUs` | 无 ack |
| ⑭ | socket 路径必须是 `mfab/<短 hash>` 形式，不得把 deviceId/token 拼进文件名 | MAJ-05 |

---

## 10. 验收判据与脚本

### 10.1 非静音

```bash
/root/ssvenv/bin/python - <<'PY'
import numpy as np
# AP1 走接收端真抓（arecord -f S32_LE，BLK-04）；AP2 床走 recv 落盘
# ⚠️ 三者位深不同：AP1 = S32(÷2³¹)、fake = S16(÷2¹⁵)、AP2 床看会话协商
for p,dt,full in [('/root/fake1.pcm','<i2',2**15),
                  ('/root/ap1_cap_44.pcm','<i4',2**31),
                  ('/root/ap2bed/ap2-1/out.pcm','<i2',2**15)]:
    a=np.fromfile(p,dtype=dt)
    if a.size==0: print(p,'EMPTY'); continue
    peak=int(np.abs(a).max())
    rms=20*np.log10(max(1e-12,(a.astype(float)**2).mean()**0.5/full))
    print(p,'peak',peak,'rms_dbfs',round(rms,1))
PY
```

判据：`peak > 1000` 且 `rms_dbfs > -40`。
> 🟡 **实测修正（2026-10-25）**：AP1 侧因 shairport `ignore_volume_control is 0`（RAOP 音量直接作用于输出），实测 peak −39.56 dBFS、rms −54.5 dBFS，**达不到 `> -40` 这条**。⇒ 判据改为「nonzero_ratio > 0.9 且分段 RMS 起伏 > 3 dB」（证明是真音频、非恒定噪声），绝对电平不再作为门限；跨用例比较前须固定设备音量档。

### 10.2 互相关（FFT + wrap-aware，唯一脚本 `backend/scripts/cc_align.py`）

> **NIT-01 定案**：只保留 `backend/scripts/cc_align.py` 一份实现，本文与《落地方案》都改成"见该脚本"，不再各自内联。两份实现是长期漂移的温床（上一版就出现了 `seed=1/7`、容差 `<0.1/0.5` 两种参数）。

```bash
# 用法：cc_align.py <a.pcm> <b.pcm> [rate]
/root/ssvenv/bin/python /workspace/MusicFlow/backend/scripts/cc_align.py \
    /root/fake1_44.pcm /root/ap1_cap_44.pcm 44100
# 期望首行：[selftest] OK  delta=137.0 ms  quality=1.000
# 末尾：    delta_ms = <x>   quality = <q>   JUDGE: PASS|FAIL
```

脚本必须内置（缺一条都不算合格）：

1. **137ms 自检**：构造 `a` 比 `b` 晚 137ms，输出必须是 `+137.0`（容差 0.5ms）。自检不过直接 `sys.exit(1)`，不许出 Δ 数字。
2. **wrap-aware lag**：`lags = np.arange(n); lags = np.where(lags > n//2, lags - n, lags)`。连续 `arange(-len(b)+1, len(a))` 是错的（实测给出 −2862.98ms 假峰位）。
3. **质量门**：`quality = cc[k] / sqrt((a·a)(b·b)) ≥ 0.2`，否则判 `FAIL`。
4. **窄带源检测（BLK-03）**：统计 lag 轴上所有 1ms 整数倍处的 `quality`，若 ≥2 个点同时 >0.99 ⇒ 打印「源不适用（窄带/周期信号），请用宽带源」并退出，不出 Δ。
5. **尾窗**：默认取最后 10s。取文件头量到的是"会话起始时刻差"，不是同步误差。

前置（**两侧必须先同速率**）：

```bash
# AP1 采样率 44.1k；fake 是 48k，先统一到 44.1k
ffmpeg -f s16le -ar 48000 -ac 2 -i /root/fake1.pcm \
  -af aresample=44100:filter_size=64:phase_shift=10 \
  -f s16le -ar 44100 -ac 2 -y /root/fake1_44.pcm
```

> ⚠️ **这个 `aresample` 滤镜自身有群延迟**，会直接加进 Δ（MIN-08）。若用它，必须先用脉冲测出该滤镜的群延迟并在 Δ 里扣除；**更优做法**：让假 Sendspin 侧也直接落盘 44.1k（`--out` 前先重采样，或用同一份 44.1k 源分别投两侧），让重采样不进入比较链。

- 相关前必须去掉静音头/尾，取共同内容区间。
- 阈值分档（MIN-08）：**同协议/同采样率 ≤5ms；跨协议 ≤20ms（上限，不是目标）**。20ms 相对采样粒度（44.1k 22.7µs / 48k 20.8µs）宽了三个数量级，技术上不难过，但对"多房间同步"偏松（双扬声器梳状滤波 1~2ms 起可闻）。

### 10.3 基频/抗混叠

```bash
/root/ssvenv/bin/python - <<'PY'
import numpy as np

def peak_hz(path,rate,f0=1000.0):
    a=np.fromfile(path,dtype='<i2').astype(float)
    w=a[-rate*5:]
    sp=np.abs(np.fft.rfft(w*np.hanning(len(w))))
    f=np.fft.rfftfreq(len(w),1/rate)
    p=float(f[np.argmax(sp)])
    print(path,'peak',round(p,2),'dev%',round((p/f0-1)*100,3))

peak_hz('/root/fake1.pcm',48000)
peak_hz('/root/ap1_cap_44.pcm',44100)
PY
```

判据：AP1 1000Hz 偏差 ≤0.5%；1088Hz 说明没重采样；23kHz 输入在 AP1 落盘应衰减 ≥40dB。

### 10.4 假 Sendspin

```bash
python3 -m py_compile /root/fake_sendspin.py
/root/ssvenv/bin/python /root/fake_sendspin.py --probe
/root/ssvenv/bin/python /root/fake_sendspin.py --name FAKE-1 --out /root/fake1.pcm
```

`--probe` 只验证 client 构造；真实收流需服务在 38927 监听并完成配对。

### 10.5 `delta` 的定义与统一日志格式（🔴 MAJ-08，旧稿只写了"`delta` 稳定"）

`delta` 没有定义就无法写脚本断言"稳定"，用例 4/6 事实上不可执行。定案：

```ts
// 成员 vs 组时间线（不是成员 vs 成员，也不是成员 vs 墙钟）
delta_us = memberPlayheadUs - (group.timelineBaseUs - memberBufferDepthUs);
//   memberPlayheadUs   = 该成员"当前正在播的内容位置"映射回 host 时间
//   memberBufferDepthUs= 该成员自己的缓冲深度（sendspin 设备用 sendAhead，桥用 L + 队列时长）
//   > 0 ⇒ 该成员落后于组时间线
```

`[airplay-bridge] stats` 每次采样（默认 2s）输出**一行 JSON**，便于 grep 与脚本解析：

```json
[airplay-bridge] {"ev":"tick","dev":"<id>","gen":7,"state":"live","clock":"local-rtp-ntp",
 "queueMs":142,"maxQueueMs":380,"late":0,"realigned":0,"driftUs":-1200,
 "deltaUs":8400,"deltaP95Us":11200,"samples":5,"anchorUs":8123456789,"leadUs":2500000}
```

- 验收写法：**10s 窗口内 `p95(|delta_us|) ≤ 20ms`，且无单调漂移（斜率 ≤ 1ms/10s）**。
- `delta` 不稳定时要能区分：`driftUs` 涨（本地对齐错）vs `deltaUs` 涨（锚点错）vs `late` 涨（lead 不足）。
- **每个关键决策点都要有可 grep 的一行**：`bridgePrepare` 结果、锚点确定（`ev:"anchor"`）、`generation` 变更（`ev:"gen"`）、`stalled`/`overflow`、`degraded`。缺任何一类，对应验收用例都无法自动判定。

### 10.6 AP2 床

```bash
/root/ap2_bed.sh stop
pkill -9 -f 'ap2venv/bin/pytho[n] -c' || true
/root/ap2_bed.sh start 1
/root/ap2_bed.sh status      # 7200 LISTEN
tail -20 /root/ap2bed/ap2-1/recv.log
```

块间整床重启；AP2 发送端探针用 RTSP OPTIONS/SETUP，不以 `curl /info` 为唯一判据。

---

## 11. 验收总表

| # | 场景 | 判据 | 阶段 |
|---|---|---|---|
| 1 | 假设备真实收流 | `[first]` + peak/rms | P0 ✅ **240 实测通过**（peak 26131 / RMS −17.1 dBFS，`--unpaired` 绕过配对） |
| 2 | AP2 床可起 | 7200 LISTEN + mDNS | P0 ✅ 已过 |
| 2b | **AP1 接收端真抓** | `arecord -f S32_LE` 非静音、分段 RMS 有起伏 | P0 ✅ **240+230 实测通过**（peak −39.6 dBFS、nonzero 1.0、RMS 起伏 12.3 dB） |
| 2c | **Δ 测量链端到端** | 同歌投两设备，多窗口 Δ 一致 | P0 ✅ **实测 −7461.4 ms × 3 窗口恒定**（桥接实现后应收敛到 ≤20 ms） |
| 2b | **AP1 抓取链**（BLK-04） | `arecord -D hw:Loopback,1 -d 5` 落盘 peak>1000 | P0 |
| 2c | **测试源就位**（BLK-03） | 宽带源 + 1k/15k/23k 正弦各一份；互相关脚本对 1kHz 源报"源不适用" | P0 |
| 3 | 通道完整性 | 10 万帧往返一致，RSS 稳定 | P2 |
| 3b | 半包注入 | 写 10 字节后断开，解析不错乱；kill -9 后 ≤6s 重连 | P2 |
| 4 | AP1 出声 | 落盘非静音、44.1k | P2/P3 |
| 5 | 组泵出声 | fake + AP1 非静音，无重复会话 | P3 |
| 5b | **`members=∅` + bridge**（BLK-01） | `pushFrame` 返回 >0，bridge 收到字节 | P3 |
| 5c | **纯 sendspin + 1 bridge**（MAJ-01） | 真实设备 `delta` 无常数 +3.7s 偏移 | P3 |
| 6 | 跨协议同步 | `\|Δ\|≤20ms`，quality≥0.2，`p95(\|delta\|)≤20ms`，斜率≤1ms/10s | P4 |
| 6b | **与 cliairplay A/B** | ① 排程保真（严格）：`|slope−1| ≤ 5e-5`、回归残差 RMS ≤1ms、三段窗截距极差 ≤1ms、零丢乱序；② 起播对齐（宽松）：锚=**SETUP 响应**到达（原 `RECORD` 锚已弃用：床侧 `SETUP(stream)` 开销 461.8–465.7ms 占该区间 98.4%，测不出我方，见注④-补）、量=首包，`|Δ| ≤ 20ms`。**口径见注②/注③**：抓 UDP 明文 RTP 头 `(arrival, rtp_ts)`；**禁用床 `out.pcm` 做互相关**（过 bed `AudioResampler(48000)` 有 12/11 膨胀）。✅ **2026-10-25 实测：① 全 PASS（slope 1.000000±5e-5、残差 0.32–0.53ms、三段窗极差 ≤0.7ms、0 丢 0 乱）；② Δ=−13.16ms PASS** | P4 ✅ |
| 7 | 起播映射 | 首包可听 = A ±1 sample；late=0 | P4 |
| 8 | 速率 | 1kHz→1kHz ±0.5%；23k 衰减 ≥40dB | P1/P4 |
| 9 | 晚加入 | 落后 ≤8s 且 10s 内收敛到 ≤20ms；不倾倒 | P5 |
| 10 | seek | 3 次均出新 generation + 新 `scheduledAnchorUs`；旧代次丢弃 >0；`bridges.size` 不变 | P5 |
| 10b | 暂停/恢复 | 暂停期 `late` 不涨；恢复后 Δ ≤20ms | P5 |
| 11 | 队列溢出 | 状态机 `live→stalled→connecting→live`；随机静音=0 | P5 |
| 12 | 子进程崩溃 | 无残留会话，能重建 | P5 |
| 12b | **多桥并发**（MIN-11） | AP1×1+AP2×2+假 Sendspin×1 同组 30min：RSS 增长<20MB，每桥 `maxQueueMs<2000`，`late=0` | P5 |
| 13 | 纯 AirPlay 组 | 旧 cast 行为零变化（RTSP 报文序列 diff 为空） | 每阶段 |
| 14 | 真机 240 | 流转/群组增删/纯 AirPlay/sendspin 回归 | 每阶段 merge 前 |
| 15 | AP2 凭据（6a） | 重启进程后免 PIN 重连 | P6a |
| 16 | AP2 A/B | Δ≤20ms，速率按 SETUP 写日志 | P6b |
| 17 | AP2 buffered/PTP | 组内日志 `clock=PTP` 计数一致，任一 `clock=NTP` 即 FAIL | P7 |

> **晚加入用例（#9）的两个限定**（复验补充）：
> 1. **seek 之后 ≥3s 再加入**。`g.close()` 会清 `recentByGroup`，seek 刚结束那几秒 ring 是空的，此时新成员必然拿到 `seedLateJoin = 0` —— 这是设计行为，不是缺陷，但会让用例偶发红。
> 2. 判据必须同时看"落后量"和"收敛时间"，只写"收敛"无法证伪。

---

## 12. 风险与回退

1. **最高风险是时钟域**：任何 `Date.now`/`performance.now` 进入锚点链都会造成跨进程偏移。守卫① + 单测锁定。
2. **第二风险是 `commonSendAheadUs` 被污染**（MAJ-01）：把 bridge lead 并进去会让**真实 sendspin 设备**恒定偏移 +3.7s（帧头不含 `send_ahead`，设备用自己的 800ms）。守卫⑧是这条的防线。
3. **第三风险是代次错源**（BLK-02）：挂 `timelineReseed` 就等于"seek 不换代"，且若把清桥挂 `stopGroupCore` 会整条桥丢掉。守卫⑩⑪。
4. **第四风险是 latency 双重计入**：`startNtp=A-L` 是唯一补偿点；`sendAhead` 只影响发送/启动，不再减一次。守卫②。
5. **第五风险是 `baseTs` 漏写**（MAJ-09）：只改三个锚点会让 `positionSec` 变垃圾，而且**不报错**——最难发现的一类。守卫⑫。
6. **第六风险是 32 位模域**（MAJ-10）：uptime >27h 后 `ntp2ts` 越界，现靠模运算侥幸自洽。守卫⑫ + `sec=100_000` 单测。
7. **第七风险是双会话**：native cast 与 bridge 同时抢同一设备。owner token + `detachFromActiveGroups` 纳入 airplay + `stopAirPlaySessionsForHost` 排除 bridge。
8. **第八风险是背压静默丢音**：hardCap 断连重连优于丢旧帧。
9. **第九风险是路由抖动**：流内固定路由，下一流再评估。
10. **验收链自身是风险源**（BLK-03/04）：1kHz 正弦测 Δ 会给出"必过"的假绿；发送端 PCM 落盘算 Δ 恒≈0。这两条比实现 bug 更危险，因为**看起来通过了**。
11. **AP2 不可低估**：HAP、加密 RTSP、ALAC 加密、PTP 都是独立工程；Phase 6/7 不得混为"一个 Phase 5"；6a 凭据契约是 6b 的门禁。
12. **回退**：`MUSICFLOW_AIRPLAY_BRIDGE=0` 即完整旧路径；不改 DB schema（P1~P5）；AP2 凭据复用 `hap_credentials`。
    - **已知缺口**：运行中把 flag 从 1 改 0 **不会拆掉已建立的 bridge 会话**，需重启或等下一首。这一点写进 CHANGELOG 与灰度说明，不要宣称"改 env 即时生效"。
13. **验收资产**：AP2 床每场会话后整床重启；假设备回调已修，但真实配对未验证；NumPy 已装；`cc_align.py` 与 AP1 抓取链尚未落盘（Phase 0 工作项）。

---

## 13. 事实核对纪律

1. 涉及常量/行号/协议能力/进程归属，必须附一次命令输出或文件行；拿不到证据写“待验证”。
2. 修正前先复验，不能以一次 grep 失败作为“不存在”的证据（`_cli_writer` 误判教训）。
3. 文档说“已改”必须同时检查实机文件（fake 44100→48000 教训）。
4. 验收脚本必须能运行：依赖先安装、算法先自检、速率先统一、lag 符号先验证。
5. 不能用“概念上对齐 MA”替代“在 MusicFlow 三进程里调用链闭合”。
