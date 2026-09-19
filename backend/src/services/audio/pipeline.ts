// ==================== 服务端统一音频管道 AudioPipeline(参数骨架/P1-1) ====================
//
// 六段流水线的参数装配层(docs/audio-pipeline-plan.md §4):
//   ① 解码(ffmpeg → F32,采样率/声道跟随源) → PCM AudioBuffer → ② 出流 ffmpeg
//      (响度 → DSP → 限制器 → 重采样/dither → 通道编码)。
// 本文件只做**纯参数拼装**(可单测、零副作用);进程拉起与泵送由各通道在 P1-2 起接入。
// 输入合规由 P1-1b 锁死(SPEC §1.8:本地路径或回环 token URL,见 resolveFfmpegInput)。
//
// 单位约定:滤镜链全部用 dB(MA 同构),限制器 `level=false` 纯天花板语义。
import type { VolumeNormalizationMode } from "./loudness.js";

/** D1 推荐值:目标响度(MA constants.py:464 默认 -14,采纳推荐值前保持可配)。 */
export const DEFAULT_TARGET_LUFS = -14;
/** D5:限制器阈值。 */
export const LIMITER_CEILING_DB = -1;
/** 动态 loudnorm 固定参数(MA controllers/streams/audio.py:1753-1782 同构)。 */
export const LOUDNORM_ARGS = "I=-14:TP=-2.0:LRA=10.0:offset=0.0:print_format=json";

// ==================== ① 解码 ====================

export interface DecodeRequest {
  /** 已合规的输入(SPEC §1.8:本地文件路径或回环 token URL)。 */
  input: string;
  /** seek 起播偏移(秒):-ss 放 -i 之前(输入定位快,见 plan §4 接口约定)。 */
  timeOffsetSec?: number;
}

/**
 * 解码段参数:输出 F32 交错 PCM 到 stdout。
 * 刻意**不加 -ar/-ac**(采样率/声道跟随源,重采样下沉到⑥);
 * `-vn -sn -dn -map 0:a:0` 只取首音频流(封面/字幕不进管道)。
 */
export function decodeArgs(req: DecodeRequest): string[] {
  const args = ["-hide_banner", "-loglevel", "error"];
  if (req.timeOffsetSec !== undefined && Number.isFinite(req.timeOffsetSec) && req.timeOffsetSec > 0) {
    args.push("-ss", String(req.timeOffsetSec));
  }
  args.push("-i", req.input, "-vn", "-sn", "-dn", "-map", "0:a:0", "-f", "f32le", "pipe:1");
  return args;
}

// ==================== ② 响度 ====================

export interface LoudnessRequest {
  mode: VolumeNormalizationMode;
  /** fixed_gain / measurement 模式的静态增益 dB(调用方经 computeGainDb 算好)。 */
  gainDb?: number;
  /** 动态模式目标 LUFS(缺省 D1 推荐 -14)。 */
  targetLoudness?: number;
}

/**
 * 响度段滤镜(单个元素,调用方拼进 -af 链):
 * - dynamic → 实时 loudnorm(无测量也生效,首播即归一化);
 * - fixed_gain / measurement_only → volume=X dB 静态增益;
 * - disabled / source → null(不加滤镜;source=上游已对齐,禁二次归一)。
 */
export function loudnessFilter(req: LoudnessRequest): string | null {
  switch (req.mode) {
    case "dynamic": {
      const t = req.targetLoudness ?? DEFAULT_TARGET_LUFS;
      return `loudnorm=I=${t}:TP=-2.0:LRA=10.0:offset=0.0:print_format=json`;
    }
    case "fixed_gain":
    case "measurement_only": {
      const g = typeof req.gainDb === "number" && Number.isFinite(req.gainDb) ? req.gainDb : 0;
      return `volume=${g}dB`;
    }
    case "disabled":
    case "source":
    default:
      return null;
  }
}

// ==================== ⑤ 限制器 ====================

/**
 * 链尾限制器(MA dsp.py:218-223 同构):
 * `limit` 直接 dB 表达;`level=false` = 不做自动电平补偿、纯天花板语义。
 */
