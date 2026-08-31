// ==================== 服务器端转码服务（OpenSubsonic /rest/stream 语义） ====================
//
// 客户端按 Subsonic 标准在 /rest/stream 上携带 format / maxBitRate / timeOffset：
//   - 未指定 format 或 format=raw → 服务端原样返回原始文件（无损直连不受影响）；
//   - format=mp3/aac → 实时转码到目标格式；maxBitRate 低于源码率时同时压码率；
//   - 转码流无法按字节 Range 断点续传，客户端改用 timeOffset 重新拉流 seek
//     （对应服务器已对外宣告的 transcodeOffset OpenSubsonic 扩展）。
//
// 转码二进制：优先 FFMPEG_PATH 环境变量（便于运维注入与测试隔离），其次 ffmpeg-static（AirPlay 投屏已用），最后 PATH。
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createRequire } from "node:module";
import type { Readable } from "node:stream";
import { createLogger } from "../utils/logger.js";

const log = createLogger("TRANSCODE");
const require_ = createRequire(import.meta.url);

/** 可转码的目标格式白名单（防止任意外部格式参数把服务器 CPU 打满）。 */
const FORMAT_WHITELIST = new Set(["mp3", "aac"]);

export const TRANSCODE_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  aac: "audio/aac",
};

/** 同时进行的转码进程上限，超出后排队等待（环境变量可覆盖）。 */
const MAX_CONCURRENT_TRANSCODES = Math.max(1, Number(process.env.TRANSCODE_MAX_CONCURRENT || 4));

let activeTranscodes = 0;
const transcodeWaiters: Array<() => void> = [];

// ---------------- 工具 ----------------

/** 码率归一为 kbps（兼容 kbps 与 bps 两种入库口径）。 */
export function normalizeBitRateKbps(br: number | null | undefined): number {
  if (!br || br <= 0) return 0;
  return br >= 10000 ? Math.round(br / 1000) : Math.round(br);
}

/** 规范化目标格式；空 / raw / 非白名单 → null（表示不转码、原样返回）。 */
export function normalizeTargetFormat(format: string | null | undefined): "mp3" | "aac" | null {
  const f = (format || "").trim().toLowerCase().replace(/^\./, "");
  if (f === "" || f === "raw") return null;
  return (FORMAT_WHITELIST.has(f) ? f : null) as "mp3" | "aac" | null;
}

/** 目标码率：优先 maxBitRate，缺省按源码率，再缺省 320；限制在 [64, cap]。 */
function effectiveBitrate(format: "mp3" | "aac", maxBitRate: number, sourceBitRate: number): number {
  const cap = format === "aac" ? 512 : 320; // mp3(lame) 最高 320，aac 原生编码器可更高
  const target = maxBitRate > 0 ? maxBitRate : sourceBitRate > 0 ? sourceBitRate : 320;
  return Math.max(64, Math.min(cap, target));
}

// ---------------- 转码判定 ----------------

export interface TranscodeDecision {
  /** 是否需要转码。 */
  should: boolean;
  /** 转码目标格式（should 为 true 时保证非空，默认 mp3）。 */
  format: "mp3" | "aac" | null;
  /** 目标码率（kbps），should 为 true 时为有效值。 */
  bitrateKbps: number;
}

/**
 * 依据 OpenSubsonic /rest/stream 参数与源文件信息判断是否需要转码，
 * 与 Navidrome / 客户端 shouldUseServerTimeOffsetSeek 的判定保持一致：
 *   - 请求了白名单格式且源格式不同，或源码率高于 maxBitRate → 转码；
 *   - 仅 maxBitRate（未指定格式）且源码率高于它 → 压码率（默认转 mp3）；
 *   - 否则原样返回原始文件。
 */
export function decideTranscode(input: {
  requestedFormat?: string | null;
  maxBitRate?: number | null;
  sourceFormat?: string | null;
  sourceBitRate?: number | null;
}): TranscodeDecision {
  const fmt = normalizeTargetFormat(input.requestedFormat ?? null);
  const br = normalizeBitRateKbps(input.maxBitRate ?? null);
  const srcFmt = (input.sourceFormat || "").trim().toLowerCase().replace(/^\./, "");
  const src = normalizeBitRateKbps(input.sourceBitRate ?? null);

  if (fmt) {
    const canUseOriginal = srcFmt === fmt && (br === 0 || (src > 0 && br >= src));
    if (canUseOriginal) return { should: false, format: null, bitrateKbps: 0 };
    return { should: true, format: fmt, bitrateKbps: effectiveBitrate(fmt, br, src) };
  }
  if (br > 0 && src > br) {
    return { should: true, format: "mp3", bitrateKbps: effectiveBitrate("mp3", br, src) };
  }
  return { should: false, format: null, bitrateKbps: 0 };
}

// ---------------- ffmpeg 转码进程 ----------------

export function resolveFfmpeg(): string {
  // 显式配置优先于内置二进制（便于运维注入与测试隔离）。
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    const p = require_("ffmpeg-static") as string | undefined;
    if (p) return p;
  } catch {
    /* 未安装 → 回退 PATH */
  }
  return "ffmpeg";
}

export interface TranscodeSpawnOptions {
  /** 本地文件路径或远程 URL。 */
  source: string;
  /** 远程源需要的额外请求头（如 Referer / Authorization），本地文件时留空。 */
  headers?: Record<string, string>;
  format: "mp3" | "aac";
  bitrateKbps: number;
  timeOffsetSec?: number;
}

/** 拉起 ffmpeg 把 source 实时转成目标格式输出到 stdout（pipe）。 */
export function spawnTranscoder(opts: TranscodeSpawnOptions): ChildProcessByStdio<null, Readable, Readable> {
  const args = ["-hide_banner", "-loglevel", "error"];
  const hdrs = Object.entries(opts.headers || {}).filter(([, v]) => v != null && v !== "");
  if (hdrs.length) {
    args.push("-headers", hdrs.map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n");
  }
  if (opts.timeOffsetSec && opts.timeOffsetSec > 0) args.push("-ss", String(opts.timeOffsetSec));
  args.push("-i", opts.source);
  args.push("-vn", "-sn", "-dn"); // 丢弃封面/字幕/数据流，只转音频
  if (opts.format === "mp3") {
    args.push("-c:a", "libmp3lame", "-b:a", `${opts.bitrateKbps}k`, "-f", "mp3", "-");
  } else {
    args.push("-c:a", "aac", "-b:a", `${opts.bitrateKbps}k`, "-f", "adts", "-");
  }
  return spawn(resolveFfmpeg(), args, { stdio: ["ignore", "pipe", "pipe"] });
}

// ---------------- 并发限制 ----------------

/** 占用一个转码并发槽（超出上限则排队等待）。 */
export function acquireTranscodeSlot(): Promise<void> {
  if (activeTranscodes < MAX_CONCURRENT_TRANSCODES) {
    activeTranscodes++;
    return Promise.resolve();
  }
  return new Promise((resolve) => transcodeWaiters.push(() => {
    activeTranscodes++;
    resolve();
  }));
}

/** 释放一个转码并发槽并唤醒下一个排队者。 */
export function releaseTranscodeSlot(): void {
  activeTranscodes = Math.max(0, activeTranscodes - 1);
  const next = transcodeWaiters.shift();
  if (next) next();
}

/** 供测试获取当前并发数。 */
export function activeTranscodeCount(): number {
  return activeTranscodes;
}
