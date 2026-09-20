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
import { chooseMode, computeGainDb } from "./loudness.js";
import { loadAnalysis } from "./analysisStore.js";

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
  /** http 输入的鉴权头(ffmpeg `-headers`,放 -i 之前;回环 token 通常不需要)。 */
  headers?: Record<string, string>;
  /** 强制输入格式(测试用 lavfi 等;生产靠扩展名/协议自动识别)。 */
  inputFormat?: string;
  /** 出流 ffmpeg 的 `-af` 链(响度→DSP→限制器,调用方按 loudnessFilter 等拼好)。 */
  af?: string[];
  /**
   * 输出封装(默认 f32le 交给下游编码层;AirPlay RAOP 要 s16le 直出)。
   * 注意:dither 仍走 af 里的 osf(见 outputFilters),这里只定容器格式。
   */
  outputFormat?: "f32le" | "s16le";
  /**
   * 过渡期强制输出采样率/声道(以 `-ar/-ac` 输出选项追加,行为与旧硬编码一致)。
   * sendspin 在 P1-4 确认编码层/pump 数学支持变采样率前,传 48000/2 保持
   * 下游所有 48k 立体声不变式;确认后去掉,真正跟随源。
   */
  forceRate?: number;
  forceChannels?: number;
}

/**
 * 解码段参数:输出 F32 交错 PCM 到 stdout。
 * 刻意**不加 -ar/-ac**(采样率/声道跟随源,重采样下沉到⑥);
 * `-vn -sn -dn -map 0:a:0` 只取首音频流(封面/字幕不进管道)。
 */
