// On-the-fly cover rendering for GET /rest/getCoverArt.
//
// Previously covers were served at their FULL on-disk resolution and the
// `size` query param was ignored — so a 1000×1000 cover was shipped to a
// 38px thumbnail on a slow external link. This module resizes to the requested
// size (capped) and, when the client advertises `Accept: image/webp`, encodes
// to webp, which is typically 3-5× smaller than the equivalent JPEG.
//
// Output is cached in RAM (keyed by content ETag) so repeated requests for the
// same cover+size+format don't re-run sharp. Browser/proxy caching is handled
// by the caller via Cache-Control + ETag (see routes/rest getCoverArt).
//
// 2026-10-12(封面慢请求治理 B):冷缓存下的"一屏封面并发"曾把单张渲染排到 1~3s。
// 三处针对性改动,都不改变对外语义:
//   ① 同一 ETag 的并发请求**单飞**——同一张图常被网格/播放器/队列同时请求,
//      不单飞就白渲染 N 遍;
//   ② sharp 渲染加**并发信号量**——不是吞吐调优(实测 sharp 吞吐与并发基本无关,
//      天花板约 130 张/秒),而是内存护栏:一张 1200×1200 解码位图约 5.8MB 原生内存,
//      上百个请求同时进 sharp 就是数百 MB 的瞬时 native 峰值;
//   ③ 编码参数调优——去掉 mozjpeg(体积只多约 25%,吞吐高约 45%)、webp effort 4→1。
// 缓存上限改为 env 可覆盖,部署侧可按机器内存收紧/放宽。
//
// `sharp` is a native module. We import it lazily and tolerate its absence:
// if it fails to load (e.g. a deployment whose base image can't run it) the
// caller falls back to serving the raw bytes, so the backend never crashes.
import crypto from "crypto";
import fs from "fs";
import { readCoverFile } from "./coverCache.js";

// sharp is a CJS module; its dynamic import yields a namespace whose `.default`
// is the callable factory. Type it loosely to avoid CJS/ESM interop friction,
// and tolerate its absence (missing native binary → serve raw bytes instead).
let sharpLib: any = null;
let sharpTried = false;
async function getSharp(): Promise<any> {
  if (sharpTried) return sharpLib;
  sharpTried = true;
  try {
    const mod: any = await import("sharp");
    sharpLib = mod?.default ?? mod;
  } catch {
    sharpLib = null;
  }
  return sharpLib;
}