export function limiterFilter(ceilingDb: number = LIMITER_CEILING_DB): string {
  return `alimiter=limit=${ceilingDb}dB:level=false:asc=true:latency=true`;
}

// ==================== 输入合规(SPEC §1.8/P1-1b) ====================

export interface FfmpegInput {
  input: string;
  headers?: Record<string, string>;
}

/**
 * ffmpeg 输入硬合规门(原 streamEngine.resolveFfmpegInput,下沉到 audio 层):
 * http(s) 直链一律包成本进程回环 token URL —— 静态 ffmpeg 在 Alpine 解析不了
 * 域名(含 302 跳转目标),且跟 302 会把 Authorization 头带给 CDN;
 * 本地文件路径原样放行。空输入直接抛错(早失败,别等 ffmpeg 报).
 * 注意动态导入 dlna/control:audio 层不允许静态依赖上层路由模块(禁环)。
 */
export async function resolvePipelineInput(direct: FfmpegInput): Promise<FfmpegInput> {
  if (/^https?:\/\//i.test(direct.input)) {
    const { loopbackRawStreamUrl } = await import("../dlna/control.js");
    return { input: loopbackRawStreamUrl(direct.input, direct.headers ?? {}) };
  }
  if (!direct.input) {
    throw new Error("ffmpeg 输入为空(本地文件路径或回环 token URL 二选一)");
  }
  return direct;
}

// ==================== ⑥ 输出(重采样 + dither + 编码) ====================

export interface OutputRequest {
  /** 源采样率/位深(解码段跟随源的实际值;未知传 null → 保守处理)。 */  sourceRate: number | null;
  sourceBits: number | null;
  targetRate: number;
  targetBits: number;
  /** 链中有 loudnorm → 重采样必须降级 swr(ffmpeg ticket 11323,照 MA 处理)。 */
  hasLoudnorm: boolean;
  /**  libsoxr 可用时走 soxr 高精度(MA 默认);不可用/未知 → swr。 */
  soxrAvailable?: boolean;
}

/**
 * 输出段滤镜链(按需组装,顺序固定:重采样 → dither):
 * - 采样率相同 → 不加 aresample(MA:只在需要时加);
 * - 链中有 loudnorm 或无 soxr → swr,否则 soxr precision=30;
 * - 仅当 输入位深>16 且 输出==16 → osf=s16:dither_method=triangular_hp
 *   (是 triangular_hp,不是 triangular)。
 */
export function outputFilters(req: OutputRequest): string[] {
  const out: string[] = [];
  const rateDiffers =
    typeof req.sourceRate === "number" &&
    Number.isFinite(req.sourceRate) &&
    req.sourceRate > 0 &&
    req.sourceRate !== req.targetRate;
  if (rateDiffers) {
    const resampler = !req.hasLoudnorm && req.soxrAvailable !== false ? "soxr:precision=30" : "swr";
    out.push(`aresample=${req.targetRate}:resampler=${resampler}`);
  }
  const needDither =
    typeof req.sourceBits === "number" &&
    Number.isFinite(req.sourceBits) &&
    (req.sourceBits as number) > 16 &&
    req.targetBits === 16;
  if (needDither) {
    out.push("aresample=osf=s16:dither_method=triangular_hp");
  }
  return out;
}

/** 通道编码参数(flac 无损 / mp3 320 / aac 256;DLNA 拒 FLAC 回退 mp3 由调用方决策)。 */
export function codecArgs(codec: "flac" | "mp3" | "aac" | "opus" | "pcm", bitrateKbps?: number): string[] {
  switch (codec) {
    case "mp3":
      return ["-c:a", "libmp3lame", "-b:a", `${bitrateKbps ?? 320}k`];
    case "aac":
      return ["-c:a", "aac", "-b:a", `${bitrateKbps ?? 256}k`];
    case "opus":
      return ["-c:a", "libopus", "-b:a", `${bitrateKbps ?? 128}k`];
    case "flac":
      return ["-c:a", "flac"];
    case "pcm":
      return ["-c:a", "pcm_s16le"];
  }
}
