// 响度解析与归一化模式决策 —— 音频流水线「② 响度标准化」段的三个纯函数。
// 行为逐条对齐 Music Assistant dev 分支 commit 76c2fcb：
//   parse_loudnorm          helpers/audio.py:881-901
//   get_normalization_mode  helpers/audio.py:904-960
// （该 commit 的源码快照不入库，按 plan 文档给出的方式拉取核对。）
//
// 本文件刻意**不 import 任何 db / 网络 / 播放器模块**：P0 的三个函数必须能在
// vitest 里零依赖单测（P0-5），也便于将来被 Sendspin fork 子进程单独引用。

/** ffmpeg loudnorm 报告：集成响度(LUFS)与真峰值(dBTP)。 */
export interface LoudnessMeasurement {
  /** EBU R128 集成响度，LUFS。 */
  inputI: number;
  /** ITU-R BS.1770-4 真峰值，dBTP；ffmpeg 未给或读到 -inf 时为 null。 */
  inputTp: number | null;
}

/**
 * 从 ffmpeg stderr 里抠出 loudnorm 的最终报告。
 *
 * 报告是 filter 在退出前打印的最后一块 JSON，**没有固定行号** —— 只能按
 * `[Parsed_loudnorm_` 标记定位。注意标记里的数字是 filter 在滤镜链中的位置，
 * 只有单独跑 loudnorm 时才是 0，**不能拿它做增删改判断**。
 *
 * 拿不到、JSON 损坏、缺 input_i、或读到数字静音(-inf)时一律返回 null ——
 * MA 原行为一致：-inf 表示「这段没有电平」而不是「电平为负无穷」，没有可校正的量。
 */
export function parseLoudnorm(rawStderr: string | Uint8Array | Buffer): LoudnessMeasurement | null {
  // stderr 可能夹带非 UTF-8 字节，统一转文本而不是假定它是 string。
  const stderr =
    typeof rawStderr === "string" ? rawStderr : Buffer.from(rawStderr).toString("utf8");
  if (!stderr) return null;

  const marker = stderr.lastIndexOf("[Parsed_loudnorm_");
  if (marker < 0) return null;
  const start = stderr.indexOf("{", marker);
  if (start < 0) return null;
  const end = stderr.indexOf("}", start);
  if (end < 0) return null;

  try {
    const data = JSON.parse(stderr.slice(start, end + 1)) as Record<string, unknown> | null;
    const inputI = Number(data?.input_i);
    // input_i 缺失或非有限(-inf / NaN) → 整个测量作废，与 MA 的 KeyError/isfinite 判定等价。
    if (!Number.isFinite(inputI)) return null;
    // true peak 是可选补充：拿不到只丢这一个字段，不牵连 input_i。
    const inputTp = Number.isFinite(Number(data?.input_tp)) ? Number(data?.input_tp) : null;
    return { inputI, inputTp };
  } catch {
    // JSON 解码失败 → 作废，与 MA 的 JSON_DECODE_EXCEPTIONS 一致。
    return null;
  }
}

/** 用户/队列配置的归一化倾向（含两个 fallback 变体）。 */
export type NormalizationPreference =
  | "disabled"
  | "fixed_gain"
  | "dynamic"
  | "measurement_only"
  | "fallback_fixed_gain"
  | "fallback_dynamic";

/** 实际采用的归一化模式。注意 source 表示「源侧已自己对齐，本端不再处理」。 */
export type VolumeNormalizationMode =
  | "disabled"
  | "source"
  | "fixed_gain"
  | "dynamic"
  | "measurement_only";

export interface ChooseModeInput {
  /** 队列是否已开启响度标准化（已由「队列设置 → 全局兜底」解析过）。 */
  enabled: boolean;
  /** 配置倾向，决定「没有测量值时怎么办」。 */
  preference: NormalizationPreference;
  /** 目标响度 LUFS；null 表示没设目标。 */
  targetLoudness: number | null;
  /** 已测得的集成响度 LUFS；null 表示尚未测量。 */
  measuredLoudness: number | null;
  /** 上游自己已经做过响度对齐：再校一次等于拿它的输出校了第二遍。 */
  sourceNormalized?: boolean;
  /** 直播/实时源：响度归上游负责，本端没有可收敛的测量值。 */
  liveSource?: boolean;
}

/**
 * 决定这一路流实际采用哪种归一化。
 *
 * 判定顺序照 MA get_normalization_mode —— **顺序不能改**，前面是硬门槛，
 * 后面才是「没测量值时怎么兜」的策略分支。
 */
export function chooseMode(input: ChooseModeInput): VolumeNormalizationMode {
  if (!input.enabled) return "disabled";
  // 直播源：生产者掌管响度，无从测量。
  if (input.liveSource) return "disabled";
  // 源侧已对齐再校正 = 校正两次（且校的还是它输出的结果）。
  if (input.sourceNormalized) return "source";
  if (input.targetLoudness === null || !Number.isFinite(input.targetLoudness)) return "disabled";

  const { preference, measuredLoudness } = input;
  const hasMeasurement = measuredLoudness !== null && Number.isFinite(measuredLoudness);

  if (!hasMeasurement) {
    // 未测量 —— 三个 fallback 变体各走一路，其余按原样直通。
    if (preference === "fallback_dynamic") return "dynamic";
    if (preference === "measurement_only") return "disabled";
    if (preference === "fallback_fixed_gain") return "fixed_gain";
    return preference as VolumeNormalizationMode;
  }

  // 已测量 —— 除非倾向本身就是某个「无视测量」的模式，否则一律走静态增益。
  if (
    preference !== "disabled" &&
    preference !== "fixed_gain" &&
    preference !== "dynamic"
  ) {
    return "measurement_only";
  }
  return preference;
}

/** 静态增益的限幅：±12 dB。防止个别异常测量值把音量拉到失真或闷到听不见。 */
export const MAX_GAIN_DB = 12;

/**
 * 由「目标响度 − 已测响度」算出静态增益 dB，并限幅到 ±maxDb。
 * 任一侧缺失/非有限一律返回 0 —— 拿不到依据就不动音量，而不是猜一个值。
 */
export function computeGainDb(
  targetLoudness: number | null,
  measuredLoudness: number | null,
  maxDb: number = MAX_GAIN_DB,
): number {
  if (targetLoudness === null || measuredLoudness === null) return 0;
  if (!Number.isFinite(targetLoudness) || !Number.isFinite(measuredLoudness)) return 0;
  const limit = Math.abs(maxDb);
  const gain = targetLoudness - measuredLoudness;
  if (gain > limit) return limit;
  if (gain < -limit) return -limit;
  return gain;
}
