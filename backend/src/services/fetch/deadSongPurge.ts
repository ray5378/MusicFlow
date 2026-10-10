// ==================== 死链清理（永久失效的网络歌曲移出曲库）====================
//
// 产品定调（2026-10-11）：一首网络歌连续 N 轮下载都以「资源不存在类」原因失败
// （见 attempts.ts PERMANENT_FAILURE_CODES），说明它在源站确实拿不到 —— 既下不下来，
// 在线播放也播不了。此时把它从曲库移除，比让它永远躺在库里反复占用下载额度更有价值。
//
// 三条安全边界（**任一条被破坏都会造成不可逆的用户数据损失**）：
//
//   1) 只动 `type='web'` 的行。本地（local）/ WebDAV（webdav）行背后有实体文件，
//      下载失败不代表文件坏了（可能只是洗版失败），必须原样保留。
//
//   2) **先转未匹配，再删 songs 行** —— 顺序不可颠倒。歌单条目转未匹配时要用
//      songs 行里的 title/artist/album/duration 回填 `external_*` 快照，行一旦先删，
//      快照就永久丢失，歌单里只剩下「未知歌曲」，将来重新匹配也无从下手。
//      转完（song_id 置 NULL + playable=0 + 写明 unavailable_reason）再删行，
//      歌单条目本身**保留**，只是变成未匹配状态。
//
//   3) 单轮删除量设上限（MAX_PURGE_PER_RUN）。若某次源站大面积故障导致大批歌同时
//      攒够阈值，上限保证不会一次清空曲库，剩下的留到下一轮，给人留出反应时间。
//
// 与 purge.ts（按年龄 + 无引用清理web歌）的分工：那个是「过期轮转」，本模块是
// 「确认死亡」；两者互不干扰，但都会保护 playable 的歌单条目（前者直接跳过有引用的）。

import { sqlite } from "../../db/index.js";
import { createLogger } from "../../utils/logger.js";
import { deleteAnalysis } from "../audio/analysisStore.js";
import { deleteSongCover } from "../playlistCover.js";
import { deleteSongLyric } from "../lyricsStore.js";
import { cleanupOrphans } from "../source/scanner.js";
import type { FetchConfig } from "./config.js";
import {
  clearDownloadAttempt,
  effectiveDeadSongPurgeThreshold,
  listPermanentFailureKeys,
} from "./attempts.js";

const log = createLogger("dead-song-purge");

/** 单轮最多移除多少首（防「源站大面积故障 → 一次清空曲库」）。 */
export const MAX_PURGE_PER_RUN = 200;

/** 写入 `playlist_songs.unavailable_reason` 的文案。
 *
 *  与 playlistSync.ts 的「曲库中未找到」同口径：这里也是**直接落库的自由文本**，
 *  前端 SongTable 直接读出来当 tooltip 显示。带上原因码，用户能一眼看出死因。 */
export function deadSongUnavailableReason(errorCode: string | null): string {
  return errorCode
    ? `下载永久失败（${errorCode}），已从曲库移除`
    : "下载永久失败，已从曲库移除";
}

/**
 * 把引用该歌的歌单条目转成「未匹配」，返回改动的条目数。
 *
 * 用 COALESCE 保护已有快照：条目若本就带着 external_*（导入时写下的），不改写；
 * 只有缺失的列才用 songs 行回填 —— 所以**调用时必须 songs 行还在**。
 */
const MATCH_REASON_SQL = `UPDATE playlist_songs
   SET song_id            = NULL,
       playable           = 0,
       unavailable_reason = ?,
       external_title     = COALESCE(external_title,    (SELECT title    FROM songs WHERE id = ?)),
       external_artist    = COALESCE(external_artist,   (SELECT artist   FROM songs WHERE id = ?)),
       external_album     = COALESCE(external_album,    (SELECT album    FROM songs WHERE id = ?)),
       external_duration  = COALESCE(external_duration, (SELECT duration FROM songs WHERE id = ?))
 WHERE song_id = ?`;

export interface DeadSongPurgeDetail {
  songId: string;
  title: string;
  errorCode: string | null;
  failCount: number;
  playlistEntries: number;
}

export interface DeadSongPurgeResult {
  /** 配置里关闭清理时为 false（其余计数全 0）。 */
  enabled: boolean;
  threshold: number;
  /** 台账里达到阈值的键数（未过滤 type）。 */
  candidates: number;
  /** 实际从曲库移除的歌曲数。 */
  purged: number;
  /** 因不是 web 行被跳过的数（本地/WebDAV 实体文件受保护）。 */
  skippedLocal: number;
  /** 因单轮上限被推迟到下一轮的数。 */
  deferred: number;
  /** 转成未匹配的歌单条目数。 */
  playlistEntries: number;
  /** 顺带清掉的文件（封面/歌词）。 */
  covers: number;
  lyrics: number;
  errors: number;
  details: DeadSongPurgeDetail[];
}