export function decodeArgs(req: DecodeRequest): string[] {
  // loudnorm 的 JSON 报告走 info 级打印(print_format=json 在流结束时输出):
  // 链里有它就必须把 loglevel 提到 info,否则 P0-4 拿不到测量值;
  // 无则保持 error(静默,沿用旧行为)。
  const needsInfo = (req.af ?? []).some(f => f.includes("loudnorm"));
  const args = ["-hide_banner", "-loglevel", needsInfo ? "info" : "error"];
  if (req.timeOffsetSec !== undefined && Number.isFinite(req.timeOffsetSec) && req.timeOffsetSec > 0) {
    args.push("-ss", String(req.timeOffsetSec));
  }
  if (req.headers && Object.keys(req.headers).length > 0) {
    const lines = Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`);
    args.push("-headers", lines.join("\r\n"));
  }
  if (req.inputFormat) args.push("-f", req.inputFormat);
  args.push("-i", req.input, "-vn", "-sn", "-dn", "-map", "0:a:0");
  if (req.af && req.af.length > 0) {
    args.push("-af", req.af.join(","));
  }
  if (req.forceRate !== undefined && Number.isFinite(req.forceRate) && req.forceRate > 0) {
    args.push("-ar", String(Math.round(req.forceRate)));
  }
  if (req.forceChannels !== undefined && Number.isFinite(req.forceChannels) && req.forceChannels > 0) {
    args.push("-ac", String(Math.round(req.forceChannels)));
  }
  args.push("-f", req.outputFormat ?? "f32le", "pipe:1");
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
/** 是否回环地址(本机回环直连不经过代理/DNS,天然合规,不再包)。
 *  导出供各通道解码器做失败 fast 的前置断言(SPEC §1.8)。 */
export function isLoopbackUrl(input: string): boolean {
  try {
    const host = new URL(input).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

export async function resolvePipelineInput(direct: FfmpegInput): Promise<FfmpegInput> {
  if (!direct.input) {
    throw new Error("ffmpeg 输入为空(本地文件路径或回环 token URL 二选一)");
  }
  if (/^https?:\/\//i.test(direct.input) && !isLoopbackUrl(direct.input)) {
    const { loopbackRawStreamUrl } = await import("../dlna/control.js");
    return { input: loopbackRawStreamUrl(direct.input, direct.headers ?? {}) };
  }
  return direct;
}

// ==================== ⑥ 输出(重采样 + dither + 编码) ====================
export interface OutputRequest {
  /** 源采样率/位深(解码段跟随源的实际值;未知传 null → 保守处理)。 */
  sourceRate: number | null;
  sourceBits: number | null;
  targetRate: number;
  targetBits: number;
  /** 链中有 loudnorm → 重采样必须降级 swr(ffmpeg ticket 11323,照 MA 处理)。 */
  hasLoudnorm: boolean;
  /**  libsoxr 可用时走 soxr 高精度(MA 默认);不可用/未知 → swr。 */
  soxrAvailable?: boolean;
  /** 协议硬性采样率(如 RAOP 恒 44100):设置即无视 sourceRate 恒发 aresample。
   *  与"跟随源"冲突时以它为准,调用方必须在注释写明协议依据。 */
  forceRate?: number;
  /** 协议硬性声道布局(如 RAOP/ESP32 恒 stereo):设置即追加 aformat。 */
  forceChannels?: "stereo" | "mono";
}

/**
 * 输出段滤镜链(按需组装,顺序固定:重采样 → dither):
 * - 采样率相同 → 不加 aresample(MA:只在需要时加);
 * - 链中有 loudnorm 或无 soxr → swr,否则 soxr precision=30;
 * - 仅当 输入位深>16 且 输出==16 → osf=s16:dither_method=triangular_hp
 *   (是 triangular_hp,不是 triangular)。
 */
export function outputFilters(req: OutputRequest): string[] {
  const forced = req.forceRate !== undefined && Number.isFinite(req.forceRate) && req.forceRate > 0;
  const rateDiffers =
    forced ||
    (typeof req.sourceRate === "number" &&
      Number.isFinite(req.sourceRate) &&
      req.sourceRate > 0 &&
      req.sourceRate !== req.targetRate);
  const needDither =
    typeof req.sourceBits === "number" &&
    Number.isFinite(req.sourceBits) &&
    (req.sourceBits as number) > 16 &&
    req.targetBits === 16;
  if (!rateDiffers && !needDither && !req.forceChannels) return [];
  // 与 MA 同构:单个 aresample 承载 resample＋osr＋osf,分开写会跑两遍重采样。
  // 无需变采样率时不带 resampler 参数(只做 osf 转换)。
  // forceChannels 是另一个 filter(aformat),独立元素。
  const out: string[] = [];
  if (rateDiffers || needDither) {
    const opts: string[] = [];
    if (rateDiffers) {
      const rate = forced ? Math.round(req.forceRate as number) : req.targetRate;
      const resampler = !req.hasLoudnorm && req.soxrAvailable !== false ? "soxr:precision=30" : "swr";
      opts.push(`resampler=${resampler}`, `osr=${rate}`);
    }
    if (needDither) {
      opts.push("osf=s16", "dither_method=triangular_hp");
    }
    out.push(`aresample=${opts.join(":")}`);
  }
  if (req.forceChannels) {
    out.push(`aformat=channel_layouts=${req.forceChannels}`);
  }
  return out;
}

/** 通道编码参数(flac 无损 / mp3 320 / aac 256;DLNA 拒 FLAC 回退 mp3 由调用方决策)。 */export function codecArgs(codec: "flac" | "mp3" | "aac" | "opus" | "pcm", bitrateKbps?: number): string[] {
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

export interface LoudnessAfOpts {
  /** 分析行 id(= songs.id):命中已测量走静态 volume,否则实时 loudnorm。 */
  rowId?: string;
  /** 缺省启用(D2);false = 整条 -af 不加(与旧命令逐字节一致,单测/逃生用)。 */
  enabled?: boolean;
  /** 目标 LUFS(缺省 D1 推荐 -14)。 */
  targetLoudness?: number;
  /** 逃生舱 env 名(如 "SENDSPIN_LOUDNESS"):设为 "0" 即整条 -af 不加。 */
  escapeEnvVar?: string;
  /**
   * 是否在链尾追加限制器(缺省 true)。
   * **flow/交叉淡入必须传 false**(P3-1):两路信号相加后仍可能超 0 dBFS,
   * 限制器只能落在混合**之后**(⑤ 在 ④ 之后,plan §3.1),由 flow 的编码段统一加。
   * 若两处都加,等于对同一信号限幅两次(白烧 CPU + 第二次是空转)。
   */
  includeLimiter?: boolean;
  /**
   * ③ 段 DSP 片段(`services/audio/dsp.ts::buildFilterChain` 的产物,P4-2)。
   * 插在**响度之后、限制器之前**:顺序是 ② → ③ → ⑤(plan §3.1)——
   * DSP 必须作用在"已经一样响"的信号上,反过来的话响度归一化会把调好的音色重新抹平。
   * 注意逃生舱语义:本函数在 `enabled:false` / `escapeEnvVar=0` 时**整条返回空**,
   * 此时 `extraFilters` 也一并丢弃 —— 与 D9/D5「关闭开关 = 滤镜链为空」一致。
   */
  extraFilters?: string[];
}

/**
 * 响度段 af:[响度?,限制器](sendspin/airplay 共用同一语义,见 P1-2/P1-3):
 * - 逃生舱/单源关闭 → []（与旧命令逐字节一致）;
 * - 默认 D2:无测量走实时 loudnorm(-14),有测量(rowId 命中)走静态 volume;
 * - 末尾跟限制器(-1dB,MA 同构),除非 `includeLimiter:false`(flow/交叉淡入用,见该字段注释)。
 * 注意需要 DB(loadAnalysis),在测试/嵌入式场景 DB 未就绪时回落无测量。
 */
export function resolveLoudnessAf(opts: LoudnessAfOpts): string[] {
  if (opts.escapeEnvVar && process.env[opts.escapeEnvVar] === "0") return [];
  if (opts.enabled === false) return [];
  const target = opts.targetLoudness ?? DEFAULT_TARGET_LUFS;
  let measured: number | null = null;
  if (opts.rowId) {
    try {
      measured = loadAnalysis(opts.rowId)?.loudnessIntegrated ?? null;
    } catch {
      measured = null;
    }
  }
  const mode = chooseMode({
    enabled: true,
    preference: "fallback_dynamic",
    targetLoudness: target,
    measuredLoudness: measured,
  });
  const out: string[] = [];
  const gainDb =
    mode === "measurement_only" || mode === "fixed_gain"
      ? computeGainDb(target, measured)
      : undefined;
  const lf = loudnessFilter({ mode, gainDb, targetLoudness: target });
  if (lf) out.push(lf);
  // ③ 段 DSP(P4-2):响度之后、限制器之前。放在这里而不是由调用方自行拼接,
  // 是为了让"②→③→⑤"这个顺序只有一个落点,不会被某个调用点接反。
  if (opts.extraFilters?.length) out.push(...opts.extraFilters);
  if (opts.includeLimiter !== false) out.push(limiterFilter());
  return out;
}

// ==================== ⑥ 通道编码决策(D4/P2-1) ====================

/** 通道输出编码。container 是 ffmpeg muxer 名(aac 用 adts),mime 是响应头。 */
export interface ChannelCodec {
  codec: "flac" | "mp3" | "aac" | "opus";
  bitrateKbps?: number;
  container: "flac" | "mp3" | "adts" | "ogg";
  mime: string;
}

/**
 * 按源后缀定输出编码(D4 跟随源族):
 * 无损(flac/wav/alac/aiff/ape)→FLAC;mp3→mp3 320;acc 系(m4a/aac)→aac 256;
 * ogg 系(ogg/oga/opus)→opus 128;未知兜底 mp3 320(最广兼容)。
 */
export function resolveChannelCodec(suffix: string | null | undefined): ChannelCodec {
  const s = String(suffix || "").trim().toLowerCase().replace(/^\./, "");
  if (["flac", "wav", "alac", "aiff", "ape"].includes(s)) {
    return { codec: "flac", container: "flac", mime: "audio/flac" };
  }
  if (s === "mp3") return { codec: "mp3", bitrateKbps: 320, container: "mp3", mime: "audio/mpeg" };
  if (s === "aac" || s === "m4a") return { codec: "aac", bitrateKbps: 256, container: "adts", mime: "audio/aac" };
  if (s === "ogg" || s === "oga" || s === "opus") {
    return { codec: "opus", bitrateKbps: 128, container: "ogg", mime: "audio/ogg" };
  }
  return { codec: "mp3", bitrateKbps: 320, container: "mp3", mime: "audio/mpeg" };
}

/**
 * DLNA 输出决策(P2-2):跟随源族,但 ogg 系(ogg/oga/opus)一律回退 mp3 320 ——
 * 音箱(MUZO 2017 固件等)普遍不支持 Ogg/Opus 容器(沿用旧 serveDlnaWebStream 兜底
 * 规则,码率按 D4 取 320)。返回 ChannelCodec,cast 时 DIDL mime 与出流
 * Content-Type 共用它,天然同步(P2-2 MIME 同步要求)。
 */
export function resolveDlnaOutput(suffix: string | null | undefined): ChannelCodec {
  const s = String(suffix || "").trim().toLowerCase().replace(/^\./, "");
  if (s === "ogg" || s === "oga" || s === "opus") {
    return { codec: "mp3", bitrateKbps: 320, container: "mp3", mime: "audio/mpeg" };
  }
  return resolveChannelCodec(suffix);
}

export interface PipelineCommandRequest extends DecodeRequest {
  codec: ChannelCodec["codec"];
  bitrateKbps?: number;
}

/**
 * 整命令组装:解码段 ＋ af 链 ＋ 通道编码 ＋ 容器输出到 stdout(P2-1)。
 * 调用方(servePipelinedSong/serveTranscodedSong)只传声明式参数,不再手拼 ffmpeg。
 */
export function buildPipelineCommand(req: PipelineCommandRequest): string[] {
  const head = decodeArgs(req);
  // decodeArgs 尾是 ["-f","f32le","pipe:1"],出流输出替换为编码＋容器。
  head.splice(-3);
  const container =
    req.codec === "mp3" ? "mp3" : req.codec === "aac" ? "adts" : req.codec === "opus" ? "ogg" : "flac";
  return [...head, ...codecArgs(req.codec, req.bitrateKbps), "-f", container, "-"];
}
