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

/** RAOP 发送节拍安全余量(吸收 25ms 泵抖动与 socket 调度)。 */
export const RAOP_SAFETY_MS = 50;

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
