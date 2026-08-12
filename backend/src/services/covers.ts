// 封面按需获取服务。
// 链路:歌曲无封面(cover_art 空)且 A(cover.onDemand,默认开)时,
//   经 coverProvider 插件(searchCover,独立选源 cover.providerId)拿到封面 URL,
//   用 cacheRemoteCover 下载缓存成本地文件,返回本地文件引用;
//   B(cover.persist,默认开)时把引用写回 songs.cover_art,一次落库永久命中。
// 防风暴(getCoverArt 是高频端点):每首歌在一次失败后,短 TTL 内不再重复触发;
//   批量补全(C)用 force 绕过该门控,但自身节流。
import { sqlite } from "../db/index.js";
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
