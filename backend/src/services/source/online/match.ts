// ==================== Auto-match unmatched playlist tracks via online source ====================
//
// For playlist entries that couldn't be matched to the local library
// (songId=null, playable=0, "曲库中未找到"), search the configured online source
// provider (go-music-dl), import the best hit as an online DB song (type="web"),
// then link it back to the playlist entry so it becomes playable.

import { db, sqlite } from "../../../db/index.js";
import { playlistSongs } from "../../../db/schema.js";
import { eq } from "drizzle-orm";
import { normalizeKey, refreshPlaylistCounts } from "../../plugin/shared.js";
import { batchConcurrency, sleepBetweenBatch } from "../../plugin/batchPacer.js";
import { OnlineSongResult } from "./types.js";
import { importOnlineSong, importOnlineSongs } from "./service.js";

export interface MatchTarget {
  entryId: number;
  title: string;
  artist: string;
  album?: string;
  duration?: number; // ms
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

// Score a provider candidate against a wanted track. Higher is better.
function scoreCandidate(cand: OnlineSongResult, t: MatchTarget): number {
  let score = 0;

  const titleExact = cand.name.toLowerCase() === (t.title || "").toLowerCase();
  const titleNorm = normalizeKey(cand.name, "") === normalizeKey(t.title || "", "");
  if (titleExact) score += 20;
  else if (titleNorm) score += 15;

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
 * 搜索 + 打分选 best(不落库)。供批量匹配(两阶段:先搜索收集,后批量导入)
 * 与单首实时匹配(match-track)复用——批量场景下避免逐首导入带来的
 * 每首独立计数刷新 + 独立去重查询(DB 阻塞放大)。
 */
export async function searchBestMatch(
  providerId: string,
  config: any,
  provider: any,
  want: MatchTarget,
): Promise<{ entryId: number; title: string; status: "matched" | "no-match" | "error"; best?: OnlineSongResult; score?: number; message?: string }> {
  const query = [want.title, want.artist].filter(Boolean).join(" ").trim();
  if (!query) return { entryId: want.entryId, title: want.title, status: "no-match", message: "缺少歌曲标题" };
  if (!provider.search) return { entryId: want.entryId, title: want.title, status: "error", message: "provider 不支持搜索" };

  const search = await provider.search(config, { query });
  if (!search.songs.length) return { entryId: want.entryId, title: want.title, status: "no-match", message: "未搜索到结果" };

  const ranked = search.songs
    .map((s: OnlineSongResult) => ({ s, score: scoreCandidate(s, want) }))
    .sort((a: { score: number }, b: { score: number }) => b.score - a.score);

  const best = ranked[0]!;
  // Only auto-link when the title plausibly matched (score >= 15 from title);
  // a pure artist-with-different-song hit is too risky to auto-bind.
  if (best.score < 15) {
    return { entryId: want.entryId, title: want.title, status: "no-match", message: `未可靠匹配(${best.s.name})` };
  }
  return { entryId: want.entryId, title: want.title, status: "matched", best: best.s, score: best.score };
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
    const m = await searchBestMatch(providerId, config, provider, want);
    if (m.status !== "matched" || !m.best) {
      return { entryId: want.entryId, title: want.title, status: m.status, message: m.message };
    }
    const res = await importOnlineSong(providerId, m.best, {});
    if (!res.success || !res.songId) {
      return { entryId: want.entryId, title: want.title, status: "error", message: res.error || "导入失败" };
    }
    linkPlaylistEntry(playlistId, want.entryId, res.songId);
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
      };
      const m = await searchBestMatch(providerId, config, provider, target);
      if (m.status === "matched" && m.best) {
        matchedByEntry.set(e.id, { best: m.best, fp: `${providerId}:${m.best.source}:${m.best.id}`, title: target.title });
        results[i] = { entryId: target.entryId, title: target.title, status: "matched", matchedSource: m.best.source, matchedName: m.best.name, message: "搜索命中,待导入" };
      } else {
        results[i] = { entryId: target.entryId, title: target.title, status: m.status, message: m.message };
        if (m.status === "no-match") noMatch++;
        else error++;
      }
      done++;
      // 节流:每 10 首主动睡眠(batchPacer:档位 + ELD 自适应),让 CPU 真正空闲,
      // 前台轮询/stream 有喘息;全速档 sleepMs=0 即退回旧行为。
      if (done % 10 === 0) await sleepBetweenBatch();
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

    // 分块事务链接:每 TX_CHUNK 首一个事务提交(避免超大歌单单事务持锁时间过长,
    // 提交瞬间 CPU 高峰),块间同样主动睡眠节流。
    const TX_CHUNK = 200;
    const linkPairs = Array.from(matchedByEntry.entries());
    for (let off = 0; off < linkPairs.length; off += TX_CHUNK) {
      const chunk = linkPairs.slice(off, off + TX_CHUNK);
      sqlite.transaction(() => {
        for (const [entryId, v] of chunk) {
          const songId = byFp.get(v.fp);
          if (!songId) continue;
          db.update(playlistSongs)
            .set({ songId, playable: 1, unavailableReason: null })
            .where(eq(playlistSongs.id, entryId))
            .run();
        }
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
        matched++;
      } else {
        results[i] = { entryId: entries[i].id, title: v.title, status: "error", message: "批量导入失败" };
        error++;
      }
    }
  }

  return { total: results.length, matched, noMatch, error, results };
}