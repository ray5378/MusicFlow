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

export type PskCategory = "lt" | "pr" | "sn";