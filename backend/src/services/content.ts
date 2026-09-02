import { eq, or, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { songs, albums, artists, playlists, playlistSongs, genres } from "../db/schema.js";
import { suffixToMime } from "./dlna/queue.js";
import { groupMemberSort } from "../utils/songSource.js";
import { probeLocalSourceOk } from "../utils/localSourceProbe.js";
import { playPreferenceActive, preferLocalEnabled, fallbackToWebEnabled } from "./plugin/core/playPreference.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("CONTENT");

// Convert song rows into QueueItem objects (shared by the album/playlist play
// endpoints and the flow runner).
export function songsToQueueItems(rows: any[]): any[] {
  // 专辑艺术家与年份只存在于 albums 表。整批一次 IN 查询取回,不要在 map 里
  // 逐行查——播放整张专辑/大歌单时那就是几百次 N+1。
  const albumIds = Array.from(new Set(rows.map(s => s.albumId).filter(Boolean))) as string[];
  const albumMap = albumIds.length
    ? new Map(db.select().from(albums).where(inArray(albums.id, albumIds)).all().map(a => [a.id, a]))
    : new Map<string, any>();

  return rows.map((s) => {
    const coverArt = s.coverArt || (s.albumId ? `al-${s.albumId}` : undefined);
    const al = s.albumId ? albumMap.get(s.albumId) : undefined;
    return {
      songId: s.id,
      title: s.title || "未知",
      artist: s.artist || undefined,
      album: s.album || undefined,
      albumId: s.albumId || undefined,
      mime: suffixToMime(s.suffix || ""),
      coverArt,
      duration: typeof s.duration === "number" ? s.duration : undefined,
      // 扩展元数据。0 / 空串在库里表示"未知",统一归一成 undefined,免得
      // 客户端把「第 0 轨」「0 年」当成真实值显示出来。
      track: s.track || undefined,
      discNumber: s.discNumber || undefined,
      albumArtist: al?.artist || s.artist || undefined,
      year: al?.year || undefined,
      genre: s.genre || al?.genre || undefined,
    };
  });
}

// Resolve a content reference (song / playlist / artist / album / genre) into
// song rows + a display name. Mirrors the frontend usePlayContent behavior.
// async:多源组 song 分支需探测 local 源可用性(失败回退 web)。
export async function resolveContentSongs(type: string, id: string): Promise<{ rows: any[]; name: string } | null> {
  if (type === "song") {
    // Single track. Kept here (rather than making callers hand-build a
    // QueueItem) so the mime/coverArt derivation stays in one place — the HA
    // integration plays a single song through the same /v1/play endpoint.
    const s = db.select().from(songs).where(eq(songs.id, id)).get();
    if (!s) return null;
    // 同曲多源组播放优选(服务端插件开关):歌曲属于多源组、且「播放优选」插件
    // 开启(默认开)时,改播组内核心曲库源(local > webdav > web,与 Web 前端
    // 主行 = sources[0] 一致)。传任意组内 id 都落到同一首歌,客户端/HA 集成
    // 无需自己选源。组内保留所有行供备选,这里只把「主源」作为播放行返回。
    // 插件关闭 → 恒走下方原行分支(按原源播放,与插件化前行为一致)。
    if (s.groupId && playPreferenceActive() && preferLocalEnabled()) {
      const members = db.select().from(songs).where(eq(songs.groupId, s.groupId)).all();
      if (members.length > 1) {
        const sorted = [...members].sort(groupMemberSort);
        // 首选 Local,失败回退平台:主源(local/webdav)探测不可用(文件缺失/
        // WebDAV 拉不到)时,切组内 web 备选源,保证播放队列可播。
        if ((sorted[0].type || "local") !== "web" && fallbackToWebEnabled()) {
          const ok = await probeLocalSourceOk(sorted[0]);
          if (!ok) {
            const webAlt = sorted.find((m) => (m.type || "") === "web");
            if (webAlt) {
              log.info("播放回退:核心曲库源不可用,切组内 web 源", { localId: sorted[0].id, webId: webAlt.id, title: webAlt.title || "" });
              return { rows: [webAlt], name: webAlt.title || "未知" };
            }
          }
        }
        return { rows: [sorted[0]], name: sorted[0].title || "未知" };
      }
    }
    return { rows: [s], name: s.title || "未知" };
  }
  if (type === "playlist") {
    const pl = db.select().from(playlists).where(eq(playlists.id, id)).get();
    if (!pl) return null;
    // Batch-load the playlist's songs in one query instead of N+1 (was one
    // songs query per entry). Order preserved via the id->row Map.
    const entries = db.select().from(playlistSongs).where(eq(playlistSongs.playlistId, id)).all()
      .filter(e => e.playable && e.songId);
    const songIds = entries.map(e => e.songId!);
    const songMap = songIds.length
      ? new Map(db.select().from(songs).where(inArray(songs.id, songIds)).all().map((s) => [s.id, s]))
      : new Map();
    const rows = entries.map(e => songMap.get(e.songId!)).filter(Boolean);
    return { rows, name: pl.name };
  }
  if (type === "album") {
    const al = db.select().from(albums).where(eq(albums.id, id)).get();
    if (!al) return null;
    const rows = db.select().from(songs).where(eq(songs.albumId, id)).orderBy(songs.discNumber, songs.track).all();
    return { rows, name: al.name };
  }
  if (type === "artist") {
    const ar = db.select().from(artists).where(eq(artists.id, id)).get();
    if (!ar) return null;
    const albumIds = db.select({ id: albums.id }).from(albums).where(eq(albums.artistId, id)).all().map(a => a.id);
    const rows = albumIds.length > 0
      ? db.select().from(songs).where(or(eq(songs.artistId, id), inArray(songs.albumId, albumIds))).orderBy(songs.albumId, songs.discNumber, songs.track).all()
      : db.select().from(songs).where(eq(songs.artistId, id)).orderBy(songs.discNumber, songs.track).all();
    return { rows, name: ar.name };
  }
  if (type === "genre") {
    const g = db.select().from(genres).where(eq(genres.id, id)).get();
    if (!g) return null;
    const rows = db.select().from(songs).where(eq(songs.genre, g.name)).orderBy(songs.albumId, songs.discNumber, songs.track).all();
    return { rows, name: g.name };
  }
  return null;
}