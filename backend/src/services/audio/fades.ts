// ==================== ④ Smart Fades L0：标准交叉淡入（纯切片层/P3-2·3·8） ====================
//
// 六段流水线的第 ④ 段（docs/audio-pipeline-plan.md §3.4）。本文件**只做数学**：
// 权重曲线、静音剥离、帧对齐取整、F32 逐片加权混合 —— 零进程、零 IO、零 DB，
// 可被单测完全覆盖。进程编排（两路解码并行 + 一条编码）在 flow.ts。
//
// 为什么不用 ffmpeg `acrossfade`（plan §3.4-2）：它要求两个输入**已按帧对齐且长度已知**，
// 而我们的两路是流式的、边解边混、长度由播放进度决定 —— ffmpeg 侧做不到。
// MA 同样在 Node/Python 侧逐片处理（`streams/smart_fades/fades.py` 的 `iter_pcm_slices`）。
//
// PCM 口径：**F32 交错**（`pipeline.ts` 的 INTERNAL_PCM_FORMAT 同构），
// 「帧（frame）」= 所有声道各一个采样 = `channels * 4` 字节。
// 帧对齐是硬要求（P3-8，照 MA `fades.py:389-394`）：跨到半个帧上混合，
// 声场会左右错位、编码器还可能整段静默不出声（无任何报错，最难查）。

/** F32 单声道单采样字节数。 */
export const F32_BYTES_PER_SAMPLE = 4;

/** 默认过渡时长（秒）= MA `CONF_ENTRY_CROSSFADE_DURATION.default_value`（`constants.py:475-483`）。 */
export const FADE_DEFAULT_SEC = 8;
/**
 * 过渡时长下限（秒）= MA 同一 ConfigEntry 的 `range[0]`。
 * 注：这里曾是 3 并在注释里写「下限 3s、对齐 MA」，与 MA 实际取值不符
 * （`constants.py:477` 是 `range=(1, 15)`，8 是 default）；已按 MA 修正为 1。
 */
export const FADE_MIN_SEC = 1;
/** 过渡时长上限（秒）= MA 同一 ConfigEntry 的 `range[1]`。早先没有上限，面板可填到 30。 */
export const FADE_MAX_SEC = 15;
/** 静音剥离默认阈值（dBFS）：低于它视为静音。 */
export const FADE_DEFAULT_SILENCE_DB = -60;

export interface FadeConfig {
  /** 过渡时长（秒，整秒）。会被夹到 [FADE_MIN_SEC, FADE_MAX_SEC]。 */
  durationSec: number;
  /** 权重曲线：`equal_power`（等功率，默认，听感最平滑）/ `linear`（线性）。 */
  curve: FadeCurve;
  /**
   * 曲尾静音剥离阈值（dBFS）。`null` = 不剥离。
   * 剥离的意义：曲尾若带 3s 静音，不做剥离就会"淡出完还在放静音"（MA 同款处理）。
   */
  silenceThresholdDb: number | null;
}
export type FadeCurve = "equal_power" | "linear";

/** 兜底配置（`crossfade.mode=standard` 但没给具体参数时）。 */
export const DEFAULT_FADE_CONFIG: FadeConfig = {
  durationSec: FADE_DEFAULT_SEC,
  curve: "equal_power",
  silenceThresholdDb: FADE_DEFAULT_SILENCE_DB,
};

/**
 * 归一化外部配置：时长取整秒并夹到 [FADE_MIN_SEC, FADE_MAX_SEC]（两端都夹，
 * 面板/设置库里塞进来的 30s 不会一路进到混合窗口）；阈值非法则回退默认；曲线只认两个值。
 * 传 `null`/`undefined` 的字段一律取默认 —— 设置项缺失不应让交叉淡入失效。
 */
export function normalizeFadeConfig(partial?: Partial<FadeConfig> | null): FadeConfig {
  const raw = partial ?? {};
  const dur =
    typeof raw.durationSec === "number" && Number.isFinite(raw.durationSec) && raw.durationSec > 0
      ? Math.round(raw.durationSec)
      : FADE_DEFAULT_SEC;
  const thr =
    raw.silenceThresholdDb === null
      ? null
      : typeof raw.silenceThresholdDb === "number" && Number.isFinite(raw.silenceThresholdDb)
        ? raw.silenceThresholdDb
        : FADE_DEFAULT_SILENCE_DB;
  return {
    durationSec: Math.min(FADE_MAX_SEC, Math.max(FADE_MIN_SEC, dur)),
    curve: raw.curve === "linear" ? "linear" : "equal_power",
    silenceThresholdDb: thr,
  };
}

