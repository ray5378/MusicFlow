// ==================== Auto-match unmatched playlist tracks via online source ====================
//
// For playlist entries that couldn't be matched to the local library
// (songId=null, playable=0, "曲库中未找到"), search the configured online source
// provider (go-music-dl), import the best hit as an online DB song (type="web"),
// then link it back to the playlist entry so it becomes playable.

import { db, sqlite } from "../../../db/index.js";
import { playlistSongs } from "../../../db/schema.js";
import { eq } from "drizzle-orm";
import { refreshPlaylistCounts, normalizeTitleStrict } from "../../plugin/shared.js";
import { batchConcurrency, sleepBetweenBatch } from "../../plugin/batchPacer.js";
import { runCoverBackfill } from "../../covers.js";
import { OnlineSongResult } from "./types.js";
import { importOnlineSong, importOnlineSongs } from "./service.js";

export interface MatchTarget {
  entryId: number;
  title: string;
  artist: string;
  album?: string;
  duration?: number; // ms
  /** 已知平台 id(source:id 形式,如 "netease:123456")。存在时直通导入,免在线搜索。 */
  externalSongId?: string;
}

export interface MatchOutcome {
  entryId: number;
  title: string;
  status: "matched" | "no-match" | "error";
  songId?: string;
  matchedSource?: string;
  matchedName?: string;
  message?: string;
}

