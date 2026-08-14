// ==================== Auto-match unmatched playlist tracks via online source ====================
//
// For playlist entries that couldn't be matched to the local library
// (songId=null, playable=0, "曲库中未找到"), search the configured online source
// provider (go-music-dl), import the best hit as an online DB song (type="web"),
// then link it back to the playlist entry so it becomes playable.

import { db } from "../../../db/index.js";
import { playlistSongs } from "../../../db/schema.js";
import { eq } from "drizzle-orm";
import { normalizeKey, refreshPlaylistCounts } from "../../plugin/playlistSync.js";
import { OnlineSongResult } from "./types.js";
import { importOnlineSong } from "./service.js";

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

    const res = await importOnlineSong(providerId, best.s, {});
    if (!res.success || !res.songId) {
      return { entryId: want.entryId, title: want.title, status: "error", message: res.error || "导入失败" };
    }

    linkPlaylistEntry(playlistId, want.entryId, res.songId);

    return {
      entryId: want.entryId, title: want.title, status: "matched", songId: res.songId,
      matchedSource: best.s.source, matchedName: best.s.name,
      message: res.deduped ? "已导入(去重)" : "已导入",
    };
  } catch (e: any) {
    return { entryId: want.entryId, title: want.title, status: "error", message: e.message || "匹配失败" };
  }
}

/**
 * Match all currently-unmatched entries of a playlist through the online provider.
 * Works for any playlist with loose (external) entries, imported or not.
 * Runs with bounded concurrency (each entry is an HTTP search + import).
 */
const MATCH_CONCURRENCY = 4;

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
  let next = 0;
  let done = 0;
  let matched = 0, noMatch = 0, error = 0;

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
      const r = await matchToOnlineSong(providerId, config, provider, playlistId, target);
      results[i] = r;
      done++;
      if (r.status === "matched") matched++;
      else if (r.status === "no-match") noMatch++;
      else error++;
      onProgress?.(done, entries.length, r);
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(MATCH_CONCURRENCY, entries.length)) }, () => worker());
  await Promise.all(workers);

  return { total: results.length, matched, noMatch, error, results };
}