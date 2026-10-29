/** AirPlay 桥接 · 速率与常量唯一源(守卫 ③:各常量全仓只出现一次,禁止散落)。
 *
 *  换算(时间↔样本)只在 bridgeMath.ts;重采样只在 resampler.ts。 */

/** Sendspin 组泵侧采样率(帧头 tsUs 域)。 */
export const SENDSPIN_RATE = 48000;

/** AirPlay 1 / ap2-compat 强制采样率(AP1 设备不接受 48k,见落地方案 D1a)。 */
export const AIRPLAY1_RATE = 44100;

/** AP2 SETUP 协商允许的速率(以实际协商为准,不假定 48k)。 */
export const AP2_RATES: readonly number[] = [48000, 44100];

/** AP2 PIN 配对(播放器页「配对」按钮)单次 RTSP 请求超时上限:设备在配对态下
 *  的 pair-setup/SRP 计算实测 < 2s,10s 足够覆盖慢设备;超过即判「设备没进配对态」。
 *  消费点:control.ts::pairAirPlayDevice 传给 ap2Session.pairNewDevice 的 timeoutMs。 */
export const AP2_PAIR_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// 147/160 多相 FIR 重采样(48k → 44.1k)
// ---------------------------------------------------------------------------

/** 上采样因子(= AIRPLAY1_RATE / gcd(48000,44100))。 */
export const RESAMPLE_L = 147;
/** 下采样因子(= SENDSPIN_RATE / gcd)。 */
export const RESAMPLE_M = 160;

/** 重采样群延迟(输出样本数)= (33−1)/2。内容经重采样后比内容时间晚
 *  16/44100 s ≈ 0.3627ms 出声;锚点补偿方向见 bridgeMath.computeBridgeAnchors。 */
export const RESAMPLE_GROUP_DELAY_OUT_SAMPLES = 16;

/** 群延迟的毫秒口径(文档值 = 17.41 输入样本 @48k;与上一条恒等,测试钉住 ±1µs)。 */
export const RESAMPLE_GROUP_DELAY_MS = 0.3627;

// ---------------------------------------------------------------------------
// 启动 lead / 缓冲(µs;只进 streamEngine 的 anchorLead,不进 commonSendAheadUs —— MAJ-01)
// ---------------------------------------------------------------------------

/** 冷启动 lead:覆盖 RAOP 连接 + RECORD + 首包映射(任一桥 cold ⇒ 整组取此值)。 */
export const BRIDGE_COLD_START_LEAD_US = 4_500_000;
/** 热启动 lead:已连接会话 flush-refill。 */
export const BRIDGE_WARM_START_LEAD_US = 2_500_000;
/** 桥成员持续缓冲下限(进 commonSendAheadUs 的唯一桥相关量)。 */
export const BRIDGE_MIN_BUFFER_US = 1_000_000;

/** 既有锚点安全提前量(纯 sendspin 组的钳制值;bridge 存在时必须绕过该截断 ——
 *  桥成员 lead 只走 bridgeStartLeadUs 进 anchorLead,绝不并入 commonSendAheadUs,
 *  MAJ-01/§3.4)。
 *
 *  ⚠️ 不能高于它:锚点 = 起播静默时长,抬到 10s 就要静默 10s。
 *  ⚠️ 也不能低于它:2026-09-17 真机事故 —— 锚点只提前 250ms,而设备按 800ms
 *  的余量判据调度 → delta = 250 − 800 = −550ms 恒为负 → 收首块即判「目标时刻
 *  已过」→ 立即吐字节 → underrun 无声。800ms 是实测可用的最低水位。
 *
 *  消费点(sendspin/streamEngine.ts,一律 import 本值,禁止重复声明/内联):
 *  ① 预填充锚点截断 min(aheadUs, ANCHOR_SAFE_LEAD_US);
 *  ② 预填充 wantFill 门控 targetUs > ANCHOR_SAFE_LEAD_US;
 *  ③ 曲末排空量 (cursorUs − nowUs() − ANCHOR_SAFE_LEAD_US)/1000。 */
export const ANCHOR_SAFE_LEAD_US = 800_000;

// ---------------------------------------------------------------------------
// 桥成员队列水位(字节,按 48k/16bit/2ch 口径 ≈ 192000 B/s)
// ---------------------------------------------------------------------------

/** 高水位:告警线。 */
export const BRIDGE_QUEUE_HIGH_WATER_BYTES = 384 * 1024;
/** 硬上限:断连线(禁止丢最旧帧,直接断连重退避)。 */
export const BRIDGE_QUEUE_HARD_CAP_BYTES = 1536 * 1024;
/** 断连重连退避:基数(带 ±20% 抖动)。 */
export const BRIDGE_BACKOFF_BASE_MS = 5_000;
/** 断连重连退避:上限。 */
export const BRIDGE_BACKOFF_MAX_MS = 30_000;