// Normalize artist into a set of tokens: go-music-dl returns combined artists
// ("周杰伦、温岚、吴宗宪") while the wanted track may be just "周杰伦".
function artistTokens(artist: string): string[] {
  return (artist || "")
    .split(/[/、&,；;，.&]|feat\.|ft\./i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 已知平台 id 直通(免搜索)。
 *
 * 外置插件(go-music-dl 私人歌单等)写入的外部条目 external_song_id 形如
 * "netease:123456"(source:平台歌曲 id)——该 id 本就来自上游歌单页面,可直接
 * 构造歌曲记录交给 importOnlineSongs(与平台推荐 Path A 同路径)导入,无需按
 * 「歌名+歌手」重新在线搜索。修复前 auto-match 对每一首占位都发一次
 * /music/search(8587 首 = 8587 次冗余网络往返,CPU 平均 57%、全程 1~2 小时),
 * 直通后秒级完成、零冗余请求。
 *
 * 无法解析(非 source:id 格式、source 非法字符、id 为空)时返回 null,调用方
 * 回退在线搜索,行为与修复前一致。
 */
export function onlineSongFromExternalId(entry: {
  externalSongId?: string | null;
  externalTitle?: string | null;
  externalArtist?: string | null;
  externalAlbum?: string | null;
  externalDuration?: number | null;
}): OnlineSongResult | null {
  const raw = String(entry.externalSongId || "");
  const colon = raw.indexOf(":");
  if (colon <= 0) return null;
  const source = raw.slice(0, colon).trim();
  const id = raw.slice(colon + 1).trim();
  // source 与 id 都必须是字母数字 _ -(平台 slug / 平台歌曲 id 均如此)——避免把
  // 任意字符串(URL、含空格的描述串等)误当 source:id 而构造出无法流式播放的歌曲。
  if (!/^[a-zA-Z0-9_-]+$/.test(source) || !/^[a-zA-Z0-9_-]+$/.test(id)) return null;
  return {
    id,
    source,
    name: String(entry.externalTitle || ""),
    artist: String(entry.externalArtist || ""),
    album: String(entry.externalAlbum || ""),
    duration: (entry.externalDuration || 0) / 1000, // ms → 秒
    cover: "",
  };
}

// Score a provider candidate against a wanted track. Higher is better.
function scoreCandidate(cand: OnlineSongResult, t: MatchTarget): number {
  let score = 0;

  // 歌名严格对齐:只保留中英文归一后的全串相等(后缀原样保留,有后缀只能配带相同
  // 后缀、无后缀只能配无后缀),仅大小写/符号/空白/全角半角放宽。
  const titleStrict = normalizeTitleStrict(cand.name) === normalizeTitleStrict(t.title || "");
  if (titleStrict) score += 20;

  const wantArtists = artistTokens(t.artist);
  const candArtists = artistTokens(cand.artist);
  if (wantArtists.length > 0) {
    const allMatch = wantArtists.every((a) =>
      candArtists.some((ca) => a === ca || a.includes(ca) || ca.includes(a)));
    if (allMatch) score += 8;
    else {
      const first = wantArtists[0];
      if (candArtists.some((ca) => first === ca || first.includes(ca) || ca.includes(first))) score += 4;
    }
  }

  // externalDuration is in ms; cand.duration is in seconds.
  if (t.duration && cand.duration) {
    const diff = Math.abs(cand.duration * 1000 - t.duration);
    if (diff < 5000) score += 10;
    else if (diff < 15000) score += 5;
  }

  return score;
}

/**
 * Link a previously-unmatched playlist entry to an online song and refresh that
 * playlist's display counts.
 */
function linkPlaylistEntry(playlistId: string, entryId: number, songId: string) {
  db.update(playlistSongs)
    .set({ songId, playable: 1, unavailableReason: null })
    .where(eq(playlistSongs.id, entryId))
    .run();
  // 共享宿主服务(playlistSync 导出的单聚合查询实现),与导入/插件歌单计数一致。
  refreshPlaylistCounts(playlistId);
}

/**
 * 搜索结果缓存条目(searchBestMatch 复用)。key 由 (title,artist) 归一化得出。
 * 同一歌单内的重复标题/歌手(同专辑多曲、不同 source id 的同一首歌)不必重复
 * 在线搜索——命中直接沿用 first 结果,省下网络往返与搜索打分 CPU。
 */
export interface SearchMatchCache {
  status: "matched" | "no-match" | "error";
  best?: OnlineSongResult;
  score?: number;
  message?: string;
}

/**
 * 搜索 + 打分选 best(不落库)。供批量匹配(两阶段:先搜索收集,后批量导入)
 * 与单首实时匹配(match-track)复用——批量场景下避免逐首导入带来的
 * 每首独立计数刷新 + 独立去重查询(DB 阻塞放大)。
 *
 * @param cache 批内可选结果缓存(按 (title,artist) 归一化 key 记忆)。传入时,
 *              同一歌单内重复的标题重复搜索直接复用首次结果;未传则每次真实搜索
 *              (单首实况匹配路径,保持原行为)。缓存只记忆资源结果,不记忆 DB 产物。
 */
export async function searchBestMatch(
  providerId: string,
  config: any,
  provider: any,
  want: MatchTarget,
  cache?: Map<string, SearchMatchCache>,
): Promise<{ entryId: number; title: string; status: "matched" | "no-match" | "error"; best?: OnlineSongResult; score?: number; message?: string }> {
  // P0 直通已在上层(onlineSongFromExternalId)拦截;到这里的都是需要服务端搜索的。
  const cacheKey = cache ? `${normalizeTitleStrict(want.title)}|${normalizeTitleStrict(want.artist || "")}` : "";
  if (cache && cache.has(cacheKey)) {
    const hit = cache.get(cacheKey)!;
    return { entryId: want.entryId, title: want.title, status: hit.status, best: hit.best, score: hit.score, message: hit.message };
  }

  const query = [want.title, want.artist].filter(Boolean).join(" ").trim();
  if (!query) return { entryId: want.entryId, title: want.title, status: "no-match", message: "缺少歌曲标题" };
  if (!provider.search) return { entryId: want.entryId, title: want.title, status: "error", message: "provider 不支持搜索" };

  const search = await provider.search(config, { query });
  if (!search.songs.length) return { entryId: want.entryId, title: want.title, status: "no-match", message: "未搜索到结果" };

  const ranked = search.songs
    .map((s: OnlineSongResult) => ({ s, score: scoreCandidate(s, want) }))
    .sort((a: { score: number }, b: { score: number }) => b.score - a.score);

  const best = ranked[0]!;
  // Only auto-link when the title strictly matched (skip <15 即标题未全串对齐);
  // a pure artist-with-different-song hit is too risky to auto-bind.
  // 收紧两层:① 歌名只保留中英文归一后必须「全串相等」(后缀原样保留,有后缀只能配
  // 带相同后缀、无后缀只能配无后缀);② 期望曲带歌手时,候选歌手必须与期望首位歌手
  // 一致——否则同歌名异歌手/同后缀异歌名的结果会被误绑为「同名异曲」。
  const wantArtists = artistTokens(want.artist);
  const titleOk = best.s.name != null &&
    normalizeTitleStrict(best.s.name) === normalizeTitleStrict(want.title || "");
  const primary = wantArtists[0] || "";
  const artistOk = !primary || artistTokens(best.s.artist || "")
    .some((ca) => primary === ca || primary.includes(ca) || ca.includes(primary));
  if (best.score < 15 || !titleOk || !artistOk) {
    const out = { entryId: want.entryId, title: want.title, status: "no-match" as const, message: `未可靠匹配(${best.s.name})` };
    if (cache) cache.set(cacheKey, { status: "no-match", message: out.message });
    return out;
  }
  const out = { entryId: want.entryId, title: want.title, status: "matched" as const, best: best.s, score: best.score };
  if (cache) cache.set(cacheKey, { status: "matched", best: best.s, score: best.score });
  return out;
}

// Attempt to match a single unmatched track via the online provider, importing
// the best hit and linking it to that playlist entry.
export async function matchToOnlineSong(
  providerId: string,
  config: any,
  provider: any,
  playlistId: string,
  want: MatchTarget,
): Promise<MatchOutcome> {
  try {
    // P0:已知 source:id 直通(与批量 auto-match 同路径)——id 本就来自上游歌单,
    // 免一次 /music/search 往返,避免「已知答案却再搜一遍」的浪费。
    const known = onlineSongFromExternalId(want);
    const m = known
      ? { entryId: want.entryId, title: want.title, status: "matched" as const, best: known, score: 100 }
      : await searchBestMatch(providerId, config, provider, want);
    if (m.status !== "matched" || !m.best) {
      return { entryId: want.entryId, title: want.title, status: m.status, message: m.message };
    }
    const res = await importOnlineSong(providerId, m.best, {});
    if (!res.success || !res.songId) {
      return { entryId: want.entryId, title: want.title, status: "error", message: res.error || "导入失败" };
    }
    linkPlaylistEntry(playlistId, want.entryId, res.songId);
    void runCoverBackfill([res.songId]).catch(() => {});
    return {
      entryId: want.entryId, title: want.title, status: "matched", songId: res.songId,
      matchedSource: m.best.source, matchedName: m.best.name,
      message: res.deduped ? "已导入(去重)" : "已导入",
    };
  } catch (e: any) {
    return { entryId: want.entryId, title: want.title, status: "error", message: e.message || "匹配失败" };
  }
}

/**
 * Match all currently-unmatched entries of a playlist through the online provider.
 * Works for any playlist with loose (external) entries, imported or not.
 *
 * 两阶段(P0 优化,解决「导入时前台卡死」)+ 节流(P0/P1/P2 批量节拍器):
 *   阶段1 搜索+打分(不落库),每 10 首 sleepBetweenBatch()——主动睡眠让 CPU 真正
 *         空闲(区别于 setImmediate 只让事件循环插空),前台请求(播放器轮询/stream/
 *         歌单加载)有喘息;并发走 batchConcurrency()(档位 + ELD 自适应);
 *   阶段2 批量导入所有命中(importOnlineSongs:批量 dedup + 计数集合去重刷新一次)
 *         + 事务批量链接条目(每 TX_CHUNK 首一个事务,锁粒度更细)+ 歌单计数刷新
 *         一次——DB 阻塞从「每首 5-8 次」降到「整歌单一次」,封面下载走全局限流。
 *   全局闸(acquireBatchLock): 由调用方(jobRunner / auto-match)持有,保证全进程
 *         同时只跑 1 个批量任务,消除多任务叠加。
 */

export async function matchUnmatchedPlaylistEntries(
  providerId: string,
  config: any,
  provider: any,
  playlistId: string,
  onProgress?: (done: number, total: number, outcome: MatchOutcome) => void,
): Promise<{ total: number; matched: number; noMatch: number; error: number; results: MatchOutcome[] }> {
  const entries = db.select().from(playlistSongs)
    .where(eq(playlistSongs.playlistId, playlistId))
    .all()
    .filter((e) => !e.playable && !e.songId && (e.externalTitle || "").trim());

  const results: MatchOutcome[] = new Array(entries.length);
  const matchedByEntry = new Map<number, { best: OnlineSongResult; fp: string; title: string }>();
  let next = 0;
  let done = 0;
  let noMatch = 0, error = 0;

  // ---- 阶段1:并发搜索 + 打分(不落库),每 10 首让行 ----
  // P0:有 source:id 的条目直通(构造歌曲,免搜索),只有真正需要搜索的才计入节流。
  // 批内结果缓存:同一歌单里重复 (title,artist)(同专辑多曲、多 source id 的同一首)
  // 只发一次真实在线搜索,后续命中直接沿用 first 结果(截断重复网络往返 + 打分 CPU)。
  const searchCache = new Map<string, SearchMatchCache>();
  let searchedSinceSleep = 0;
  const worker = async () => {
    while (next < entries.length) {
      const i = next++;
      const e = entries[i];
      const target: MatchTarget = {
        entryId: e.id,
        title: e.externalTitle || "",
        artist: e.externalArtist || "",
        album: e.externalAlbum || undefined,
        duration: e.externalDuration || undefined,
        externalSongId: e.externalSongId || undefined,
      };
      const known = onlineSongFromExternalId(e);
      let m: { entryId: number; title: string; status: "matched" | "no-match" | "error"; best?: OnlineSongResult; score?: number; message?: string };
      if (known) {
        m = { entryId: target.entryId, title: target.title, status: "matched", best: known, score: 100 };
      } else {
        m = await searchBestMatch(providerId, config, provider, target, searchCache);
        // 节流:每 10 首主动睡眠(batchPacer:档位 + ELD 自适应),让 CPU 真正空闲,
        // 前台轮询/stream 有喘息;全速档 sleepMs=0 即退回旧行为。仅对真实网络搜索节流。
        searchedSinceSleep++;
        if (searchedSinceSleep % 10 === 0) await sleepBetweenBatch();
      }
      if (m.status === "matched" && m.best) {
        matchedByEntry.set(e.id, { best: m.best, fp: `${providerId}:${m.best.source}:${m.best.id}`, title: target.title });
        results[i] = { entryId: target.entryId, title: target.title, status: "matched", matchedSource: m.best.source, matchedName: m.best.name, message: known ? "已知平台id直通" : "搜索命中,待导入" };
      } else {
        results[i] = { entryId: target.entryId, title: target.title, status: m.status, message: m.message };
        if (m.status === "no-match") noMatch++;
        else error++;
      }
      done++;
      onProgress?.(done, entries.length, results[i]);
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(batchConcurrency(), entries.length)) }, () => worker());
  await Promise.all(workers);

  // ---- 阶段2:批量导入所有命中(批量 dedup + 计数去重刷新一次)+ 分块事务链接 ----
  let matched = 0;
  if (matchedByEntry.size > 0) {
    const imp = await importOnlineSongs(providerId, Array.from(matchedByEntry.values()).map((v) => v.best), {});
    const byFp = new Map<string, string>();
    for (const s of imp.songs) byFp.set(s.fingerprint, s.id);

    // 只保留真正链接成功的 (entryId → songId) 对(byFp 命中的)。
    const linkPairs = Array.from(matchedByEntry.entries())
      .map(([entryId, v]) => ({ entryId, songId: byFp.get(v.fp) }))
      .filter((x): x is { entryId: number; songId: string } => !!x.songId);
    matched = linkPairs.length;

    // 分块事务链接:每块用【单条 CASE UPDATE】替掉逐 entry 的 N 次 UPDATE(prepare+run
    // 每次),块提交避免超大歌单单事务持锁时间过长。块间主动睡眠节流。
    const TX_CHUNK = 200;
    for (let off = 0; off < linkPairs.length; off += TX_CHUNK) {
      const chunk = linkPairs.slice(off, off + TX_CHUNK);
      sqlite.transaction(() => {
        const ids = chunk.map((c) => c.entryId);
        const idPh = ids.map(() => "?").join(",");
        const songCases = chunk.map(() => "WHEN ? THEN ?").join(" ");
        const songArgs: any[] = [];
        for (const c of chunk) songArgs.push(c.entryId, c.songId);
        // CASE id WHEN entry THEN song END → 每行写回各自 song_id;WHERE id IN 限定本块,
        // 未命中分支的 id 不会出现在 IN 内,因此 ELSE 分支不会被走到(缺省为 NULL 也无妨)。
        sqlite
          .prepare(`UPDATE playlist_songs SET song_id = CASE id ${songCases} END, playable = 1, unavailable_reason = NULL WHERE id IN (${idPh})`)
          .run(...songArgs, ...ids);
      })();
      if (off + TX_CHUNK < linkPairs.length) await sleepBetweenBatch();
    }
    // 歌单计数整单刷新一次(替代每首刷新)。
    refreshPlaylistCounts(playlistId);

    // 回填 results(按 entries 顺序,entryId 关联)。
    for (let i = 0; i < entries.length; i++) {
      const v = matchedByEntry.get(entries[i].id);
      if (!v) continue;
      const songId = byFp.get(v.fp);
      if (songId) {
        results[i] = { entryId: entries[i].id, title: v.title, status: "matched", songId, matchedSource: v.best.source, matchedName: v.best.name, message: "已导入" };
      } else {
        results[i] = { entryId: entries[i].id, title: v.title, status: "error", message: "批量导入失败" };
        error++;
      }
    }

    // 封面回填由 importOnlineSongs 内部统一触发(见 service.ts);此处不再重复。
  }

  return { total: results.length, matched, noMatch, error, results };
}