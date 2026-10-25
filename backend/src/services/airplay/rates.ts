/** AirPlay 桥接 · 速率与常量唯一源(守卫 ③:各常量全仓只出现一次,禁止散落)。
 *
 *  换算(时间↔样本)只在 bridgeMath.ts;重采样只在 resampler.ts。 */

/** Sendspin 组泵侧采样率(帧头 tsUs 域)。 */
export const SENDSPIN_RATE = 48000;

/** AirPlay 1 / ap2-compat 强制采样率(AP1 设备不接受 48k,见落地方案 D1a)。 */
export const AIRPLAY1_RATE = 44100;

/** AP2 SETUP 协商允许的速率(以实际协商为准,不假定 48k)。 */
export const AP2_RATES: readonly number[] = [48000, 44100];

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

/** 既有锚点安全提前量(纯 sendspin 组的钳制值;bridge 存在时必须绕过该截断)。 */
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

/** RAOP 发送节拍安全余量(吸收 25ms 泵抖动与 socket 调度)。 */
export const RAOP_SAFETY_MS = 50;

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
  /** 96=RAOP, 102=realtime, 103=buffered。 */
  streamType: 96 | 102 | 103;
}

export const PROTOCOL_CAPS: Record<BridgeProtocol, ProtocolCaps> = {
  "raop":         { rate: AIRPLAY1_RATE, clock: "ntp", encryption: "none",        streamType: 96  },
  "ap2-compat":   { rate: AIRPLAY1_RATE, clock: "ntp", encryption: "none",        streamType: 96  },
  "ap2-realtime": { rate: 48000,         clock: "ntp", encryption: "alac-chacha", streamType: 102 },
  "ap2-buffered": { rate: 48000,         clock: "ptp", encryption: "alac-chacha", streamType: 103 },
};
