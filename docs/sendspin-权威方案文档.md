# Sendspin 权威方案文档

> **基线**：MusicFlow **v4.0.19** · ESPHome **2026.9.0** · ESP32-S3-DevKitC-1（Octal PSRAM 80MHz）· 对标 Music Assistant（`aiosendspin==9.1.1`）+ [Sendspin 官方协议规范](https://github.com/Sendspin/spec)
> **文档来历**：合并了仓库里此前 10 份分散的 Sendspin 文档（协议设计 / 实施计划 / 任务交接 / 真机排障 / 踩坑录 / FLAC 专项 / MA 对齐审计 / 多房流式方案 / 联调手册 / 模拟器说明），并以 v4.0.17 → v4.0.18 → v4.0.**19** 三轮真机实测的最新结论为准重写。原文档已归档到 [`docs/archive/sendspin/`](./archive/sendspin/)。
> **怎么读**：**第一～五部分是正确做法，照做即可**；**第六部分是踩过的坑（含被推翻的旧结论），务必别重蹈**；其后是验证方法、MA 对齐、环境与附录。
> **本文是唯一权威**。与归档文档冲突时，以本文为准。

---

## 0. 一分钟总纲

把「**服务端推流**」和「**设备缓冲**」当成两个独立系统，它们之间唯一的对接契约是设备在握手时宣告的 `buffer_capacity`（**字节**）。服务端据此算出「最多能提前灌多少秒」：

```
实际预填充水位(ms) = min( 档位, 30 秒(时长上限), 0.6 × buffer_capacity ÷ 实测压缩码率 )
```

- **超出即自动钳制**：档位比设备装得下的更大时，服务端把水位压到装得下的值并打日志说明，**不报错、不拒收**——被压的是「预填充水位」，不是功能失效。
- **想要更深的水位，唯一的正道是调大设备端 `buffer_size`**（容量变大，同一比例对应秒数更多），而不是指望把比例调高。
- 设备**不宣告** `buffer_capacity` 时退回 30 秒上限，行为与旧版本完全一致（向后兼容旧固件）。

四条最容易翻车的铁律（详见第二部分）：

| 铁律 | 一句话 |
|---|---|
| 音频帧头 **9 字节** | `[0x04][i64 大端 μs][data]`，**没有 `send_ahead`**。多一个字节就整条链路无声 |
| FLAC `codec_header` 的 **last 位必须为 1** | 头是单独发的；last=0 会让解码器撞帧同步码，**服务端全绿、设备零报错、就是没声** |
| 时间线**按实际产出**推进 + **绝对时刻调度** | 固定 sleep 会累积漂移；设备 hard-sync 阈值只有 **5ms** |
| 编解码**默认 FLAC** | ESPHome 默认偏好就是 `[flac, opus, pcm]`；PCM 是 2× 空口占用 |

---

# 第一部分：架构与职责边界

## 1.1 服务端权威模型

核心模型：**服务端权威播放**。`UniversalPlayer / QueueController / PlaybackTracker` 管理队列、播放状态、自动下一曲、换源/回退/跳过；renderer 插件只做**协议专属操作**。

```
QueueController ── registerSendspinDevice(clientId)
      │  ProtocolPlayer(play/pause/resume/seek/setVolume/pollState)
      ▼
sendspin/protocolPlayer.ts   ── 组/客户端协议操作
      ▼
sendspin/server.ts           ── WebSocket 服务端 + 握手 + 组模型
      ▼
sendspin/streamEngine.ts     ── 解码 → PCM → 按真实时间推帧（驱动 auto-advance）
      ▼
Sendspin 接收端（ESP32 sendspin-cpp / aiosendspin SDK / 硬件音箱）
```

**关键挂接点**：`backend/src/services/sendspin/index.ts#registerServerPlayer`（把就绪连接注册为 QueueController 的服务器权威播放器）。对照基准：`services/player/` 的 `QueueController`、`PlayerController`、`UniversalPlayer`，以及 `registerDlnaDevice` / `createDlnaProtocolPlayer` 的同款用法。

**形态**：仿 **AirPlay** 的「平行子系统 + 薄 renderer 适配器」——`services/sendspin/` 自含服务端（协议 + 流引擎 + 组/时钟 + 配对），`services/plugin/renderers/sendspin.ts` 只是把它暴露成 `renderer` 能力的薄壳。
**理由**：AirPlay 已是「服务端推送」模型并跑自有服务器；Sendspin 同构，对齐最省且已被验证。**外置沙箱插件不可行**——沙箱插件无 Node 能力，不能绑 TCP/WS 监听、不能用 Node crypto、不能跑流引擎；故 renderer 必须是内置插件（同 DLNA/AirPlay）。

## 1.2 模块职责（`backend/src/services/sendspin/`）

| 文件 | 职责 |
|---|---|
| `index.ts` | 装配 / 生命周期：启动 WS + mDNS + 配对存储；stop 关闭全部；fork-aware helper（`sendspinGroupPlay/Stop/Join/Leave`） |
| `server.ts` | `SendspinServer`：bind 38927、连接生命周期、明文期流程、`client/hello` 解析（含 `buffer_capacity`）、`SendspinGroup`（容量钳制、推流计量） |
| `identity.ts` | 静态身份密钥（X25519）生成 / 持久化 / 加载（数据目录 0600） |
| `handshake.ts` | Noise_KKpsk2 initiator，双 suite；Sentinel 回退；配对后 re-handshake |
| `framing.ts` | 加密后帧封装：JSON（type 0）、分片（2/3）、音频块（**9B 头**） |
| `messages.ts` | type0 JSON 收发 + 全角色事件派发 |
| `roles/` | `registry.ts`（`<role>@v1` 注册表、bin id 区间映射）、`player.ts`、`controller.ts`、`metadata.ts`、`artwork.ts`、`source.ts`、`visualizer.ts`、`color.ts` |
| `clock.ts` | `server/time` 应答；`nowUs()`（单调 μs）+ 测试接缝 `setNowUsOverride` |
| `group.ts` / `playerCore.ts` | 组模型、成员、公共 send-ahead、组音量/mute 算法、组播放/加入/退出核心 |
| `stream.ts` / `streamEngine.ts` / `streamSource.ts` | 推流引擎：ffmpeg 解码 → PCM → 逐客户端编码 → 按组公共时钟分块推；`PcmWindow` 流式窗口 |
| `encoding.ts` | opus / flac / pcm 编码器包装（libflacjs asm.js；ffmpeg） |
| `pairing.ts` / `pairingStore.ts` / `pairServer.ts` | 三配对法（码生成 + `StaticCodeGate`）/ PSK store（`pskIdForHex`）/ `SP:` token 编解码 |
| `protocolPlayer.ts` | `createSendspinProtocolPlayer(clientId\|groupId)`：实现 `ProtocolPlayer` 契约 |
| `discovery/mdns.ts` | 通报 `_sendspin-server._tcp`(38927)；监听 `_sendspin._tcp`(8928) |
| `childMain.ts` / supervisor | 常驻子进程 + IPC + 心跳看门狗 + 退避重启（v3.0.34 起；v3.0.39 起改用通用宿主 `services/rendererHost/`） |

## 1.3 端口与角色分工（先把这事钉死）

| 端口 | 归属 | 作用 |
|---|---|---|
| **38927** | **MusicFlow 的 Sendspin server** | 控制 + 音频**共用一条 WebSocket**（刻意避开 MA 的 8927） |
| 8927 | Music Assistant 的 Sendspin server | 同上（MA 用） |
| 8928 | Sendspin client（每台设备自监听） | 服务端主动拨设备时连这里 |
| **6053** | ESPHome **Native API** | 控制面（实体/状态/服务）。**只有 HA、ESPHome Dashboard 连它**；音乐流完全不走这里 |
| 8095 / 8097 | MA Web API / MA Stream Server | 与 Sendspin 无关 |

**38927 与 6053 是互不相干的两套协议。** 别指望 6053 能管音频，也别指望 sendspin 能读设备实体。

## 1.4 三方职责边界（谁管什么）

| 层 | 负责 | 不负责 |
|---|---|---|
| **Sendspin 协议规范** | 定义 `buffer_capacity`（硬字节上限）、`min_buffer_ms`/`required_lead_time_ms`/`static_delay_ms`（对 player 是 REQUIRED）、`available` 门控、服务端可去抖 timing 更新 | 不规定具体秒数；秒数是**服务端算出来的** |
| **MusicFlow 服务端** | 读 `client/hello` 的容量 → 换算安全水位 → 按时间线把压缩帧推出去；保证不越容量；让出事件循环；曲末排空 | 不负责设备的物理缓冲大小（那是设备 `buffer_size` 的事） |
| **ESPHome 设备端** | 宣告 `buffer_capacity`（= 自己的 `buffer_size`）；按时间戳播放；吸收抖动 | 旧固件**不报**三个时序参数（报 0 = 表达缺失，不是真实诉求） |

> 一句话：**协议定契约，设备报容量，服务端算水位。** 三层里任何一层想越界替另一层做主，都会出问题（见第六部分）。

---

# 第二部分：协议链路（正确做法）

## 2.1 连接与握手

```
WS text 明文期:
  C→S client/init {client_id, version:1, suite}
  S→C server/init {server_id, version:1}
  S→C noise/handshake {data: b64url(msg1)}        # Server 恒为 initiator
  C→S noise/handshake {data: b64url(msg2)}
   → prologue = client/init 原文字节 ‖ server/init 原文字节（UTF-8 无分隔拼接，不含 WS 帧头）
切换到 Noise transport；WS binary 帧 = Noise AEAD 密文
  S→C server/hello {server_id, name, version, active_roles, connection_reason}
  C→S client/hello {name, device_info?, supported_roles, player@v1_support, pair_methods, unpaired_access}
  S→C server/activate {activities:[playback|pairing], active_roles?, pairing?}
  → 此后发业务数据
```

握手要点：

- **suite**：`25519_ChaChaPoly_SHA256` / `25519_AESGCM_SHA256`；用**标准 Noise KKpsk2**，不自制标签。
- KKpsk2 pattern：消息1 `[e, es, ss]`；消息2 `[e, ee, se, psk]`。PSK 模式「e 令牌」额外 `MixKey(e.pub)`；`psk` 令牌 `MixKeyAndHash(psk)`。
- 前消息（pre-messages）哈希顺序固定为 **initiator static 先、responder static 后**（与角色无关）。
- msg1 明文 = `{"psk_id","psk_category"}`，msg2 明文 = 字节 `{}`。
- 密钥轮换的 nonce 非随机化：8 字节计数器写在 12 字节 nonce 的**偏移 4**。
- `SENTINEL_PSK = sha256("sendspin-sentinel-psk-v1")`；`psk_id = b64url(sha256("sendspin-psk-id-v1" ‖ psk))`。PskCategory：`lt` / `pr` / `sn`。
- 身份：X25519，43 字符 base64url（无 padding）。`server_id = b64url(server_pub)`，私钥持久化到数据目录，0600。
- **TS 握手已与真实 Python `noise` 库逐字节互操作通过**（`handshake_hash` 完全一致）——核心协议风险已化解。

**三条硬约束**：

1. **`server/hello` 五字段必须齐**：`server_id`/`name`/`version`/`active_roles`/`connection_reason`；`connection_reason` 只能是 `discovery` 或 `playback`，其他值 → **整条 hello 作废**。不要加 spec 之外的字段。
2. **不要等设备回 `server/activate`** —— 真机明确 `Unhandled server message type: server/activate`，永不回；等它 = 15s activation timeout 自杀连接（表现为「每 5~6 分钟重拨一次」的假重连循环）。
3. **30 秒红线**：连接进 nursery 后，握手 30 秒内完不成（卡在 `HELLO_SENT`）即被 drop：`Nursery connection stalled at HELLO_SENT (>30 s), dropping`。此前每次「准时 30 秒离开」都是这个原因，不是对端有另一个 server。

## 2.2 字节级既定事实（勿改）

1. **音频块** = `[0x04][i64 大端 μs][data]`（**9 字节头，无 `send_ahead`**）。
2. **分片类型**：解密后 `plaintext[0]`：`0`=JSON、`2`=MORE、`3`=END（**不是 1**）。首帧 `[2, orig_type, ...payload]`，续帧 `[2|3, ...payload]`。单帧明文上限 `65519`（65535−16 AEAD tag）；首帧净荷 `65517`、续帧 `65518`；重组上限 64 MiB。
3. **bin id 分区**：`0`=JSON、`2/3`=分片、`4`=player 音频、`8-11`=artwork、`12`=source 音频、`16-21`=visualizer。
4. **`server/time`**：`client_transmitted`（回显）、`server_received`（接收时 `now_us()`）、`server_transmitted`（发送时**重新盖章**）。时钟 = `CLOCK_MONOTONIC_RAW` μs。`stream/start|clear|end` 的 `server_transmitted` 亦发送时盖章。
5. **`stream/start.player`**：`{codec: opus|flac|pcm, sample_rate, channels, bit_depth, codec_header?}`。FLAC 的 `codec_header` = `base64("fLaC"\x80 + 3B len + STREAMINFO extradata)`。opus = `codec_header None`，每块一个 RFC6716 包，帧长 25ms。
6. **seek / 跳曲的流生命周期**：seek 与跳曲**只发 `stream/clear`**（清缓冲继续来块），**绝不**发 `stream/end`；track 切换只 `stream/start` 更新（gapless）；**真正结束才发 `stream/end`**。

## 2.3 编解码协商：默认 FLAC，不要默认 PCM

ESPHome 的默认 codec 偏好就是 `[flac, opus, pcm]`（FLAC 优先），Sendspin / ESPHome 团队认为 FLAC 是这类设备的最佳选择。

| | PCM | FLAC |
|---|---|---|
| 码率 | 48k/立体声/16bit = **192,000 B/s = 1.536 Mbps** | ≈ 0.7～0.9 Mbps（约一半，随曲目浮动） |
| 帧间隔 | 25ms（40 包/秒） | ≈85ms（约 12 包/秒，libFLAC 块编码） |
| 设备 CPU | `memcpy`（极低） | FLAC 解码（S3 轻松） |
| 服务端 CPU | 极低 | 每客户端独立编码（见第七部分对齐项） |

- **正确配置**：服务端插件页 `preferred_codec: flac`；设备端 `codecs: [flac, pcm]`（去掉服务端未实现的 opus）。
- **协商顺序**：flac 优先 → pcm 次选。裸 opus 被这类客户端拒收（9.x 明确 "only PCM and FLAC are supported"），**永远不要协商到 opus**。
- 键名兼容 `player@v1_support`（9.x 别名）与 `player_support`（老版）。代码见 `server.ts` `negotiateCodec(payload, preferred)`。

## 2.4 `codec_header` 的 last-metadata-block 位**必须为 1**

FLAC 头是**单独**发给设备初始化解码器的，之后设备直接收裸音频帧。若照抄真实流（真实流里 STREAMINFO 后面还有 VORBIS_COMMENT / PADDING，故 last 位 = 0），解码器读完 STREAMINFO 会继续按「元数据块」解析下一段，撞上 FLAC 帧同步码 `0xFF`（块类型 = 127，非法）→ 解码状态机失败。

- **正解**：从实流提取的 header，把块头 last 位**强制置 1**（`out[4] = (out[4] | 0x80) & 0xff`），其余 41 字节仍逐字节取自实流（保留「真实头不会与实流漂移」的优点）。
- **迷惑性极强**：服务端日志全绿、进度照走、设备零报错，但**完全无声**。
- **实证**（同一台设备，两组值仅第 5 字节不同，其余 41B 完全一致，48k/2ch/16bit/block 4096）：

  | 版本 | header 头部 | 第 5 字节 | 结果 |
  |---|---|---|---|
  | v4.0.17 | `ZkxhQ4AAACIQ…` | `0x80`（last=1） | 有声 |
  | v4.0.18 | `ZkxhQwAAACIQ…` | `0x00`（last=0） | **无声** |

  v4.0.17 之所以「有声」纯属**偶然**：它的 `pushFrame` 在 `encode()` 之前就兑现宣告，编码器还没产出东西 → 回落**合成头**（自带 last=1）。详见第六部分坑 B4。

## 2.5 预填充水位 × 设备容量「匹配好」（核心）

档位是**期望水位**，实际水位必须匹配设备宣告的容量：

```ts
// backend/src/services/sendspin/server.ts
export const DEVICE_BUFFER_HEADROOM_RATIO = 0.6;

capacityLimitedPrefillMs(): number {
  const cap = this.deviceCapacityBytes();              // 设备 client/hello 宣告的字节数
  if (cap <= 0) return PREFILL_BUFFER_MAX_MS;          // 未宣告容量 → 退回 30s（兼容旧固件）
  const byBytes = (0.6 * cap / Math.max(1, this.encodedBytesPerSec())) * 1000;
  return Math.max(PREFILL_BUFFER_MIN_MS, Math.min(PREFILL_BUFFER_MAX_MS, Math.floor(byBytes)));
}
```

```
实际水位 = min( 档位, 30s, 0.6 × buffer_capacity ÷ 实测压缩码率 )
```

| 参数 | 来源 |
|---|---|
| `buffer_capacity` | 设备 `client/hello` → `player@v1_support.buffer_capacity`，**单位字节**；= ESPHome 的 `buffer_size` |
| 30 秒 | aiosendspin `PlayerPersistentState.max_duration_us` 默认 `30_000_000`（两道尺独立生效） |
| 实测压缩码率 | 推流中累计「压缩字节 ÷ 音频秒数」，**每首清零**（上一首的码率对新歌无参考价值） |
| `0.6` 余量 | 本仓按**时长**记账（非按真实字节），叠加协议头开销与一帧过冲，按 100% 必踩线，故留 0.6 |

**为什么是 0.6 而不是 100%**（真机 A/B 实证，容量 1.6MB、FLAC 实测 105052 B/s）：

| 占用率 | 钳制后目标 | 设备侧结果（100 秒窗口） |
|---|---|---|
| 100% | 15230 ms | PLAYING 后 **15.30 秒**起连续 `sendspin.player: Failed to send audio chunk`（缓冲满、逐帧拒收）＋ `Lost sync (85352us off)` 风暴 |
| 60% | 9138 ms | `Failed to send audio chunk` = **0**、`Lost sync` = **0** |

`15.30s` 与 `1600000 ÷ 105052 = 15.23s` 吻合。三首不同曲目的钳制结果在**字节口径上恒为容量的 60%**，换算链路自洽。

**档位全集**：`0.8 / 1.5 / 3 / 5 / 10 / 15 / 20 / 25 / 30` 秒（插件页「设备缓冲深度（抗卡顿）」，Web 改完 5s 内生效）。常量：`PREFILL_BUFFER_MIN_MS=100` / `MAX_MS=30000` / `DEFAULT_MS=3000`（`constants.ts`）。

> **⚠️ 档位名存实亡的陷阱**：如果你的 `buffer_size` 装不下想用的档位，档位会被**永远钳到更低值**。要真用上 20/25/30s，必须按 §3.2 调大设备 `buffer_size`。

## 2.6 时间线模型：按**实际产出**推进，且聚合口径必须免疫编码器相位

三层，缺一层就会出坑（B15 就是第三层没做对）：

**① 单编码组内**：`ts = 锚点 + 累计实际产出样本 / SR`（**样本精确**，绝不按调度粒度）。
→ 为什么不能按喂入量：编码器攒样期（libFLAC 要攒满 4096 样本 ≈85ms 才吐帧）若把「喂进去但没吐出来」的量算成已播出，时间线会超前约 75ms → 设备报 `Lost sync (75006us off)` → 往音乐里**插静音**补空 → 听感卡顿。

**② 跨编码组聚合**：推进量 = `max(各组**累计**交付样本)` 的**增量**（不是「每批取 max」）。
→ 「每批取 max」在块编码器下会把**并集**当成本批推进（B15）：相位错开时两批共记 8192 而真正上网只有 4096。

**③ 结构上消除相位**：按 `(codec, gain)` **分组编码** —— 同组只编一次、字节与时间戳分发给全组。
→ 同一 `(codec, gain)` 的设备**共用同一个编码器实例**，相位由构造决定一致 ⇒ ②的口径不再有可被相位干扰的余地。`(codec, gain)` 不同（如 FLAC 与 PCM 混编、各设备音量不同）才分属不同组，成本随**组数**而非成员数增长。

- 锚点 = `nowUs() + SendspinGroup.commonSendAheadUs()`。
- `produced > 0 ? 按产出推进 : 不推进`；零产出超过 `STALL_GRACE_US`（500ms）才降级为按喂入量推进，避免编码器真坏时时间线冻结。
- **`commonSendAheadUs()` 是唯一出口**：锚点必须用它（帧头 9B 里**没有** send_ahead，设备用自己那个，未协商默认 800ms）。
- 新编码组以**当前峰值**为基线登记 ⇒ 播中加入的成员（新 codec/gain 组合）不会让 `max` 被拉低（时间线不倒退、不停滞）。

**设备上报三个时序参数为 0 时**（`output_delay` / `required_lead` / `min_buffer`）必须视为「未提供」，回落缺省 **800ms**（ESPHome 实测恒报 0，是表达能力缺失，不是真的不需要 buffer）。

> 曾有版本误把 MA 的 `DEFAULT_INITIAL_DELAY_US=250ms` 当独立常量 → 锚点 250ms vs `send_ahead` 800ms → `delta` 恒 −550ms → 设备收首块即判「已过期」→ 立即吐字节 → underrun → **日志全绿但无声**。

**测试锁**：`pushFrameGroupEncode.test.ts`（10 例，含「两组相位错开 4 批共吐 2 帧 ⇒ 推进 8192」）。

## 2.7 pacing 必须**绝对时刻调度**（固定 sleep 会累积漂移）

```
dueMs = paceWallMs0 + (i * FRAME_MS) / speed;
await sleep(dueMs - Date.now());   // 自校正，±0.5ms 振荡
```

`await sleep(25)` 之外还有 encode/send 开销，实际周期约 26ms 而时间戳只推 25ms → 每包落后 1~1.8ms 并**单向累积**（实测跑到 −611ms）。设备 hard sync 阈值只有 **5ms**（`sync_task.cpp:36 HARD_SYNC_THRESHOLD_US = 5000`），越界就插静音 → 「一卡一卡」。

## 2.8 进度上报 = **可听位置**，不是已推送位置

预填充会把「已推送」和「已听到」拉开整整一个缓冲深度。若上报已推送位置，10 秒档下所有歌一开播进度条/歌词就直接显示 `00:10`（偏移量 = 档位值）。

- **正解**：上报**可听位置** = 已推送位置 − 当前缓冲深度
  ```ts
  audiblePositionMs = 已推送ms - (cursorUs - nowUs()) / 1000
  ```
  （`cursorUs` 与 `nowUs()` 同为 host monotonic 时钟，可直接相减）。取帧仍用 `playCursorMs`，只有对外上报换口径。
- **保住 seek 语义**：可听位置带**下界** `reportedFloorMs`（本轮起播位置 / seek 目标）。正常起播下界为 0 → 开播即 `00:00`；拖到 40s 时下界为 40s → UI 立刻显示目标值，不会被「缓冲还没建立」拉低（对齐 MA `controller.py` 的 `elapsed_time` 防回跳）。

## 2.9 推流循环落后时**必须让出宏任务**

```
if (delayMs > 0) await sleep(delayMs);   // ❌ 落后时完全没有让出点
```

一旦落后，整条循环退化成**微任务自旋**，`client/time` 的 I/O 回调排不上队 → 设备报 `Time message N/8 timed out` → 重同步 → 卡顿。

- **正解**：落后分支加 `await new Promise((r) => setImmediate(r))`（对齐 MA 每轮迭代的宏任务让出）。

## 2.10 曲末排空

`stream/end` 要等设备把缓冲播完再发，否则会砍掉尾部音频。排空期间**分段等待并持续刷新上报位置**，让进度平滑走到曲末（一次睡到底会让进度停在 `durationMs` 之前，拖后自动切歌判定）。

另：`stream/end` 之后应丢弃已过期音频（对应 MA `_stream_started` 守卫）——**当前未做**，见第十部分。

## 2.11 `client/state` 解析：**根层优先**

真机实发 payload：

```json
{"state":"synchronized","player":{"volume":53,"muted":false,"static_delay_ms":0}}
```

- `state` 在**根层**，不在 `player` 里；`output_delay_ms` / `required_lead_time_ms` / `min_buffer_ms` / `available` / `buffer_capacity` 该固件**一个都不发**。
- **正解**：`state` / `available` / `buffer_capacity` 根层优先、`player` 层回落，两处都读；额外解析 `player.static_delay_ms`。
- **顺带收益**：设备只在状态**翻转**时才发 `client/state`，故新增 `SYNC LOST (state=error)` / `synchronized` 变化日志——排查偶发卡顿以前只能靠设备侧串口，现在服务端可自证。
- **`stream/start` 门控**：spec 要求 `server MUST NOT send stream/start unless the latest client/state reports available:true`。按「设备**明确上报过** `available:false` 才拦 + 3 秒超时兜底」实现：未上报该字段的固件行为**零变化**。

## 2.12 发现（mDNS）与拨号方向

| 主体 | 服务类型 | 端口 | 说明 |
|---|---|---|---|
| 设备（播放器） | `_sendspin._tcp` | 8928（txt `path=/sendspin`） | 服务端发现设备 → 主动拨号 |
| 服务端 | `_sendspin-server._tcp` | 38927（txt `path=/sendspin`） | 设备发现服务端 → 自己拨号 |

**正确方向是「设备经 mDNS 发现服务端后自己拨入 38927」（Client-Initiated）。**

- **服务端不要拨设备自身端口（8928）** —— 会被判为「竞争第二个 server」，回 `goodbye: another_server` 并触发 `noAutoRedial` **永久抑制重拨**。
- **不存在的 dial 目标要删干净**：`MUSICFLOW_DATA_DIR/sendspin/dial_targets.json` 里若留着设备自身端口（如 `192.168.10.245:8928`），服务端每 60s 拨过去就会被踢回并抑制。
- **并发拨号必死**：同一目标单飞（`pendingDials`），否则设备仲裁踢掉一个。
- `another_server` **不自动重拨**（spec），手动 dial 可清除抑制；`restart` 才可重拨。
- **先有音频再谈记住**：设备 `Persisted last played server` 只认真正播过的 server；靠「连上」混不成记住，不配对就用播放把它拿下。
- **冷起播必须走 `playMedia`，不能只 `pump.resume()`**：`POST /peers/:id/play` → `QueueController.transport(play)` → `player.resume()`。sendspin 的 `resume()` 若只调 `pumpFor(...).resume()`，在「队列 `isActive=true` 但从未起播」时是**空操作**（`resumePlayback()` 见 `q.isActive` 直接早退）→ 无 `playMedia` / 无 `stream/start` / 无 pump = 静默。对照 DLNA：它的 `resume() = playDevice()`（重发 `SetAVTransportURI`）= 真起播，所以 DLNA 不暴露此缺口。
  修法：`protocolPlayer.resume()` 判 `pump.active` —— 在跑就原地 resume，没跑就走 `playMedia` 冷起播（需 `QueueController.resolveItem` 公开，补全 songId-only 的 item 元数据）。

## 2.13 配对（三法全量）

1. **Pairing PSK**：token `SP:0` + base32(client_key(32B) ‖ pairing_psk(32B)，`2`↔`9` 转写)，直配无 PAKE。
2. **Dynamic Code**：Sentinel 连 + CPACE-X25519-SHA512 PAKE；6 位数字 / QR（QR = 前 24B digest）；PSK 以 `wrapped_psk` 在 CPace 输出下 seal；20 轮后 hold。
3. **Static Code**：固定 8 位码 + PAKE；配对窗口（手势打开，建议 5min，5 次失败关闭）。

配对后带内 re-handshake 升长期 PSK；`unpaired_access` 需操作员按 `client_id` 显式批准（复刻 MA `set_trusted_unpaired` 同意流）。服务端静态身份持久化于数据目录（0600）。

> **实现落点**（避免照抄旧设计稿）：码生成与窗口门在 `pairing.ts`（`StaticCodeGate`）；**PSK store 在 `pairingStore.ts`**（`pskIdForHex`）；**`SP:` token 编解码在 `pairServer.ts`**。PAKE 实现见 `cpace.ts`（CPACE-X25519-SHA512）。

## 2.14 时钟同步

- 周期 `client/time` → `server/time{client_transmitted, server_received, server_transmitted}`。
- 2D Kalman（offset + drift）在**客户端**计算；服务端只提供时间戳并测到达/发送时刻。
- 收敛前客户端不报 `available:true`。稳态 ±0.5~±1ms；漂移修正节制（dead band ~100µs，整帧删/插）。
- **服务端可 rate-limit / debounce / coalesce** 客户端的 timing 更新（spec 允许）。

---

# 第三部分：设备端（ESPHome 2026.9.0）

## 3.1 三个必须项

| 项 | 值 | 为什么 |
|---|---|---|
| `network:` 块 | `enable_high_performance: false`（+ `enable_ipv6: true`） | 未配 `network:` 块时，该网络优化被 sendspin 组件**自动打开**；社区（2026-09-18，6 台 louder-esp32 实测）确认这是「每隔几分钟掉一次」的直接原因 |
| `buffer_size` | 按 §3.2 选型，**≥ 你想用的最深档位所需** | 这是设备唯一能报给服务端的容量，决定水位上限。合法范围 ≥ 25000，默认 1000000 |
| `decode_memory` | `psram`（默认） | 官方明写 internal「**Has minimal benefit on the ESP32-S3**」；S3 + Octal 80MHz 上 internal 无收益还白吃内部 RAM |

> **2026.9.0 备选**：若 `enable_high_performance: false` 有副作用，可改用更细粒度的 `network: tcp_send_buffer:`（暴露 lwIP 每 socket 发送缓冲，@bdraco #18610，"without paying the RAM cost of enable_high_performance"）。

## 3.2 容量选型对照表（档位 ↔ `buffer_size`）

`buffer_size` 要满足 `buffer_size ≥ 档位 × 实测码率 ÷ 0.6`。按两种码率算：

| 目标档位 | FLAC 所需（≈105 KB/s） | PCM 所需（192 KB/s） |
|---|---|---|
| 20s | 3.5 MB | 6.4 MB |
| 25s | 4.4 MB | 8.0 MB |
| 30s | **5.3 MB** | **9.6 MB（超 8MB PSRAM，物理不可达）** |

**推荐**：`buffer_size: 6000000`（6MB，板子 8MB PSRAM 下）。

- **FLAC 下 20/25/30 全解锁**（FLAC 是 v4.0.19 实测走的链路）。
- 若某天被协商成 PCM，30s 仍会被钳到 ~18.75s —— 这是 **8MB PSRAM 的物理上限**，不是配置问题，解决法是确保走 FLAC。
- **前提**：PSRAM = 8MB（Octal/80MHz 典型值）。若实际只有 2MB，必须下调 `buffer_size`，否则编译/运行失败。

> 其它**保持原样**：`power_save_mode: none`、`psram: octal 80MHz`、esp-idf 5.5.4、`output_power: 8.5`（双刃剑，见 §3.3）。

## 3.3 `output_power` 需要实测

`8.5` 是 ESPHome 允许的**最小值**（默认 20.5dB）。降功率能减少自干扰，但**如果设备离 AP 不近，8.5dB 会导致大量重传** → 抖动。

判断阈值：RSSI > −60dBm 可保持 8.5；**RSSI < −70dBm 建议回到 17～20.5dB**。临时加 `wifi_signal` 传感器看信号质量。

## 3.4 `media_source` 的平台名：`audio_http`，**不是** `http_request`

```yaml
media_source:
  - platform: audio_http      # ✅ 正确
    id: http_source_media
  # - platform: http_request  # ❌ Platform not found: 'media_source.http_request'
```

- `http_request` 是**顶层组件**（HTTP 客户端，用于自动化里发请求 / 给自签证书关 TLS 校验），**不是** `media_source` 的平台。
- **源码实证**（tag `2026.9.0`）：`esphome/components/audio_http/media_source.py` **存在**；`esphome/components/http_request/` 目录下**没有任何 media-source 平台文件**（只有 http_request.cpp/.h、ota/、update/）。
- 若要用自签证书，加的是**顶层** `http_request: { verify_ssl: false }`（会全局关掉构建里所有 TLS 校验），别写进 `media_source`。

## 3.5 `reboot_timeout` 的语义陷阱

设备周期性重启（曾每 15 分钟 `No clients; rebooting`）的真凶：`api.reboot_timeout` 默认 15min，**只认 6053 上的连接**。

- 修法：固件 `api: reboot_timeout: 0s`（**`0s` = 关闭**），或由 HA 的 ESPHome 集成常驻。
- **`60s` 是反方向**——会变成每分钟重启一次，比 15min 糟得多。官方原文：`Can be disabled by setting this to 0s. Defaults to 15min.`，**必须读原文**，不能凭字面推。
- ⚠️ **调这部分时注意**：调试脚本自己连着 6053 时就是一个 client，会掩盖这个问题（观察者效应）。

---

# 第四部分：FLAC 链路专项

> 状态：**已完成**。2026-09-18 真机基线验证一次达标 —— 切 `preferred_codec=flac` 并断电重启音箱（旧连接沿用已协商 codec，必须重启才吃到新偏好）后，连续播放**零 `Lost sync`、零 `BAD_BLOCK_SIZE`、零 `Serious error decoding`、零 underrun**，出声三件套齐全，听感与 PCM 无差异。

## 4.1 核心矛盾：喂料粒度 vs FLAC 块大小

PCM 是「喂多少吐多少」（零攒样）；libFLAC 是「**攒满一个 block 才吐一帧**」：

```
喂料节奏：每 25ms 喂 1200 样本（FRAME_MS / FRAME_SAMPLES）
FLAC 块：  4096 样本 ≈ 85.3ms ≈ 3.41 次喂料
实际产出：喂 4 次（100ms）后吐 1 帧 4096 样本 ⇒ 产出是「每 85~100ms 一大块」
```

时间线已改为按实际产出推进 ⇒ 时间轴不会漂；但设备端 ring buffer 的进料是**脉冲式的**（85ms 一大块，块间零进料）。设备 hard-sync 阈值仅 5ms，超阈值会插静音——这曾是 FLAC「一卡一卡」的形态学解释。

## 4.2 三处通用修复已把 FLAC 治好

**实测结论**：9B 帧头 + 时间线按实产推进 + 绝对时刻调度，这三处修复之后，FLAC 在「25ms 喂料攒到块大小统一吐帧」的模式下**没有**出现担心的「85ms 脉冲插静音」——设备端 ring buffer 容纳住了块间零进料的间隙。`Lost sync` / 解码报错 / underrun 计数全零。

因此**无需**降 compression level 或改喂料单位（那两个备选方案保留在 §4.5）。

## 4.3 ffmpeg 链路的既定事实

- 容器内 ffmpeg = `/app/backend/node_modules/ffmpeg-static/ffmpeg`（**无系统 ffmpeg**，7.0.2-static）。
- flac 编码器 sample_fmt 支持 `s16 s32`；必须带 `-sample_fmt s16`（否则 f32le 默认编 s32 → 24bit）。
- 常驻 ffmpeg 输出带容器头：`fLaC` + STREAMINFO(4+34) + VORBIS_COMMENT + 8KB PADDING = **8288B**，首帧 sync 在偏移 8288，**必须剥掉**。
- 首帧前有 **~1.1s lookahead 零输出**，`-flush_packets 1` 无效 → 短音频（≤1.1s）必须 `flush()` 逼尾帧。
- STREAMINFO 应**从真实流提取**，不要硬编码。
- ffmpeg 48kHz 自选 block size = **4608**；libFLAC 默认 = 4096（compression ≥ 1）。两者**不同源，别混为一谈**。

**FLAC 编码器实现**：libflacjs **asm.js 变体**（`factory("release")`，WASM 在 Node 下崩）。block size 传 0 = **编码器自选**（libFLAC compression ≥ 1 → 4096；compression 0 → 1152）。`codec_header` 从编码器**真实元数据流提取**（`fLaC`+STREAMINFO 42B → base64），不硬编码。

## 4.4 约束与边界（改代码前自查）

- **micro-flac `BAD_BLOCK_SIZE`**：实际帧块大小**不得大于** STREAMINFO 声明的 `max_block`（设备按它分配解码缓冲），校验在 `frame_header.cpp:88`。任何「合成 header」路径都要保证两者一致。
- **`-frame_size` 不是 flac 的正式 AVOption**（是编码器通用参数，实际生效但会改 STREAMINFO 声明）。它**不能**约束消费者的行为，**不是**对齐 MA 的手段（见第六部分坑 A3）。
- **短音频尾帧**：libFLAC 常驻编码器是同步回调，无 ffmpeg 那种 ~1.1s lookahead；但 `stream/end` 时要 `finish()` / `flush()` 逼尾帧，否则最后一截（不足一块）丢失。
- **不改设备固件、不做 opus**（裸 opus 被客户端拒收，9.x 明确 only PCM and FLAC）。
- 设备端：micro-flac 0.2.0；sendspin-cpp 0.7.2。

## 4.5 备选方案（仅当 FLAC 回归出问题时）

按**代价从小到大**依次试，每步真机回归：

- **方案 A（首选，零风险）：`FLAC_COMPRESSION_LEVEL` 降为 0**。libFLAC compression 0 自选块 **1152** = 24ms < 25ms 喂料 ⇒ **每次喂料必吐一帧**，产出节奏与 PCM 同构，脉冲消失。代价：码率升高，但仍远低于 PCM 的 1.536 Mbps。
- **方案 B：喂料单位改为块大小整数分块**。把 25ms 粒度改为按 4096 样本整块喂。注意这会改变 `pushFrame` 的调度粒度，与绝对时刻调度强耦合，改动面大，仅当 A 不达标再做。
- **方案 C（不建议）**：保持 4096 + 提高设备端缓冲容忍 —— 需要改设备固件，超出本仓边界。

## 4.6 收益定位

| | PCM | FLAC |
|---|---|---|
| 空口占用 | 1.536 Mbps | ≈ 0.7～0.9 Mbps |
| 适用场景 | 局域网、设备解码弱 | 跨网段 / 带宽敏感 |

**推荐语**：局域网优先 PCM（零解码）；跨网段/带宽敏感用 FLAC。但**默认偏好取 FLAC**（ESPHome 默认也是 FLAC 优先）。

---

# 第五部分：多房间组 + 流式解码

> 状态：**A（流式解码）+ B（组管理）全部完工**，已随 **v3.0.36** 发版。本部分保留为现行设计说明。

## 5.1 流式解码（`PcmWindow`）

**动因**：原 `defaultSource` 把整曲一次解成内存 F32 —— 320 秒歌曲 ≈ **122MB PCM**，切歌时新旧缓冲重叠 → ~570MB 尖峰；子进程继承 `--max-old-space-size=256`，超长单曲会顶爆堆。

**做法**（`streamSource.ts`，`SENDSPIN_STREAM_SOURCE` 开关，默认关）：

- **生产者**：每首歌一个长命 ffmpeg（`ffmpeg -ss <offset> -i <url> -ar 48000 -ac 2 -f f32le pipe:1`），后台 reader 持续排入窗口。水位：低 20 秒 / 高 30 秒；满则停读（ffmpeg 被管道憋住，**天然背压**，无需额外协议）。
- **`pushLoop` 取数**从 `pcm.subarray(lo,hi)` 改成 `window.slice(absLo,absHi)`：命中窗口 → 直接喂编码器（热路径逐字节一致）；未命中但未 EOF → 等（带超时，走现有 `STALL_GRACE` 降级）；EOF 且窗口耗尽 → 结束。
- **seek**：目标在窗口内（±10 秒占绝大多数）→ 只改 `positionMs`，零成本；窗口外 → 杀 ffmpeg 按 `-ss` 重起，空窗 ~1 秒。
- **stop**：杀 ffmpeg + 清窗口（`reclaim.test.ts` 的「停后释放」语义保留）。
- **接口兼容**：保留 `PumpSource` / `GroupAudio` 整包接口，`GroupAudio` 加可选 `stream?: PcmWindow`；有 `stream` 走窗口路径，否则走老路径。现有注入测试（`overridePumpSource`、`pumpEnd`、`reclaim`、`pumpFallback`）**零改动**。
- announce 的 TTS 短包（0.5 秒级）保持整包 `decodeToF32`，不动。

**窗口上限 30 秒**（`WINDOW_HIGH_SEC` 60→30，2026-09-19 定），与 MA 的 `sleep_to_limit_buffer(30秒)` 对齐。

## 5.2 组管理 API：壳复用、核分流

**不另起 `/v1/sendspin/groups`** —— 平行系统必腐化（权限 / WS / 前端 / QC 全 duplicate），且用户要理解两套「群组」是实现泄漏。复用既有 `/v1/groups` + `group:<id>` peer。

**成员 id 命名空间化**：`dlna:<id>` / `sendspin:<clientId>`，裸 id 继续沿用 DLNA（存量组零迁移）。

**增量成员口**：

```
POST /v1/groups/:id/members
Body: { add?: string[], remove?: string[] }
→ 一次调用可同时加减，原子执行，返回更新后 group（含成员详情，免二次 GET）
```

- 为手机场景而设：单成员幂等（add 已存在 = no-op），无 read-modify-write，两台手机同时加不同设备不丢成员；弱网重试安全。权限/owner 校验复用 PUT 同一套；WS 照常广播 `group_updated`。
- **PUT 保留 `setMembers`（精确顺序，leader = 首个在线成员）**，POST 增量口走 `applyMemberDelta`；「新增 → 加入对齐」钩子只存在一份（`alignGroupMembers`：dlna 走 `rejoinMembers` cast + seek，sendspin 走 `sendspinGroupJoin` 直播沿，摘除走 `sendspinGroupLeave`）。

**`group:<id>` 扇出按 kind 分流**：transport 类经 QC 零改动；mute 逐成员按 kind 分发（dlna 走 RenderingControl，sendspin 走组/连接双置位）；watchdog 探活/对齐仅 dlna 成员，悬挂判定含 sendspin 在线。

**Flutter 流程**：`GET /v1/peers` 选设备 → `POST members {add:[...]}` → 收 WS `group_updated` 刷新。播放/音量/静音走 `group:<id>` peer 口。

## 5.3 直播沿加入 + **late-join 回填**（对齐 aiosendspin `on_role_join`）

sendspin 版「rejoin」：`stream/start`（codec_header + 格式）→ `members.add` → 收帧；摘除：`members.delete` + `stream/end`。编码器按 `(codec, gain)` 分组共享（§2.6），**PCM + FLAC 混编可并存**。

> ⚠️ 本节曾被写成「**不抄 MA 式回填**」，那是错的 —— 见坑 B14。当时理由是「时间戳绝对 + 按 ts 排播天然对齐 ⇒ 新成员无需历史」。这只证明了**对齐**不需要历史，**没有**回答**出声延迟**。

### 为什么必须回填

| 事实 | 后果 |
|---|---|
| 预填充把组游标推到**领先墙钟一整个水位**（30s 档 ≈29s —— 这正是 §2.5 的抗抖动余量本身） | 「未来帧」都在游标之后 |
| 新成员旧行为下只从**游标之后**收帧 | 它的首帧时间戳在 29s 之后 → **静默等 29 秒才出声**（2026-09-24 真机「加入新设备要很久才发出声音」） |

**MA（aiosendspin `server/push_stream.py`）的解法**：组内保留**尚未播到**的音频缓存，新角色 `on_role_join` 时把「起点 ≥ late-join 目标时刻」的 chunk **立即回放**，之后无缝接实时流。

| MA 机制 | MA 常量 | 本仓等价物 |
|---|---|---|
| `_pcm_chunk_cache` / `_role_chunk_cache`（按 `ts + duration <= now` 逐出） | `_HISTORY_KEEP_PAST_US = 1_000_000` | `SendspinGroup.recentByGroup`（键 = 编码组，逐出规则同款） |
| `_send_cached_chunks_to_role`（只发起点 ≥ 目标时刻的 chunk） | `LATE_JOINER_MIN_LEAD_US = 100_000` | `SendspinGroup.seedLateJoin` |
| `_pending_join_roles`（commit 在飞时**延迟 join**，不打断） | — | 同步回填，天然无竞态 |
| `_start_catchup_encoding`（无编码缓存则按 PCM 缓存补编） | `ENCODER_CATCHUP_WARMUP_US = 120_000` | **不需要**：同组字节逐字节相同，直接复用缓存 |

### 本仓实现要点（`SendspinGroup.seedLateJoin`）

1. **目标时刻 = `now + send_ahead + 100ms`**。设备**按 `ts − send_ahead` 决定何时播**这一块（帧头只有 9B：type + 8B 微秒 ts，**不含** send_ahead；设备用自己那个，未协商时默认 800ms），所以「没落在过去」的充要条件是 `ts ≥ now + send_ahead`。
   ⚠️ 这点与**起播锚点不同**：起播时没有别人在对齐，锚点可以自选提前量（`min(send_ahead, 800ms)`）；late-join 必须**贴住既有时间轴**，否则新成员一进来就 underrun。
2. **跳过起点早于目标时刻的 chunk**（MA：「straddling 的整块跳过」）。
3. **回填量受设备容量钳制**（`capacityLimitedPrefillMs`，§2.5）—— 否则一进来就把设备灌满 → 逐帧拒收。
4. **先 `stream/start`、后音频**（复用 `pendingAnnounces` + `flushAnnounceFor`，§2.4 同款约束）；设备报 `available:false` 时不回填。
5. 缓存**按曲清零**（`resetPushMeter`）—— 上一首的字节对新流毫无用处，留着只会把新成员灌进已播完的音频。

**效果**：新成员约 **0.1s 出声**，且与老成员播的是**同一份时间戳**（天然对齐），不再等一个水位。

**测试锁**：`lateJoinBackfill.test.ts`（8 例）—— 首帧不在过去、≈100ms 出声、截止于组游标、只剩过期缓存时不回填、`available:false` 不回填、容量钳制、按编码组取字节、成员数不影响推进量。

## 5.4 内存对照

| | MA 上游 | 我们（流式开关开时） |
|---|---|---|
| 有界量 | 队列 6.4 秒 + 背压 30 秒 + 历史 1 秒 ≈ 37 秒 | 窗口 30 秒 + 历史 5 秒 ≈ 35 秒 |
| F32 缓冲 | ≈ **14MB** | ≈ **13MB**（+ ffmpeg 常驻 ~15MB，两边都有） |
| 与曲长关系 | 无关（O(1)） | 无关（O(1)） |

- 整曲缓冲（122MB/320 秒歌、长单曲 OOM）这个主要矛盾**两侧都已消除**。
- **成员越多我们相对越省**：MA 每成员一条 DSP ffmpeg 链（各带内部缓冲），我们是单 pump + 每成员一个 libFLAC 编码器（块缓冲 4096 样本 ≈ 0.7MB/成员）。
- 240 实测（3.0.35 整曲缓冲期）：主进程 ~220MB 平稳；子进程 ~300MB 基线、切歌尖峰 ~570MB，锯齿回落无单调泄漏。回收点：播完/切歌/停止即 `pcm = null`，断连/空组走 `stopGroupPump` + `reclaimSendspinOrphans`。

---

# 第六部分：踩坑记录（**特色错误必须记住**）

> 这些是**真的踩过**的坑，不是假设。每条：现象 → 当时的错误判断 → 真相 → 正解。
> 分两组：**A 组**是早期真机排障期（2026-09-17~18）的「看着像对的」错误；**B 组**是 v4.0.17→v4.0.18→v4.0.19 三轮迭代踩的坑。

## 6.1 A 组：早期真机排障（11 条）

### 坑 A1 —— 给音频帧头加了 4 字节 `send_ahead`（最严重，完全无声）

- **当时怎么想的**：看到 `aiosendspin` 某些版本在帧里带 `send_ahead`，认为要「对齐金标准」，于是把帧头从 9B 扩成 13B（`1B type + 8B ts + 4B send_ahead`）。
- **真相**：`send_ahead` **根本不是 wire 字段**。设备 `sendspin-cpp` 的处理是 `client.cpp` 只剥 1B type → `player_role.cpp` 常量 `BINARY_TIMESTAMP_SIZE = 8` → **8B 之后一律当作编码音频**。多出的 4B 落在 payload 头部，首字节 `0x00` 而非 FLAC 同步字 `0xFF` → 每包 `Serious error decoding FLAC file`。
- **为什么没早发现**：这个错误同时掩盖了自己 —— 帧格式错导致**每包都失败**，看起来像「解码器有问题」，于是去查 STREAMINFO、block size、喂料粒度，越查越远。
- **教训**：**wire 格式的对错只有接收方能定义。** 任何「对齐某个参考实现」的推断，都必须回到接收端源码逐字节验证（`grep -rn "send_ahead" sendspin-cpp/` → **零命中**，一句话就证伪了）。

### 坑 A2 —— 把 STREAMINFO block size 当成「决定性根因」

- **当时怎么想的**：dump 出 ffmpeg 的 STREAMINFO 看到 `min=max=0x1000=4096`，而代码里写的是 4608，改完之后某些日志确实变了 → 认定这是决定性根因，还写进了 CHANGELOG。
- **真相**：block size 必须正确（它是**必要条件**），但真正的决定性根因是坑 A1 的帧头错位。改 block size 时设备仍然静音，只是日志里少了一类报错，于是被误读成「接近解决了」。
- **教训**：**相关不等于因果**，尤其在错误分布在多个层面时。「改完日志变好」和「症状消失」是两件事 —— 判断标准要定死在**最终症状**（出声/流畅），不能中途换成「报错变少」。

### 坑 A3 —— 用 `-frame_size 4096` 去「对齐 Music Assistant」

- **当时怎么想的**：MA 实测每个 FLAC 帧是 4096 样本，于是想让 ffmpeg 也输出 4096。
- **真相**：`-frame_size` **不是 flac encoder 的正式 AVOption**（`ffmpeg -h encoder=flac` 不列出），但作为通用编码器参数**实际生效**，而且会改变 STREAMINFO（`4096` → 声明 `1000 1000`）。ffmpeg 48kHz **自选 4608**。`-frame_size` 只影响编码器声明，**不能**约束消费者行为。
- **教训**：把一个「看起来生效的参数」当成「这就是 MA 的秘密」，是典型的**把巧合当规律**。正确做法：让 ffmpeg 自选，然后**用编码器自选的块大小作为喂料单位**，并**从真实流里提取 STREAMINFO**，而不是两边各写一个魔数。

### 坑 A4 —— 固定 `sleep(25)` 做 pacing（一卡一卡的真凶）

- **当时怎么想的**：每帧 25ms，发完睡 25ms，看起来很合理。
- **真相**：encode + send 本身有开销，实际周期约 26ms，而时间戳只推 25ms。每包落后 1~1.8ms 并**单向累积**，实测漂到 **−611ms**。设备 hard sync 阈值只有 **5ms**，越界就往音乐里**插静音**补空 → 听感「一卡一卡」。
- **教训**：任何「循环 + 固定 sleep」的节流都会累积漂移。必须**绝对时刻调度**，让误差正负自校正。另外：设备侧的同步阈值是**毫秒级**的（5ms！），不要假定「几十毫秒无所谓」。

### 坑 A5 —— 相信「服务端日志全绿 = 成功了」

- **当时怎么想的**：`Stream Started` / `codec header` / `State changed to PLAYING` / `19200 ring_buffer` 全都出现了 → 断言「链路已通」。
- **真相**：这些只是**协议层**的证据。上述日志全部出现、而实际上**完全无声**的情况，至少发生过两次 —— 协议层通了不等于耳朵旁边有声音。
- **教训**：必须有一套**独立于己方的外部判据**。现在有了：6053 读回 `media_player state=2 (PLAYING)` —— 那是设备自己承认在播。在此之前只能靠用户耳朵，这是不可接受的验证链。

### 坑 A6 —— 设备日志抓晚了一拍 → 反过来改正确代码

- **当时怎么想的**：看到日志里没有 `speaker_mixer Starting` → 断定「还是没出声」→ 去改代码。
- **真相**：`speaker_mixer Starting` **只在首次打印**；`Processed new codec header` 也只在流建立瞬间打印一次。如果在**播放之后**才启动日志订阅，必然漏掉 → 「日志里没有」被误判成「没发生」。
- **教训**：**先起订阅 → 确认连上 → 再触发动作 → 全程同一订阅内观察。** 采样时序错误会被读成事实。

### 坑 A7 —— 以为 `reboot_timeout: 60s` 是「延长」重启间隔

- **当时怎么想的**：设备每 15 分钟 `No clients; rebooting` 自重启，想「改成 60s 应该更好」。
- **真相**：官方原文 `Can be disabled by setting this to 0s. Defaults to 15min.` → **`0s` 才是关闭**，`60s` 会变成**每分钟重启一次**，比 15min 糟得多。
- **教训**：涉及「0 表示什么」这类反直觉语义，**必须读官方文档原文**，不能凭字面推。

### 坑 A8 —— 以为 HA 连着 6053 就是「像 Music Assistant 那样解决问题」

- **当时怎么想的**：「MA 播的时候从来不重启 → HA 现在连着 → 所以等价于 MA 的场景」。
- **真相**：**MA 从不连 6053**（它只做 8927/8928）。MA 那会儿不重启，是因为当时有别的东西连着 6053 —— 多半是开着 ESPHome Dashboard 看日志。我们持久化连一条 6053 是**复刻一个巧合**，不是修根因。
- **教训**：当 A、B 两种情形结果不同时，要先证明**那个变量真的不同**，不然只是在做模仿。

### 坑 A9 —— 调试脚本自己掩盖了正在排查的 bug

- **现象**：调 watchdog 期间一切正常，脚本撤走后立刻开始每 15 分钟重启。
- **真相**：`aioesphomeapi` 订阅日志本身就是**一个 6053 client**，不断把 `reboot_timeout` 计时清零。
- **教训**：**观测手段本身会改变被测系统**（观察者效应）。收尾时一定要撤掉观测再复现一遍。这条最隐蔽 —— 排查工具和问题是同源的。

### 坑 A10 —— 想当然地认为「6053 能控制播放」

- **当时怎么想的**：设备 yaml 里有两个 `media_player`，于是设想把音量 / 进度 / 下一首都走 6053。
- **真相**：连上去 dump 后发现，**只有 1 个实体暴露**（没有 `name` 的实体 ESPHome 不暴露到 API），而且其 `featureFlags = 0x12520d` 里**没有 `SEEK` / `NEXT_TRACK` / `PREVIOUS_TRACK` / `PLAY`** —— 只能停不能起，也不能切歌、不能 seek。因为该实体背后是 speaker pipeline，面前只有一条 PCM 流，**压根没有曲目和队列的概念**。
- **教训**：**能力要向设备询问，不要凭 yaml 里的组件名推断。** 成本极低（一次 connect + dump），比写完代码才发现不支持便宜太多。

### 坑 A11 —— `esphome-client` 的 PSK 字段名写错

- **当时怎么想的**：照着另一个库的习惯写了 `encryptionKey`。
- **真相**：这个库叫 **`psk`**（client 标识也是 `clientId` 而非 `clientInfo`）。写错后**静默走明文握手**，设备回一个 `0x01` noise 指示字节 → `EncryptionRequiredError`。另外它也**没有 `error` 事件**，失败原因是挂在 `lifecycle` 的 `disconnect.cause` 上。
- **教训**：跨库 API 不要靠包名迁移经验。**让类型系统先拦一遍**——这两个错误都是 `tsc` 报出来的。

## 6.2 B 组：v4.0.17 → v4.0.18 → v4.0.19 → v4.0.20 四轮迭代（15 条）

### 坑 B1 —— 把「服务端只推 800ms」当成根因

- **现象**：解码日志 `lead=800000us`，只有 0.8 秒在途，设备抗抖动窗口极小。
- **错误判断**：认定「根因 = 服务端预推太浅」，打算直接把 `send_ahead` 硬编码抬到 2～3s 了事。
- **真相**：800ms 是**设备从未上报三个时序参数**时的保守回落缺省；而真正缺的是「**服务端完全没读 `buffer_capacity`**」——它根本不知道设备能吃多少，自然也就算不出该推多深。
- **正解**：做成**可配档位 + 按设备容量自动钳制**（§2.5）。硬编码一个更大的常数只是换了个拍脑袋的数。

### 坑 B2 —— 把 `buffer_capacity` 当成「时长」

- **错误判断**：看到 `buffer_capacity: 1600000` 以为是 1600000 微秒/毫秒级别的时长。
- **真相**：单位是**字节**。ESPHome 源码实锤：`components/sendspin/__init__.py` 把 `CONF_BUFFER_SIZE`（`media_source` 里 `cv.int_range(min=25000)`）塞进 `audio_buffer_capacity`；aiosendspin 同名字段作 `BufferTracker(capacity_bytes=...)` 消费。真机 `1600000` = 1.6MB = ESPHome 的 `buffer_size`。
- **正解**：按字节换算，除以**实测码率**（字节/秒）才得到秒数。

### 坑 B3 —— `client/state` 的 `state` 解析错位

- **错误判断**：以为 `state` 在 `player` 对象里，且以为日志里的 `output_delay=0ms required_lead=0ms min_buffer=0ms` 是**设备真实上报**。
- **真相**：真机实发 `state` 在**根层**；三个时序参数与 `available`/`buffer_capacity` 该固件**一个都不发**，日志里的 0 一直是**缺省值回显**。
- **正解**：根层优先、`player` 层回落；未上报就当「无约束」，绝不因新增门控砸掉旧设备（§2.11）。

### 坑 B4 —— FLAC 完全无声（最迷惑的一个）

- **现象**：FLAC 链路**完全没有声音**，PCM 正常；服务端日志全绿、进度照走、设备零报错。
- **错误判断**：先怀疑是「设备不认 FLAC」/「协商出错」/「设备丢流」，去查 `stream/start` 时机、查设备 codec 支持。
- **真相**：`codec_header` 的 **last-metadata-block 位错了**（v4.0.18 送 `0x00`）。而且 v4.0.17 之所以「有声」，是因为它**根本没送真实头** —— 它在 `encode()` 之前就兑现宣告，编码器还没产出，于是回落**合成头**（自带 last=1），**纯属偶然正确**。v4.0.18 把宣告延后到「首块音频就绪」后，第一次真正送出真实 STREAMINFO，才暴露了这个字节位。
- **正解**：强制 last 位 = 1（§2.4）。
- **教训**：**「能响」不等于「对」**。一个偶然奏效的回落路径会掩盖真正的 bug，直到你把正确的数据第一次真正送出去。

### 坑 B5 —— 预填充按 100% 容量算 → 逐帧拒收风暴

- **错误判断**：既然协议说 `buffer_capacity` 是硬上限，那把水位正好填到 100% 就是最优。
- **真相**：本仓按**时长**记账（`depth = cursor − now` 再乘平均码率），叠加每 chunk 协议头开销与最多一帧（25ms）水位过冲，**按 100% 算必然踩线** → 灌满后每一帧都被设备拒收（`Failed to send audio chunk` 风暴 + `Lost sync`）。
- **正解**：留 **0.6** 余量（§2.5）。100% → 15.30s 起风暴；60% → 0 拒收。

### 坑 B6 —— 把 ESPHome「三个时序参数报 0」当成设备诉求

- **错误判断**：以为设备报 `min_buffer=0` 就是「设备不需要缓冲」。
- **真相**：这三个参数在 spec 里对 player 是 **REQUIRED**，ESPHome 全报 0 是**客户端侧表达能力缺失**，不是真实诉求。服务端必须自己兜缺省（MusicFlow 兜 800ms，MA 兜 1000ms + 容量约束）。
- **正解**：不要信 0；以 `buffer_capacity`（字节）为准。

### 坑 B7 —— 未配 `network:` 块 → 高性能网络优化被自动打开

- **现象**：设备每隔几分钟掉一次流。
- **真相**：未配 `network:` 块时，`enable_high_performance` 被 sendspin 组件**自动启用**；社区（6 台 louder-esp32 实测）确认这是掉流主因。
- **正解**：显式配 `network: { enable_ipv6: true, enable_high_performance: false }`。

### 坑 B8 —— `decode_memory: internal` 在 S3 上无收益

- **错误判断**：以为放内部 RAM 解码更快、更稳。
- **真相**：官方明写 `internal`「**Has minimal benefit on the ESP32-S3**」。S3 + Octal 80MHz（最快 PSRAM）上 internal 无收益，还白吃紧张的内部 RAM。
- **正解**：`decode_memory: psram`（默认）。

### 坑 B9 —— 以为 PCM「更简单所以更稳」

- **错误判断**：PCM 是 memcpy、零编码成本，直觉上「更不容易出问题」。
- **真相**：PCM 48k/立体声/16bit = **1.536 Mbps**，是 FLAC 的约两倍空口占用，40 包/秒，在 WiFi 上压力更大。ESPHome 默认偏好其实是 FLAC。
- **正解**：默认 FLAC（§2.3）。PCM 只作为兜底。

### 坑 B10 —— 单测全绿 ≠ 真机不炸

- **现象**：本地 `187 文件 / 1598 例`全绿，真机上设备却在逐帧拒收。
- **真相**：设备侧的拒收/失步**不进容器日志**，服务端「看起来」全绿。
- **正解**：涉及容量/时序的改动，必须走真机受控 A/B（§7.6），看设备侧计数。

### 坑 B11 —— 热替换漏了「新 import 的模块」→ 崩溃循环

- **现象**：热部署后容器 `Restarting (1)` 死循环，`SyntaxError: The requested module './constants.js' does not provide an export named 'PREFILL_BUFFER_MAX_MS'`。
- **真相**：把预填充常量从 `streamEngine.ts` 搬到 `constants.ts`（避免循环 import）后，**只替换了 `streamEngine.js`，忘了 `constants.js`**。
- **正解**：部署自检项要覆盖「**新符号出现在哪个文件**」，别只查出现次数。另：崩溃循环中 `docker cp` 会失败，必须 `docker stop → cp → docker start`。

### 坑 B12 —— 不同曲目的 FLAC 码率差异被误判为「计量错误」

- **现象**：几首歌测出的钳制秒数不一样，怀疑码率计量有 bug。
- **真相**：FLAC 瞬时码率随内容起伏（氛围曲压得狠、码率低；密集曲高）。换算链路其实自洽 —— **在字节口径上恒为容量的 60%**。
- **正解**：以「字节占用率」而非「秒数」判断是否越界。

### 坑 B13 —— 把 HTTP 音频媒体源写成 `platform: http_request`

- **现象**：ESPHome 编译报 `Platform not found: 'media_source.http_request'`。
- **错误判断**：以为 HTTP 音频源就叫 `http_request`（`http_request` 确实是个真实存在的 ESPHome 组件名，于是想当然）。
- **真相**：`http_request` 是**顶层组件**（HTTP 客户端，用于自动化里发请求 / 给自签证书关 TLS 校验），**不是** `media_source` 的平台。HTTP 音频媒体源在 2026.9.0 的正确平台名是 **`audio_http`**。
  **源码实证**（tag `2026.9.0`）：`esphome/components/audio_http/media_source.py` **存在**；而 `esphome/components/http_request/` 目录下**没有任何 media-source 平台文件**。所以 `platform: http_request` 必然「平台未找到」。
- **正解**：`media_source: - platform: audio_http`（§3.4）。

### 坑 B14 —— 用「对齐不需要历史」否掉了「出声需要回填」（**曾经写进本文档的错结论**）

- **现象**：播放中把 Sendspin 播放器加入群组，**新设备要等 ≈29 秒才出声**（30s 档）。
- **当时的错误判断**：本文档 §5.3 曾写「**不抄 MA 式回填**」，理由是「时间戳绝对，新成员首帧 ts 即『现在 + send_ahead』，按 ts 排播天然对齐，无追赶概念」。
- **真相**：那个推理证明了**对齐**不需要历史，却把「出声延迟」偷换掉了 ——
  预填充把组游标推到**领先墙钟一整个水位**（§2.5 的抗抖动余量本身），而新成员只从**游标之后**收帧 ⇒ 首帧时间戳在 29s 之后 ⇒ 设备老实等到那一刻才播。
  MA 的回填也**不是为了对齐**（MA 同样用绝对时间戳），而是为了让新成员**拿到它本该已经收到的音频**，从而立刻出声。
- **正解**：`seedLateJoin` 回填「起点 ≥ `now + send_ahead + 100ms`」的缓存 chunk（§5.3）。

### 坑 B15 —— 「每成员一个编码器 + 每批产出取 max」把**并集**当成时间线推进量

- **现象**：FLAC 链路下播中加成员 → **整组一卡一卡**；且**只有当前这首坏，切下一首就恢复**。
- **当时的错误判断**：`pushFrame` 的注释写着「各成员产出的样本总应相同，取 max 以防某成员缓冲未吐拖慢时间线」—— 这个前提在**块编码器**下不成立。
- **真相**：libFLAC 攒满 4096 样本（≈85ms）才吐一帧，而喂料粒度 25ms ⇒ 每 3.4 批只有 1 批有产出。两个编码器的**块相位由创建时刻决定**：起播时全员同时创建 ⇒ 相位恒同 ⇒ 时间线正确；**播中加入者**的编码器在流中途创建 ⇒ 相位任意错开 ⇒ 逐批取 max 变成**并集计数**：

  ```
  批 k  : A 吐 4096 / B 吐 0     → 记 4096
  批 k+1: A 吐 0    / B 吐 4096  → 再记 4096   ← 两批共记 8192,真正上网只有 4096
  ```

  游标按 ~2× 推进（真机实测净 1.44×），帧时间戳跑到墙钟前面 → 设备排程跟不上 → 反复 `SYNC LOST(state=error)` ↔ `synchronized`（240 实测峰值 556 次/分钟，两台一起）。游标全组共享 ⇒ **全员一起卡**。「切歌即恢复」的指纹也由此解释：新曲全员重新创建编码器，相位重新对齐。
- **正解**：① **按 `(codec, gain)` 分组编码**（同组只编一次、字节分发给全组 ⇒ 结构上不存在相位错开）；② 时间线推进取 `max(各组**累计**交付样本)` 的增量，而非「每批取 max」（§2.6）。

## 6.3 这些坑的共同模式（提取成规则）

| 模式 | 犯在哪 | 防呆规则 |
|---|---|---|
| **拿参考实现当协议标准** | A1、A3、B4 | wire 格式只认接收端源码；「某实现这么做」不是证据 |
| **把相关当因果** | A2 | 判断标准必须锁定最终症状，中途不得换成「报错变少」 |
| **累积漂移** | A4 | 循环节流一律用绝对时刻，不用固定 sleep |
| **只看己方日志** | A5、B10 | 必须有外部判据；服务端自证不算证据 |
| **采样时序错** | A6 | 先订阅后触发，全程同一会话 |
| **字面理解反直觉参数** | A7 | `0s`、负数、`-1` 这类特殊值必须读官方原文 |
| **和结果只相关不因果的「解法」** | A8 | 先证明变量确实不同，再宣称修复 |
| **观察者效应** | A9 | 收尾必撤观测复现 |
| **凭配置推断能力** | A10 | 向设备询问能力，一次 dump 即可 |
| **跨库 API 记忆** | A11 | 交给类型系统 + 一次真跑 |
| **偶然正确掩盖真 bug** | B4 | 「能响」不等于「对」；要问「这条路是设计走通的还是碰巧走通的」 |
| **把缺省回显当成设备诉求** | B1、B3、B6 | 日志里的 0 先问「是谁写的 0」；未上报 = 无约束，不是零诉求 |
| **拍脑袋定常量** | B1、B5 | 一切阈值都要有来源（设备宣告 / 实测 / 规范条款），并留安全余量 |
| **用一个正确结论否掉另一个问题** | B14 | 「X 不需要 A」≠「Y 不需要 A」：先锁定症状，再证明该机制与**这个**症状无关 |
| **拿「各成员应当相同」当不变量** | B15 | 有状态编解码器（块编码器）下成员间**相位可以任意错开**；聚合口径必须在结构上不可能被相位影响 |

---

# 第七部分：验证方法

> 调试的总原则：**先问设备、再读源码、再抓字节、最后才调参**（§7.8）。
> 模拟器是 lenient 实现、真机（sendspin-cpp）是 strict 实现 —— **模拟器全通不代表真机能通**，反之亦然。

## 7.0 按症状找入口（出问题先看这张表）

| 症状 | 最可能的根因 | 直接查 |
|---|---|---|
| 完全无声，但服务端日志全绿、设备零报错 | FLAC `codec_header` last 位 = 0（坑 B4） | §2.4、§7.1 三件套 |
| 设备建了 `19200` 环形区，但 `speaker_mixer` 始终不 `Starting` | STREAMINFO 的 min/max block size ≠ 4096（§7.4 归档坑） | §7.1 基准序列逐行比对 |
| 一卡一卡 / 节奏越播越偏 | 用固定 `sleep()` 做 pacing，累积漂移（坑 A4） | §2.7 |
| 播十几秒后逐帧 `Failed to send audio chunk` | 预填充水位 > 设备容量（坑 B5） | §7.2 服务端日志 → §2.5 |
| `Lost sync (Xus off)` 风暴 | 同上，容量越界的具体表现 | §7.2 |
| 每 5~6 分钟重拨一次（假重连循环） | 在等设备回 `server/activate`（真机**永不回**）→ 15s activation timeout 自杀 | §2.1 条款 2 |
| 每次都「准时 30 秒」断开 | 握手卡在 `HELLO_SENT`，撞 30 秒红线被 drop | §2.1 条款 3、§7.4 |
| 设备回 `goodbye: another_server` 后**永不再连** | `dial_targets.json` 里留了设备自身 `:8928` → `noAutoRedial` 永久抑制 | §2.12 |
| 进度 / 歌词从缓冲深度起跳（如设 10s 就从 `00:10` 开始） | 报了「已推送」位置而非「可听位置」（v4.0.19 已修） | §2.8 |
| 选了 15/20/25/30 档却感觉没生效 | 被设备容量**正常钳制**（不是失效）→ 需调大设备 `buffer_size` | §7.2 找 `clamped prefill` 日志 → §3.2 |
| 设备日志一条都收不到 | 方法一漏了 `dump_config=True`；或错过窗口期 | §7.3 |
| 冷启播完全没反应，但暂停后恢复正常 | 只调了 `pump.resume()`，没走 `playMedia` 冷起播 | §2.13 冷起播条 |
| 模拟器能播、真机不能（或反之） | 模拟器 lenient / 真机 strict，不能互相背书 | §7.7 |

## 7.1 出声判据（设备侧）

| 层 | 判据 |
|---|---|
| 协议 | `Processed new codec header: <codec>, 48000 Hz, 2 ch, 16-bit` |
| 播放器 | `State changed to PLAYING` |
| **出声三件套** | `speaker_mixer Starting` → `i2s_audio.speaker Starting` → `96000 ring_buffer [speaker_task]` |
| **6053 只读面** | `media_player state=2 (PLAYING)` |
| **最终** | **用户耳朵验收** ← 唯一有效判据 |

**正确出声的完整设备侧序列**（可作基准比对）：

```
Group update - state: playing, id: 3C:0F:02:F9:69:E4
Stream Started
Processed new codec header: flac, 48000 Hz, 2 ch, 16-bit
sendspin_id: current
State changed to PLAYING
Created ring buffer with size 19200              ← 解码环形区
speaker_mixer:369 Starting                        ← 输出链路起来（关键标志）
i2s_audio.speaker:070 Starting                    ← I2S 输出起来（关键标志）
Created ring buffer with size 96000 [speaker_task] ← 输出环形区（关键标志）
```

切歌时（扬声器**不拆**）：

```
Stream ended - player:1 artwork:1 visualizer:1
Group update - state: playing
State changed to IDLE
Stream Started
Processed new codec header: flac, 48000 Hz, 2 ch, 16-bit
sendspin_id: current
State changed to PLAYING
Created ring buffer with size 19200
```

> `speaker_mixer Starting` / `i2s_audio.speaker Starting` / `96000 ring_buffer` **只在首次出现一次**，后续切歌不再打印 —— 这是正常的，不代表掉链。判「有没有掉」看有没有 `stopped`。
> `19200 ring_buffer` 早于三件套出现。

## 7.2 服务端自证日志速查

| 日志字样 | 含义 |
|---|---|
| `client/hello: device buffer_capacity=<N> bytes …` | 设备宣告的容量（字节），钳制的分子来源 |
| `… clamped prefill to <ms> by device capacity …` | 档位被容量钳制（带实测码率），**不是档位失效** |
| `SYNC LOST (state=error)` / `synchronized` | 设备失步/恢复的时间线（服务端可自证，不必看设备串口） |
| `Processed new codec header: flac, 48000 Hz, 2 ch, 16-bit` + `State changed to PLAYING` | FLAC 链路真正出声的铁证 |
| `[Esphome] 6053 已连接 …` | 只读监控通道就绪 |

**设备侧关键错误字样**（`logger: level: DEBUG` 时可见）：`Failed to send audio chunk`（缓冲满逐帧拒收）、`Lost sync (Xus off)`、`Time message N/8 timed out`、`underrun`。
> 注意：稳定播放时设备**零日志**，看计数不看有无。

**调试开关**：`SENDSPIN_JITTER=1`（打印 diff 序列）、`SENDSPIN_PUSH_SPEED`、`SENDSPIN_STREAM_SOURCE=1`（流式解码）。

## 7.3 设备日志抓取（三法）

### 方法一：原生 API 订阅日志（推荐，可脚本化）

```bash
pip install --break-system-packages aioesphomeapi
```

```python
import asyncio, re
from aioesphomeapi import APIClient
from aioesphomeapi.model import LogLevel

ANSI = re.compile(rb'\x1b\[[0-9;]*m')

async def main():
    api = APIClient("192.168.10.245", 6053, None,
                    noise_psk="<yaml 里 api.encryption.key 的值>")
    await api.connect(login=True)
    def on_log(entry):
        msg = entry.message if isinstance(entry.message, bytes) else entry.message.encode()
        print(ANSI.sub(b'', msg).decode('utf8', 'replace'), flush=True)
    # dump_config=True 是钥匙：不带它经常一条日志都收不到；
    # log_level=DEBUG 才能看到 sendspin [D] 行；message 可能是 bytes，先脱 ANSI 色。
    api.subscribe_logs(on_log, log_level=LogLevel.LOG_LEVEL_DEBUG, dump_config=True)
    await asyncio.sleep(60)

asyncio.run(main())
```

同接口还能查实体状态（播放器是否真在播，比日志更准）：

```python
ents = await api.list_entities_services()   # 找 MediaPlayerInfo(object_id=speaker_media_player)
api.subscribe_states(lambda s: print(s.key, getattr(s, 'state', None)))
# state: 0=NONE, 1=IDLE, 2=PLAYING, 3=PAUSED
```

### 方法二：ESPHome Dashboard → 设备 → LOGS（无线）

最省事，适合人眼盯。注意窗口期：拨号后 30~50 秒、播放起止前后是关键段。

### 方法三：设备 Web 页面 `http://<ip>/events`（SSE，慎用）

实测只下发 `ping`（但 ping 里 `"log":true` 表示服务端支持），`log` 事件没下来。**该通道目前看不到日志，别在这上面烧时间**。用方法一/二。

## 7.4 抓包（服务端侧）与消息速查

```bash
tcpdump -i any -U -w esphome.pcap "host 192.168.10.245"
```

关键消息速查（全是明文 JSON，TEXT 帧；`client/hello` 先行即 legacy 明文模式）：

| 方向 | 消息 | 要看的点 |
|---|---|---|
| C→S | `client/hello` | `supported_formats` 顺序（flac/opus/pcm）、`supported_roles`、**`player@v1_support.buffer_capacity`** |
| S→C | `server/hello` | **五字段必须齐**；`connection_reason` 只能是 `discovery`/`playback` |
| S→C | `server/activate` | `{activities:["playback"], active_roles}`；真机这版直接 `Unhandled`（忽略），不指望它推进状态 |
| S→C | `group/update` | `{playback_state, group_id, group_name}`；spec 要求首次 activate 后立即发 |
| S→C | `stream/start` | `{player:{codec, sample_rate, channels, bit_depth, codec_header?}}`；**FLAC 必须带 `codec_header`，否则整条作废 + 之后每块音频全灭** |
| S→C | 音频帧 | 二进制；opus ≈20ms/包，flac 看编码器脸色 |
| S→C | `stream/end` | 曲终/停止必须发，否则设备永远卡 PLAYING |
| C→S | `client/goodbye` | `reason` 语义：`another_server` = 切到别的 server（服务端 SHOULD NOT 自动重拨）；`restart` 才可重拨 |
| C→S | `client/time` / `client/state` | 心跳与状态（`state:synchronized` + 音量/静音表示会话健康参与中） |

## 7.5 mDNS 速查

见 §2.12。node 单行浏览（仓库自带 `bonjour-service`）：

```js
import { Bonjour } from "/workspace/MusicFlow/backend/node_modules/bonjour-service/dist/index.js";
new Bonjour().find({ type: "sendspin-server" },
  (s) => console.log("FOUND:", s.name, s.host, s.port, JSON.stringify(s.txt)));
setTimeout(() => process.exit(0), 10000);
```

## 7.6 受控 A/B（唯一能证伪的方法）

同一台设备、同一首歌，只改一个变量（档位 / codec / `buffer_size`），同步抓「服务端时间线 + 设备日志」，对比 `Failed to send audio chunk` 与 `Lost sync` 的**计数**。

- 100% 占用必现拒收风暴、60% 必为 0 —— 这是容量匹配是否正确的判据。
- 涉及容量/时序的改动，**必须**走这条路（单测全绿 ≠ 真机不炸，坑 B10）。

## 7.7 模拟器联调

仓库自带两个基于官方 `aiosendspin 9.x` 的协议模拟器（含 Noise 加密握手，与服务端互操作已验证）。脚本在 `backend/scripts/` 下。

```bash
python3 -m venv /tmp/sendspin-venv
/tmp/sendspin-venv/bin/pip install "aiosendspin==9.1.1"      # 要求 Python ≥ 3.12
```

> 注意：官方 `sendspin` CLI（播放器）至今还 pin 着 `aiosendspin~=6.0.1`（前加密时代），连不上合规加密服务端，**不要用它联调**。

**模式一（拨入，模拟普通播放器上线）**：

```bash
/tmp/sendspin-venv/bin/python backend/scripts/sendspin-sim-player.py \
  ws://<服务端IP>:38927/sendspin [静态配对码]
```

- 不带配对码：以未配对访问（UNPAIRED）上线，能播（需服务端允许未配对播放）。
- 带 8 位静态码（如 `12345678`）：同时打开配对窗口，可走设置页静态码配对全流程。
- `SIM_LOG=DEBUG` 看握手/配对详细日志；收到音频会打 `[audio] chunks=... bytes=...`（只计数不放音）。

**模式二（监听，模拟可被拨号的播放器）**：

```bash
/tmp/sendspin-venv/bin/python backend/scripts/sendspin-sim-listener.py [端口] [名字]
# 缺省：端口 18931，名字 MF-Listen-Speaker
```

监听 `0.0.0.0:<端口>/sendspin`，mDNS 不广播（手动填 IP 即可）；服务端拨入后日志显示 `server attached, admitted`。

**联调对照表**：

| 步骤 | 服务端日志 | 模拟器日志 |
|---|---|---|
| 连上 | `new connection from` | `CONNECTED+ADMITTED` / `server attached` |
| 握手通过 | `handshake ok: <clientId>` | （无报错即过） |
| 激活注册 | `activated <clientId> name=...` / `registered Sendspin client` | — |
| 推流到达 | （按组推帧，无单帧日志） | `[audio] chunks=N bytes=M fmt=...` |

**FAQ**：连上但 `chunks=0` → 看 `fmt=` 的 codec 是否在客户端声明的 `supported_formats` 里；`pairing_required` 被拒 → 未配对会话要开客户端 `unpaired_access`，或走正式配对流程；连不上 38927 → 确认插件 `sendspin-renderer` 已启用、端口（默认 38927）与防火墙，`curl` 拿到 `101` 即 WS 通路正常。

> **忠实协议客户端**：`backend/scripts/sendspin-client-sim.mjs <server_id> <psk_hex>`（Noise KKpsk2 responder，直连 `:38927/sendspin`），用于「真实 WebSocket 全连路」验证而非仅进程内单测。

## 7.8 最低成本的取证顺序（下次照这个走）

1. **先问设备**：连一次 6053，dump 实体与 `featureFlags` —— 先搞清楚它到底能干什么。
2. **再读接收端源码**：grep 关键字段名；**零命中就可以直接证伪一个假设**（坑 A1 就是这么解决的）。
3. **抓真实下发字节**：临时 dump 实际发出的包，和设备期望的格式逐字节对齐。
4. **再谈调参**：参数能改已经多了的现象 ≠ 解决了问题（坑 A2、A3）。
5. **收尾撤观测复现一遍**（坑 A9）。

**回归命令**：

```bash
cd backend
npx tsc --noEmit
npx vitest run tests/sendspin/ src/services/sendspin/
npx vitest run src/services/sendspin/playerGroup.test.ts
```

---

# 第八部分：MusicFlow vs Music Assistant 对齐表

> MA 的节奏/背压逻辑在 `aiosendspin`（MA 的同步内核库），**不在 provider 里**。provider（`music_assistant/providers/sendspin/*.py`）只做 DSP、元数据、发现与桥接，同步/推流全部委托给 `aiosendspin.server`。以下为**仍在参考**的对齐清单，标注当前状态。

## 8.0 参考实现的权威出处（查证用）

**架构**：`┌ SendspinProvider ─▶ SendspinServer(port 8927) ─▶ Audio Streams ┐`，客户端直连 WebSocket（`ws://<ma>:8927/sendspin`）或 WebRTC DataChannel（局域网外）。

| 关注点 | 文件 | 关键符号 |
|---|---|---|
| 推流时间线 / 缓存 / late-join | `aiosendspin/server/push_stream.py` | `PushStream`、`commit_audio()`、`now_us()`、`_channel_timing`（+`_channel_timing_residue` 无漂移累加）、`prepare_historical_audio()`、`prepare_audio()`、`_pcm_chunk_cache`、`_role_chunk_cache`、`_prune_role_chunk_cache()`、`on_role_join()`、`_do_role_join()`、`_pending_join_roles`、`_start_catchup_encoding()`、`sleep_to_limit_buffer()`、`set_live_source()`、`_min_send_ahead_us()` |
| 组与成员增删 | `aiosendspin/server/group.py` | `SendspinGroup`、`_group_roles`、`on_client_added/removed`、`add_client()`（先 `client.ungroup()`）、`remove_client()`、`start_stream()`（换流 `keep_stream=True`）、`_play_start_time_us` |
| 角色模型 | `aiosendspin/server/roles/`、`client.py` | `Role`、`get_audio_requirements()`、`AudioRequirements`、`AudioChunk`、`supports_preconnect_audio()` |
| MA 侧播放管线 | `music_assistant/providers/sendspin/playback.py` | `SendspinPlaybackSession`、`commit_audio()`、`_history`、`_start_join_catchup()`、`_feed_join_history()`、`_promote_join_catchup_processor()`、`_pad_history_to_live_tail()`、`_wait_for_buffer_drain()` |
| MA 侧组员管理 | `music_assistant/providers/sendspin/player.py`、`provider.py` | `SendspinPlayer`、`SendspinGroup` 模型、`create_virtual_player()`（服务端常驻 anchor ⇒ **成员来去不会触发 leader 迁移**） |

**可直接引用的常量**（本仓取值都已对齐）：

| 常量 | 值 | 含义 |
|---|---|---|
| `DEFAULT_INITIAL_DELAY_US` | 250 000 | 无角色/无锚点时的兜底提前量 |
| `LATE_JOINER_MIN_LEAD_US` | 100 000 | late-join 目标时刻的最小提前量 |
| `_HISTORY_KEEP_PAST_US` | 1 000 000 | 回填缓存保留的「已播过」尾巴 |
| `ENCODER_CATCHUP_WARMUP_US` | 120 000 | 追赶编码预热 |
| `_JOIN_PROMOTE_ARM_WINDOW_US` / `_JOIN_PROMOTE_TOLERANCE_US` | 2 000 000 / 50 000 | 追赶处理器「提升为实时管线」的进入窗口与容差 |
| `_JOIN_PROMOTION_TIMEOUT_S` | 15.0 | 追赶超时放弃 |
| `_PRODUCER_BUFFER_LIMIT_US` | 30 000 000 | 背压上限（= 我们的预填充 30s 天花板） |
| `max_duration_us`（`PlayerPersistentState`） | 30 000 000 | 时长天花板 |

## 8.1 早期结构性错位（均已修复，存档备查）

2026-09-17 的全面审计发现两处**结构性错位**（非参数微调能修）：**编码器生命周期** 与 **时间线/超前量**。均已修复并经真机验收。

| 环节 | MA（aiosendspin） | 曾经的 MusicFlow | 结果 |
|---|---|---|---|
| **编码器生命周期** | 单实例长驻 | 每 0.5s 重起 ffmpeg，每段独立完整 FLAC 文件 | ❌ 结构性错位 → 已修 |
| **下发字节形态** | 裸 FLAC 帧（无 `fLaC`/STREAMINFO） | 完整 FLAC 文件（每段自带 `fLaC`+STREAMINFO） | ❌ 无声根因 → 已修 |
| **`stream/start` 时机** | 推迟到首块音频 | 已改为首帧前发 | ✅ |
| **`stream/end` 时机** | 置 `_stream_started=False`，之后音频**全部丢弃**直到新 start | 发 `stream/end` + `group/update` | ⚠️ **无「丢音频」守卫**（未做） |
| **chunk 时长** | 25ms | 曾 100ms + 0.5s 分段 | ✅ 已对齐 25ms |
| **时间戳** | 样本精确推进 + residue | 曾 `i * FRAME_MS * 1000` | ✅ 已修（按实产样本） |
| **`send_ahead` 单位/取值** | 微秒；`max(min_buffer, required_lead) + output_delay` | 曾毫秒；硬编码 800ms | ⚠️ 单位已对齐；仍不消费设备上报（坑 B6） |

**存档教训**：MA 是**一个长生命周期编码器**，`stream/start` 已把 STREAMINFO 通过 `codec_header` 给过设备，之后只下发**裸 FLAC 帧**。设备拿到 `codec_header` 后按「连续帧流」解析；每 0.5s 塞一个 `fLaC` magic + STREAMINFO 进去 → 解码器在期待 frame sync 的位置遇到文件头 → **整帧作废、静默、零报错**（micro-flac 对损坏帧静默丢弃）。

## 8.2 现行对齐清单

| # | 机制 | MA / aiosendspin | MusicFlow v4.0.19 | 状态 |
|---|---|---|---|---|
| 1 | 时间同步优先级 | 独立优先级队列，writer 每轮先排空它再发音频 | 无优先级通道，靠「落后让出宏任务」（§2.9）缓解 | 部分 |
| 2 | 背压（`buffer_capacity`） | `BufferTracker` 双闸门（字节 + 时长，`max_duration_us=30s`） | **已实现容量钳制**（预填充不越容量），但非运行时逐帧背压 | 部分 |
| 3 | 迟到帧处理 | `drop_late=True` + 2s 宽限期 | 无 | 未做 |
| 4 | 事件循环防饿死 | 每 50 次迭代强制 `await asyncio.sleep(0)` | 落后时 `setImmediate` 让出（§2.9） | ✅ |
| 5 | 预推深度 | producer 推到领先 60s，受客户端 buffer 约束 | 可配档位 + 容量钳制（§2.5） | ✅ |
| 6 | 追赶策略 | 上游饥饿时整条时间线向前跳（rebase） | 落后多少补多少 | 未做 |
| 7 | 时钟源 | `RawMonotonicClock`（避免 NTP slew 毒化） | 配速用墙钟、时间戳用单调钟混用 | 未做 |
| 8 | 编码成本 | `TransformerPool`：按 transform key 共享编码器，同 chunk 分发给所有 role | **已实现**：按 `(codec, gain)` 分组编码，同组只编一次、字节分发给全组（§2.6 ③） | ✅ |
| 9 | 音源窗口 CPU | — | `PcmWindow` 每次 `slice` 从头线性扫描、`evict()` 做 O(n) `shift()` | 未做 |
| 10 | 慢设备处置 | 队列溢出 → 断连重连，不拖累全组 | 无检测 | 未做 |
| 11 | time 请求频率 | 客户端自适应（未同步 0.2s，稳定 3s） | 服务端被动应答 | 未做 |
| 12 | **late-join 回填** | `on_role_join` 回放**尚未播到**的缓存（`_role_chunk_cache`，`LATE_JOINER_MIN_LEAD_US=100ms`） | **已实现**：`seedLateJoin`（§5.3），新成员约 0.1s 出声 | ✅ |
| 13 | 成员换组 | `add_client` 第一步 `await client.ungroup()`（一个客户端只属于一个组） | `joinGroupCore` 直接改 `conn.group`，**未**从旧组 `remove` ⇒ 可能双成员（旧组仍在 `members` 里） | ⚠️ 待修（见下） |
| 14 | 显式操控成员 | `ensure_player_ungrouped` 语义 | 已实现（`detachFromActiveGroups`） | ✅ |

## 8.3 真机验证记录（v4.0.20，2026-09-24）

受控复现脚本 `/root/lj_test.sh`（240 容器内）：① 移出 `esp32-player-meet` → ② `playnow group:ab7fca6f-…` 组起播（仅 `esp32-player2`，FLAC）→ ③ 等 45s 灌深水位 → ④ **播中加入** `esp32-player-meet` → ⑤ 观察 75s → `python3 /root/an_latejoin.py 200 <gid>`。

| 观测项 | 修复前 | 修复后（v4.0.20 实测） |
|---|---|---|
| 新成员出声延迟 | 空等**一个完整水位** ≈ 29s | **≈ 0.1s**（首帧 `delta = ts − send_ahead − now = 100ms`） |
| 群组播放速率 | **1.44×**（超速、一卡一卡） | **1.00×**（`pos` 40s/40s） |
| `SYNC LOST` / `Lost sync` | 持续风暴 | **0 / 0** |
| 编码器零产出 / `pushLoop` 退出 | 频发 | **0 / 0** |
| `timeline RE-anchored` | — | **0**（流全程未重启、时间轴未重锚） |

关键日志（原文）：

```text
05:01:38 [sendspin] 预填充水位按设备容量钳制:档位=30000ms → 实际=29995ms
                    (设备 buffer_capacity=4800000B, 实测码率=96014B/s, 目标占用≈2879926B=60%)
05:02:41 announceStream -> {"player":{"codec":"flac",…}}
05:02:41 [sendspin] sendspin late-join 回填: client=3C:0F:02:F9:69:E4 codec=flac
                    chunks=341 span=29099ms target=882706us(ahead of now)
                    group=ug:ab7fca6f-82fe-49f5-9652-32440f83a4f1
```

**读数要点**（下次照此判读）：

- `target=882706us` = `send_ahead 800000 + LATE_JOIN_MARGIN_US 100000` —— 证明回填**贴住既有时间轴**，没有自选提前量。
- `chunks=341` × 85.33ms ≈ **29099ms**，与钳制水位 `29995ms` 严丝合缝（差的就是那 900ms 的 `send_ahead+margin`）。
  341 这个数字同时反证编码器粒度：libFLAC 攒满 4096 样本（≈85.33ms）才吐一帧，**不是**每 25ms 一帧。
- 回填前 17ms 先出现 `announceStream`（两行），顺序正确 —— `seedLateJoin` 内部先兑现
  `pendingAnnounces`、再推缓存字节；反过来设备会因缺 `codec_header` 丢弃缓存帧。
- 加入后 `synchronized` 计数为 **0**（起播阶段那 2 次是设备握手，与本次无关）。

**为何不会撑爆设备缓冲**：回填 29.1s ≈ 2.79MB < `buffer_capacity` 4.8MB；此后设备「收到速率 = 播出速率」，
差值恒定为 `29995 − 900 = 29095ms`，稳态不增长。（水位钳制按目标占用 60% 算，40% 余量即为此留。）

---

# 第九部分：环境与部署

## 9.1 热部署（240 容器，无代码卷挂载）

```bash
# 本机
cd backend && npx tsc
scp -P 35320 -i "E:\SSH私钥\mykey\mykey" dist/... root@192.168.10.240:/root/
# 服务器
docker cp /root/xxx.js musicflow:/app/backend/xxx.js
docker exec musicflow chown -R musicflow:musicflow /app/backend
docker restart musicflow
```

- ⚠️ **只能用 `docker restart`** —— `docker compose up --force-recreate` 会抹掉 `docker cp` 的补丁。
- ⚠️ 崩溃循环中 `docker cp` 会失败，必须 `docker stop → cp → docker start`（坑 B11）。
- ⚠️ 替换前先确认「**新符号出现在哪个文件**」，别只查出现次数。

## 9.2 环境速查

- 宿主：`192.168.10.240`，`ssh -i "E:\SSH私钥\mykey\mykey" -p 35320 root@192.168.10.240`
- 容器：`musicflow`（镜像 `ray5378/musicflow:latest`，`entrypoint.sh → node dist/index.js`）
- 数据卷：`/vol1/1000/SSD/docker/musicflow/data`（`musicflow.db`、`sendspin/{identity.key,dial_targets.json,pairing_store.json}`）
- 设备：`esp32-player-meet`（ESP32-S3，MAC `3C:0F:02:F9:69:E4`，IP `192.168.10.245`）
- 设备 Native API PSK：设备 yaml 中 `api: encryption: key` 的值
- ESPHome：**2026.9.0**；`sendspin-cpp 0.7.2`；`micro-flac 0.2.0`

## 9.3 ESPHome 只读监控（6053）

配置：插件页 `Sendspin 播放器` → `ESPHome 只读监控(6053)` 开关 + `ESPHome API 加密密钥`。设备 IP **自动派生**（取自 Sendspin 连接的对端地址），无需填写。

实测能力边界（`featureFlags = 0x12520d`）：

| 能做 | 不能做 |
|---|---|
| 读 `state`（NONE/IDLE/PLAYING/PAUSED/…） | ❌ `SEEK` —— 设备未宣告 |
| 读 `volume`（speaker 硬件输出音量） | ❌ `NEXT_TRACK` / `PREVIOUS_TRACK` |
| PAUSE / STOP | ❌ `PLAY` —— **只能停不能起** |
| 保活（喂 `reboot_timeout` 计时） | ❌ 音量不建议在这里设（与 Sendspin group volume 相乘会打架） |

根因：6053 上能看到的实体是 `platform: speaker_source` 的 `Speaker Media Player`（yaml 里 `platform: sendspin` 那个没写 `name`，ESPHome **不会暴露无 name 的实体**），它面前只有一条 PCM 流，**没有曲目和队列的概念**。切歌与进度的权威天然在服务端。

查询出口：`GET /v1/sendspin/esphome`（**不回显 PSK**）。

---

# 第十部分：遗留与待办

## 10.1 已实现（本轮及此前版本闭环）

- ✅ 9B 音频帧头（回归锁在 `framing.test.ts`）
- ✅ 时间线按**实际产出**推进（`STALL_GRACE_US` 降级）
- ✅ pacing 绝对时刻调度
- ✅ codec 协商可配（`preferred_codec`，插件页下拉）
- ✅ FLAC 编码器 asm.js + 真实元数据流提取 `codec_header`
- ✅ FLAC `codec_header` last 位 = 1（v4.0.19）
- ✅ 预填充档位 + **按设备容量自动钳制**（0.6 余量，v4.0.19）
- ✅ 进度上报改为**可听位置** + seek 下界（v4.0.19）
- ✅ `client/state` 根层解析 + `SYNC LOST` / `synchronized` 日志（v4.0.19）
- ✅ 落后时让出宏任务（`setImmediate`）
- ✅ 曲末分段排空
- ✅ 流式解码 `PcmWindow`（`SENDSPIN_STREAM_SOURCE`）
- ✅ 多房组管理（命名空间 + 增量成员口 + 直播沿加入）
- ✅ **按 `(codec, gain)` 分组编码** + 时间线 `max-of-累计`（v4.0.20，§2.6，修「播中加入成员 → 整组卡顿」）— **真机实测 1.44× → 1.00×**（§8.3）
- ✅ **late-join 回填** `seedLateJoin`（v4.0.20，§5.3，修「加入新设备要很久才出声」）— **真机实测 ≈29s → ≈0.1s**（§8.3）
- ✅ ESPHome 6053 只读监控 + `GET /v1/sendspin/esphome`
- ✅ 长音源 ref 长度溢出修复（v4.0.19）

## 10.2 未做（留待决定）

| 项 | 说明 |
|---|---|
| **成员换组未从旧组摘出** | `joinGroupCore` 直接改 `conn.group`/`g.add(conn)`，**没有** `prev.remove(conn)`；MA `add_client` 第一步就是 `await client.ungroup()`（一个客户端只属于一个组）。现状：旧组 `members` 仍持有该 conn，若旧组也在推流则设备收**双流**。修法：抽 `SendspinServer.detachFromGroup(conn)`（组空 → `stopGroupPump` + `close`，与 `onConnectionClosed` 同款收尾），`joinGroupCore` 先调它。⚠️ 需同时确保「为换组而停的 pump」不被 tracker 误判为自然结束（`GroupPump.stop()` 已走 epoch 路径、不置 `endedNaturally`，但仍要核对 `pollState` 的上报语义） |
| **加入群组时中止该设备原有独立会话** | 已确认方向（选项 A）：设备加进组即停掉它自己的 pump + 清队列标记，绝不让 tracker 判 `advance`。与上一项同批做（同一处语义） |
| `stream/end` 音频丢弃守卫 | 对齐 MA `_stream_started` |
| 迟到帧丢弃 | 对齐 MA `drop_late=True` + 2s 宽限期 |
| 时间线 rebase | 上游饥饿时整条时间线向前跳 |
| 统一时钟源 | 避免墙钟/单调钟混用（NTP slew 毒化） |
| `PcmWindow` 环形缓冲 | 消除每次 `slice` 的线性扫描与 `evict()` 的 O(n) `shift()` |
| 慢设备断连 | 队列溢出 → 断连重连，不拖累全组 |
| `state:error` 自适应回缩水位 | 现仅记日志，未据此自动降水位 |
| 切歌 `finishPlayback` 被调用两次 | 幂等性收敛 |
| `broadcastGroupState` 死代码 | `PlayerStatePayload` 实为 client → server 方向 |
| `SendspinGroup` 重复定义 | `group.ts` 与 `server.ts` 各有一份，待合并 |
| 插件页 `preferred_codec` 帮助文案量化码率 | 任务 4 遗留，不阻塞 |

## 10.3 已知边界（不是 bug）

- **PCM 下 30s 档位物理不可达**（需 9.6MB > 8MB PSRAM）。解决法：确保走 FLAC，或换更大 PSRAM 的板子。
- **FLAC 码率随曲目起伏**（0.7～0.9 Mbps），故钳制秒数逐曲不同；按**字节占用率**判断是否越界。
- **设备只在状态翻转时发 `client/state`**，不要期待周期心跳。

---

# 附录

## A. 设备配置（ESP32-S3，**已脱敏**）

> **相对原始配置的改动点只有 3 处**：新增 `network:` 块、`buffer_size` 设为 6MB、`decode_memory` 用 `psram`。其余保持原样。
> **api 密钥 / WiFi SSID / 密码已用 `XXXXX` 占位，烧录前请换成你自己的值。**

```yaml
# Board: Generic ESP32-S3 Board (Generic)
# Definition: definitions/boards/generic-esp32s3/manifest.yaml
esphome:
  name: esp32-player2
  friendly_name: esp32-player2

esp32:
  board: esp32-s3-devkitc-1
  flash_size: 16MB
  framework:
    type: esp-idf
    version: 5.5.4

logger:
web_server:
  port: 80

api:
  encryption:
    key: "XXXXXXXX"          # ← 换成你自己的 api.encryption.key
  reboot_timeout: 600s

ota:
  - platform: esphome
    password: !secret esp32_player_meet__encryption_key

# ★ 改动 1：关掉 sendspin 自动打开的高性能网络优化（未配 network: 块时该优化被自动启用，
#   社区实测是「每隔几分钟掉一次」的直接原因，见坑 B7）。
network:
  enable_ipv6: true
  enable_high_performance: false

wifi:
  networks:
    - ssid: XXXXX            # ← 换成你自己的 WiFi SSID
      password: XXXXX        # ← 换成你自己的 WiFi 密码
  manual_ip:
    static_ip: 192.168.10.245
    gateway: 192.168.10.1
    subnet: 255.255.255.0
    dns1: 223.5.5.5
    dns2: 8.8.8.8
  # 关闭 Wi-Fi 省电，避免连接不稳定导致音频流中断
  power_save_mode: none
  # 8.5dB 是 ESPHome 允许的下限(默认 20.5dB)；RSSI < -70dBm 建议回到 17~20.5
  output_power: 8.5
  ap:
    ssid: XXXXX              # ← 换成你自己的 AP SSID
    password: XXXXX          # ← 换成你自己的 AP 密码

captive_portal:

psram:
  mode: octal
  speed: 80MHz

sendspin:
  id: sendspin_hub

i2s_audio:
  - id: i2s_output
    i2s_lrclk_pin: GPIO7
    i2s_bclk_pin: GPIO6

speaker:
  - platform: i2s_audio
    id: speaker_id
    dac_type: external
    i2s_dout_pin: GPIO5
    i2s_audio_id: i2s_output
    sample_rate: 48000
    bits_per_sample: 16bit
    channel: stereo
  - platform: mixer
    id: mixer_speaker_id
    output_speaker: speaker_id
    source_speakers:
      - id: announcement_spk_mixer_input
      - id: media_spk_mixer_input
  - platform: resampler
    id: media_spk_resampling_input
    output_speaker: media_spk_mixer_input
  - platform: resampler
    id: announcement_spk_resampling_input
    output_speaker: announcement_spk_mixer_input

media_source:
  # HTTP 音频源平台名 = audio_http（写成 http_request 会报「平台未找到」，见坑 B13）
  - platform: audio_http
    id: http_source_media
  - platform: audio_http
    id: http_source_announcement
  - platform: sendspin
    id: sendspin_source
    # ★ 改动 2：6MB。FLAC 下解锁 20/25/30s 预设（见 §3.2 对照表）。
    #   选型公式：buffer_size ≥ 档位 × 实测码率 ÷ 0.6。
    buffer_size: 6000000
    # ★ 改动 3：改回 psram（官方文档明写 internal 在 ESP32-S3 上收益极小，见坑 B8）。
    decode_memory: psram
    task_stack_in_psram: true

media_player:
  - platform: sendspin
    id: sendspin_group_media_player
  - platform: speaker_source
    name: "Speaker Media Player"
    id: speaker_media_player_id
    media_pipeline:
      speaker: media_spk_resampling_input
      num_channels: 2
      sources:
        - sendspin_source
        - http_source_media
    announcement_pipeline:
      speaker: announcement_spk_resampling_input
      num_channels: 1
      sources:
        - http_source_announcement
```

### 排障时临时追加（验证完记得撤掉）

```yaml
# logger 已存在，把级别临时改成 DEBUG 抓设备侧证据：
#   logger:
#     level: DEBUG      # 找 Failed to send audio chunk / Lost sync / Time message N/8 timed out / underrun

# 判断 output_power 该往哪调：
# sensor:
#   - platform: wifi_signal
#     name: "ESP32 WiFi Signal"
#     update_interval: 30s
#   → RSSI > -60dBm 可保持 8.5；RSSI < -70dBm 建议回到 17~20.5dB
```

### 两个提醒

1. `ota: password:` 与 `api: encryption:` 并存时 ESPHome 校验会告警（建议改用 `ota: encryption:` 复用 API 密钥）；不影响编译。
2. 若多台设备共用同一个 `static_ip`，会互相抢地址 —— 烧录前核对 `manual_ip`。

## B. 协议规范关键条款（Sendspin spec）

> `buffer_capacity` is a **hard per-player byte limit**; servers should not send data that would cause a player's queued compressed audio to exceed this limit.
> `server MUST NOT send stream/start unless the latest client/state reports available:true`.
> Especially for live streams, servers must schedule timestamps so each player's queued audio duration stays at or above its `min_buffer_ms`.
> Servers **may rate-limit, debounce, or coalesce** a player's timing updates.

`min_buffer_ms` / `required_lead_time_ms` / `static_delay_ms` 对 player 是 **REQUIRED** 字段。

## C. 归档文档索引

被本文合并的 10 份原文档已移到 `docs/archive/sendspin/`，保留原文件名：

| 归档文件 | 原路径 | 内容 |
|---|---|---|
| `2026-09-12-sendspin-renderer-design.md` | `docs/superpowers/specs/` | Sendspin 渲染器插件设计（全角色 / 三配对法 / 多房同步 / 时钟 Kalman）；含 4 处**事实订正**（分片是 2/3 不是 1、9B 不是 13B、`registerSendspinDevice` 实名、PSK store 落点） |
| `2026-09-12-sendspin-renderer.md` | `docs/superpowers/plans/` | 实施计划（16 个 Task，含「字节级既定事实」原文）——本文 §2.2 的来源 |
| `sendspin-renderer-handoff-2026-09-13.md` | `docs/` | 任务交接日志：P0~P2 进度、握手互操作验证、架构与职责 |
| `SENDSPIN_ESPHOME_DEBUG.md` | `docs/` | 真机联调手册：抓日志三法 / 抓包速查 / mDNS 速查 / 坑位表 / 正确序列 |
| `SENDSPIN_ESPHOME_FLAC_2026-09-17.md` | `docs/` | 真机排障与修复真相版（四个根因、端口分工、6053 只读面） |
| `SENDSPIN_PITFALLS_2026-09-18.md` | `docs/` | 早期踩坑录（11 条）——本文第六部分 A 组 |
| `SENDSPIN_FLAC_ROADMAP.md` | `docs/` | FLAC 专项任务书（核心矛盾、备选方案 A/B/C、约束、验收清单）——本文第四部分 |
| `SENDSPIN_MA_ALIGNMENT_AUDIT.md` | `docs/` | MA 对齐审计（16 行对照表 + P0~P3 根因）——本文 §8.1 |
| `SENDSPIN_MULTIROOM_STREAMING_PLAN.md` | `docs/` | 多房组 + 流式解码方案与施工日志——本文第五部分 |
| `sendspin-sim-player.md` | `docs/` | 协议模拟器使用说明——本文 §7.7 |

## D. 参考来源

- Sendspin 协议规范：<https://github.com/Sendspin/spec>
- ESPHome Sendspin Media Source 文档：<https://esphome.io/components/media_source/sendspin>
- ESPHome `audio_http` media source 源码（tag `2026.9.0`）：`esphome/components/audio_http/media_source.py`
- ESPHome 2026.9.0 发布说明（新增 `network: tcp_send_buffer`，#18610）：<https://beta.esphome.io/blog/2026/09/16/esphome-2026-9/>
- 社区实证（2026-09-18，6 台 louder-esp32，`enable_high_performance: false` 消除掉流）：<https://alex.dandrea.io/2026/09/18/louder-esp32-and-sendspin>
- HA 社区 `Time message timed out` + 卡顿：<https://community.home-assistant.io/t/sendspin-time-message-timeouts-and-bad-stuttering-no-audio/1008262>
- Music Assistant：provider 在 `music_assistant/providers/sendspin/`，节奏/背压在 `aiosendspin==9.1.1`
- MusicFlow 发版报告：`CHANGELOG.md`（`[4.0.19]` 为三处修复的完整实证）
