// 自动生成 —— 由 index.ts 物理拆分而来（history 域，2 条路由）。零逻辑改动。
import type { Hono } from "hono";
import {
  PERM,
  albums,
  db,
  desc,
  eq,
  inArray,
  permMiddleware,
  playHistory,
  songs,
  touch,
} from "./shared.js";

export function registerHistory(app: Hono): void {
app.get("/v1/history", permMiddleware(PERM.HISTORY_MANAGE), (c) => {
  const user = c.get("user");
  const page = Math.max(1, parseInt(c.req.query("page") || "1") || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(c.req.query("pageSize") || "50") || 50));
  if (!user) return c.json({ total: 0, page, pageSize, items: [] });
  // Push the playedAt DESC sort to SQL (covered by idx_play_history_played_at),
  // then batch song + album lookups instead of N+1 per history row.
  const all = db.select().from(playHistory).where(eq(playHistory.userId, user.id)).orderBy(desc(playHistory.playedAt)).all();
  const total = all.length;
  const pageRows = all.slice((page - 1) * pageSize, page * pageSize);
  const songIds = pageRows.map((h) => h.songId).filter((x): x is string => !!x);
  const songMap = songIds.length
    ? new Map(db.select().from(songs).where(inArray(songs.id, songIds)).all().map((s) => [s.id, s]))
    : new Map<string, any>();
  const albumIds: string[] = [];
  for (const s of songMap.values()) if (s.albumId) albumIds.push(s.albumId as string);
  const albumMap = albumIds.length
    ? new Map(db.select().from(albums).where(inArray(albums.id, albumIds)).all().map((a) => [a.id, a]))
    : new Map<string, any>();
  const items = pageRows.map((h) => {
    const song = songMap.get(h.songId);
    if (!song) return null;
    const album = song.albumId ? albumMap.get(song.albumId) : undefined;
    return {
      id: song.id, title: song.title, artist: song.artist, album: song.album,
      artistId: song.artistId, albumId: song.albumId, duration: song.duration || 0,
      bitRate: song.bitRate, suffix: song.suffix, contentType: song.contentType,
      // 与歌单曲目同一回退链:歌曲自带 → 专辑封面(al- 的最终图片由 getCoverArt
      // 解析,专辑无自带封面时借同专辑首支带封面曲目的图)。
      coverArt: song.coverArt ? `so-${song.id}` : (album ? `al-${album.id}` : undefined),
      playedAt: h.playedAt || "",
    };
  }).filter(Boolean);
  return c.json({ total, page, pageSize, items });
});

// Clear the current user's play history. Does not touch playCount on songs
// (that's a historical counter, not a history record).

app.delete("/v1/history", permMiddleware(PERM.HISTORY_MANAGE), (c) => {
  const user = c.get("user");
  if (!user) return c.json({ deleted: 0 });
  const result = db.delete(playHistory).where(eq(playHistory.userId, user.id)).run();
  return c.json({ deleted: result.changes || 0 });
});

// ==================== DLNA cast ====================
// P2-2 MIME 同步:cast/enqueue 的 DIDL mime 用 resolveDlnaOutput(与出流同一来源)。

// Derive the LAN base URL the DLNA renderer should use to pull the stream.
// Uses the request Host header's hostname + the backend's actual listening
// port (so it works even when fronted by a dev proxy on a different port).
// Also records it for the internal cast paths (auto-advance / stalled retry)
// so they reuse the same reachable address.
//
// 关键:只信任「局域网可达」的 Host(私有 IP / .local)。通过公网域名访问时,Host 头是
// 公网域名,设备在同一 LAN 内无法解析回连 → 直接回退到自动探测的 LAN IP,确保推给 DLNA
// 设备的永远是局域网地址。DLNA_BASE_URL 环境变量优先级最高,可显式覆盖。
}
