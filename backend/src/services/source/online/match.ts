// ==================== Auto-match unmatched playlist tracks via online source ====================
//
// For playlist entries that couldn't be matched to the local library
// (songId=null, playable=0, "曲库中未找到"), search the configured online source
// provider (go-music-dl), import the best hit as an online DB song (type="web"),
// then link it back to the playlist entry so it becomes playable.

import { db, sqlite } from "../../../db/index.js";
import { playlistSongs } from "../../../db/schema.js";
import { eq } from "drizzle-orm";
import { refreshPlaylistCounts, strictNormEquals } from "../../plugin/shared.js";
import { batchConcurrency, sleepBetweenBatch } from "../../plugin/batchPacer.js";
import { runCoverBackfill } from "../../covers.js";
import { OnlineSongResult } from "./types.js";
import { importOnlineSong, importOnlineSongs } from "./service.js";
import { passesImportGate } from "./importGate.js";

export interface MatchTarget {
  entryId: number;
  title: string;
  artist: string;
  album?: string;
  duration?: number; // ms
  // 注:曾有的 externalSongId(平台 id 直通)已废除——所有条目一律搜索+门禁交叉比对。
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
 * 已知平台 id 直通已废除(v2.3.0 导入命中门禁):
 * 上游歌单自带的 source:id 不再免搜索直接导入——元数据冒名的假源(合辑冒名
 * 翻唱等)正是经这条道混入库的(如 QQ 私人歌单里的《我们的歌》/K情歌 5)。
 * 现在所有条目一律经在线搜索 + 导入命中门禁(passesImportGate)交叉比对,
 * 搜不到全命中候选就保持未匹配占位,绝不落库。
 */

// Score a provider candidate against a wanted track. Higher is better.
function scoreCandidate(cand: OnlineSongResult, t: MatchTarget): number {
  let score = 0;

  // 歌名严格对齐:只保留中英文归一后的全串相等(后缀原样保留,有后缀只能配带相同
  // 后缀、无后缀只能配无后缀),仅大小写/符号/空白/全角半角放宽。
  // 假名/谚文/纯符号标题归一为空串,strictNormEquals 原文回退全等——否则任意
  // 两个非中英文标题会被判成相等(+20 分误匹配)。
  const titleStrict = strictNormEquals(cand.name, t.title || "");
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

  // 专辑软加分(仅排序用;硬门禁在 passesImportGate):同歌名同歌手多版本时,
  // 专辑一致者优先——减少「K情歌合辑」类冒名候选排在前面挤掉正版的机会。
  if (t.album && cand.album) {
    if (strictNormEquals(cand.album, t.album)) score += 6;
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
  // 缓存键用原文 trim+lowercase(不用 normalizeTitleStrict):假名/纯符号标题
  // 归一后全是空串,不同歌会共享同一缓存键导致跨歌错配;原文键永不碰撞。
  const cacheKey = cache ? `${String(want.title || "").trim().toLowerCase()}|${String(want.artist || "").trim().toLowerCase()}` : "";
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
  // 绑定门禁 = 导入命中门禁(passesImportGate):规范化标题 + 歌手(强制)+
  // 专辑一致(开关)+ 时长容差全命中才允许绑定/导入。此前只查标题全串相等 +
  // 首位歌手 + score≥15,专辑/时长无门禁,合辑冒名假源(标题/歌手/时长全对上)
  // 会被误绑——现统一收口到门禁,维度语义见 importGate.ts。
  const gate = passesImportGate(
    {
      title: want.title || "",
      artist: want.artist,
      album: want.album,
      duration: (want.duration || 0) / 1000, // ms → 秒
    },
    best.s,
  );
  if (!gate.ok) {
    const out = { entryId: want.entryId, title: want.title, status: "no-match" as const, message: `未通过导入门禁[${gate.reason}]:${gate.detail || ""}(最佳候选:${best.s.name})` };
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
    // 平台 id 直通已废除:一律走搜索 + 门禁交叉比对(假源正是从直通混入的)。
    const m = await searchBestMatch(providerId, config, provider, want);
    if (m.status !== "matched" || !m.best) {
      return { entryId: want.entryId, title: want.title, status: m.status, message: m.message };
    }
    const res = await importOnlineSong(providerId, m.best, { gate: "verified" });
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
  // 批内结果缓存:同一歌单里重复 (title,artist)(同专辑多曲、多 source id 的同一首)
  // 只发一次真实在线搜索,后续命中直接沿用 first 结果(截断重复网络往返 + 打分 CPU)。
  // 注意:平台 id 直通已废除——所有条目(含带 source:id 的)一律搜索 + 门禁交叉比对。
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
      };
      const m = await searchBestMatch(providerId, config, provider, target, searchCache);
      // 节流:每 10 首主动睡眠(batchPacer:档位 + ELD 自适应),让 CPU 真正空闲,
      // 前台轮询/stream 有喘息;全速档 sleepMs=0 即退回旧行为。
      searchedSinceSleep++;
      if (searchedSinceSleep % 10 === 0) await sleepBetweenBatch();
      if (m.status === "matched" && m.best) {
        matchedByEntry.set(e.id, { best: m.best, fp: `${providerId}:${m.best.source}:${m.best.id}`, title: target.title });
        results[i] = { entryId: target.entryId, title: target.title, status: "matched", matchedSource: m.best.source, matchedName: m.best.name, message: "搜索命中并通过导入门禁,待导入" };
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
    const imp = await importOnlineSongs(providerId, Array.from(matchedByEntry.values()).map((v) => v.best), { gate: "verified" });
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

/**
 * 上游歌单/整单导入的批量交叉比对(导入命中门禁第 4 条道)。
 *
 * 每日推荐同步、歌单/专辑搜索「加入库」等路径拿到的歌曲自带上游平台 id 与
 * 元数据,旧逻辑直接 importOnlineSongs 落库——元数据冒名的假源(如 QQ 私人
 * 歌单里的《我们的歌》/K情歌 5 合辑翻唱)正是经这条道混入库的。现改为:
 * 每首先按「标题+歌手」在线搜索,候选须通过导入命中门禁(passesImportGate),
 * 命中的以【搜索验证过的候选】导入(替换原上游对象),搜不到全命中候选则拒导。
 *
 * 性能:批内 (title,artist) 结果缓存(重复标题只搜一次)+ batchConcurrency 并发
 * + sleepBetweenBatch 节流,与 matchUnmatchedPlaylistEntries 同节奏。
 */
export async function crossVerifySongs(
  providerId: string,
  config: any,
  provider: any,
  songs: OnlineSongResult[],
  opts?: { interactive?: boolean },
): Promise<{ verified: OnlineSongResult[]; rejected: number }> {
  const verified: OnlineSongResult[] = [];
  let rejected = 0;
  if (!Array.isArray(songs) || songs.length === 0) return { verified, rejected };

  const cache = new Map<string, SearchMatchCache>();
  let next = 0;
  const worker = async () => {
    while (next < songs.length) {
      const i = next++;
      const s = songs[i]!;
      const m = await searchBestMatch(
        providerId,
        config,
        provider,
        {
          entryId: i,
          title: s.name || "",
          artist: s.artist || "",
          album: s.album || undefined,
          duration: s.duration ? Math.round(s.duration * 1000) : undefined, // 秒 → ms
        },
        cache,
      );
      if (m.status === "matched" && m.best) {
        verified.push(m.best);
      } else {
        rejected++;
      }
      // 节流:后台批量(每日推荐等)与 auto-match 同节奏(sleepBetweenBatch:档位 +
      // ELD 自适应);交互式导入(搜索加入库)走全速,不 sleep。
      if (!opts?.interactive) await sleepBetweenBatch();
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(batchConcurrency(), songs.length)) }, () => worker());
  await Promise.all(workers);
  return { verified, rejected };
}