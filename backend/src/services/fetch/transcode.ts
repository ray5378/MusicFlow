// ==================== 下载产物转码（MusicFetch M1） ====================
//
// 只做「换封装 + 响度归一化」，不做音质提升 —— 源是 320k mp3 转 flac 之后仍是 320k
// 的音质，体积还会变大。产品口径必须明写这一点，避免用户误以为转 flac = 变无损。
//
// 🔴 最关键的一条（M0 实测，230）：转 flac **必须 `-sample_fmt s16`**。
//    只写 `-c:a flac` 时，ffmpeg 会把 16bit 源虚假升到 s32/24bit：同一段 3 秒样本
//    实测 24bit = 163950B vs 16bit = 46255B（**3.5 倍**），采样率与时长不变、
//    音质零提升。本模块默认对 flac 强制 s16（可用 keepBitDepth16:false 关闭）。
//
// 【响度归一化（-14 LUFS）】开 loudnessNormalize 时在**编码器之前**插一条 `-af`：
//   `loudnorm=I=..:TP=..:LRA=..  ,  aresample=resampler=swr:osr=..:osf=..`
//   两条缺一不可，且**顺序不可换**：
//     1. `loudnorm` 内部恒把流**上采样到 192kHz**、且走**浮点**。不复位的话成品就是
//        192kHz（部分 renderer 变速变调播放，见 services/playerRate.ts 头部实测）；
//        浮点不复位则 flac 恒落 24bit（16bit 源也出 s32，体积翻倍）。
//     2. `aresample` 紧随其后把采样率/位深**复位**成目标值。`osr` 恒给（拿不到源采样率
//        时回落 48000，= playerRate 缺省）；`osf=s16:dither_method=triangular_hp`
//        降位深必须带抖动（三角高频抖动，防直接截断引入相关失真），24bit 用 `osf=s32`；
//        wav 目标（pcm_s16le 定死）不写 `osf`。
//   两遍法（缺省开）：先 `-f null -` 空跑一遍拿 loudnorm 的实测 JSON（含 input_lra /
//   input_thresh / target_offset —— 这三个 `parseLoudnorm` 不返回，故本文件用等价的全
//   字段解析 `parseLoudnormMeasurement`），第二遍带 `measured_*` + `linear=true` 精确压制；
//   第一遍失败就降级单遍动态并记 warning（**归一化是增值项，绝不因此让整首歌失败**）。
//
// 其余约定：
//   - 源已是目标容器且**未开响度归一化** → `skipped:true` 直接返回，不跑 ffmpeg；
//   - 绝不原地覆盖：写 `<dst>.trtmp` 成功后再 rename（同 tagWriter）；
//   - ffmpeg 二进制一律走 `resolveFfmpeg()`（支持 FFMPEG_PATH 注入，便于测试隔离）。
import { spawn } from "node:child_process";
import { existsSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { createLogger } from "../../utils/logger.js";
import { resolveFfmpeg } from "../transcode.js";
import { DEFAULT_TARGET_LUFS, clampTargetLufs } from "../audio/normalization.js";
import { probeFile } from "./probe.js";
import type { FetchErrorCode } from "./types.js";

const log = createLogger("FETCH_TRANSCODE");

/** 转码目标容器（只做封装转换，不提升音质）。 */
export type TranscodeFormat = "flac" | "alac" | "wav";

export interface TranscodeOptions {
  /** 目标容器 */
  target: TranscodeFormat;
  /** 输出路径；缺省 = 同目录、换扩展名 */
  dstPath?: string;
  /** 目标采样率（Hz）；不传 = 跟随源 */
  sampleRateHz?: number;
  /** flac 压缩等级 0-12；不传 = ffmpeg 默认(5) */
  compressionLevel?: number;
  /** 是否保留标签与内嵌封面（默认 true） */
  keepTags?: boolean;
  /** （旧参数）是否强制 16bit：true=16 / false=24。新代码请用 bitDepth（缺省 auto=跟随源位深，产品定调 2026-10-10）。 */
  keepBitDepth16?: boolean;
  /** 输出位深档位："auto"（缺省）= 跟随源（源 ≥24bit→24，16bit 源→16，拿不到→24 保真）；16/24 = 强制。 */
  bitDepth?: "auto" | 16 | 24;
  /** 单次转码超时（毫秒），缺省 300s */
  timeoutMs?: number;
  /**
   * 是否做响度归一化到目标 LUFS。模块级缺省 false（纯转码复用）；但 **fetch 入库流水线
   * 强制开启** —— 响度归一化（-14 LUFS）是标准化处理，不是可选增值（产品定调 2026-10-10）。
   */
  loudnessNormalize?: boolean;
  /** 目标响度 LUFS，缺省 -14（= normalization.ts 的 DEFAULT_TARGET_LUFS，自动夹到 [-30,-5]）。 */
  loudnessTargetLufs?: number;
  /** 真峰值上限 dBTP，缺省 -2.0（= MA loudnorm 的 TP）。 */
  loudnessTruePeakDb?: number;
  /** 响度范围 LU，缺省 10.0（= MA loudnorm 的 LRA）。 */
  loudnessRangeLu?: number;
  /** 两遍（先测后编，linear）模式；缺省 true，false = 单遍动态。 */
  loudnessTwoPass?: boolean;
}

export interface TranscodeResult {
  ok: true;
  srcPath: string;
  dstPath: string;
  /** 源已是目标容器且无需改变采样率且未开响度归一化 → 直接返回，未跑 ffmpeg */
  skipped: boolean;
  bytes: number;
  warnings: string[];
}

/** 转码失败（ffmpeg 非 0 退出 / 超时 / 产物为空）。 */
export class FetchTranscodeError extends Error {
  readonly code: FetchErrorCode;
  readonly file: string;

  constructor(code: FetchErrorCode, message: string, file: string) {
    super(message);
    this.name = "FetchTranscodeError";
    this.code = code;
    this.file = file;
  }
}

const DEFAULT_TIMEOUT_MS = 300_000;

/** loudnorm 真峰值上限缺省（dBTP）。 */
const DEFAULT_TRUE_PEAK_DB = -2.0;
/** loudnorm 响度范围缺省（LU）。 */
const DEFAULT_LOUDNESS_RANGE_LU = 10.0;
/** 拿不到源采样率、也没显式给目标率时的回落（= playerRate.ts 的 DEFAULT_TARGET_RATE）。 */
const DEFAULT_RESAMPLE_RATE = 48000;

/** 输出路径：未指定时替换扩展名（alac 落 .m4a —— ffmpeg 认这个扩展名）。 */
export function defaultDstPath(srcPath: string, target: TranscodeFormat): string {
  const ext = extname(srcPath);
  const want = target === "alac" ? "m4a" : target;
  return ext ? `${srcPath.slice(0, srcPath.length - ext.length)}.${want}` : `${srcPath}.${want}`;
}

/**
 * 临时文件路径：标记插在扩展名之前（`o.flac` → `o.trtmp.flac`）。
 * 理由同 tagWriter：ffmpeg 靠扩展名挑封装格式，`.trtmp` 它会报
 * `Unable to choose an output format` 直接 exit 234。
 */
export function tmpPathFor(target: string, marker: string): string {
  const b = basename(target);
  const ext = extname(b);
  const stem = ext ? b.slice(0, b.length - ext.length) : b;
  return join(dirname(target), `${stem}.${marker}${ext}`);
}

/** loudnorm 第一遍实测到的完整报告（两遍 linear 模式需要全部五值）。 */
export interface LoudnessMeasurement {
  /** 集成响度 LUFS（input_i）。 */
  i: number;
  /** 响度范围 LU（input_lra）。 */
  lra: number;
  /** 真峰值 dBTP（input_tp）。 */
  tp: number;
  /** 门限电平（input_thresh）。 */
  thresh: number;
  /** loudnorm 建议的偏移（target_offset）。 */
  offset: number;
}

export interface LoudnessFilterInput {
  /** 目标响度 LUFS（会夹到 [-30,-5]）。 */
  targetLufs: number;
  /** 真峰值上限 dBTP，缺省 -2.0。 */
  truePeakDb?: number;
  /** 响度范围 LU，缺省 10.0。 */
  rangeLu?: number;
  /** 出流目标采样率（osr）；loudnorm 恒上采样 192k，必须复位。 */
  targetSampleRateHz: number;
  /** 出流样本格式；省略 = 不写出流位深（wav 目标用）。 */
  osf?: "s16" | "s32";
  /** 两遍模式第一遍实测值；齐全才走 `linear=true` 的静态增益。 */
  measured?: LoudnessMeasurement;
}

/**
 * 解析输出位深（纯函数）：16/24 显式生效；"auto" 跟随源 —— 源 ≥24bit → 24，
 * 16bit 源或**拿不到位深**（有损/探针失败）→ 16（防 3.5 倍虚假升位，回归守卫）。
 */
export function resolveOutDepth(mode: "auto" | 16 | 24 | undefined, srcBits?: number): 16 | 24 {
  if (mode === 16) return 16;
  if (mode === 24) return 24;
  return srcBits !== undefined && srcBits >= 24 ? 24 : 16;
}

/**
 * 拼「loudnorm + aresample」滤镜串（纯函数，便于单测锁定顺序与参数）。
 *
 * 顺序硬约束：`loudnorm` 必须在 `aresample` **之前** —— 前者是唯一的电平处理，
 * 后者只负责把前者输出的 192kHz/浮点复位成目标采样率/位深。
 */
export function buildLoudnessFilter(inp: LoudnessFilterInput): string {
  const t = clampTargetLufs(inp.targetLufs);
  const tp =
    typeof inp.truePeakDb === "number" && Number.isFinite(inp.truePeakDb)
      ? inp.truePeakDb
      : DEFAULT_TRUE_PEAK_DB;
  const lra =
    typeof inp.rangeLu === "number" && Number.isFinite(inp.rangeLu)
      ? inp.rangeLu
      : DEFAULT_LOUDNESS_RANGE_LU;

  let loud = `loudnorm=I=${t}:TP=${tp}:LRA=${lra}`;
  const m = inp.measured;
  const hasMeasured =
    !!m && [m.i, m.lra, m.tp, m.thresh].every((v) => Number.isFinite(v));
  if (hasMeasured && m) {
    const off = Number.isFinite(m.offset) ? m.offset : 0;
    loud += `:measured_I=${m.i}:measured_LRA=${m.lra}:measured_TP=${m.tp}:measured_thresh=${m.thresh}:offset=${off}:linear=true:print_format=summary`;
  } else {
    // 单遍动态：offset=0.0 关掉自动偏移（与 pipeline.ts 的 dynamic 同口径）。
    loud += `:offset=0.0:print_format=summary`;
  }

  let resample = `aresample=resampler=swr:osr=${Math.trunc(inp.targetSampleRateHz)}`;
  if (inp.osf === "s16") resample += `:osf=s16:dither_method=triangular_hp`;
  else if (inp.osf === "s32") resample += `:osf=s32`;

  return `${loud},${resample}`;
}

/** 拼装转码参数（纯函数，便于单测锁定命令形态）。 */
export function buildTranscodeArgs(opts: {
  src: string;
  out: string;
  target: TranscodeFormat;
  sampleRateHz?: number;
  compressionLevel?: number;
  keepTags?: boolean;
  /** （旧参数）true=16 / false=24；outDepth 给了就忽略。 */
  keepBitDepth16?: boolean;
  /** 解析后的输出位深（16/24）；缺省回退 keepBitDepth16（!==false 视为 16）。 */
  outDepth?: 16 | 24;
  hasCover?: boolean;
  /** 音频滤镜链（响度归一化用）；给了就下发 `-af`。 */
  af?: string;
}): string[] {
  const keepTags = opts.keepTags !== false;
  const s16 = opts.outDepth ? opts.outDepth === 16 : opts.keepBitDepth16 !== false;
  const hasCover = !!opts.hasCover;

  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error", "-i", opts.src];
  // 音频流必选；封面仅在「保留标签且源里确实有」时才带上（无封面却 -map 0:v 会报错）。
  args.push("-map", "0:a");
  if (keepTags && hasCover) args.push("-map", "0:v");
  args.push("-map_metadata", keepTags ? "0" : "-1");

  if (opts.target === "flac") {
    args.push("-c:a", "flac");
    if (s16) args.push("-sample_fmt", "s16");
    if (typeof opts.compressionLevel === "number" && opts.compressionLevel >= 0 && opts.compressionLevel <= 12) {
      args.push("-compression_level", String(Math.trunc(opts.compressionLevel)));
    }
  } else if (opts.target === "alac") {
    args.push("-c:a", "alac", "-f", "ipod");
    if (s16) args.push("-sample_fmt", "s16");
  } else {
    // wav：位深跟随源（16 → pcm_s16le / 24 → pcm_s24le；s32 的 wav 兼容性差不用）
    args.push("-c:a", opts.outDepth === 24 ? "pcm_s24le" : "pcm_s16le");
  }

  if (keepTags && hasCover) {
    args.push("-c:v", "copy", "-disposition:v:0", "attached_pic");
  } else {
    args.push("-vn");
  }
  if (typeof opts.sampleRateHz === "number" && opts.sampleRateHz > 0) {
    args.push("-ar", String(Math.trunc(opts.sampleRateHz)));
  }
  // 滤镜链（loudnorm,aresample）是输出选项，必须排在输出文件之前。
  if (opts.af) args.push("-af", opts.af);
  args.push(opts.out);
  return args;
}

interface RunResult {
  code: number | null;
  stderr: string;
  timedOut: boolean;
}

function runFfmpeg(args: string[], timeoutMs: number, file: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(resolveFfmpeg(), args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      reject(new FetchTranscodeError("TAG_FAILED", `无法启动 ffmpeg: ${String(e)}`, file));
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
      resolve({ code: null, stderr, timedOut: true });
    }, timeoutMs);
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
    });
    child.on("error", (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new FetchTranscodeError("TAG_FAILED", `ffmpeg 启动失败: ${e.message}`, file));
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stderr, timedOut: false });
    });
  });
}

