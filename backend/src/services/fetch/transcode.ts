// ==================== 下载产物转码（MusicFetch M1） ====================
//
// 只做「换封装」，不做音质提升 —— 源是 320k mp3 转 flac 之后仍是 320k 的音质，
// 体积还会变大。产品口径必须明写这一点，避免用户误以为转 flac = 变无损。
//
// 🔴 最关键的一条（M0 实测，230）：转 flac **必须 `-sample_fmt s16`**。
//    只写 `-c:a flac` 时，ffmpeg 会把 16bit 源虚假升到 s32/24bit：同一段 3 秒样本
//    实测 24bit = 163950B vs 16bit = 46255B（**3.5 倍**），采样率与时长不变、
//    音质零提升。本模块默认对 flac 强制 s16（可用 keepBitDepth16:false 关闭）。
//
// 其余约定：
//   - 源已是目标容器 → `skipped:true` 直接返回，不跑 ffmpeg（省一次全解码 + 避免
//     不必要的体积膨胀）；
//   - 绝不原地覆盖：写 `<dst>.trtmp` 成功后再 rename（同 tagWriter）；
//   - ffmpeg 二进制一律走 `resolveFfmpeg()`（支持 FFMPEG_PATH 注入，便于测试隔离）。
import { spawn } from "node:child_process";
import { existsSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { createLogger } from "../../utils/logger.js";
import { resolveFfmpeg } from "../transcode.js";
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
  /** 是否强制 16bit（默认 true，防 3.5 倍膨胀） */
  keepBitDepth16?: boolean;
  /** 单次转码超时（毫秒），缺省 300s */
  timeoutMs?: number;
}

export interface TranscodeResult {
  ok: true;
  srcPath: string;
  dstPath: string;
  /** 源已是目标容器且采样率无需改变 → 直接返回，未跑 ffmpeg */
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

/** 拼装转码参数（纯函数，便于单测锁定命令形态）。 */
export function buildTranscodeArgs(opts: {
  src: string;
  out: string;
  target: TranscodeFormat;
  sampleRateHz?: number;
  compressionLevel?: number;
  keepTags?: boolean;
  keepBitDepth16?: boolean;
  hasCover?: boolean;
}): string[] {
  const keepTags = opts.keepTags !== false;
  const s16 = opts.keepBitDepth16 !== false;
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
    // wav：16bit PCM（s32 的 wav 兼容性差且无意义）
    args.push("-c:a", "pcm_s16le");
  }

  if (keepTags && hasCover) {
    args.push("-c:v", "copy", "-disposition:v:0", "attached_pic");
  } else {
    args.push("-vn");
  }
  if (typeof opts.sampleRateHz === "number" && opts.sampleRateHz > 0) {
    args.push("-ar", String(Math.trunc(opts.sampleRateHz)));
  }
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
 * 转码到目标容器。
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
  let hasCover = false;
  try {
    const m = await probeFile(srcPath);
    srcContainer = m.container;
    srcSampleRate = m.sampleRateHz;
    hasCover = m.hasCover;
  } catch {
    warnings.push("源探针失败，按未知容器处理（不 skip）");
  }

  const dstPath = opts.dstPath || defaultDstPath(srcPath, opts.target);
  const needResample =
    typeof opts.sampleRateHz === "number" && opts.sampleRateHz > 0 &&
    (!srcSampleRate || srcSampleRate !== opts.sampleRateHz);

  // 源已是目标容器且无需重采样 → 直接返回（换名场景由调用方用 dstPath 控制）。
  if (srcContainer === opts.target && !needResample && !opts.dstPath) {
    log.info("源已是目标容器，跳过转码", { srcPath, target: opts.target });
    return { ok: true, srcPath, dstPath: srcPath, skipped: true, bytes: statSync(srcPath).size, warnings };
  }

  const tmp = tmpPathFor(dstPath, "trtmp");
  const args = buildTranscodeArgs({
    src: srcPath,
    out: tmp,
    target: opts.target,
    sampleRateHz: opts.sampleRateHz,
    compressionLevel: opts.compressionLevel,
    keepTags: opts.keepTags,
    keepBitDepth16: opts.keepBitDepth16,
    hasCover,
  });
  log.info("转码", { srcPath, dstPath, target: opts.target, s16: opts.keepBitDepth16 !== false });
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