/** 空结果（关闭 / 无候选时复用）。 */
function emptyResult(enabled: boolean, threshold: number): DeadSongPurgeResult {
  return {
    enabled,
    threshold,
    candidates: 0,
    purged: 0,
    skippedLocal: 0,
    deferred: 0,
    playlistEntries: 0,
    covers: 0,
    lyrics: 0,
    errors: 0,
    details: [],
  };
}

/**
 * 把达到永久失效阈值的网络歌曲移出曲库（并把歌单条目转未匹配）。
 *
 * 幂等：清理成功的键会从台账删除，重入不会重复处理；失败的下轮再来。
 * `cfg.deadSongPurgeThreshold` 为 0 时整体关闭。
 */
export function purgeDeadSongs(cfg: FetchConfig): DeadSongPurgeResult {
  const threshold = effectiveDeadSongPurgeThreshold(cfg);
  if (threshold < 1) return emptyResult(false, threshold);

  const keys = listPermanentFailureKeys(threshold);
  if (keys.length === 0) return emptyResult(true, threshold);

  const result = emptyResult(true, threshold);
  result.candidates = keys.length;

  const pickRow = sqlite.prepare(
    `SELECT id, title, type FROM songs WHERE id = ?`,
  );
  const delFavorites = sqlite.prepare(`DELETE FROM user_favorite_songs WHERE song_id = ?`);
  const delHistory = sqlite.prepare(`DELETE FROM play_history WHERE song_id = ?`);
  const delSong = sqlite.prepare(`DELETE FROM songs WHERE id = ?`);

  for (const { songKey, errorCode, failCount } of keys) {
    if (result.purged >= MAX_PURGE_PER_RUN) {
      result.deferred = keys.length - result.purged - result.skippedLocal - result.errors;
      if (result.deferred < 0) result.deferred = 0;
      log.warn(`单轮上限 ${MAX_PURGE_PER_RUN} 已达，剩余 ${result.deferred} 首推迟到下一轮`);
      break;
    }
    if (!songKey) continue;

    try {
      const row = pickRow.get(songKey) as { id?: string; title?: string; type?: string } | undefined;
      if (!row?.id) {
        // songs 行已不在（用户手动删过 / 上次清理的残留）→ 台账行没意义了，清掉。
        clearDownloadAttempt(songKey);
        continue;
      }
      if (row.type !== "web") {
        // 安全边界 1：本地 / WebDAV 行背后有实体文件，绝不由下载流程删除。
        // 台账行照样清掉 —— 它不该是死链清理的候选，留着只会每轮重复扫到。
        clearDownloadAttempt(songKey);
        result.skippedLocal++;
        continue;
      }

      const songId = String(row.id);
      const reason = deadSongUnavailableReason(errorCode);

      // FK-first：audio_analysis.row_id 有 FK 无 CASCADE，必须先于 songs 行删除。
      // 放在事务外 —— deleteAnalysis 自带事务，嵌套会抛「cannot start a transaction
      // within a transaction」。万一随后事务失败，只会留下「无测量的歌」，无害。
      try {
        deleteAnalysis(songId);
      } catch (e) {
        log.warn(`删音频分析失败（忽略，不影响移除）`, { songId, err: msg(e) });
      }

      const tx = sqlite.transaction(() => {
        // 安全边界 2：转未匹配必须发生在删行之前（要用 songs 行回填 external_* 快照）。
        const upd = sqlite
          .prepare(MATCH_REASON_SQL)
          .run(reason, songId, songId, songId, songId, songId);
        const playlistEntries = Number(upd.changes ?? 0);
        delFavorites.run(songId);
        delHistory.run(songId);
        const del = delSong.run(songId);
        sqlite.prepare(`DELETE FROM fetch_download_attempts WHERE song_key = ?`).run(songId);
        return { playlistEntries, removed: Number(del.changes ?? 0) };
      });
      const { playlistEntries, removed } = tx();

      if (removed > 0) {
        result.purged++;
        result.playlistEntries += playlistEntries;
        result.details.push({
          songId,
          title: String(row.title ?? ""),
          errorCode,
          failCount,
          playlistEntries,
        });
        // 文件清理放在事务提交之后（DB 已一致，文件删失败只是留垃圾，不影响正确性）。
        try {
          result.covers += deleteSongCover(songId);
          result.lyrics += deleteSongLyric(songId);
        } catch (e) {
          log.warn(`删封面/歌词文件失败（忽略）`, { songId, err: msg(e) });
        }
      }
    } catch (e) {
      result.errors++;
      log.error(`移除死链失败`, { songKey, err: msg(e) });
    }
  }

  if (result.purged > 0) {
    try {
      cleanupOrphans();
    } catch (e) {
      log.warn(`清理孤立专辑/艺人失败（忽略）`, { err: msg(e) });
    }
    log.info(
      `[dead-song-purge] 移除 ${result.purged} 首（歌单转未匹配 ${result.playlistEntries} 条，` +
        `跳过本地 ${result.skippedLocal}，推迟 ${result.deferred}，失败 ${result.errors}，` +
        `封面 ${result.covers}，歌词 ${result.lyrics}）`,
    );
  }

  return result;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