/**
 * 从 ffmpeg stderr 里抠出 loudnorm 的**完整** JSON 报告。
 *
 * 为什么不用 `services/audio/loudness.ts` 的 `parseLoudnorm`：那个函数只返回
 * `input_i` / `input_tp` 两个字段，而 linear 两遍需要 `input_lra` / `input_thresh` /
 * `target_offset` 才能算出静态增益。定位策略与它**完全一致**（按最后一块
 * `[Parsed_loudnorm_` 标记 + 其后首个 `{...}`），只是多读三个字段。
 */
export function parseLoudnormMeasurement(raw: string): LoudnessMeasurement | undefined {
  if (!raw) return undefined;
  const marker = raw.lastIndexOf("[Parsed_loudnorm_");
  if (marker < 0) return undefined;
  const start = raw.indexOf("{", marker);
  if (start < 0) return undefined;
  const end = raw.indexOf("}", start);
  if (end < 0) return undefined;
  try {
    const d = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const num = (k: string): number => Number(d?.[k]);
    const i = num("input_i");
    const lra = num("input_lra");
    const tp = num("input_tp");
    const thresh = num("input_thresh");
    if (![i, lra, tp, thresh].every((v) => Number.isFinite(v))) return undefined;
    const off = num("target_offset");
    return { i, lra, tp, thresh, offset: Number.isFinite(off) ? off : 0 };
  } catch {
    return undefined;
  }
}