// ---------------------------------------------------------------------------
// 桥队列水位与心跳(Phase 2;MIN-05:阈值按"秒"计量、按输入速率 48k 折算,
// 字节数只进日志 —— 上面两个 *_BYTES 常量仅供日志换算对照,判定一律走 *_MS)
// ---------------------------------------------------------------------------

/** 输入 PCM 码率:48k × s16le(2B) × 2ch = 192000 B/s(重采样**前**口径)。 */
export const BRIDGE_PCM_BYTES_PER_SEC = 192_000;

/** 发送端高水位:告警线(2s × 192000B/s ≈ 384KB)。 */
export const BRIDGE_QUEUE_HIGH_WATER_MS = 2_000;
/** 发送端硬上限:断连线(8s × 192000B/s ≈ 1.5MB;禁止丢最旧帧,直接断连重退避)。 */
export const BRIDGE_QUEUE_HARD_CAP_MS = 8_000;
/** airplay 接收侧 PCM 积压上限(§4.4:8s,同 48k 口径;超过断连报 overflow,让发送侧重连)。 */
export const BRIDGE_RECEIVE_OVERFLOW_MS = 8_000;
/** 心跳间隔(发送端;接收端 2s 无帧判 stalled,间隔须显著小于该值)。 */
export const BRIDGE_HEARTBEAT_INTERVAL_MS = 1_000;
/** 接收端 stall 判定:2s 未收到任何帧(§4.2)。 */
export const BRIDGE_STALL_NO_FRAME_MS = 2_000;

// ---------------------------------------------------------------------------
// 曲末排空的桥安全钳制(2026-11 真机:换歌 RTP 断流 3~7s)
// ---------------------------------------------------------------------------

/** 曲末排空的桥周转余量(ms):排空上限 = 队列硬上限 − 本余量。
 *
 *  **为什么需要**:曲末排空期间 `pushLoop` 已退出、**不再产出任何 PCM**,而 AirPlay
 *  桥成员的音频**全靠 pushLoop 现场产料**(`bridgeMember.pushAudio`,桥侧队列
 *  `BRIDGE_QUEUE_HARD_CAP_MS` 为硬上限)⇒ 队列只出不进,排空时长一旦逼近硬上限,
 *  排到后半段桥就**必然断料**:用户听感「卡顿几秒又恢复」。
 *
 *  **为什么是 1500ms**(三个事实,缺一不可):
 *   ① 排空期间桥不再产料(上面的机制),可取量 = 排空前桥队列里的存量,硬上限 8s;
 *   ② 2026-11 真机抓包实测:断料**提前 1.72s**(桥侧 `bridge pacing rebase:
 *      +2987790µs`),即真实可用存量约 8s − 1.72s ≈ 6.28s;
 *   ③ 1500ms ≈ 1720ms 实测断料点**再让 200ms**,吸收泵抖动与桥补投定时器粒度
 *      (250ms 一拍),保证「钳制后也不断料」而不是「刚好不早于断料点」。
 *  ⇒ 8s − 1.5s = 6.5s:仍能排掉绝大部分曲末缓冲,同时桥侧恒有余量。
 *
 *  消费点:sendspin/streamEngine.ts 曲末排空(经 bridgeMath.capEndDrainMs 钳制,
 *  **仅当组内存在桥成员**;纯 sendspin 组不钳制,行为与本常量引入前逐字节一致)。 */
export const BRIDGE_END_DRAIN_MARGIN_MS = 1_500;

/** 曲末排空量在桥成员在场时的安全上限(ms)= 队列硬上限 − 周转余量(理由见上)。 */
export const BRIDGE_END_DRAIN_SAFE_MAX_MS = BRIDGE_QUEUE_HARD_CAP_MS - BRIDGE_END_DRAIN_MARGIN_MS;

/** RAOP 发送节拍安全余量(吸收 25ms 泵抖动与 socket 调度)。
 *
 *  ⚠️ **只用于锚点可达性判据**(planBridgeAnchor)与 RAOP 的 sendAt 节拍。
 *  AP2 realtime 的 sendAt **不得**再加它:AP2 的提前量已经由 latencyMin 声明给接收端,
 *  再叠 50ms 会让 AP2 恒早 50ms 出声(与同组 RAOP 成员直接错位)。 */
export const RAOP_SAFETY_MS = 50;

