// 封面按需获取服务。
// 链路:歌曲无封面(cover_art 空)且 A(cover.onDemand,默认开)时,
//   经 coverProvider 插件(searchCover,独立选源 cover.providerId)拿到封面 URL,
//   用 cacheRemoteCover 下载缓存成本地文件,返回本地文件引用;
//   B(cover.persist,默认开)时把引用写回 songs.cover_art,一次落库永久命中。
// 防风暴(getCoverArt 是高频端点):每首歌在一次失败后,短 TTL 内不再重复触发;
//   批量补全(C)用 force 绕过该门控,但自身节流。
import { db, sqlite } from "../db/index.js";
import { songs } from "../db/schema.js";
import { inArray } from "drizzle-orm";
import { hasCoverProvider, searchCover } from "../plugins/providers.js";
import { cacheRemoteCover } from "./playlistCover.js";
import { getSettingBool } from "./settings.js";

export interface CoverSongInput {
  id: string;
  title: string;
  artist?: string | null;
  album?: string | null;
  duration?: number | null;
  coverArt?: string | null;
}

const ATTEMPT_TTL = 10 * 60 * 1000; // 10 分钟内同一首歌失败后不再自动重试
const attempts = new Map<string, number>();

// 失败标记的 TTL 清扫:entries 只在成功时被删(clearCoverAttempt),失败的歌会
// 一直留在 map 里。周期扫掉过期项,避免随失败歌曲数量无界增长(歌词缓存同款)。
const attemptsSweep = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) {
    if (now - v >= ATTEMPT_TTL) attempts.delete(k);
  }
}, 5 * 60 * 1000);
(attemptsSweep as any).unref?.();

// 封面下载全局限流(≤2 并发):批量导入/回填时避免叠加造成网络洪峰
// (前台 stream/轮询请求被挤占)。全局信号量,所有封面下载共用。
const COVER_CONCURRENCY_LIMIT = 2;
let coverInflight = 0;
const coverWaiters: (() => void)[] = [];
/** 封面下载/封面补全全局信号量(≤2 并发),供导入与后台封面回填共用。 */
export async function withCoverLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (coverInflight >= COVER_CONCURRENCY_LIMIT) {
    await new Promise<void>((resolve) => coverWaiters.push(resolve));
  }
  coverInflight++;
  try {
    return await fn();
  } finally {
    coverInflight--;
    coverWaiters.shift()?.();
  }
}

/** 记录一次"已尝试"：force(批量补全)不记,避免污染按需门控语义。 */
function markAttempt(songId: string, force: boolean) {
  if (!force) attempts.set(songId, Date.now());
}

/** 清除某首歌的尝试记录(供测试/重试)。 */
export function clearCoverAttempt(songId: string): void {
  attempts.delete(songId);
}

/**
 * 按需获取一首歌的封面。返回可直接喂给 resolveCoverFile 的本地文件引用,
 * 或 null(无封面/未启用/获取失败)。
 * @param force 批量补全(C)传 true:绕过"已尝试"门控,但仍按 A/persist 开关执行。
 */
export async function fetchCoverForSong(song: CoverSongInput, force = false): Promise<string | null> {
  if (!song?.id || !song?.title) return null;

  // 已有封面(本地内嵌/之前落库)→ 直接用
  if (song.coverArt) return song.coverArt;

  // 防风暴:失败后 TTL 内不再自动重试
  const last = attempts.get(song.id);
  if (!force && last && Date.now() - last < ATTEMPT_TTL) return null;

  // A 开关 + 存在启用的 coverProvider
  if (!getSettingBool("cover.onDemand", true) || !hasCoverProvider()) return null;

  let url: string | null = null;
  try {
    url = await searchCover({
      title: song.title,
      artist: song.artist || undefined,
      album: song.album || undefined,
      duration: song.duration ?? undefined,
    });
  } catch {
    url = null;
  }

  if (!url) {
    markAttempt(song.id, force);
    return null;
  }

  // 下载缓存成本地文件(引用形如 <songId>.jpg,与 deleteSongCover 约定一致)
  const ref = await cacheRemoteCover(url, song.id);
  if (!ref) {
    markAttempt(song.id, force);
    return null;
  }

  // B 落库:写回 cover_art,一次下载永久命中
  if (getSettingBool("cover.persist", true)) {
    try { sqlite.prepare("UPDATE songs SET cover_art = ? WHERE id = ?").run(ref, song.id); } catch { /* ignore */ }
  }
  return ref;
}

/**
 * 后台封面回填:导入/链接的歌曲若缺封面,经 coverProvider 插件按歌名搜索
 * 补齐并落库。全局限流(≤2 并发,与导入共用 withCoverLimit),不阻塞导入。
 * 无 coverProvider(如测试环境)或无可补歌曲时立即返回。
 * @returns { ok, fail } 命中并落库 / 未取到封面的数量。
 */
export async function runCoverBackfill(songIds: string[]): Promise<{ ok: number; fail: number }> {
  if (!hasCoverProvider() || songIds.length === 0) return { ok: 0, fail: 0 };
  const targets = db.select().from(songs).where(inArray(songs.id, songIds)).all()
    .filter((s: any) => !s.coverArt);
  if (targets.length === 0) return { ok: 0, fail: 0 };
  let next = 0;
  let ok = 0;
  let fail = 0;
  const worker = async () => {
    while (next < targets.length) {
      const s = targets[next++];
      try {
        const ref = await withCoverLimit(() => fetchCoverForSong(s, true));
        if (ref) ok++; else fail++;
      } catch {
        fail++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, targets.length) }, () => worker()));
  return { ok, fail };
}