/** 第一遍：空跑一遍只测电平（`-f null -`），解析 loudnorm 的 JSON 报告。 */
async function measureLoudness(
  srcPath: string,
  opts: { targetLufs: number; truePeakDb?: number; rangeLu?: number; timeoutMs: number },
): Promise<LoudnessMeasurement | undefined> {
  const t = clampTargetLufs(opts.targetLufs);
  const tp = Number.isFinite(opts.truePeakDb) ? (opts.truePeakDb as number) : DEFAULT_TRUE_PEAK_DB;
  const lra = Number.isFinite(opts.rangeLu) ? (opts.rangeLu as number) : DEFAULT_LOUDNESS_RANGE_LU;
  // 不写 -loglevel error：loudnorm 的报告走 AV_LOG_INFO，压到 error 就看不到。
  const args = [
    "-hide_banner",
    "-i", srcPath,
    "-af", `loudnorm=I=${t}:TP=${tp}:LRA=${lra}:print_format=json`,
    "-f", "null", "-",
  ];
  let r: RunResult;
  try {
    r = await runFfmpeg(args, opts.timeoutMs, srcPath);
  } catch {
    return undefined;
  }
  if (r.timedOut || r.code !== 0) return undefined;
  return parseLoudnormMeasurement(r.stderr);
}