/** 读一个正整数 env,非法/缺失时回落默认值(0 与负值视为非法,不留"静默关闭"后门)。 */
function envInt(name: string, def: number): number {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

interface Rendered {
  buf: Uint8Array;
  contentType: string;
  at: number;
}

// RAM budget for rendered (resized/encoded) covers. Distinct covers are few and
// a 300px webp is ~10-30KB, so this holds thousands of entries. Env-overridable
// (COVER_RENDER_CACHE_MB / COVER_RENDER_MAX_ENTRIES) so a small box can tighten
// it; the entry cap exists because bytes alone don't bound the map for tiny
// payloads, and the byte cap exists because entries alone don't bound the map
// for big sizes (a 1200px jpeg is ~150KB).
const RENDER_BUDGET = envInt("COVER_RENDER_CACHE_MB", 48) * 1024 * 1024;
const RENDER_MAX_ENTRIES = envInt("COVER_RENDER_MAX_ENTRIES", 1500);

/**
 * 同时在途的 sharp 渲染数上限(env COVER_RENDER_CONCURRENCY)。
 * 这是**内存护栏**而不是性能旋钮:实测 sharp 吞吐与并发无关(约 130 张/秒封顶),
 * 但每个在途渲染都攥着一张全尺寸解码位图(1200×1200 ≈ 5.8MB 原生内存),
 * 并发一放开,冷启动的一屏封面就能把瞬时 native 内存推到数百 MB。
 * 钉在个位数只增加排队时间,不降低吞吐。
 */
export const RENDER_CONCURRENCY = envInt("COVER_RENDER_CONCURRENCY", 4);

const cache = new Map<string, Rendered>();
// 在途渲染:etag -> 该次渲染的 promise(单飞)。命中即复用,结束后自摘。
const inflight = new Map<string, Promise<CoverOut | null>>();
let heldBytes = 0;

let activeRenders = 0;
const renderWaiters: Array<() => void> = [];

/** 取一个渲染槽位;满员则排队。 */
async function acquireRenderSlot(): Promise<void> {
  if (activeRenders < RENDER_CONCURRENCY) {
    activeRenders++;
    return;
  }
  // 满员:排队等唤醒。被 release 唤醒时槽位是"过户"过来的,总数不变,这里不再自增。
  await new Promise<void>((resolve) => renderWaiters.push(resolve));
}

/** 归还槽位;有等待者则直接过户(不经过 0,避免惊群)。 */
function releaseRenderSlot(): void {
  const next = renderWaiters.shift();
  if (next) {
    next();
    return;
  }
  activeRenders--;
}

function evict(): void {
  if (cache.size <= RENDER_MAX_ENTRIES && heldBytes <= RENDER_BUDGET) return;
  const keys = [...cache.keys()].sort((a, b) => cache.get(a)!.at - cache.get(b)!.at);
  for (const k of keys) {
    if (cache.size <= RENDER_MAX_ENTRIES && heldBytes <= RENDER_BUDGET) break;
    const e = cache.get(k)!;
    heldBytes -= e.buf.byteLength;
    cache.delete(k);
  }
}

/** 登记一条渲染结果并做预算回收(缓存写入的唯一出口)。 */
function put(etag: string, out: Rendered): void {
  cache.set(etag, out);
  heldBytes += out.buf.byteLength;
  evict();
}

function guessMime(ref: string): string {
  const ext = ref.toLowerCase().split(".").pop() || "";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

export interface CoverOut {
  data: Uint8Array;
  contentType: string;
  etag: string;
}

/**
 * Resolve + resize + (optionally) re-encode a cover file.
 *
 * 并发语义:同一 ETag 的在途渲染会单飞(多个调用方拿到**同一个** promise 与
 * 同一个结果对象);不同 ETag 各自排队,受 RENDER_CONCURRENCY 约束。
 *
 * @param filePath absolute path to the cover image
 * @param size     requested edge length in px (clamped to [24, 1200])
 * @param wantWebp encode webp when true (raster sources only; gif preserved)
 */
export async function loadAndRenderCover(
  filePath: string,
  size: number,
  wantWebp: boolean,
): Promise<CoverOut | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const reqSize = Math.min(1200, Math.max(24, Math.round(size || 300)));
  const etagSrc = `${filePath}|${stat.size}|${stat.mtimeMs}|${reqSize}|${wantWebp ? 1 : 0}`;
  const etag = `"${crypto.createHash("md5").update(etagSrc).digest("hex")}"`;

  const hit = cache.get(etag);
  if (hit) {
    hit.at = Date.now();
    return { data: hit.buf, contentType: hit.contentType, etag };
  }

  // 单飞:命中在途渲染直接复用,不再重复解码/编码同一张图。
  const pending = inflight.get(etag);
  if (pending) return pending;

  const task = renderAndCache(etag, filePath, reqSize, wantWebp).finally(() => {
    inflight.delete(etag);
  });
  inflight.set(etag, task);
  return task;
}

/**
 * 真正做活的路径:读原图 → (有 sharp 则)缩放/转码 → 登记缓存。
 * 契约:**永不抛异常**——任何失败都降级成"原样回传字节"或 null,
 * 这样上面的单飞 promise 不会把异常带给多个调用方中的某一个。
 */
async function renderAndCache(
  etag: string,
  filePath: string,
  reqSize: number,
  wantWebp: boolean,
): Promise<CoverOut | null> {
  let raw: Uint8Array;
  try {
    raw = await readCoverFile(filePath);
  } catch {
    return null;
  }

  const sharp = await getSharp();
  if (!sharp) {
    // No image library available — serve the original bytes as-is.
    const out: Rendered = { buf: raw, contentType: guessMime(filePath), at: Date.now() };
    put(etag, out);
    return { data: out.buf, contentType: out.contentType, etag };
  }

  let out: Rendered;
  await acquireRenderSlot();
  try {
    const img = sharp(Buffer.from(raw));
    const meta = await img.metadata().catch(() => null);
    const isGif = meta?.format === "gif";
    const useWebp = wantWebp && !isGif;
    const pipeline = img.rotate().resize(reqSize, reqSize, {
      fit: "cover",
      withoutEnlargement: true,
    });
    if (useWebp) {
      const buf = await pipeline.webp({ quality: 80, effort: 1 }).toBuffer();
      out = { buf, contentType: "image/webp", at: Date.now() };
    } else if (meta?.format === "png") {
      const buf = await pipeline.png({ quality: 80 }).toBuffer();
      out = { buf, contentType: "image/png", at: Date.now() };
    } else if (meta?.format === "webp") {
      const buf = await pipeline.webp({ quality: 80, effort: 1 }).toBuffer();
      out = { buf, contentType: "image/webp", at: Date.now() };
    } else {
      // 不用 mozjpeg:mozjpeg 把 12KB 压到 ~9KB,但吞吐从 ~153 张/秒掉到 ~106 张/秒。
      // 封面是 300px 级缩略图,几 KB 的体积差无关痛痒,而冷缓存突发的排空速度
      // 直接决定会不会撞上慢请求告警线。
      const buf = await pipeline.jpeg({ quality: 82 }).toBuffer();
      out = { buf, contentType: "image/jpeg", at: Date.now() };
    }
  } catch {
    // Decode/encode failed (corrupt or unsupported) — serve the original bytes.
    out = { buf: raw, contentType: guessMime(filePath), at: Date.now() };
  } finally {
    releaseRenderSlot();
  }

  put(etag, out);
  return { data: out.buf, contentType: out.contentType, etag };
}

/** Drop the rendered-cover cache (used by maintenance hooks if needed). */
export function clearRenderedCovers(): void {
  cache.clear();
  heldBytes = 0;
}

/** Bytes of rendered (resized/webp) cover bytes held in RAM (observability). */
export function getRenderedCoverBytes(): number {
  return heldBytes;
}

/** 当前在途的 sharp 渲染数(observability / 并发护栏断言)。 */
export function getActiveRenderCount(): number {
  return activeRenders;
}

/** 当前在途排队等待渲染槽位的请求数(observability)。 */
export function getQueuedRenderCount(): number {
  return renderWaiters.length;
}

/** 封面渲染管线压力快照(端到端背压信号,供 /rest/getCoverArt 回传,见 ADR-4)。 */
export interface CoverPressure {
  /** 在途 sharp 渲染数。 */
  active: number;
  /** 排队等待渲染槽位的请求数。 */
  queued: number;
  /** 渲染并发上限(COVER_RENDER_CONCURRENCY)。 */
  limit: number;
  /** 是否已达/超护栏(有排队或槽位占满)——客户端据此退避。 */
  saturated: boolean;
}

/** 读取当前封面渲染管线压力。 */
export function getCoverPressure(): CoverPressure {
  return {
    active: activeRenders,
    queued: renderWaiters.length,
    limit: RENDER_CONCURRENCY,
    saturated: renderWaiters.length > 0 || activeRenders >= RENDER_CONCURRENCY,
  };
}

/**
 * 把压力快照转成响应头:始终回传并发上限(供具备请求头能力的调用方对齐自身并发),
 * 并在管线饱和时给出 `Retry-After` 退避提示。
 *
 * 抽成纯函数是为了可确定性单测——无需真的把渲染管线压饱和即可断言两条分支。
 * 说明:客户端 `<img>` / Flutter `Image.network` 读不到响应头,故该信号主要服务
 * Web 前端(XHR/fetch)与未来经 dio 拉取封面字节的端侧实现。
 */
export function buildCoverPressureHeaders(p: CoverPressure): Record<string, string> {
  const headers: Record<string, string> = {
    "X-MusicFlow-Cover-Concurrency": String(p.limit),
    "X-MusicFlow-Cover-Active": String(p.active),
    "X-MusicFlow-Cover-Queued": String(p.queued),
  };
  if (p.saturated) {
    headers["Retry-After"] = "1";
    headers["X-MusicFlow-Cover-Saturated"] = "1";
  }
  return headers;
}