// ---------------------------------------------------------------------------
// AP2 realtime 播放链(Phase 6b · T03 双出口)
// ---------------------------------------------------------------------------

/** AP2 realtime SETUP 里声明给接收端的 latencyMin(样本数 @48k,缺省 11025 ≈ 229.7ms)。
 *  接收端据此定抖动缓冲深度(bed: buffer = latencyMin·7/spf + 1)。 */
export const AP2_DEFAULT_LATENCY_FRAMES = 11_025;

/** AP2 发送侧**有效**提前量(帧):`sendAt_i = A + i·spf/rate − L_eff`。
 *
 *  初值 = 声明值(先让「声明什么就以什么提前量发」成立,避免一上来就偏)。
 *  ⚠️ **真机需一次标定**:接收端从收包到扬声器的固定延迟(解码 + 抖动缓冲 + DAC)
 *  无法在仓内测量,标定后只改这一个常量;残差由**按组** airplay_delay_ms
 *  (anchorShiftUs,唯一补偿落点)吸收 —— 绝不在 sendAt 里再加别的偏移。 */
export const AP2_EFFECTIVE_LATENCY_FRAMES = AP2_DEFAULT_LATENCY_FRAMES;

/** AP2 迟到丢弃阈值(µs):sendAt 已过这么久的内容再发也会被接收端丢掉/挤坏
 *  抖动缓冲 ⇒ 按 RAOP 的 skip 语义**丢该块并计数**(`ev=ap2-late-skip`),
 *  不补静音、不前移时间线(内容位置照常推进,时间线仍只有那一条)。
 *  ≈4 个 spf 包(352 帧 @48k = 7.33ms)⇒ 30ms。 */
export const AP2_LATE_SKIP_US = 30_000;

/** AP2 输出循环的等待切片(ms):暂停/中止判定的最大响应延迟(不泄漏定时器)。 */
export const AP2_WAIT_SLICE_MS = 10;

// ---------------------------------------------------------------------------
// 暂停/恢复与 pacing 重锚(Phase 5,§5.4)
// ---------------------------------------------------------------------------

/** 暂停保持上限(§5.4):暂停 ≤45s ⇒ 恢复按「继续」(原 A/B 不动,pacing 对齐);
 *  >45s ⇒ 恢复按「锚点不可达」重新锚定(A = now + warmLead,跳到该时刻内容)。 */
export const BRIDGE_MAX_HELD_AUDIO_US = 45_000_000;
/** 发送节拍 rebase 阈值:sendAt 落后墙钟超过该值(暂停恢复/长饥饿)⇒ 对齐 pacing
 *  参考而不计 latePackets(§5.4「暂停期不计 latePackets」;RTP 映射不动)。 */
export const BRIDGE_RESUME_REBASE_US = 2_000_000;

// ---------------------------------------------------------------------------
// 协议能力映射
// ---------------------------------------------------------------------------

export type BridgeProtocol = "raop" | "ap2-compat" | "ap2-realtime" | "ap2-buffered";

export interface ProtocolCaps {
  /** AP1/compat 恒 44100;ap2-realtime 以 SETUP 协商为准。 */
  rate: number;
  clock: "ntp" | "ptp";
  encryption: "none" | "alac-chacha";
  /** 96 = RAOP(AP1) 与 AP2 realtime **共用**；103 = AP2 buffered。
   *  🔴 原写的 102 无任何接收端源码支撑，已更正为 96：权威依据
   *  `/tmp/ap2recv/ap2/connections/stream.py:12`（`REALTIME = 96` / `BUFFERED = 103`），
   *  非 96 床侧 `Stream.__init__` 会走 buffered 分支；发送侧权威常量见
   *  `ap2/ap2Stream.ts` 的 `AP2_REALTIME_STREAM_TYPE`（同为此值）。
   *  ⚠️ 96 同时代表两种协议 ⇒ `streamType` **不能单独区分协议**，必须连带看
   *  `encryption`（RAOP = `none`，AP2 realtime = `alac-chacha`）。 */
  streamType: 96 | 103;
}

export const PROTOCOL_CAPS: Record<BridgeProtocol, ProtocolCaps> = {
  "raop":         { rate: AIRPLAY1_RATE, clock: "ntp", encryption: "none",        streamType: 96  },
  "ap2-compat":   { rate: AIRPLAY1_RATE, clock: "ntp", encryption: "none",        streamType: 96  },
  "ap2-realtime": { rate: 48000,         clock: "ntp", encryption: "alac-chacha", streamType: 96  },
  "ap2-buffered": { rate: 48000,         clock: "ptp", encryption: "alac-chacha", streamType: 103 },
};
