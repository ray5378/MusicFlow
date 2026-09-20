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
import { decodeArgs, codecArgs } from "./audio/pipeline.js";

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
  /**
   * 管道 -af 链(响度/DSP/限制器,P1-5):与编码同一次 ffmpeg 进程完成,
   * 不再为"先转码、再处理"起第二个进程。缺省空 = 与旧命令逐字节一致。
   * 有 loudnorm 时 decodeArgs 自动提 loglevel 到 info(供 P0-4 读 JSON)。
   */
  af?: string[];
}

/** 转码命令拼装(纯函数,供单测锁定;spawnTranscoder 原样使用)。
 *  无 af 时与旧命令逐字节一致(除 -headers 尾部多余 CRLF 归一化掉、
 *  新增无害的 -map 0:a:0);有 af 时响度/DSP/限制器与编码同一次进程完成。 */
export function transcodeArgs(opts: TranscodeSpawnOptions): string[] {
  const head = decodeArgs({
    input: opts.source,
    headers: opts.headers,
    timeOffsetSec: opts.timeOffsetSec,
    ...(opts.af && opts.af.length > 0 ? { af: opts.af } : {}),
  });
  head.splice(-3);
  const container = opts.format === "mp3" ? "mp3" : "adts";
  return [...head, ...codecArgs(opts.format, opts.bitrateKbps), "-f", container, "-"];
}

/** 用已组装好的参数直接拉起 ffmpeg(供统一管道组装调用方)。 */
export function spawnTranscoderWithArgs(args: string[]): ChildProcessByStdio<null, Readable, Readable> {
  return spawn(resolveFfmpeg(), args, { stdio: ["ignore", "pipe", "pipe"] });
}

/** 拉起 ffmpeg 把 source 实时转成目标格式输出到 stdout（pipe）。 */
export function spawnTranscoder(opts: TranscodeSpawnOptions): ChildProcessByStdio<null, Readable, Readable> {
  const args = transcodeArgs(opts);
  const child = spawn(resolveFfmpeg(), args, { stdio: ["ignore", "pipe", "pipe"] });
  // stderr 常开排空:无读者时管道满(64KB)会憋住 ffmpeg(长会话必踩,此前靠
  // -loglevel error 输出极少侥幸避开;loudnorm 开启后 info 输出变多)。
  // P0-4 HTTP 落点要读 JSON 时再加捕获,此处只保活。
  child.stderr.on("data", () => {});
  child.stderr.resume();
  return child;
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
