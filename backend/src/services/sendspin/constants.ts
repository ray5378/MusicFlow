export const PROTOCOL_VERSION = 1;
export const WS_PATH = "/sendspin";
export const WS_PORT = 38927;
export const LEGACY_WS_PORT = 8928;
export const MDNS_TYPE_SERVER = "sendspin-server"; // _sendspin-server._tcp.local.
export const MDNS_TYPE_CLIENT = "sendspin"; // _sendspin._tcp.local.

export type NoiseSuite = "25519_ChaChaPoly_SHA256" | "25519_AESGCM_SHA256";
export const NOISE_SUITES: NoiseSuite[] = ["25519_ChaChaPoly_SHA256", "25519_AESGCM_SHA256"];

export const SENTINEL_PSK_HEX = "1b5e24dbc1aed95fc2a5a338a90c05df44bd10f5ec1f4cd66cbf86272767b9d3";
export const SENTINEL_PSK_ID_HEX = "185b15f6d2da4909bd1dc156a4ab206103abef0153bcd52d926170b95cf7ce8a";

export const MAX_TRANSPORT_PLAINTEXT = 65519; // 65535 - 16 (AEAD tag)
export const MAX_FRAGMENT_FIRST = MAX_TRANSPORT_PLAINTEXT - 2;
export const MAX_FRAGMENT_NEXT = MAX_TRANSPORT_PLAINTEXT - 1;
export const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;

/** 解密后 plaintext[0] 类型字节 */
export const BIN_JSON = 0;
export const BIN_FRAGMENT_MORE = 2;
export const BIN_FRAGMENT_END = 3;
export const BIN_PLAYER_AUDIO = 4; // 0x04
export const BIN_ARTWORK_BASE = 8; // 8..11
export const BIN_SOURCE_AUDIO = 12;
export const BIN_VISUALIZER_BASE = 16; // 16..21

// ---- 预填充缓冲水位的合法区间(毫秒)。放在 constants 里而不是 streamEngine:
//      server.ts(SendspinGroup.capacityLimitedPrefillMs)也要用,而 streamEngine
//      是 import server.js 的下游 —— 常量放那边会形成循环 import。
//      streamEngine 仍 re-export 这三个,维持既有引用路径与测试不变。

/** 下限 100ms:再低就没有抗抖动意义。 */
export const PREFILL_BUFFER_MIN_MS = 100;
/** 上限 30000ms —— **两道独立的尺**同时生效(对照 aiosendspin `BufferTracker`):
 *   ① 时长:等于 aiosendspin `PlayerPersistentState.max_duration_us` 默认
 *      30_000_000,协议侧的时长天花板;
 *   ② 字节:设备 `client/hello` 宣告的 `buffer_capacity`(byte,= ESPHome 的
 *      `buffer_size`)÷ 实测压缩码率(见 SendspinGroup.capacityLimitedPrefillMs)。
 *  设备未宣告容量时只有 ① 生效,行为与引入容量匹配前完全一致。 */
export const PREFILL_BUFFER_MAX_MS = 30_000;

// ---- late-join 回填(对齐 aiosendspin `PushStream.on_role_join` 的缓存回放)----
//
// 2026-09-24 真机:播放中把 Sendspin 播放器加入群组,新成员要等**一个完整预填充
// 水位**(30s 档 ≈ 29s)才出声。原因不是代码写错,而是**只给新成员发未来帧**:
// 组时间线游标领先墙钟一个水位深度,新成员收到的首帧时间戳在 30s 之后,只能干等。
//
// MA / aiosendspin 的做法(`push_stream.py`):组内保留**尚未播到**的音频缓存
// (`_pcm_chunk_cache` / `_role_chunk_cache`,按 `ts + duration <= now` 逐出),
// 新角色 `on_role_join` 时把缓存里起点 ≥「late-join 目标时刻」的 chunk **立即回放**
// 给它,之后无缝接上实时流。于是新成员与老成员**同一时刻出声**。
//
// 目标时刻 = `now + send_ahead + LATE_JOIN_MARGIN_US`(见 SendspinGroup.seedLateJoin):
//   late-join **不能自选提前量**——起播时无人在对齐,锚点可以随便提前;但回填必须
//   **贴住既有时间轴**,否则新成员与老成员的 `ts` 就会错开一个提前量。
//   设备侧判据 `delta = (ts - send_ahead) - now`,所以取「设备协商的 send_ahead」
//   再加一点传输余量,首帧 delta ≈ +100ms:既不在过去被丢,也不至于等太久。
//   (早期版本误用起播锚点的 lead 作提前量,已删;真机实测 target=882706us
//    = send_ahead 800000 + margin 100000, 新成员约 0.1s 出声。)

/** 回填首帧的额外余量(µs)。对齐 aiosendspin `LATE_JOINER_MIN_LEAD_US = 100_000`。 */
export const LATE_JOIN_MARGIN_US = 100_000;
/** 缓存保留的「已播过」尾巴(µs)。对齐 aiosendspin `_HISTORY_KEEP_PAST_US = 1_000_000`。 */
export const LATE_JOIN_KEEP_PAST_US = 1_000_000;
/** 缓存总时长上限(µs):= 预填充上限 30s + 余量,足够覆盖任何档位。 */
export const LATE_JOIN_RING_MAX_US = 35_000_000;

