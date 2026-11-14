// 学习记录的服务端权威写入(4.14.5)。
//
// 背景:学习进度原本只有客户端 PUT /v1/study/progress 一条写入口,投屏/群组/
// 网页控制等「服务端在播」的场景下,一旦控制端退出就没有记录。本模块让服务端
// 在播放推进时自己落库,记录仍按 userId 完全隔离(与接口写入同一套表)。
//
// 红线:
//   · 只旁路写库,任何异常吞掉,绝不打断播放;
//   · 只写 kind='study' 的歌曲,不写音乐播放历史;
//   · 高频位置回调按 (用户,歌曲) 节流,换曲/暂停/停止时由调用方 force 补报。
import { and, desc, eq, notInArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { playlists, playlistSongs, songs, studyProgress, studyPlaylistProgress } from "../../db/schema.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("study-progress");

/** 与 routes/api/study.ts 的保留上限保持一致。 */
const LIMIT = 50;
/** 同一用户同一首歌的位置写入最小间隔。 */
const THROTTLE_MS = 5_000;

const lastWriteAt = new Map<string, number>();

export interface StudyPlaybackSample {
  /** 记录归属用户(与接口上报同一口径,按用户隔离)。 */
  userId: string;
  songId: string;
  /** 当前曲内容秒(flow 设备已由调用方换算)。 */
  positionSec: number;
  durationSec: number;
  /** 学习歌单播放时传入,用于整单续播(study_playlist_progress)。 */
  playlistId?: string;
  /** 换曲/暂停/停止/清队列时的最后补报,跳过节流。 */
  force?: boolean;
}

/** 写入一条学习进度(同步、节流、永不抛)。 */
export function noteStudyPlayback(sample: StudyPlaybackSample): void {
  try {
    if (!sample.userId || !sample.songId) return;
    const key = `${sample.userId}:${sample.songId}`;
    const nowMs = Date.now();
    if (!sample.force && nowMs - (lastWriteAt.get(key) ?? 0) < THROTTLE_MS) return;

    const song = db.select({ kind: songs.kind, duration: songs.duration })
      .from(songs).where(eq(songs.id, sample.songId)).get();
    if (!song || song.kind !== "study") return;

    lastWriteAt.set(key, nowMs);
    if (lastWriteAt.size > 2000) lastWriteAt.clear(); // 防长驻进程无限增长

    const duration = Math.max(0, sample.durationSec || song.duration || 0);
    let position = Math.max(0, sample.positionSec || 0);
    if (duration > 0) position = Math.min(position, duration);
    const finished = duration > 0 && position >= duration * 0.95 ? 1 : 0;
    const now = new Date().toISOString();

    db.insert(studyProgress).values({
      userId: sample.userId, songId: sample.songId,
      positionSec: position, durationSec: duration, finished, updatedAt: now,
    }).onConflictDoUpdate({
      target: [studyProgress.userId, studyProgress.songId],
      set: { positionSec: position, durationSec: duration, finished, updatedAt: now },
    }).run();
    pruneSongs(sample.userId);

    if (sample.playlistId) {
      const pl = db.select({ kind: playlists.kind })
        .from(playlists).where(eq(playlists.id, sample.playlistId)).get();
      if (pl?.kind === "study") {
        // 只记录确实属于该歌单的曲目,避免队列串了来源时写错整单进度。
        const inPlaylist = db.select({ id: playlistSongs.id }).from(playlistSongs)
          .where(and(eq(playlistSongs.playlistId, sample.playlistId), eq(playlistSongs.songId, sample.songId)))
          .get();
        if (inPlaylist) {
          db.insert(studyPlaylistProgress).values({
            userId: sample.userId, playlistId: sample.playlistId, songId: sample.songId,
            positionSec: position, durationSec: duration, updatedAt: now,
          }).onConflictDoUpdate({
            target: [studyPlaylistProgress.userId, studyPlaylistProgress.playlistId],
            set: { songId: sample.songId, positionSec: position, durationSec: duration, updatedAt: now },
          }).run();
          prunePlaylists(sample.userId);
        }
      }
    }
  } catch (e: any) {
    log.debug(`学习记录写入忽略: ${String(e?.message || e).slice(0, 120)}`);
  }
}

function pruneSongs(userId: string): void {
  const keep = db.select({ songId: studyProgress.songId }).from(studyProgress)
    .where(eq(studyProgress.userId, userId))
    .orderBy(desc(studyProgress.updatedAt)).limit(LIMIT).all().map((r) => r.songId);
  if (keep.length >= LIMIT) {
    db.delete(studyProgress)
      .where(and(eq(studyProgress.userId, userId), notInArray(studyProgress.songId, keep)))
      .run();
  }
}

function prunePlaylists(userId: string): void {
  const keep = db.select({ playlistId: studyPlaylistProgress.playlistId }).from(studyPlaylistProgress)
    .where(eq(studyPlaylistProgress.userId, userId))
    .orderBy(desc(studyPlaylistProgress.updatedAt)).limit(LIMIT).all().map((r) => r.playlistId);
  if (keep.length >= LIMIT) {
    db.delete(studyPlaylistProgress)
      .where(and(eq(studyPlaylistProgress.userId, userId), notInArray(studyPlaylistProgress.playlistId, keep)))
      .run();
  }
}
