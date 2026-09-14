// ==================== 统一音源裁决与取流 ====================
//
// 所有播放链路(DLNA 设备拉流 /rest/stream,本机/客户端出流,sendspin pump,
// 切歌前 judgePlayable)的唯一真相源。此前各链路分散实现导致误判不一致:
//   - judge 只认缓存+单行探测,本地行探失败即判死,不看组内 web 兄弟;
//   - pump 只认 ensure 结果,不认优选换行;
//   结果同一首歌这边跳那边播(周深小美满案:歌单引用无 url 本地行,
//   WebDAV 明明可达,sendspin 照跳不误)。
// 本模块收敛决策:快缓存 → 本行探测 → 优选换行(含验证) → 本行复核,
// 每一步带 reason,调用方按需兜底,日志可直接定位判死位置。
import { db } from "../../db/index.js";
import { songs, mediaSources } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import {
  ensurePlayableStream,
  getCachedPlayability,
  probeStream,
} from "./online/streamFallback.js";
import { resolvePreferredSong } from "./preferredSource.js";
import { probeLocalSourceOk, parseSongPath } from "../../utils/localSourceProbe.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("RESOLVE-AUDIO");

export type SongRow = typeof songs.$inferSelect;

export interface PlayableRowResult {
  row: SongRow | null;
  /** 判定路径标记: fresh-cache / ensure-ok / local-probe-ok / preferred-swap / reverify-ok / ...-failed */
  reason: string;
  /** true=确定无源(本地文件确死),调用方可直接判 skip;
   *  false=未知(网络抖动/缓存过期),调用方须宽容放行,不可判死。 */
  definitive: boolean;
}

/** 快速验证一行确实可播:本地行走 probeLocalSourceOk;web 行探 url(5s)。 */
async function verifyRow(row: SongRow): Promise<boolean> {
  try {
    if ((row.type || "local") !== "web") {
      return await probeLocalSourceOk({ id: row.id, path: (row as any).path });
    }
    if (!row.url) return false;
    return (await probeStream(row.url, 5000)) === "ok";
  } catch {
    return false;
  }
}

/** 与 /rest/stream 同口径的行取字节:web 行走 url(+stream_headers)/cachePath;
 *  local/webdav 行按 path 解析(webdav 带源鉴权,本地读文件)。取不到返回 null。
 *  (原为 pump 内联,抽到此处供所有链路复用。) */
export async function fetchRowBytes(row: SongRow): Promise<Buffer | null> {
  try {
    if (!row) return null;
    if ((row.type || "local") === "web") {
      if ((row as any).cachePath) {
        try {
          const fs = await import("fs");
          if (fs.existsSync((row as any).cachePath)) return fs.readFileSync((row as any).cachePath);
        } catch { /* 继续走 url */ }
      }
      if (!row.url) return null;
      let headers: Record<string, string> = {};
      try { headers = JSON.parse((row as any).stream_headers || "{}"); } catch { /* ignore */ }
      const res = await fetch(row.url, { headers, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    }
    const parsed = parseSongPath((row as any).path || "");
    if (!parsed) return null;
    if (parsed.type === "w") {
      const source: any = db.select().from(mediaSources).where(eq(mediaSources.id, parsed.sourceId)).get();
      if (!source) return null;
      const config = JSON.parse(source.config || "{}");
      const origin = new URL(config.url).origin;
      const headers: Record<string, string> = {};
      if (config.username && config.password) {
        headers["Authorization"] = "Basic " + Buffer.from(`${config.username}:${config.password}`).toString("base64");
      }
      const res = await fetch(origin + parsed.filePath, { headers, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    }
    const fs = await import("fs");
    if (!fs.existsSync(parsed.filePath)) return null;
    return fs.readFileSync(parsed.filePath);
  } catch {
    return null;
  }
}

/** 裁决某首歌的可播行(可能是兄弟行)。调用方:
 *  - judge 要 verdict:row ? "play" : (cached-unplayable ? "skip" : "play")(宽容不变);
 *  - pump 要字节:row ? fetchRowBytes(row) : throw。
 *  失败只返回 null + reason,不抛(调用方按自己语义处理)。 */
export async function resolvePlayableRow(songId: string): Promise<PlayableRowResult> {
  const t0 = Date.now();
  let row: SongRow | null = null;
  try {
    row = db.select().from(songs).where(eq(songs.id, songId)).get() as SongRow | null;
  } catch (e) {
    return { row: null, reason: `db-error:${(e as Error)?.message || e}`, definitive: false };
  }
  if (!row) return { row: null, reason: "no-row", definitive: false };
  const done = (r: SongRow | null, reason: string, definitive = false): PlayableRowResult => {
    log.info(`[resolve] ${songId} -> ${r ? r.id : "null"} (${reason}) ms=${Date.now() - t0}`);
    return { row: r, reason, definitive };
  };
  // 1) 快缓存(零成本)
  try {
    if (getCachedPlayability(songId) === "playable") return done(row, "fresh-cache");
  } catch { /* ignore */ }
  const isWeb = !!row.pluginEntry && typeof row.pluginEntry === "string";
  if (isWeb) {
    // web 行先换行(与 /rest/stream 同顺序):ensure 内部换行成功只返回 URL 不换行,
    // 后续按行取字节会对不上(曾导致死链 web 行 verdict 通过、取字节却拉死链)。
    try {
      const alt: any = await resolvePreferredSong(row as any);
      if (alt && alt.id !== row.id && (await verifyRow(alt))) {
        return done(alt as SongRow, "preferred-swap");
      }
    } catch { /* 继续本行 */ }
    try {
      if (await ensurePlayableStream(row as any)) return done(row, "ensure-ok");
    } catch { /* 继续复核 */ }
  } else {
    // 本地行先直探(快;失败有 5 分钟记忆,重复不贵),失败再换组内 web 兄弟。
    try {
      if (await probeLocalSourceOk({ id: row.id, path: (row as any).path })) return done(row, "local-probe-ok");
    } catch { /* 继续换行 */ }
    try {
      const alt: any = await resolvePreferredSong(row as any);
      if (alt && alt.id !== row.id && (await verifyRow(alt))) {
        return done(alt as SongRow, "preferred-swap");
      }
    } catch { /* 继续复核 */ }
    // 本地行探失败且无可用兄弟行 = 确定无源(文件确死,非网络抖动),可直接判 skip。
    return done(null, "local-probe-fail", true);
  }
  // 4) 本行复核:换行失败后的最终确认,避免单次探测抖动判死。
  try {
    if (await verifyRow(row)) return done(row, "reverify-ok");
  } catch { /* ignore */ }
  return done(null, "all-failed");
}