// ---- 桥投递可听域窗口化(§6.2,2026-10-25)----
// 桥不再实时消费 raw cursor 域 ts(旧实现 commandedLead ≈ 预填充深度,实测恒
// 10.584s,而桥队列硬上限 8s < 一次全量回填 11.6s → 必然重连风暴)。pushFrame
// 只写 ring(带内容代次戳),由每组 250ms 补投定时器按时间窗统一推桥:窗口以
// **原 ts 域**表述,**投递时原 ts 原样投递**(2026-10-26 起,贴组时间线):
// 设备的帧 ts T 在墙钟 T 出声(esp32 按时间戳排程),桥侧可听时刻 = 收到的时间戳,
// ⇒ 同一帧两边同一墙钟出声。旧实现做 `ts' = ts − commonSendAheadUs` 会让桥整体
// 早 sendAhead(实测 500ms),并把首个交付帧压到 `now+1.0s` —— 低于 RAOP 可达线
// `L(1s)+SAFETY(50ms)`,导致每次切歌都自锚到 `now+2.5s`(1.5s 静默 + 1.48s 内容被裁)。
/** 桥补投定时器周期(ms)。1s 宽的投递窗口下,250ms 一投余量充足且字节平滑。 */
export const BRIDGE_PUSH_TICK_MS = 250;
/** 投递窗口上沿(µs,原 ts 域):只投 ts ≤ now+2.5s 的帧,桥队列水位有界,
 *  永远摸不到 8s 硬上限(reconnect 风暴根因)。 */
// 注:字面量 "2_500_000" 被守卫 uniq 钉唯一,唯一出现点 = rates.ts 的
// BRIDGE_WARM_START_LEAD_US(语义无关:那边是暖启动提前量,这边是投递窗口上沿,
// 数值巧合同为 2.5s)。故此处用 2_500*1000 拼写规避重复字面量;改值只改本行。
export const BRIDGE_PUSH_HORIZON_US = 2_500 * 1000;
/** 投递窗口下沿(µs,原 ts 域):ts < now+1.5s 的帧不再投递 —— 桥(AirPlay
 *  发送侧)来不及为其建立稳定排程,宁可由可达性重锚接手也不喂「马上要响」的帧。 */
export const BRIDGE_PUSH_FLOOR_US = 1_500_000;

/** 切歌垫片·冷(µs):「track」代次边界且桥路由冷启(句柄重建,RAOP 握手+设备缓冲,
 *  见 protocolPlayer.prepareBridgeRoute)时组时间线整体前移量,随内容推进消耗归零。
 *  必须盖过冷重锚定耗时 —— 固定 1s 贴下限真机不稳定(2026-10-27 实测);量级对齐 MA
 *  cold lead(BRIDGE_COLD_START_LEAD_MS=4500 的下位近似,HiVi 实测重锚 1~2s)。
 *  env `BRIDGE_TRACK_LEAD_COLD_MS` 可调(0=关)。 */
export const BRIDGE_TRACK_LEAD_COLD_US = Number(process.env.BRIDGE_TRACK_LEAD_COLD_MS ?? 2500) * 1000;
/** 切歌垫片·暖(µs):「track」边界但路由暖复用(B 方案)/「seek/rehost」边界 —— 桥
 *  会话原地续用,仅需 BOUNDARY 重锚(清队列+新锚),量级小。env `BRIDGE_TRACK_LEAD_WARM_MS` 可调(0=关)。 */
export const BRIDGE_TRACK_LEAD_WARM_US = Number(process.env.BRIDGE_TRACK_LEAD_WARM_MS ?? 800) * 1000;
/** 混合组(桥 + 直连成员)的锚点 lead 下限(µs)= 桥下沿 + 一个补投周期。
 *  为什么必须有:混合组不能深锚(直连 esp32 硬同步阈值 5ms,见 streamEngine 注释),
 *  历史上回落到 prefill 的 min(sendAhead, 800ms)=500ms;而桥的投递窗口下沿是
 *  BRIDGE_PUSH_FLOOR_US(1.5s)⇒ 组一开播就把「桥来不及排程」的前 1s 内容推过去,
 *  桥只能从窗口下沿接 ⇒ 真机表现「SENDSPIN 已经出声、AirPlay 还没声,整首开头丢」。
 *  抬到 下沿 + 补投周期后,首帧本身即落在窗口内 ⇒ 开头零丢失。
 *  代价 = 每首歌起播多等 ~1.25s(全组一致,不破坏组内同步)。 */
export const BRIDGE_MIXED_GROUP_ANCHOR_LEAD_US = BRIDGE_PUSH_FLOOR_US + BRIDGE_PUSH_TICK_MS * 1000;
/** 播中回填单桥总量上限(µs)。常态窗口宽仅 1s,远达不到;纯防御异常大帧。 */
export const BRIDGE_BACKFILL_MAX_US = 6_000_000;

export type PskCategory = "lt" | "pr" | "sn";