/** dBFS → 线性幅度（阈值比较用）。 */
export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

// ==================== 帧对齐（P3-8） ====================

/**
 * 按帧对齐取整（照 MA `fades.py:389-394`：`crossfade_size = bytes // frame_size * frame_size`）。
 * 非正/非法入参返回 0（宁可不成过渡，也不产生半帧）。
 */
export function alignToFrame(bytes: number, frameBytes: number): number {
  if (!Number.isFinite(bytes) || !Number.isFinite(frameBytes) || frameBytes <= 0 || bytes <= 0) return 0;
  return Math.floor(bytes / frameBytes) * frameBytes;
}

/** 一帧（所有声道各一个采样）的字节数。 */
export function frameBytesOf(channels: number): number {
  const ch = Math.max(1, Math.round(channels) || 1);
  return ch * F32_BYTES_PER_SAMPLE;
}

/**
 * 过渡窗口的**样本帧数**（P3-8：按时长算，落到整数帧）。
 * 返回的是"帧"数，不是采样数 —— 调用方乘 `channels` 得采样下标。
 * 与字节级契约的关系见 `alignToFrame`：整帧窗口 × 整数声道 ⇒ 采样数也是整数，
 * 即 MA `bytes // frame_size * frame_size` 的等价形式（f32 下 frame_size = ch*4）。
 */
export function crossfadeFrames(durationSec: number, sampleRate: number): number {
  const sec = typeof durationSec === "number" && Number.isFinite(durationSec) ? durationSec : 0;
  const rate = typeof sampleRate === "number" && Number.isFinite(sampleRate) ? sampleRate : 0;
  if (sec <= 0 || rate <= 0) return 0;
  return Math.round(sec * rate);
}

/**
 * 该窗口在给定声道数下的采样数（必为 `channels` 的整数倍 = 帧对齐）。
 * 单独抽出是为了能直接断言「窗口采样数 % channels === 0」这条契约。
 */
export function crossfadeSamples(durationSec: number, sampleRate: number, channels: number): number {
  const ch = Math.max(1, Math.round(channels) || 1);
  const frames = crossfadeFrames(durationSec, sampleRate);
  // 字节级口径（MA fades.py:389-394）等价形式：先把字节数按帧取整，再回到采样。
  const bytes = frames * frameBytesOf(ch);
  return alignToFrame(bytes, frameBytesOf(ch)) / F32_BYTES_PER_SAMPLE;
}

// ==================== 权重曲线 ====================

/**
 * 交叉淡入权重：`t`∈[0,1]（0 = 完全 outgoing，1 = 完全 incoming）。
 * - `equal_power`：cos/sin 曲线，`w_out² + w_in² = 1` —— 两首歌响度不相关时
 *   功率恒定，听感最平滑（推荐）；
 * - `linear`：`1-t` / `t` —— 两首歌相位相关时更保守，功率会掉 3dB。
 * t 越界一律夹到 [0,1]（浮点误差不该让权重变成负增益）。
 */
export function fadeWeights(t: number, curve: FadeCurve = "equal_power"): { out: number; in: number } {
  const x = !Number.isFinite(t) ? 0 : Math.min(1, Math.max(0, t));
  if (curve === "linear") return { out: 1 - x, in: x };
  const half = (Math.PI / 2) * x;
  return { out: Math.cos(half), in: Math.sin(half) };
}

/**
 * 过渡窗口逐帧的 **outgoing 权重**序列（= `fadeWeights(t)` 的 out 分量在
 * t = i/(frames-1) 上的采样）。`mixCrossfade` 内联同一算法，本函数让"曲线连续、
 * 起止点正确"可以被直接断言 —— 跳变就是能听见的爆音。
 */
export function fadeWeightCurve(frames: number, curve: FadeCurve = "equal_power"): Float32Array {
  const n = Math.max(0, Math.floor(frames));
  const out = new Float32Array(n);
  if (n === 0) return out;
  if (n === 1) { out[0] = 0; return out; } // 单帧 = 全 incoming
  for (let i = 0; i < n; i++) out[i] = fadeWeights(i / (n - 1), curve).out;
  return out;
}