/**
 * 转码到目标容器（可选 -14 LUFS 响度归一化）。
 *
 * @throws FetchTranscodeError  TAG_FAILED（ffmpeg 失败）| TIMEOUT（超时）
 */
export async function transcodeFile(
  srcPath: string,
  opts: TranscodeOptions,
): Promise<TranscodeResult> {
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const warnings: string[] = [];
  if (!existsSync(srcPath)) {
    throw new FetchTranscodeError("TAG_FAILED", `源文件不存在: ${srcPath}`, srcPath);
  }

  // 源属性：容器决定是否 skip、hasCover 决定要不要带封面流。
  let srcContainer: string | undefined;
  let srcSampleRate: number | undefined;
  let srcBits: number | undefined;
  let hasCover = false;
  try {
    const m = await probeFile(srcPath);
    srcContainer = m.container;
    srcSampleRate = m.sampleRateHz;
    srcBits = m.bitDepth;
    hasCover = m.hasCover;
  } catch {
    warnings.push("源探针失败，按未知容器处理（不 skip）");
  }

  const loudnessOn = !!opts.loudnessNormalize;
  const dstPath = opts.dstPath || defaultDstPath(srcPath, opts.target);
  const needResample =
    typeof opts.sampleRateHz === "number" && opts.sampleRateHz > 0 &&
    (!srcSampleRate || srcSampleRate !== opts.sampleRateHz);

  // 源已是目标容器、无需重采样、且**未开响度归一化** → 直接返回。
  // 🔴 开了 loudnessNormalize 绝不能 skip：内容要变，跳过等于没归一化。
  if (!loudnessOn && srcContainer === opts.target && !needResample && !opts.dstPath) {
    log.info("源已是目标容器，跳过转码", { srcPath, target: opts.target });
    return { ok: true, srcPath, dstPath: srcPath, skipped: true, bytes: statSync(srcPath).size, warnings };
  }

  // 出流目标采样率：显式 > 源采样率 > 48000。loudnorm 恒上采样 192k，必须显式复位。
  const targetRate =
    typeof opts.sampleRateHz === "number" && opts.sampleRateHz > 0
      ? Math.trunc(opts.sampleRateHz)
      : srcSampleRate && srcSampleRate > 0
        ? srcSampleRate
        : DEFAULT_RESAMPLE_RATE;

  // 位深档位解析（产品定调 2026-10-10：跟随源）：显式 bitDepth > 旧 keepBitDepth16（true=16/false=24）> auto。
  const depthMode: "auto" | 16 | 24 =
    opts.bitDepth ??
    (opts.keepBitDepth16 === false ? 24 : opts.keepBitDepth16 === true ? 16 : "auto");
  const outDepth = resolveOutDepth(depthMode, srcBits);

  let af: string | undefined;
  if (loudnessOn) {
    const wantTarget = typeof opts.loudnessTargetLufs === "number" ? opts.loudnessTargetLufs : DEFAULT_TARGET_LUFS;
    let measured: LoudnessMeasurement | undefined;
    if (opts.loudnessTwoPass !== false) {
      measured = await measureLoudness(srcPath, {
        targetLufs: wantTarget,
        truePeakDb: opts.loudnessTruePeakDb,
        rangeLu: opts.loudnessRangeLu,
        timeoutMs,
      });
      if (!measured) {
        // 增值项降级：拿不到实测就走单遍动态，绝不因此让整首歌失败。
        warnings.push("响度两遍实测失败，已降级为单遍动态归一化");
      }
    }
    af = buildLoudnessFilter({
      targetLufs: wantTarget,
      truePeakDb: opts.loudnessTruePeakDb,
      rangeLu: opts.loudnessRangeLu,
      targetSampleRateHz: targetRate,
      // wav 目标（pcm_s16le/pcm_s24le 由 -c:a 定死）不写出流位深。
      osf: opts.target === "wav" ? undefined : outDepth === 16 ? "s16" : "s32",
      measured,
    });
  }


  const tmp = tmpPathFor(dstPath, "trtmp");
  const args = buildTranscodeArgs({
    src: srcPath,
    out: tmp,
    target: opts.target,
    sampleRateHz: opts.sampleRateHz,
    compressionLevel: opts.compressionLevel,
    keepTags: opts.keepTags,
    outDepth,
    hasCover,
    af,
  });
  log.info("转码", {
    srcPath,
    dstPath,
    target: opts.target,
    outDepth,
    srcBits,
    loudnorm: loudnessOn,
    osr: loudnessOn ? targetRate : undefined,
  });
  try {
    const r = await runFfmpeg(args, timeoutMs, srcPath);
    if (r.timedOut) {
      throw new FetchTranscodeError("TIMEOUT", `ffmpeg 转码超时(${timeoutMs}ms): ${srcPath}`, srcPath);
    }
    if (r.code !== 0 || !existsSync(tmp) || statSync(tmp).size === 0) {
      throw new FetchTranscodeError(
        "TAG_FAILED",
        `ffmpeg 转码失败(exit=${r.code}): ${srcPath} ${r.stderr.slice(0, 300)}`,
        srcPath,
      );
    }
    renameSync(tmp, dstPath);
    return { ok: true, srcPath, dstPath, skipped: false, bytes: statSync(dstPath).size, warnings };
  } finally {
    if (existsSync(tmp)) {
      try { rmSync(tmp, { force: true }); } catch { /* 清理失败不影响主流程 */ }
    }
  }
}
