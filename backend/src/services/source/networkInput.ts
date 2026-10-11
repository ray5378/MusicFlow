// ==================== 出流输入的「源解析」(出流路径与后台预取共用同一份推导) ====================
//
// 为什么必须抽出来（2026-10-12 · 下一首预缓冲）：
// `/rest/stream` 的 `resolveTranscodeInput` 原本是 `routes/rest/index.ts` 的**模块私有**函数，
// 预取器（services/source/prefetchCache.ts）在别的模块里拿不到它的 URL 推导逻辑。若预取自己
// 抄一份，两边迟早漂移 —— 预取到一个与实际出流不同的 URL（播放优选换源 / WebDAV Basic 鉴权头 /
// 空直链的兜底解析），结果是「预取成功但播不到」：白烧流量、首字节照样慢，且日志上完全看不出来。
//
// 这里把推导收敛成两个纯函数，**出流与预取共用同一份**：
//   - `resolveLocalFilePath` —— 本地直读路径（本地磁盘行 / web 行已缓存到本地的文件）；没有 → null
//   - `resolveNetworkInput`  —— 网络源（web 插件直链 / WebDAV）；本地行 → null
// 两者**互斥**：对同一行最多一个返回非 null（互斥性由 tests/source/networkInput.test.ts 断言）。
// 出流侧的分支语义与抽离前逐条一致（本地直读 → 缓冲 → 回退直通），见 resolveTranscodeInput。
//
// ⚠ 改动这里 = 同时改出流与预取。任何行为变化都必须先问「正在播的流会不会变慢 / 断流」。

import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { mediaSources } from "../../db/schema.js";
import { parseSongPath } from "../../utils/localSourceProbe.js";

/** 只需要被读取的那几个字段；出流行与任意 partial 行都满足。 */
export interface SongLike {
  id?: string;
  type?: string | null;
  path?: string | null;
  url?: string | null;
  streamHeaders?: string | null;
  cachePath?: string | null;
  [k: string]: any;
}

/** WebDAV 源：把 `media_sources.config.url` 的 origin 拼上库内相对路径。 */
export function getWebDAVUrl(sourceConfig: any, filePath: string): string {
  const origin = new URL(sourceConfig.url).origin;
  return origin + filePath;
}

/**
 * 本地直读路径（ffmpeg 可直接打开的磁盘文件）。无 → null（表示要走网络源）。
 *
 * 覆盖两类：
 *   - web 行的 `cachePath` 且文件确实在盘上（插件源已缓存，零网络成本）；
 *   - `path` 前缀 `l:` 的本地曲库行。
 * `w:`（WebDAV）行一律返回 null —— 它是网络源。
 */
export async function resolveLocalFilePath(song: SongLike | null | undefined): Promise<string | null> {
  if (!song) return null;
  if ((song.type || "local") === "web") {
    // 有缓存路径但文件不在 → 不算本地（回落到网络直链，与抽离前行为一致）。
    if (song.cachePath && existsSync(song.cachePath)) return song.cachePath;
    return null;
  }
  const parsed = parseSongPath(song.path || "");
  if (!parsed) return null;
  if (parsed.type === "w") return null; // WebDAV → 网络源
  return parsed.filePath;
}

/** 网络源输入（url + 请求头）。本地直读行 → null。 */
export interface NetworkInput {
  url: string;
  headers: Record<string, string>;
}

/**
 * 网络源输入解析（web 插件直链 / WebDAV）。本地直读行 → null。
 *
 * 与 `resolveLocalFilePath` 互斥：本函数返回非 null 时，前者必为 null。
 */
export async function resolveNetworkInput(song: SongLike | null | undefined): Promise<NetworkInput | null> {
  if (!song) return null;

  // ---- 分支 A：web 行（插件 / 在线源）----
  if ((song.type || "local") === "web") {
    // 已缓存到本地 → 不是网络源（出流直接读盘）。
    if (song.cachePath && existsSync(song.cachePath)) return null;
    const headers: Record<string, string> = {};
    try {
      Object.assign(headers, JSON.parse(song.streamHeaders || "{}"));
    } catch {
      /* 头解析失败按无头处理 */
    }
    let url: string | null = song.url || null;
    if (!url) {
      // 空直链 web 行（纯核实源导入）：兜底解析，解析不出就没有可用源。
      const { resolveEmptyUrlStream } = await import("./online/streamFallback.js");
      url = await resolveEmptyUrlStream(song as any);
    }
    return url ? { url, headers } : null;
  }

  // ---- 分支 B：WebDAV 行（path 前缀 `w:`）----
  const parsed = parseSongPath(song.path || "");
  if (!parsed || parsed.type !== "w") return null;
  const source = db.select().from(mediaSources).where(eq(mediaSources.id, parsed.sourceId)).get();
  if (!source) return null;
  const config = JSON.parse(source.config || "{}");
  const url = getWebDAVUrl(config, parsed.filePath);
  const headers: Record<string, string> = {};
  if (config.username && config.password) {
    headers["Authorization"] = "Basic " + Buffer.from(`${config.username}:${config.password}`).toString("base64");
  }
  return { url, headers };
}

/** 该行是否走网络源（= 是否值得后台预缓冲）。本地直读行一律 false。 */
export async function isNetworkSong(song: SongLike | null | undefined): Promise<boolean> {
  if (!song) return false;
  if ((song.type || "local") === "web") {
    if (song.cachePath && existsSync(song.cachePath)) return false;
    return true;
  }
  const parsed = parseSongPath(song.path || "");
  return !!parsed && parsed.type === "w";
}