// ==================== 静音剥离（P3-3） ====================

/**
 * 从尾部往前数「静音帧」数：一帧内**所有**声道的幅度都不超过阈值才算静音
 * （单声道超阈值 = 该帧有声音）。
 * 返回 0 = 尾部无静音；返回总帧数 = 整段静音。
 */
export function trailingSilenceFrames(
  pcm: Float32Array,
  channels: number,
  thresholdDb: number | null = FADE_DEFAULT_SILENCE_DB,
): number {
  const ch = Math.max(1, Math.round(channels) || 1);
  if (thresholdDb === null || !Number.isFinite(thresholdDb)) return 0;
  const total = Math.floor(pcm.length / ch);
  if (total === 0) return 0;
  const limit = dbToLinear(thresholdDb);
  let silent = 0;
  for (let f = total - 1; f >= 0; f--) {
    let quiet = true;
    const base = f * ch;
    for (let c = 0; c < ch; c++) {
      if (Math.abs(pcm[base + c]) > limit) { quiet = false; break; }
    }
    if (!quiet) break;
    silent++;
  }
  return silent;
}

/**
 * 本次过渡实际可用的帧数（P3-3）：配置窗口 ∩ 实际可用长度，再扣掉曲尾静音。
 * - `outgoingFrames`：上一曲持有的尾段长度（帧）；
 * - `incomingFrames`：下一曲已解码出/可用的首段长度（帧，未知则给 Infinity）；
 * 任一为 0 → 0（不做过渡，直接接上，也就没有空隙）。
 */
export function effectiveFadeFrames(opts: {
  wantFrames: number;
  outgoingFrames: number;
  incomingFrames?: number;
  silenceFrames?: number;
}): number {
  const want = Math.max(0, Math.floor(opts.wantFrames) || 0);
  const avail = Math.min(
    Math.max(0, Math.floor(opts.outgoingFrames) || 0),
    Number.isFinite(opts.incomingFrames ?? Infinity) ? Math.max(0, Math.floor(opts.incomingFrames as number)) : Infinity,
  );
  const silent = Math.max(0, Math.floor(opts.silenceFrames || 0));
  // 静音占比不能超过窗口：整段静音时窗口归零（宁可不混，也不要淡一段静音）。
  return Math.max(0, Math.min(want, Math.max(0, avail - silent)));
}

// ==================== 混合（P3-2/P3-8） ====================

/**
 * F32 逐片加权混合：`out = outgoing × w_out + incoming × w_in`（逐帧一权重）。
 * - 两段长度**必须相等**且为声道数的整数倍（帧对齐），否则抛错 ——
 *   这正是不做成"容错"的原因：静默错位的声场比报错难查得多（P3-8）。
 * - 返回新数组，不改入参（上曲尾段还留在 hold back 缓冲里，可能被复用）。
 */
export function mixCrossfade(
  outgoing: Float32Array,
  incoming: Float32Array,
  opts: { channels: number; curve?: FadeCurve },
): Float32Array {
  const ch = Math.max(1, Math.round(opts.channels) || 1);
  if (outgoing.length !== incoming.length) {
    throw new Error(`交叉淡入两段长度不等:${outgoing.length} vs ${incoming.length}`);
  }
  if (outgoing.length % ch !== 0) {
    throw new Error(`交叉淡入长度未帧对齐:${outgoing.length} 不是 ${ch} 声道的整数倍`);
  }
  const frames = outgoing.length / ch;
  const curve = opts.curve ?? "equal_power";
  const out = new Float32Array(outgoing.length);
  for (let f = 0; f < frames; f++) {
    const t = frames === 1 ? 1 : f / (frames - 1);
    const w = fadeWeights(t, curve);
    const base = f * ch;
    for (let c = 0; c < ch; c++) {
      out[base + c] = outgoing[base + c] * w.out + incoming[base + c] * w.in;
    }
  }
  return out;
}

/** 过渡窗口的末尾权重采样（判断"增益是否连续"用：起点 w_out 必为 1、终点 w_in 必为 1）。 */
export function fadeEndpoints(curve: FadeCurve = "equal_power"): { start: { out: number; in: number }; end: { out: number; in: number } } {
  return { start: fadeWeights(0, curve), end: fadeWeights(1, curve) };
}
