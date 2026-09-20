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
import os from "node:os";
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

/** 同时进行的 ffmpeg 进程上限见文末「并发限制」（P2-5：两个独立池）。 */

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

// ---------------- 并发限制（P2-5：两个独立池） ----------------
//
// 为什么要分池：实时管道化之后，「用户主动要了音质档位」的转码和「默认管道」
// 走的是同一条出流函数，若共用一个池，多设备连播 / 后续交叉淡入（过渡期两路
// 解码）会把池占满，导致用户显式点的高码率请求排队卡在首字节。
// 因此按「谁决定的输出格式」分池，两池互不抢槽：
//   quality : 客户端显式指定 format / maxBitRate（音质转码）—— 编码最重，池小但受保护
//   pipeline: 默认实时管道（解码 → loudnorm → 同族编码）—— 数量最多，池子开大
//   flow    : 交叉淡入会话的**解码器**（P3-6）—— 过渡期两路并存，故上限按"解码器数"计
// 上限默认值照 MA 的派生方式按 CPU 核数算（constants.py:211
// `_default_background_scan_concurrency` 同为「按核数派生 + 封顶」），
// 并允许环境变量覆盖（容器编排里固定值时用）。

export type TranscodeSlotKind = "quality" | "pipeline" | "flow";

export interface SlotLimits {
  /** 音质转码池上限（客户端显式要档位）。 */
  quality: number;
  /** 归一化管道池上限（默认实时管道）。 */
  pipeline: number;
  /**
   * 交叉淡化会话的**解码器**上限（P3-6）。
   * 一个 flow 会话稳态占 1 个（当前曲），过渡窗口内占 2 个（当前曲 + 预取曲），
   * 所以"会话数 × 2 = 解码器数"—— 上限按解码器数给，等于**为过渡峰值预留了
   * 一倍余量**，交叉淡入不会因为抢不到槽而在接缝处停顿。
   */
  flow: number;
}

/**
 * 由核数与环境变量算出三池上限（纯函数，供单测锁定）。
 *   - quality ：核数，下限 4、上限 8（编码重，不无限开）
 *   - pipeline：核数 ×2，下限 6（解码+loudnorm 很轻，但数量多，实时性优先）
 *   - flow    ：核数，下限 4（按解码器数；8 核 = 4 个会话同时处于过渡期）
 * 环境变量：`TRANSCODE_MAX_CONCURRENT`（沿用旧名，现只约束音质池）、
 * `TRANSCODE_PIPELINE_MAX_CONCURRENT`、`TRANSCODE_FLOW_MAX_CONCURRENT`。
 * 非正数 / 非法值一律回退默认。
 */
export function resolveSlotLimits(cpuCount: number, env: Record<string, string | undefined>): SlotLimits {
  const cores = Number.isFinite(cpuCount) && cpuCount > 0 ? Math.floor(cpuCount) : 4;
  const pick = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  return {
    quality: pick(env.TRANSCODE_MAX_CONCURRENT, Math.max(4, Math.min(cores, 8))),
    pipeline: pick(env.TRANSCODE_PIPELINE_MAX_CONCURRENT, Math.max(6, cores * 2)),
    flow: pick(env.TRANSCODE_FLOW_MAX_CONCURRENT, Math.max(4, cores)),
  };
}

interface SlotPool {
  limit: number;
  active: number;
  /** FIFO 排队者：被唤醒时先占槽再 resolve。 */
  waiters: Array<() => void>;
}

const SLOT_LIMITS: SlotLimits = resolveSlotLimits(
  os.availableParallelism?.() ?? os.cpus?.().length ?? 4,
  process.env,
);

const slotPools: Record<TranscodeSlotKind, SlotPool> = {
  quality: { limit: SLOT_LIMITS.quality, active: 0, waiters: [] },
  pipeline: { limit: SLOT_LIMITS.pipeline, active: 0, waiters: [] },
  flow: { limit: SLOT_LIMITS.flow, active: 0, waiters: [] },
};

/**
 * 占用一个并发槽，返回**该槽的释放函数**（幂等，重复调用无副作用）。
 * 用租约而不是 acquire/release 两个函数成对调用，是为了让释放必然落到
 * 申请时那个池 —— 分池之后「释放到错误池」会静默把另一个池的额度吃掉。
 * 与 `plugin/batchPacer.ts::acquireBatchLock()` 同一形态。
 */
export function acquireTranscodeSlot(kind: TranscodeSlotKind = "quality"): Promise<() => void> {
  const pool = slotPools[kind];
  // released 闭包标志:租约必须幂等 —— 出流路径上 abort/exit/close 三种终态都会
  // 调 release,不挡住的话一次出流会还掉三个额度(池子被悄悄放大)。
  let released = false;
  const lease = () => {
    if (released) return;
    released = true;
    releaseTranscodeSlot(pool);
  };
  if (pool.active < pool.limit) {
    pool.active++;
    return Promise.resolve(lease);
  }
  // 排队是可观测事件（首字节延迟的直接来源），只在实际排队时记一次。
  log.info("转码槽排队等待", { kind, limit: pool.limit, queue: pool.waiters.length + 1 });
  return new Promise((resolve) => pool.waiters.push(() => {
    pool.active++;
    resolve(lease);
  }));
}

/** 释放一个槽并唤醒下一个排队者（内部使用；外部请用 acquire 返回的租约）。 */
function releaseTranscodeSlot(pool: SlotPool): void {
  pool.active = Math.max(0, pool.active - 1);
  const next = pool.waiters.shift();
  if (next) next();
}

/** 当前生效的池上限（供测试与排障读取真实值）。 */
export function slotLimit(kind: TranscodeSlotKind): number {
  return slotPools[kind].limit;
}

/** 指定池的占用数；不传 kind 时为三池合计（兼容旧调用）。 */
export function activeTranscodeCount(kind?: TranscodeSlotKind): number {
  if (kind) return slotPools[kind].active;
  return slotPools.quality.active + slotPools.pipeline.active + slotPools.flow.active;
}
