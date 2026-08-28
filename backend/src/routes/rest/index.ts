import { Hono } from "hono";
import { db } from "../../db/index.js";
import { users, songs, albums, artists, playlists, playlistSongs, userFavoriteSongs, playlistFavorites, playHistory, mediaSources, userRatings, userPlayQueues } from "../../db/schema.js";
import { eq, like, sql, or, and, isNotNull, inArray, desc, gt } from "drizzle-orm";
import fs from "fs";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { getLyricsForSongId, getLyricsForSong, lrcToStructured } from "../../services/lyrics.js";
import { notifyScrobble, dedupeScrobbleDispatch, dedupePlayDispatch } from "../../plugins/scrobblers.js";
import { getPlaylistCover, cacheRemoteCover, clearPlaylistCoverCache, resolveCoverFile } from "../../services/playlistCover.js";
import { fetchCoverForSong } from "../../services/covers.js";
import { isImportedPlaylist, isPluginSyncPlaylist } from "../../utils/playlist.js";
import { isFixedRecommendPlaylist } from "../../services/plugin/fixedRecommend.js";
import { maybeRefreshRandomSongs, RANDOM_PLAYLIST_ID } from "../../services/plugin/randomSongs.js";
import { readCoverFile } from "../../services/coverCache.js";
import { loadAndRenderCover } from "../../services/coverImage.js";
import { dailyRecommendTag } from "../../services/pluginAccess.js";
import { refreshPlaylistCounts } from "../../services/plugin/shared.js";
import { resolveCastToken } from "../../services/dlna/control.js";
import { findFallbackStream } from "../../services/source/online/streamFallback.js";
import { getConfiguredProvider } from "../../services/source/online/index.js";
import { permMiddleware } from "../../middleware/auth.js";
import { PERM, hasPerm } from "../../services/access.js";

export const restRoutes = new Hono();

// OpenSubsonic clients (libopensonic/MA) POST form-encoded params with .view suffixes.
// Parse the form body once and merge into query params via c.set(), mirroring
// Navidrome's postFormToQueryParams middleware. getParam() reads merged values.
const paramKey = "mergedParams" as const;
restRoutes.use("*", async (c, next) => {
  try {
    const merged: Record<string, any> = {};
    for (const [k, v] of new URL(c.req.url).searchParams.entries()) {
      if (k in merged) {
        if (Array.isArray(merged[k])) merged[k].push(v);
        else merged[k] = [merged[k], v];
      } else {
        merged[k] = v;
      }
    }
    const method = c.req.method;
    if (method === "POST" || method === "PUT" || method === "DELETE") {
      const ct = c.req.header("content-type") || "";
      if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data") || ct === "") {
        const body = await c.req.parseBody().catch(() => ({})) as Record<string, any>;
        for (const [k, v] of Object.entries(body)) {
          if (k in merged) {
            if (Array.isArray(merged[k])) merged[k].push(v);
            else merged[k] = [merged[k], v];
          } else {
            merged[k] = v;
          }
        }
      }
    }
    c.set(paramKey, merged);
  } catch { c.set(paramKey, {}); }
  return next();
});

// Read a param from merged query+form params (Navidrome-style)
function getParam(c: any, name: string): string | undefined {
  const merged = c.get(paramKey) || {};
  const v = merged[name];
  if (Array.isArray(v)) return v[v.length - 1] as string;
  if (v !== undefined && v !== null) return String(v);
  return undefined;
}

function getParams(c: any, name: string): string[] {
  const merged = c.get(paramKey) || {};
  const v = merged[name];
  if (Array.isArray(v)) return v.map(String);
  if (v !== undefined && v !== null) return [String(v)];
  return [];
}

const API_VERSION = "1.16.1";
const SERVER_VERSION = process.env.APP_VERSION || "1.0.0";
const MIME_MAP: Record<string, string> = {
  mp3: "audio/mpeg", flac: "audio/flac", wav: "audio/wav", aac: "audio/aac",
  ogg: "audio/ogg", m4a: "audio/mp4", wma: "audio/x-ms-wma", ape: "audio/ape",
  aiff: "audio/aiff", opus: "audio/opus",
};

// ==================== Helpers ====================

function ok(data: any = {}) {
  return { "subsonic-response": { status: "ok", version: API_VERSION, serverVersion: SERVER_VERSION, type: "MusicFlow", openSubsonic: true, ...data } };
}

function err(code: number, message: string) {
  return (c: any) => c.json({ "subsonic-response": { status: "failed", version: API_VERSION, serverVersion: SERVER_VERSION, type: "MusicFlow", openSubsonic: true, error: { code, message } } });
}

// Response body for a failed request. Subsonic clients inspect the body's
// status field, so a failed lookup MUST return status:"failed" — not
// ok({error}) which masks the failure behind a success envelope.
function fail(code: number, message: string) {
  return { "subsonic-response": { status: "failed", version: API_VERSION, serverVersion: SERVER_VERSION, type: "MusicFlow", openSubsonic: true, error: { code, message } } };
}

const ERR_NOT_FOUND = (what: string) => err(70, `${what} not found`);

function getStarredSet(userId?: string): Set<string> {
  if (!userId) return new Set();
  const favs = db.select().from(userFavoriteSongs).where(eq(userFavoriteSongs.userId, userId)).all();
  return new Set(favs.map(f => f.songId));
}

// OpenSubsonic setRating 的读取端:单条查询,用于单实体端点(getSong/getAlbum/getArtist)
// 回填 userRating。列表端点保持 0(客户端普遍忽略),避免逐条 N+1。
function getRatingValue(userId: string | undefined, itemType: string, itemId: string): number {
  if (!userId) return 0;
  return db.select({ rating: userRatings.rating }).from(userRatings)
    .where(and(eq(userRatings.userId, userId), eq(userRatings.itemType, itemType), eq(userRatings.itemId, itemId)))
    .get()?.rating ?? 0;
}

function resolveAlbumCover(albumId: string | null): string | undefined {
  if (!albumId) return undefined;
  const album = db.select().from(albums).where(eq(albums.id, albumId)).get();
  return album?.coverArt ? `al-${album.id}` : undefined;
}

// Web/online-imported albums (go-music-dl etc.) cache their artwork on the
// song rows (songs.cover_art), not on the album row. Find the first song of an
// album that carries a cover so album pages can inherit that artwork.
function firstSongWithCover(albumId: string): string | undefined {
  const song = db.select({ id: songs.id }).from(songs)
    .where(and(eq(songs.albumId, albumId), isNotNull(songs.coverArt)))
    .limit(1).get();
  return song?.id;
}

// Resolve the displayable cover ref for an album: its own cover (al-<id>), or
// the first song-with-cover's ref (so-<id>) so imported albums aren't blank.
function albumCoverRef(a: any): string | undefined {
  if (a?.coverArt) return `al-${a.id}`;
  const songId = firstSongWithCover(a?.id);
  return songId ? `so-${songId}` : undefined;
}

// OpenSubsonic Child for a song
function songToChild(s: any, starredSet?: Set<string>, rating?: number): any {
  const starred = starredSet?.has(s.id);
  return {
    id: s.id,
    parent: s.albumId || undefined,
    isDir: false,
    title: s.title,
    album: s.album || "",
    artist: s.artist || "",
    track: s.track || 0,
    year: 0,
    genre: s.genre || "",
    // Web/online songs cache their cover on the song row (songs.cover_art);
    // local songs rely on the album cover. Prefer the song's own cover so
    // imported platform songs always show artwork.
    coverArt: s.coverArt ? `so-${s.id}` : resolveAlbumCover(s.albumId),
    size: s.size || 0,
    contentType: s.contentType || "audio/mpeg",
    suffix: s.suffix || "mp3",
    duration: s.duration || 0,
    bitRate: s.bitRate || 0,
    path: s.path || "",
    playCount: s.playCount || 0,
    discNumber: s.discNumber || 1,
    created: s.createdAt || undefined,
    albumId: s.albumId || undefined,
    artistId: s.artistId || undefined,
    type: "music",
    starred: starred ? new Date().toISOString() : undefined,
    userRating: rating ?? 0,
    isVideo: false,
    mediaType: "song",
  };
}

// OpenSubsonic AlbumID3
function albumToID3(a: any, starredSet?: Set<string>, rating?: number): any {
  const starred = starredSet?.has(a.id);
  return {
    id: a.id,
    name: a.name,
    artist: a.artist || "",
    artistId: a.artistId || undefined,
    coverArt: albumCoverRef(a),
    songCount: a.songCount || 0,
    duration: a.duration || 0,
    playCount: a.playCount || 0,
    created: a.createdAt || new Date().toISOString(),
    starred: starred ? new Date().toISOString() : undefined,
    year: a.year || 0,
    genre: a.genre || "",
    userRating: rating ?? 0,
    mediaType: "album",
  };
}

// OpenSubsonic ArtistID3
function artistToID3(a: any, starredSet?: Set<string>, rating?: number): any {
  const starred = starredSet?.has(a.id);
  return {
    id: a.id,
    name: a.name,
    coverArt: a.coverArt ? `ar-${a.id}` : undefined,
    artistImageUrl: a.coverArt ? `/rest/getCoverArt?id=ar-${a.id}&size=600` : undefined,
    albumCount: a.albumCount || 0,
    starred: starred ? new Date().toISOString() : undefined,
    userRating: rating ?? 0,
    mediaType: "artist",
  };
}

// OpenSubsonic Child for an album (getMusicDirectory / getAlbumList)
function albumToChild(a: any, starredSet?: Set<string>): any {
  const starred = starredSet?.has(a.id);
  return {
    id: a.id,
    parent: a.artistId || undefined,
    isDir: true,
    title: a.name,
    album: a.name,
    artist: a.artist || "",
    year: a.year || 0,
    genre: a.genre || "",
    coverArt: albumCoverRef(a),
    duration: a.duration || 0,
    songCount: a.songCount || 0,
    playCount: a.playCount || 0,
    created: a.createdAt || undefined,
    artistId: a.artistId || undefined,
    type: "album",
    starred: starred ? new Date().toISOString() : undefined,
    mediaType: "album",
  };
}

function getAlbumStarredSet(userId?: string): Set<string> {
  if (!userId) return new Set();
  // We only have song favorites in the schema; album/artist starred derive from song favorites
  return new Set();
}

function getArtistStarredSet(userId?: string): Set<string> {
  if (!userId) return new Set();
  return new Set();
}

function paginate<T>(list: T[], offset: number, size: number): T[] {
  return list.slice(offset, offset + size);
}

// ==================== System ====================

restRoutes.get("/ping", (c) => c.json(ok()));
restRoutes.get("/ping.view", (c) => c.json(ok()));
restRoutes.get("/getLicense", (c) => c.json(ok({ license: { valid: true } })));
restRoutes.get("/getOpenSubsonicExtensions", (c) => c.json(ok({
  openSubsonicExtensions: [
    { name: "transcodeOffset", versions: [1] },
    { name: "formPost", versions: [1] },
    { name: "songLyrics", versions: [1, 2] },
    { name: "indexBasedQueue", versions: [1] },
    { name: "playbackReport", versions: [1] },
    { name: "topSongsByArtistId", versions: [1] },
  ],
})));
restRoutes.get("/getScanStatus", (c) => c.json(ok({ scanStatus: { scanning: false, count: 0 } })));
restRoutes.all("/startScan", (c) => c.json(ok({ scanStatus: { scanning: false, count: 0 } })));
restRoutes.get("/getBookmarks", (c) => c.json(ok({ bookmarks: { bookmark: [] } })));
restRoutes.all("/createBookmark", (c) => c.json(ok()));
restRoutes.all("/deleteBookmark", (c) => c.json(ok()));
restRoutes.get("/getPlayQueue", (c) => {
  const user = c.get("user");
  const empty = { entry: [], username: user?.username || "", changed: new Date().toISOString(), changedBy: "MusicFlow" };
  if (!user) return c.json(ok({ playQueue: empty }));
  const row = db.select().from(userPlayQueues).where(eq(userPlayQueues.userId, user.id)).get();
  if (!row) return c.json(ok({ playQueue: empty }));
  const ids = JSON.parse(row.entryIdsJson || "[]") as string[];
  const starredSet = getStarredSet(user.id);
  const songMap = ids.length
    ? new Map(db.select().from(songs).where(inArray(songs.id, ids)).all().map(s => [s.id, s]))
    : new Map<string, any>();
  const entry = ids.map(id => songMap.get(id)).filter(Boolean).map(s => songToChild(s, starredSet));
  return c.json(ok({ playQueue: {
    entry,
    current: row.currentId || undefined,
    position: row.position || 0,
    username: user.username,
    changed: row.changedAt || new Date().toISOString(),
    changedBy: "MusicFlow",
  } }));
});

restRoutes.all("/savePlayQueue", async (c) => {
  const user = c.get("user");
  if (!user) return c.json(fail(40, "Unauthorized"));
  const body = await parseBody(c);
  const ids = toIdArray(body.id);
  const current = String(body.current || "");
  const position = parseInt(String(body.position ?? "0"), 10) || 0;
  const now = new Date().toISOString();
  db.insert(userPlayQueues).values({ userId: user.id, entryIdsJson: JSON.stringify(ids), currentId: current || null, position, changedAt: now, changedBy: "MusicFlow" })
    .onConflictDoUpdate({ target: userPlayQueues.userId, set: { entryIdsJson: JSON.stringify(ids), currentId: current || null, position, changedAt: now, changedBy: "MusicFlow" } }).run();
  return c.json(ok());
});
restRoutes.get("/getInternetRadioStations", (c) => c.json(ok({ internetRadioStations: { internetRadioStation: [] } })));
restRoutes.get("/getPodcasts", (c) => c.json(ok({ podcasts: { channel: [] } })));
restRoutes.get("/getNewestPodcasts", (c) => c.json(ok({ newestPodcasts: { episode: [] } })));
restRoutes.get("/getCaptions", (c) => c.json(ok()));

// ==================== Users ====================

restRoutes.get("/getUser", (c) => {
  const username = getParam(c, "username") || c.get("user")?.username;
  const user = db.select().from(users).where(eq(users.username, username || "")).get();
  if (!user) return c.json(fail(70, "User not found"));
  const isAdmin = !!user.isAdmin;
  const roles = (b: boolean) => b;
  const can = (key: string) => hasPerm(user.id, isAdmin, key);
  return c.json(ok({ user: {
    username: user.username,
    email: user.email || "",
    scrobblingEnabled: true,
    adminRole: roles(isAdmin),
    settingsRole: roles(can(PERM.SETTINGS_MANAGE)),
    downloadRole: roles(can(PERM.LIBRARY_STREAM)),
    uploadRole: false,
    playlistRole: roles(can(PERM.PLAYLIST_MANAGE)),
    coverArtRole: roles(can(PERM.COVER_VIEW)),
    commentRole: false,
    podcastRole: false,
    streamRole: roles(can(PERM.LIBRARY_STREAM)),
    jukeboxRole: false,
    shareRole: false,
    videoConversionRole: false,
    folder: [0],
  } }));
});

restRoutes.get("/getUsers", (c) => {
  const all = db.select().from(users).all();
  return c.json(ok({ users: { user: all.map(u => { const isAdmin = !!u.isAdmin; const can = (key: string) => hasPerm(u.id, isAdmin, key); return {
    username: u.username,
    email: u.email || "",
    scrobblingEnabled: true,
    adminRole: isAdmin,
    settingsRole: can(PERM.SETTINGS_MANAGE),
    downloadRole: can(PERM.LIBRARY_STREAM),
    uploadRole: false,
    playlistRole: can(PERM.PLAYLIST_MANAGE),
    coverArtRole: can(PERM.COVER_VIEW),
    commentRole: false,
    podcastRole: false,
    streamRole: can(PERM.LIBRARY_STREAM),
    jukeboxRole: false,
    shareRole: false,
    videoConversionRole: false,
    folder: [0],
  }; }) } }));
});

// MusicFlow 不存用户头像:对存在的用户返回品牌占位图(与 coverArt 占位同风格),
// 避免客户端(如 MA 设置页)因 404 报错;未知用户返回标准 70 失败体。
restRoutes.get("/getAvatar", (c) => {
  const username = getParam(c, "username") || c.get("user")?.username || "";
  const user = username ? db.select().from(users).where(eq(users.username, username)).get() : undefined;
  if (!user) return c.json(fail(70, "User not found"));
  const initial = (user.username || "?").slice(0, 1).toUpperCase().replace(/[<>&'"]/g, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300"><rect fill="#1a1a2e" width="300" height="300"/><circle cx="150" cy="115" r="48" fill="#16213e"/><rect x="95" y="180" width="110" height="80" rx="40" fill="#16213e"/><text x="150" y="130" text-anchor="middle" font-family="sans-serif" font-size="46" fill="#e94560">${initial}</text></svg>`;
  return new Response(svg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } });
});

// ==================== Browsing ====================

restRoutes.get("/getMusicFolders", (c) => {
  const sources = db.select().from(mediaSources).where(eq(mediaSources.enabled, 1)).all();
  return c.json(ok({ musicFolders: { musicFolder: [{ id: 0, name: "Music" }, ...sources.map(s => ({ id: s.id as any, name: s.name }))] } }));
});

restRoutes.get("/getIndexes", permMiddleware(PERM.LIBRARY_BROWSE), (c) => {
  const allArtists = db.select().from(artists).all();
  const indexMap = new Map<string, any[]>();
  for (const a of allArtists) {
    const ch = (a.name || "#")[0]?.toUpperCase() || "#";
    const key = /[A-Z]/.test(ch) ? ch : "#";
    if (!indexMap.has(key)) indexMap.set(key, []);
    indexMap.get(key)!.push({ id: a.id, name: a.name, coverArt: a.coverArt ? `ar-${a.id}` : undefined, artistImageUrl: a.coverArt ? `/rest/getCoverArt?id=ar-${a.id}&size=600` : undefined, albumCount: a.albumCount || 0 });
  }
  return c.json(ok({ indexes: { lastModified: Date.now(), ignoredArticles: "The An A Die Das Ein Eine Les Le La", index: Array.from(indexMap.entries()).map(([name, artist]) => ({ name, artist })) } }));
});

restRoutes.get("/getArtists", permMiddleware(PERM.LIBRARY_BROWSE), (c) => {
  const user = c.get("user");
  const starredSet = getArtistStarredSet(user?.id);
  const allArtists = db.select().from(artists).all();
  const indexMap = new Map<string, any[]>();
  for (const a of allArtists) {
    const ch = (a.name || "#")[0]?.toUpperCase() || "#";
    const key = /[A-Z]/.test(ch) ? ch : "#";
    if (!indexMap.has(key)) indexMap.set(key, []);
    indexMap.get(key)!.push(artistToID3(a, starredSet));
  }
  return c.json(ok({ artists: { ignoredArticles: "The An A Die Das Ein Eine Les Le La", index: Array.from(indexMap.entries()).map(([name, artist]) => ({ name, artist })) } }));
});

restRoutes.get("/getArtist", permMiddleware(PERM.LIBRARY_BROWSE), (c) => {
  const id = getParam(c, "id") || "";
  const user = c.get("user");
  const artist = db.select().from(artists).where(eq(artists.id, id)).get();
  if (!artist) return c.json(fail(70, "Artist not found"));
  const artistAlbums = db.select().from(albums).where(eq(albums.artistId, id)).all();
  const starredSet = getAlbumStarredSet(user?.id);
  return c.json(ok({ artist: { ...artistToID3(artist, getArtistStarredSet(user?.id), getRatingValue(user?.id, "artist", id)), album: artistAlbums.map(al => albumToID3(al, starredSet)) } }));
});

restRoutes.get("/getArtistInfo", (c) => {
  const id = getParam(c, "id");
  const artist = db.select().from(artists).where(eq(artists.id, id || "")).get();
  if (!artist) return c.json(fail(70, "Artist not found"));
  return c.json(ok({ artistInfo: { biography: artist.bio || "", musicBrainzId: "", lastFmUrl: "", smallImageUrl: artist.coverArt ? `/rest/getCoverArt?id=ar-${artist.id}&size=200` : "", mediumImageUrl: artist.coverArt ? `/rest/getCoverArt?id=ar-${artist.id}&size=500` : "", largeImageUrl: artist.coverArt ? `/rest/getCoverArt?id=ar-${artist.id}&size=1200` : "", similarArtist: { artist: [] } } }));
});

restRoutes.get("/getArtistInfo2", (c) => {
  const id = getParam(c, "id");
  const artist = db.select().from(artists).where(eq(artists.id, id || "")).get();
  if (!artist) return c.json(fail(70, "Artist not found"));
  return c.json(ok({ artistInfo2: { biography: artist.bio || "", musicBrainzId: "", lastFmUrl: "", smallImageUrl: artist.coverArt ? `/rest/getCoverArt?id=ar-${artist.id}&size=200` : "", mediumImageUrl: artist.coverArt ? `/rest/getCoverArt?id=ar-${artist.id}&size=500` : "", largeImageUrl: artist.coverArt ? `/rest/getCoverArt?id=ar-${artist.id}&size=1200` : "", similarArtist: { artist: [] } } }));
});

restRoutes.get("/getAlbum", permMiddleware(PERM.LIBRARY_BROWSE), (c) => {
  const id = getParam(c, "id") || "";
  const user = c.get("user");
  const album = db.select().from(albums).where(eq(albums.id, id)).get();
  if (!album) return c.json(fail(70, "Album not found"));
  // Server-side paging: only the requested page is pulled from SQL (was: load the
  // whole album into memory then slice). A huge compilation album never spikes memory.
  const whereAlbum = eq(songs.albumId, id);
  const offset = Math.max(0, parseInt(getParam(c, "offset") || "0", 10) || 0);
  const size = parseInt(getParam(c, "size") || "0", 10) || 0;
  const songTotal = db.select({ n: sql<number>`count(*)` }).from(songs).where(whereAlbum).get()?.n ?? 0;
  const pageSongs = size > 0
    ? db.select().from(songs).where(whereAlbum).orderBy(sql`rowid`).limit(size).offset(offset).all()
    : db.select().from(songs).where(whereAlbum).orderBy(sql`rowid`).all();
  // Duration aggregated in SQL (SUM), not by iterating every album row in JS.
  const totalDuration = db.select({ s: sql<number>`COALESCE(SUM(${songs.duration}), 0)` }).from(songs).where(whereAlbum).get()?.s ?? 0;
  const starredSet = getStarredSet(user?.id);
  const songsArr = pageSongs.map(s => songToChild(s, starredSet));
  return c.json(ok({ album: { ...albumToID3(album, getAlbumStarredSet(user?.id), getRatingValue(user?.id, "album", id)), songCount: songsArr.length, songTotal, duration: totalDuration, song: songsArr } }));
});

restRoutes.get("/getAlbumInfo", (c) => {
  const id = getParam(c, "id");
  const album = db.select().from(albums).where(eq(albums.id, id || "")).get();
  if (!album) return c.json(fail(70, "Album not found"));
  const coverRef = albumCoverRef(album);
  return c.json(ok({ albumInfo: { notes: "", musicBrainzId: "", lastFmUrl: "", smallImageUrl: coverRef ? `/rest/getCoverArt?id=${coverRef}&size=200` : "", mediumImageUrl: coverRef ? `/rest/getCoverArt?id=${coverRef}&size=500` : "", largeImageUrl: coverRef ? `/rest/getCoverArt?id=${coverRef}&size=1200` : "" } }));
});

restRoutes.get("/getAlbumInfo2", (c) => {
  const id = getParam(c, "id");
  const album = db.select().from(albums).where(eq(albums.id, id || "")).get();
  if (!album) return c.json(fail(70, "Album not found"));
  const coverRef = albumCoverRef(album);
  return c.json(ok({ albumInfo: { notes: "", musicBrainzId: "", lastFmUrl: "", smallImageUrl: coverRef ? `/rest/getCoverArt?id=${coverRef}&size=200` : "", mediumImageUrl: coverRef ? `/rest/getCoverArt?id=${coverRef}&size=500` : "", largeImageUrl: coverRef ? `/rest/getCoverArt?id=${coverRef}&size=1200` : "" } }));
});

restRoutes.get("/getSong", permMiddleware(PERM.LIBRARY_BROWSE), (c) => {
  const id = getParam(c, "id") || "";
  const user = c.get("user");
  const song = db.select().from(songs).where(eq(songs.id, id)).get();
  if (!song) return c.json(fail(70, "Song not found"));
  return c.json(ok({ song: songToChild(song, getStarredSet(user?.id), getRatingValue(user?.id, "song", id)) }));
});

restRoutes.get("/getMusicDirectory", permMiddleware(PERM.LIBRARY_BROWSE), (c) => {
  const id = getParam(c, "id") || "";
  const user = c.get("user");
  const starredSet = getStarredSet(user?.id);
  const artist = db.select().from(artists).where(eq(artists.id, id)).get();
  if (artist) {
    const artistAlbums = db.select().from(albums).where(eq(albums.artistId, id)).all();
    return c.json(ok({ directory: { id: artist.id, name: artist.name, child: artistAlbums.map(al => albumToChild(al, getAlbumStarredSet(user?.id))) } }));
  }
  const album = db.select().from(albums).where(eq(albums.id, id)).get();
  if (album) {
    const albumSongs = db.select().from(songs).where(eq(songs.albumId, id)).all();
    return c.json(ok({ directory: { id: album.id, name: album.name, child: albumSongs.map(s => songToChild(s, starredSet)) } }));
  }
  return c.json(ok({ directory: { id, name: "", child: [] } }));
});

// ==================== Album lists ====================

function getAlbumListData(c: any) {
  const type = getParam(c, "type") || "newest";
  const size = Math.min(500, parseInt(getParam(c, "size") || "10") || 10);
  const offset = parseInt(getParam(c, "offset") || "0") || 0;
  const genre = getParam(c, "genre");
  const fromYear = parseInt(getParam(c, "fromYear") || "0") || 0;
  const toYear = parseInt(getParam(c, "toYear") || "0") || 0;
  const user = c.get("user");

  let allAlbums = db.select().from(albums).all();
  switch (type) {
    case "random": allAlbums = [...allAlbums].sort(() => Math.random() - 0.5); break;
    case "newest": allAlbums.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")); break;
    case "recent": allAlbums.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")); break;
    case "frequent": allAlbums.sort((a, b) => (b.playCount || 0) - (a.playCount || 0)); break;
    case "highest": allAlbums.sort((a, b) => (b.playCount || 0) - (a.playCount || 0)); break;
    case "alphabeticalByName": allAlbums.sort((a, b) => (a.name || "").localeCompare(b.name || "")); break;
    case "alphabeticalByArtist": allAlbums.sort((a, b) => (a.artist || "").localeCompare(b.artist || "")); break;
    case "byGenre": if (genre) allAlbums = allAlbums.filter(a => (a.genre || "") === genre); break;
    case "byYear": allAlbums = allAlbums.filter(a => (a.year || 0) >= fromYear && (a.year || 0) <= toYear); break;
    case "starred": {
      const starredSet = getStarredSet(user?.id);
      const starredAlbumIds = new Set<string>();
      for (const s of db.select().from(songs).all()) {
        if (s.albumId && starredSet.has(s.id)) starredAlbumIds.add(s.albumId);
      }
      allAlbums = allAlbums.filter(a => starredAlbumIds.has(a.id));
      break;
    }
  }
  return { paged: paginate(allAlbums, offset, size), user };
}

restRoutes.get("/getAlbumList", permMiddleware(PERM.LIBRARY_BROWSE), (c) => {
  const { paged, user } = getAlbumListData(c);
  const starredSet = getAlbumStarredSet(user?.id);
  return c.json(ok({ albumList: { album: paged.map(al => albumToChild(al, starredSet)) } }));
});

restRoutes.get("/getAlbumList2", permMiddleware(PERM.LIBRARY_BROWSE), (c) => {
  const { paged, user } = getAlbumListData(c);
  const starredSet = getAlbumStarredSet(user?.id);
  return c.json(ok({ albumList2: { album: paged.map(al => albumToID3(al, starredSet)) } }));
});

// ==================== Searching ====================

const searchHandler = (c: any) => {
  const query = getParam(c, "query") || "";
  const songCount = Math.min(500, parseInt(getParam(c, "songCount") || "20") || 20);
  const albumCount = Math.min(500, parseInt(getParam(c, "albumCount") || "20") || 20);
  const artistCount = Math.min(500, parseInt(getParam(c, "artistCount") || "20") || 20);
  const songOffset = parseInt(getParam(c, "songOffset") || "0") || 0;
  const albumOffset = parseInt(getParam(c, "albumOffset") || "0") || 0;
  const artistOffset = parseInt(getParam(c, "artistOffset") || "0") || 0;
  const user = c.get("user");
  const starredSet = getStarredSet(user?.id);

  const q = `%${query}%`;
  const isId = /^[0-9a-fA-F-]{36}$/.test(query.trim());

  let foundSongs: any[];
  let foundAlbums: any[];
  let foundArtists: any[];

  if (query === "" || query === '""') {
    // Empty query: return everything (used by clients to page through the whole library).
    // 只投影 songToChild 实际用到的列,避开 source_data/stream_headers/cache_path
    // 等大文本列 —— 整库翻页不会再把整张 songs 表的文本载荷都拉进内存(排序/分页
    // 语义不变:标题按 localeCompare 排)。
    foundSongs = db.select({
      id: songs.id,
      albumId: songs.albumId,
      title: songs.title,
      album: songs.album,
      artist: songs.artist,
      track: songs.track,
      genre: songs.genre,
      coverArt: songs.coverArt,
      size: songs.size,
      contentType: songs.contentType,
      suffix: songs.suffix,
      duration: songs.duration,
      bitRate: songs.bitRate,
      path: songs.path,
      playCount: songs.playCount,
      discNumber: songs.discNumber,
      createdAt: songs.createdAt,
    }).from(songs).all().sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    foundAlbums = db.select().from(albums).all();
    foundArtists = db.select().from(artists).all();
  } else if (isId) {
    foundSongs = db.select().from(songs).where(eq(songs.id, query.trim())).all();
    foundAlbums = db.select().from(albums).where(eq(albums.id, query.trim())).all();
    foundArtists = db.select().from(artists).where(eq(artists.id, query.trim())).all();
  } else {
    foundSongs = db.select().from(songs).where(or(like(songs.title, q), like(songs.artist, q), like(songs.album, q))).all();
    foundAlbums = db.select().from(albums).where(or(like(albums.name, q), like(albums.artist, q))).all();
    foundArtists = db.select().from(artists).where(like(artists.name, q)).all();
  }

  return {
    song: paginate(foundSongs, songOffset, songCount).map(s => songToChild(s, starredSet)),
    album: paginate(foundAlbums, albumOffset, albumCount).map(a => albumToID3(a, getAlbumStarredSet(user?.id))),
    artist: paginate(foundArtists, artistOffset, artistCount).map(a => artistToID3(a, getArtistStarredSet(user?.id))),
  };
};

restRoutes.get("/search2", permMiddleware(PERM.LIBRARY_SEARCH), (c) => c.json(ok({ searchResult2: searchHandler(c) })));
restRoutes.get("/search3", permMiddleware(PERM.LIBRARY_SEARCH), (c) => c.json(ok({ searchResult3: searchHandler(c) })));

restRoutes.get("/getSongsByGenre", permMiddleware(PERM.LIBRARY_BROWSE), (c) => {
  const genre = getParam(c, "genre") || "";
  const count = parseInt(getParam(c, "count") || "10") || 10;
  const offset = parseInt(getParam(c, "offset") || "0") || 0;
  const user = c.get("user");
  const allSongs = db.select().from(songs).where(eq(songs.genre, genre)).all();
  return c.json(ok({ songsByGenre: { song: paginate(allSongs, offset, count).map(s => songToChild(s, getStarredSet(user?.id))) } }));
});

restRoutes.get("/getRandomSongs", permMiddleware(PERM.LIBRARY_BROWSE), (c) => {
  const size = Math.min(100, parseInt(getParam(c, "size") || "10") || 10);
  const user = c.get("user");
  // SQL 随机取样,避免把整张 songs 表(含大文本列)加载进来在 JS 里洗牌。
  const allSongs = db.select().from(songs).orderBy(sql`random()`).limit(size).all();
  return c.json(ok({ randomSongs: { song: allSongs.map(s => songToChild(s, getStarredSet(user?.id))) } }));
});

restRoutes.get("/getGenres", permMiddleware(PERM.LIBRARY_BROWSE), (c) => {
  const genreMap = new Map<string, { songCount: number; albumCount: number }>();
  // SQL GROUP BY 聚合,替代整表加载后在 JS 里逐行计数(大曲库下避免两张大表
  // 的瞬态内存尖峰)。语义与原实现一致:跳过空串 genre(NULL/'' 排除,'' 保留)。
  const songRows = db.select({ genre: songs.genre, count: sql<number>`count(*)` })
    .from(songs)
    .where(sql`${songs.genre} is not null and ${songs.genre} != ''`)
    .groupBy(songs.genre).all();
  for (const r of songRows) {
    genreMap.set(r.genre!, { songCount: r.count, albumCount: 0 });
  }
  const albumRows = db.select({ genre: albums.genre, count: sql<number>`count(*)` })
    .from(albums)
    .where(sql`${albums.genre} is not null and ${albums.genre} != ''`)
    .groupBy(albums.genre).all();
  for (const r of albumRows) {
    const entry = genreMap.get(r.genre!);
    if (entry) entry.albumCount = r.count;
  }
  return c.json(ok({ genres: { genre: Array.from(genreMap.entries()).map(([name, counts]) => ({ value: name, songCount: counts.songCount, albumCount: counts.albumCount })) } }));
});

restRoutes.get("/getTopSongs", permMiddleware(PERM.LIBRARY_SEARCH), (c) => {
  const artistId = getParam(c, "artistId");
  let artistName = getParam(c, "artist") || "";
  if (!artistName && artistId) {
    // OpenSubsonic topSongsByArtistId 扩展:按 artistId 解析歌手名
    const a = db.select().from(artists).where(eq(artists.id, artistId)).get();
    artistName = a?.name || "";
  }
  const count = parseInt(getParam(c, "count") || "50") || 50;
  const user = c.get("user");
  const allSongs = db.select().from(songs).where(eq(songs.artist, artistName)).all().slice(0, count);
  return c.json(ok({ topSongs: { song: allSongs.map(s => songToChild(s, getStarredSet(user?.id))) } }));
});

restRoutes.get("/getSimilarSongs", permMiddleware(PERM.LIBRARY_BROWSE), (c) => c.json(ok({ similarSongs: { song: [] } })));
restRoutes.get("/getSimilarSongs2", permMiddleware(PERM.LIBRARY_BROWSE), (c) => c.json(ok({ similarSongs2: { song: [] } })));

// ==================== Playlists ====================

restRoutes.get("/getPlaylists", permMiddleware(PERM.PLAYLIST_VIEW), (c) => {
  const user = c.get("user");
  // Visibility: admin sees all; others see their own + public + 导入/插件歌单
  // (sourceUrl 非空,音乐库内容对所有用户开放)。Pushed to SQL,
  // and the daily-recommend-first ordering is expressed as a CASE + recency.
  const where = user?.isAdmin
    ? undefined
    : or(
        eq(playlists.isPublic, 1),
        eq(playlists.ownerId, user?.id ?? ""),
        isNotNull(playlists.sourceUrl),
      );
  // 当前用户收藏的歌单 id 集合:每项 favorite 状态按它判断(收藏已按用户隔离)。
  const favIds = new Set(db.select({ pid: playlistFavorites.playlistId })
    .from(playlistFavorites).where(eq(playlistFavorites.userId, user?.id ?? ""))
    .all().map(r => r.pid));
  const dailyTag = dailyRecommendTag() || "每日推荐";
  const dailyOrder = sql`CASE WHEN ${playlists.comment} LIKE ${`%${dailyTag}%`} AND ${playlists.name} = '今日推荐' THEN 0 ELSE 1 END`;
  const recency = sql`COALESCE(${playlists.updatedAt}, ${playlists.createdAt})`;
  // Server-side paging + name search: cards scroll the whole library, so the
  // response carries a total and only the requested page (offset/size).
  const q = (getParam(c, "query") || "").trim();
  const nameWhere = q ? like(playlists.name, `%${q}%`) : undefined;
  const whereAll = where && nameWhere ? and(where, nameWhere) : (where || nameWhere);
  const total = db.select({ n: sql<number>`count(*)` }).from(playlists).where(whereAll).get()?.n ?? 0;
  const offset = Math.max(0, parseInt(getParam(c, "offset") || "0", 10) || 0);
  const size = parseInt(getParam(c, "size") || "0", 10) || 0;
  const base = db.select().from(playlists).where(whereAll).orderBy(dailyOrder, desc(recency));
  const page = size > 0 ? base.limit(size).offset(offset).all() : base.all();
  return c.json(ok({ playlists: { total, playlist: page.map(p => ({ id: p.id, name: p.name, owner: p.ownerId, public: !!p.isPublic, created: p.createdAt || new Date().toISOString(), changed: p.updatedAt || new Date().toISOString(), songCount: p.songCount || 0, duration: p.duration || 0, coverArt: `pl-${p.id}`, comment: p.comment || "", isImported: !!p.sourceUrl, syncEnabled: !!p.syncEnabled, favorite: favIds.has(p.id), sourcePlatform: p.sourcePlatform || "" })) } }));
});

restRoutes.get("/getPlaylist", permMiddleware(PERM.PLAYLIST_VIEW), (c) => {
  const id = getParam(c, "id") || "";
  const user = c.get("user");
  const playlist = db.select().from(playlists).where(eq(playlists.id, id)).get();
  if (!playlist) return c.json(fail(70, "Playlist not found"));
  // 「随机歌曲」固定歌单惰性刷新:距上次生成超时则立即重建(毫秒级),客户端播完
  // 一轮再来读取时歌单必然已刷新好 → 消除「现场生成导致的空白等待」。
  if (playlist.id === RANDOM_PLAYLIST_ID) maybeRefreshRandomSongs();
  // Private playlists are only visible to the owner (admins can view all).
  // 导入/插件歌单(sourceUrl 非空)属于音乐库内容,对所有登录用户开放。
  if (!playlist.isPublic && playlist.ownerId !== user?.id && !user?.isAdmin && !playlist.sourceUrl) {
    return c.json(fail(50, "Playlist is private"));
  }
  // Server-side paging: only the requested page of playable entries is pulled
  // from SQL (was: read the whole playlist into memory, slice, then O(N) scan).
  // OpenSubsonic clients can only play library-matched tracks. Unmatched remote
  // stubs are NOT exposed to third-party clients (they cannot be streamed);
  // the web UI uses /rest/api/v1/playlists/:id/tracks to see the full list.
  const playableWhere = and(
    eq(playlistSongs.playlistId, playlist.id),
    eq(playlistSongs.playable, 1),
    isNotNull(playlistSongs.songId),
  );
  const songTotal = db.select({ n: sql<number>`count(*)` }).from(playlistSongs).where(playableWhere).get()?.n ?? 0;
  const offset = Math.max(0, parseInt(getParam(c, "offset") || "0", 10) || 0);
  const size = parseInt(getParam(c, "size") || "0", 10) || 0;
  const pageEntries = size > 0
    ? db.select().from(playlistSongs).where(playableWhere).orderBy(playlistSongs.id).limit(size).offset(offset).all()
    : db.select().from(playlistSongs).where(playableWhere).orderBy(playlistSongs.id).all();
  const starredSet = getStarredSet(user?.id);
  // Batch song lookups ONCE (was N+1: a songs query per entry, plus a second
  // pass inside the duration reducer). Map keeps id -> row for both passes.
  const songIds = pageEntries.map(e => e.songId!).filter(Boolean);
  const songMap = songIds.length
    ? new Map(db.select().from(songs).where(inArray(songs.id, songIds)).all().map(s => [s.id, s]))
    : new Map<string, any>();
  const entryChildren = pageEntries.map(e => {
    const song = e.songId ? songMap.get(e.songId) : null;
    return song ? { ...songToChild(song, starredSet), playable: true } : null;
  }).filter(Boolean);
  // Duration over the returned page only (bounded by LIMIT, no full-list scan).
  let duration = 0;
  for (const e of pageEntries) {
    const song = e.songId ? songMap.get(e.songId) : null;
    duration += song?.duration || 0;
  }
  return c.json(ok({ playlist: {
    id: playlist.id, name: playlist.name, owner: playlist.ownerId, public: !!playlist.isPublic,
    created: playlist.createdAt || new Date().toISOString(), changed: playlist.updatedAt || new Date().toISOString(),
    songCount: entryChildren.length, songTotal, duration,
    coverArt: `pl-${playlist.id}`, comment: playlist.comment || "",
    sourcePlatform: playlist.sourcePlatform || "",
    isImported: isImportedPlaylist(playlist),
    pluginSynced: isPluginSyncPlaylist(playlist),
    syncEnabled: !!playlist.syncEnabled,
    entry: entryChildren,
  } }));
});

// Parse JSON body with form-encoded fallback (OpenSubsonic clients use form params, our frontend uses JSON)
// Repeated query params (e.g. songIdToAdd=a&songIdToAdd=b) are collected into arrays
async function parseBody(c: any): Promise<Record<string, any>> {
  try {
    const ct = c.req.header("content-type") || "";
    if (ct.includes("application/json")) return await c.req.json();
  } catch {}
  const result: Record<string, any> = {};
  const url = new URL(c.req.url);
  for (const [k, v] of url.searchParams.entries()) {
    if (k in result) {
      if (Array.isArray(result[k])) result[k].push(v);
      else result[k] = [result[k], v];
    } else {
      result[k] = v;
    }
  }
  const form = await c.req.parseBody().catch(() => ({}));
  for (const [k, v] of Object.entries(form)) {
    if (k in result) {
      if (Array.isArray(result[k])) result[k].push(v);
      else result[k] = [result[k], v];
    } else {
      result[k] = v;
    }
  }
  return result;
}

function toIdArray(v: any): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (v === undefined || v === null) return [];
  return String(v).split(",").filter(Boolean);
}

restRoutes.all("/createPlaylist", permMiddleware(PERM.PLAYLIST_MANAGE), async (c) => {
  const user = c.get("user");
  const body = await parseBody(c);
  const id = `pl-${Date.now()}`;
  const name = (body.name as string) || "New Playlist";
  db.insert(playlists).values({ id, name, ownerId: user?.id || "" }).run();
  const songIds = [...toIdArray(body.songId), ...toIdArray(body.songIds)];
  songIds.forEach((sid, i) => { db.insert(playlistSongs).values({ playlistId: id, songId: sid, position: i, playable: 1 }).run(); });
  refreshPlaylistCounts(id);
  return c.json(ok({ playlist: { id, name, songCount: songIds.length, duration: 0, created: new Date().toISOString(), changed: new Date().toISOString(), owner: user?.id || "", public: false } }));
});

restRoutes.all("/updatePlaylist", permMiddleware(PERM.PLAYLIST_MANAGE), async (c) => {
  const user = c.get("user");
  const body = await parseBody(c);
  const playlistId = (body.playlistId as string) || (body.id as string) || "";
  if (!playlistId) return c.json(fail(10, "Missing playlistId"));
  const playlist = db.select().from(playlists).where(eq(playlists.id, playlistId)).get();
  if (!playlist) return c.json(fail(70, "Playlist not found"));
  // Only owner (or admin) can modify a playlist; others' public playlists are read-only
  if (playlist.ownerId !== user?.id && !user?.isAdmin) {
    return c.json(fail(50, "Not authorized to modify this playlist"));
  }
  const isImported = !!playlist.sourceUrl;
  // Imported playlists are read-only for tracks: track list follows the platform, sync via /sync
  const wantsTrackEdit = toIdArray(body.songIdToAdd).length > 0 || toIdArray(body.songIdToRemove).length > 0 || toIdArray(body.songIndexToRemove).length > 0;
  if (isImported && wantsTrackEdit) {
    return c.json(fail(50, "导入歌单的曲目只读,请在原平台修改后同步"));
  }
  if (body.name) db.update(playlists).set({ name: body.name as string, updatedAt: new Date().toISOString() }).where(eq(playlists.id, playlistId)).run();
  if (body.comment !== undefined) db.update(playlists).set({ comment: String(body.comment), updatedAt: new Date().toISOString() }).where(eq(playlists.id, playlistId)).run();
  if (body.public !== undefined) db.update(playlists).set({ isPublic: body.public ? 1 : 0, updatedAt: new Date().toISOString() }).where(eq(playlists.id, playlistId)).run();
  if (body.syncEnabled !== undefined) db.update(playlists).set({ syncEnabled: body.syncEnabled ? 1 : 0, updatedAt: new Date().toISOString() }).where(eq(playlists.id, playlistId)).run();

  // Remove by song index (OpenSubsonic: songIndexToRemove, zero-based positions)
  const indicesToRemove: number[] = toIdArray(body.songIndexToRemove).map(x => parseInt(x)).filter(n => !isNaN(n));
  // Remove by song id (legacy)
  const idsToRemove = toIdArray(body.songIdToRemove);
  const allEntries = db.select().from(playlistSongs).where(eq(playlistSongs.playlistId, playlistId)).all();
  if (indicesToRemove.length > 0) {
    for (const idx of indicesToRemove) {
      const entry = allEntries[idx];
      if (entry) db.delete(playlistSongs).where(eq(playlistSongs.id, entry.id)).run();
    }
  }
  if (idsToRemove.length > 0) {
    for (const sid of idsToRemove) {
      db.delete(playlistSongs).where(and(eq(playlistSongs.playlistId, playlistId), eq(playlistSongs.songId, sid))).run();
    }
  }

  // Add songs (OpenSubsonic: songIdToAdd, can be repeated / comma-separated)
  const idsToAdd = toIdArray(body.songIdToAdd);
  if (idsToAdd.length > 0) {
    const count = db.select().from(playlistSongs).where(eq(playlistSongs.playlistId, playlistId)).all().length;
    idsToAdd.forEach((sid, i) => {
      const exists = db.select().from(playlistSongs).where(and(eq(playlistSongs.playlistId, playlistId), eq(playlistSongs.songId, sid))).get();
      if (!exists) db.insert(playlistSongs).values({ playlistId, songId: sid, position: count + i, playable: 1 }).run();
    });
  }
  // Track list changed -> the self-built cover (first song's album cover) may need refresh
  if (idsToAdd.length > 0 || indicesToRemove.length > 0 || idsToRemove.length > 0) {
    clearPlaylistCoverCache(playlistId);
  }
  refreshPlaylistCounts(playlistId);
  return c.json(ok());
});

restRoutes.all("/deletePlaylist", permMiddleware(PERM.PLAYLIST_MANAGE), async (c) => {
  const user = c.get("user");
  const body = await parseBody(c);
  const id = (body.id as string) || (body.playlistId as string) || "";
  if (!id) return c.json(fail(10, "Missing id"));
  if (isFixedRecommendPlaylist(id)) return c.json(fail(10, "固定推荐歌单(今日/本地/漫游)由插件每日重建,不可删除"));
  const playlist = db.select().from(playlists).where(eq(playlists.id, id)).get();
  if (!playlist) return c.json(fail(70, "Playlist not found"));
  // Only owner (or admin) can delete; others' public playlists are read-only
  if (playlist.ownerId !== user?.id && !user?.isAdmin) {
    return c.json(fail(50, "Not authorized to delete this playlist"));
  }
  db.delete(playlistSongs).where(eq(playlistSongs.playlistId, id)).run();
  db.delete(playlists).where(eq(playlists.id, id)).run();
  clearPlaylistCoverCache(id);
  return c.json(ok());
});

// ==================== Starring ====================

function parseStarIds(raw: string | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  return String(raw).split(",").filter(Boolean);
}

restRoutes.get("/star", permMiddleware(PERM.FAVORITES_MANAGE), (c) => {
  const user = c.get("user");
  if (!user) return c.json(fail(40, "Unauthorized"));
  const ids = parseStarIds(getParam(c, "id"));
  const albumIds = parseStarIds(getParam(c, "albumId"));
  const artistIds = parseStarIds(getParam(c, "artistId"));
  for (const id of ids) {
    const existing = db.select().from(userFavoriteSongs).where(and(eq(userFavoriteSongs.userId, user.id), eq(userFavoriteSongs.songId, id))).get();
    if (!existing) db.insert(userFavoriteSongs).values({ userId: user.id, songId: id }).run();
  }
  // Star all songs in albums/artists (schema only stores song favorites)
  for (const aid of albumIds) {
    for (const s of db.select().from(songs).where(eq(songs.albumId, aid)).all()) {
      const existing = db.select().from(userFavoriteSongs).where(and(eq(userFavoriteSongs.userId, user.id), eq(userFavoriteSongs.songId, s.id))).get();
      if (!existing) db.insert(userFavoriteSongs).values({ userId: user.id, songId: s.id }).run();
    }
  }
  for (const arid of artistIds) {
    for (const a of db.select().from(albums).where(eq(albums.artistId, arid)).all()) {
      for (const s of db.select().from(songs).where(eq(songs.albumId, a.id)).all()) {
        const existing = db.select().from(userFavoriteSongs).where(and(eq(userFavoriteSongs.userId, user.id), eq(userFavoriteSongs.songId, s.id))).get();
        if (!existing) db.insert(userFavoriteSongs).values({ userId: user.id, songId: s.id }).run();
      }
    }
  }
  return c.json(ok());
});

restRoutes.get("/unstar", permMiddleware(PERM.FAVORITES_MANAGE), (c) => {
  const user = c.get("user");
  if (!user) return c.json(fail(40, "Unauthorized"));
  const ids = parseStarIds(getParam(c, "id"));
  const albumIds = parseStarIds(getParam(c, "albumId"));
  const artistIds = parseStarIds(getParam(c, "artistId"));
  for (const id of ids) db.delete(userFavoriteSongs).where(and(eq(userFavoriteSongs.userId, user.id), eq(userFavoriteSongs.songId, id))).run();
  for (const aid of albumIds) {
    for (const s of db.select().from(songs).where(eq(songs.albumId, aid)).all()) {
      db.delete(userFavoriteSongs).where(and(eq(userFavoriteSongs.userId, user.id), eq(userFavoriteSongs.songId, s.id))).run();
    }
  }
  for (const arid of artistIds) {
    for (const a of db.select().from(albums).where(eq(albums.artistId, arid)).all()) {
      for (const s of db.select().from(songs).where(eq(songs.albumId, a.id)).all()) {
        db.delete(userFavoriteSongs).where(and(eq(userFavoriteSongs.userId, user.id), eq(userFavoriteSongs.songId, s.id))).run();
      }
    }
  }
  return c.json(ok());
});

// OpenSubsonic setRating:id 支持歌曲/专辑/歌手(均为 uuid,无前缀),rating 0–5;
// rating=0 等价删除评分。GET/POST/.view 由底部兼容垫片统一补全。
restRoutes.all("/setRating", permMiddleware(PERM.FAVORITES_MANAGE), async (c) => {
  const user = c.get("user");
  if (!user) return c.json(fail(40, "Unauthorized"));
  const body = await parseBody(c);
  const id = String(body.id || getParam(c, "id") || "");
  const rating = Math.max(0, Math.min(5, parseInt(String(body.rating ?? getParam(c, "rating") ?? "0"), 10) || 0));
  if (!id) return c.json(fail(10, "Missing id"));
  let itemType: string | null = null;
  if (db.select({ id: songs.id }).from(songs).where(eq(songs.id, id)).get()) itemType = "song";
  else if (db.select({ id: albums.id }).from(albums).where(eq(albums.id, id)).get()) itemType = "album";
  else if (db.select({ id: artists.id }).from(artists).where(eq(artists.id, id)).get()) itemType = "artist";
  if (!itemType) return c.json(fail(70, "Item not found"));
  const now = new Date().toISOString();
  if (rating === 0) {
    db.delete(userRatings).where(and(eq(userRatings.userId, user.id), eq(userRatings.itemType, itemType), eq(userRatings.itemId, id))).run();
  } else {
    db.insert(userRatings).values({ userId: user.id, itemType, itemId: id, rating, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: [userRatings.userId, userRatings.itemType, userRatings.itemId], set: { rating, updatedAt: now } }).run();
  }
  return c.json(ok());
});

restRoutes.get("/getStarred", permMiddleware(PERM.FAVORITES_MANAGE), (c) => {
  const user = c.get("user");
  if (!user) return c.json(ok({ starred: { song: [], album: [], artist: [] } }));
  const favs = db.select().from(userFavoriteSongs).where(eq(userFavoriteSongs.userId, user.id)).all();
  const starredSet = new Set(favs.map(f => f.songId));
  const favSongs = favs.map(f => { const song = db.select().from(songs).where(eq(songs.id, f.songId)).get(); return song ? songToChild(song, starredSet) : null; }).filter(Boolean);
  return c.json(ok({ starred: { song: favSongs, album: [], artist: [] } }));
});

restRoutes.get("/getStarred2", permMiddleware(PERM.FAVORITES_MANAGE), (c) => {
  const user = c.get("user");
  if (!user) return c.json(ok({ starred2: { song: [], album: [], artist: [], songTotal: 0 } }));
  const favs = db.select().from(userFavoriteSongs).where(eq(userFavoriteSongs.userId, user.id)).all();
  const favIds = favs.map(f => f.songId);
  const q = (getParam(c, "query") || "").trim().toLowerCase();
  // 搜索:在整份最爱 ID 集上做 SQL 过滤(title/artist/album),再分页,保证 total 正确。
  let matched: Set<string> | null = null;
  if (q && favIds.length) {
    const rows = db.select({ id: songs.id }).from(songs)
      .where(and(inArray(songs.id, favIds),
        or(like(songs.title, `%${q}%`), like(songs.artist, `%${q}%`), like(songs.album, `%${q}%`)))).all();
    matched = new Set(rows.map(r => r.id));
  }
  const ordered = matched ? favs.filter(f => matched!.has(f.songId)) : favs;
  const songTotal = ordered.length;
  const starredSet = new Set(favIds);
  const offset = Math.max(0, parseInt(getParam(c, "offset") || "0", 10) || 0);
  const size = parseInt(getParam(c, "size") || "0", 10) || 0;
  const slice = size > 0 ? ordered.slice(offset, offset + size) : ordered;
  // Only fetch the songs on the requested page (not the whole favorite list),
  // so a library with thousands of starred tracks doesn't pull them all at once.
  const favSongs = slice.map(f => { const song = db.select().from(songs).where(eq(songs.id, f.songId)).get(); return song ? songToChild(song, starredSet) : null; }).filter(Boolean);
  // Starred album ids in ONE batched query (was N+1: a songs query per favorite).
  const starredAlbumIds = new Set<string>();
  if (favIds.length) {
    const rows = db.select({ albumId: songs.albumId }).from(songs).where(inArray(songs.id, favIds)).all();
    for (const r of rows) if (r.albumId) starredAlbumIds.add(r.albumId);
  }
  const favAlbums = Array.from(starredAlbumIds).map(id => { const a = db.select().from(albums).where(eq(albums.id, id)).get(); return a ? albumToID3(a) : null; }).filter(Boolean);
  return c.json(ok({ starred2: { song: favSongs, album: favAlbums, artist: [], songTotal } }));
});

// ==================== Scrobble ====================

// 播放历史去重窗口:同一用户同一首歌 10 分钟内重复播放,只保留最新的一次记录
// (UPDATE played_at 刷新,不新增行)。用 DB 查询实现,重启不丢状态,替代旧的
// 10 秒内存 Map 去重。songs.playCount 仍按真实播放次数累加。
const HISTORY_DEDUPE_WINDOW_MS = 10 * 60 * 1000; // 10 分钟

restRoutes.get("/scrobble", permMiddleware(PERM.HISTORY_MANAGE), (c) => {
  const user = c.get("user");
  const id = getParam(c, "id");
  const nowIso = new Date().toISOString();
  if (!user || !id) return c.json(ok());
  const submission = (getParam(c, "submission") || "true") !== "false";
  if (submission) {
    const windowStart = new Date(Date.now() - HISTORY_DEDUPE_WINDOW_MS).toISOString();
    // 10 分钟内已有同一首歌 → 只刷新播放时间(保留最新一次);否则插入新记录。
    const existing = db.select({ id: playHistory.id }).from(playHistory)
      .where(and(eq(playHistory.userId, user.id), eq(playHistory.songId, id), gt(playHistory.playedAt, windowStart)))
      .get();
    if (existing) {
      db.update(playHistory).set({ playedAt: nowIso }).where(eq(playHistory.id, existing.id)).run();
    } else {
      db.insert(playHistory).values({ userId: user.id, songId: id, playedAt: nowIso }).run();
    }
    db.update(songs).set({ playCount: sql`${songs.playCount} + 1` }).where(eq(songs.id, id)).run();
  }
  // Dispatch to enabled scrobbler plugins (Last.fm / ListenBrainz / ...).
  // Fire-and-forget: a scrobbler failure must never break the request, and the
  // plugin layer already isolates each scrobbler's errors.
  // 派发去重:客户端(尤其 OpenSubsonic)会对同一首歌连发多个 /scrobble——
  // now-playing 常连发多次、submission 偶发重复。playHistory 的去重只挡 DB
  // 写入、挡不住插件派发,这里按「用户+歌曲+窗口」只放行一次,否则每次调用
  // 都会真实地向 Last.fm / ListenBrainz 提交一条重复收听记录。
  try {
    const songRow: any = db.select().from(songs).where(eq(songs.id, id)).get();
    const event = {
      songId: id,
      title: songRow?.title || "",
      artist: songRow?.artist || "",
      album: songRow?.album || undefined,
      duration: songRow?.duration || undefined,
      playedAt: nowIso,
    };
    const allowDispatch = submission ? dedupeScrobbleDispatch(user.id, id) : dedupePlayDispatch(user.id, id);
    if (allowDispatch) notifyScrobble(submission ? "scrobble" : "play", event).catch(() => {});
  } catch { /* never block the scrobble response */ }
  return c.json(ok());
});

restRoutes.get("/getNowPlaying", (c) => c.json(ok({ nowPlaying: { entry: [] } })));

// ==================== Lyrics ====================

restRoutes.get("/getLyrics", permMiddleware(PERM.LYRICS_VIEW), async (c) => {
  const artist = getParam(c, "artist") || "";
  const title = getParam(c, "title") || "";
  let song: any = null;
  if (title) {
    song = db.select().from(songs).where(and(eq(songs.title, title), eq(songs.artist, artist || ""))).get()
      || db.select().from(songs).where(eq(songs.title, title)).get();
  }
  if (!song) return c.json(ok({ lyrics: { artist, title, value: "" } }));
  const lines = await getLyricsForSongId(song.id);
  const value = lines ? lines.map(l => `[${fmtLrcTime(l.time)}]${l.text}`).join("\n") : "";
  return c.json(ok({ lyrics: { artist, title, value } }));
});

restRoutes.get("/getLyricsBySongId", permMiddleware(PERM.LYRICS_VIEW), async (c) => {
  const id = getParam(c, "id") || "";
  const song = db.select().from(songs).where(eq(songs.id, id)).get();
  let lines = null;
  if (song) {
    lines = await getLyricsForSong(song as any);
  } else if (id.startsWith("remote:")) {
    // 远程未入库歌曲(web 端 remote:<provider>:<source>:<rid> 直放,无 DB 行):用请求
    // 里的曲目字段现场构造虚拟 web 歌曲,复用同一条在线歌词管线(lyricProvider 搜索 /
    // legacy lyricUrl)。title/artist/album/duration/cover 由前端在查询串中携带。
    const parts = id.split(":");
    const providerId = parts[1] || "";
    const source = parts[2] || "";
    const rid = parts.slice(3).join(":");
    const cfg = getConfiguredProvider(providerId);
    if (cfg && source && rid) {
      const title = getParam(c, "title") || "";
      const artist = getParam(c, "artist") || "";
      const album = getParam(c, "album") || "";
      const duration = Number(getParam(c, "duration") || 0) || 0;
      const virtualSong = {
        id: rid,
        title,
        artist,
        album,
        duration,
        type: "web",
        pluginEntry: providerId,
        url: cfg.provider.streamUrl(cfg.config, {
          source,
          id: rid,
          name: title || "Unknown",
          artist: artist || "Unknown",
          album,
          duration,
          cover: getParam(c, "cover") || "",
        }),
        sourceData: JSON.stringify({ source, extra: null }),
      };
      lines = await getLyricsForSong(virtualSong);
    }
  }
  if (!lines) return c.json(ok({ lyricsList: { structuredLyrics: [] } }));
  return c.json(ok({ lyricsList: { structuredLyrics: [lrcToStructured(lines, "und")] } }));
});

function fmtLrcTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec - Math.floor(sec)) * 1000);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

// ==================== Media retrieval ====================

function parseSongPath(p: string): { type: "w" | "l"; sourceId: string; filePath: string } | null {
  const colon1 = p.indexOf(":");
  if (colon1 < 0) return null;
  const prefix = p.slice(0, colon1);
  const rest = p.slice(colon1 + 1);
  const colon2 = rest.indexOf(":");
  if (colon2 < 0) return null;
  return { type: prefix as "w" | "l", sourceId: rest.slice(0, colon2), filePath: rest.slice(colon2 + 1) };
}

function getWebDAVUrl(sourceConfig: any, filePath: string): string {
  const origin = new URL(sourceConfig.url).origin;
  return origin + filePath;
}

// Stream an online/plugin song. Serves the local cache file if present, otherwise
// proxies the song's remote `url` applying its `streamHeaders` (e.g. Referer) + Range.
async function serveWebSongStream(c: any, song: any, rangeHeader?: string | null) {
  try {
    const fs = await import("fs");
    if (song.cachePath && fs.existsSync(song.cachePath)) {
      const filePath = song.cachePath;
      const fileSize = fs.statSync(filePath).size;
      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (match) {
          const start = parseInt(match[1]);
          const end = match[2] ? parseInt(match[2]) : fileSize - 1;
          const chunkSize = end - start + 1;
          const stream = fs.createReadStream(filePath, { start, end });
          return new Response(stream as any, {
            status: 206,
            headers: {
              "Content-Type": MIME_MAP[song.suffix || ""] || "application/octet-stream",
              "Content-Range": `bytes ${start}-${end}/${fileSize}`,
              "Content-Length": String(chunkSize),
              "Accept-Ranges": "bytes",
            },
          });
        }
      }
      const stream = fs.createReadStream(filePath);
      return new Response(stream as any, {
        status: 200,
        headers: {
          "Content-Type": MIME_MAP[song.suffix || ""] || "application/octet-stream",
          "Content-Length": String(fileSize),
          "Accept-Ranges": "bytes",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    // Remote proxy with per-song headers (e.g. Bilibili requires Referer).
    if (!song.url) return c.json(fail(0, "No stream url"));
    const headers: Record<string, string> = {};
    try { Object.assign(headers, JSON.parse(song.streamHeaders || "{}")); } catch {}
    if (rangeHeader) headers["Range"] = rangeHeader;

    let url = song.url;
    let upstream = await fetch(url, { headers });

    // If the original platform could not resolve this song, try an automatic
    // multi-source fallback (search the same provider for a working alternative).
    // 触发条件含 403(地区版权封锁)与 404/5xx,全代理链路(本机 /rest/stream、
    // /rest/stream-remote、/dlna/stream)统一命中。仅当换源命中时才 cancel 原 body;
    // 未命中(无可播替代/normalize 失配)保留原始失败响应原样透传,避免把已锁定
    // 的 body 再交给 c.body() 抛错。
    if ((upstream.status === 404 || upstream.status === 403 || upstream.status >= 500) && song.pluginEntry && song.sourceData) {
      try {
        const sd = JSON.parse(song.sourceData || "{}");
        const fb = await findFallbackStream(
          song.id, song.title || sd?.title || "", song.artist || sd?.artist || "", song.album || "",
          song.pluginEntry, sd?.source || "",
        );
        if (fb) {
          await upstream.body?.cancel();
          url = fb.url;
          upstream = await fetch(url, { headers });
        }
      } catch {
        // keep original upstream result
      }
    }

    const respHeaders: Record<string, string> = {
      "Content-Type": upstream.headers.get("content-type") || MIME_MAP[song.suffix || ""] || "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
    };
    const cl = upstream.headers.get("content-length");
    if (cl) respHeaders["Content-Length"] = cl;
    const cr = upstream.headers.get("content-range");
    if (cr) respHeaders["Content-Range"] = cr;
    return c.body(upstream.body as any, upstream.status as any, respHeaders);
  } catch (e: any) {
    return c.json(fail(0, e.message || "Stream failed"));
  }
}

restRoutes.get("/stream", permMiddleware(PERM.LIBRARY_STREAM), async (c) => {
  const id = getParam(c, "id") || "";
  const song = db.select().from(songs).where(eq(songs.id, id)).get();
  if (!song) return c.json(fail(70, "Song not found"));

  const rangeHeader = c.req.header("range");
  const timeOffset = parseInt(getParam(c, "timeOffset") || "0") || 0;
  const format = getParam(c, "format"); // "raw" = no transcode; other formats unsupported

  // Online song (built-in source plugin): serve local cache first, else proxy `url` with its headers.
  if ((song.type || "local") === "web") {
    return serveWebSongStream(c, song, rangeHeader);
  }
  const parsed = parseSongPath(song.path);
  if (!parsed) return c.json(fail(0, "Invalid song path"));

  try {
    if (parsed.type === "w") {
      const source = db.select().from(mediaSources).where(eq(mediaSources.id, parsed.sourceId)).get();
      if (!source) return c.json(fail(0, "Source not found"));
      const config = JSON.parse(source.config || "{}");
      const downloadUrl = getWebDAVUrl(config, parsed.filePath);
      const headers: Record<string, string> = {};
      if (config.username && config.password) {
        headers["Authorization"] = "Basic " + Buffer.from(`${config.username}:${config.password}`).toString("base64");
      }
      if (rangeHeader) headers["Range"] = rangeHeader;

      const upstream = await fetch(downloadUrl, { headers });
      const respHeaders: Record<string, string> = {};
      const ct = upstream.headers.get("content-type");
      if (ct) respHeaders["Content-Type"] = ct;
      else respHeaders["Content-Type"] = MIME_MAP[song.suffix || ""] || "application/octet-stream";
      const cl = upstream.headers.get("content-length");
      if (cl) respHeaders["Content-Length"] = cl;
      const cr = upstream.headers.get("content-range");
      if (cr) respHeaders["Content-Range"] = cr;
      respHeaders["Accept-Ranges"] = "bytes";
      respHeaders["Cache-Control"] = "public, max-age=3600";

      return c.body(upstream.body as any, upstream.status as any, respHeaders);
    } else {
      const fs = await import("fs");
      const filePath = parsed.filePath;
      if (!fs.existsSync(filePath)) return c.json(fail(70, "File not found"));
      const stat = fs.statSync(filePath);
      const fileSize = stat.size;

      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (match) {
          const start = parseInt(match[1]);
          const end = match[2] ? parseInt(match[2]) : fileSize - 1;
          const chunkSize = end - start + 1;
          const stream = fs.createReadStream(filePath, { start, end });
          return new Response(stream as any, {
            status: 206,
            headers: {
              "Content-Type": MIME_MAP[song.suffix || ""] || "application/octet-stream",
              "Content-Range": `bytes ${start}-${end}/${fileSize}`,
              "Content-Length": String(chunkSize),
              "Accept-Ranges": "bytes",
            },
          });
        }
      }

      const stream = fs.createReadStream(filePath);
      return new Response(stream as any, {
        status: 200,
        headers: {
          "Content-Type": MIME_MAP[song.suffix || ""] || "application/octet-stream",
          "Content-Length": String(fileSize),
          "Accept-Ranges": "bytes",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }
  } catch (e: any) {
    return c.json(fail(0, e.message || "Stream failed"));
  }
});

// ==================== DLNA 投屏 CDS 播放清单 (链路 B) ====================
// DLNA 设备(电视/盒子/Kodi)作为渲染器可依 ContentDirectory (DIDL-Lite) 容器按序
// 自播整段列表。服务端以请求携带的队列 id 列表构造标准容器:设备拿到容器后逐个
// item 从 /rest/stream **直连拉流** → 手机被杀也能整列表续播(符合 DLNA 标准)。
// 鉴权与 /rest/stream 一致;item 的 res 复用本次请求的 token(query 串令牌认证,
// 让无法携带 header 的渲染器仅凭 URL 即可直连拉流)。
restRoutes.get("/castPlaylist", permMiddleware(PERM.LIBRARY_STREAM), async (c) => {
  const songIds = getParams(c, "songs").flatMap(s => s.split(",")).map(s => s.trim()).filter(Boolean);
  if (songIds.length === 0) return c.json(fail(0, "No songs specified"));
  const token = getParam(c, "token") || "";

  const rows = db.select().from(songs).where(inArray(songs.id, songIds)).all();
  // 按请求顺序排列(队列语义),跳过已不存在的 id。
  const ordered = songIds.map(id => rows.find(r => r.id === id)).filter((r): r is any => !!r);

  // 绝对 base url:优先反代 X-Forwarded-*,否则用请求 Host(渲染器在 LAN 内直连)。
  const fwdProto = c.req.header("x-forwarded-proto");
  const proto = fwdProto ? fwdProto.split(",")[0].trim() : (new URL(c.req.url).protocol.replace(":", "") || "http");
  const host = c.req.header("x-forwarded-host") || c.req.header("host");
  const base = `${proto}://${host}`;

  const xmlEscape = (v: string): string => String(v ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
  const hms = (sec: number): string => {
    const s = Math.floor(sec || 0);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
  };

  let xml = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
    `xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">` +
    `<container id="cast-queue" parentID="0" restricted="false" childCount="${ordered.length}">` +
    `<dc:title>MusicFlow 投屏队列</dc:title>` +
    `<upnp:class>object.container.playlistContainer.musicPlaylist</upnp:class>` +
    `</container>`;

  for (const s of ordered) {
    const mime = MIME_MAP[s.suffix || ""] || s.contentType || "audio/mpeg";
    const resUrl = `${base}/rest/stream?id=${encodeURIComponent(s.id)}` +
      (token ? `&token=${encodeURIComponent(token)}` : "");
    xml += `<item id="so-${xmlEscape(s.id)}" parentID="cast-queue" restricted="false">` +
      `<dc:title>${xmlEscape(s.title)}</dc:title>` +
      `<dc:creator>${xmlEscape(s.artist || "未知艺人")}</dc:creator>` +
      `<upnp:class>object.item.audioItem.musicTrack</upnp:class>` +
      `<res protocolInfo="http-get:*:${xmlEscape(mime)}:*" ` +
      `duration="${hms(s.duration)}" size="">${xmlEscape(resUrl)}</res>` +
      `</item>`;
  }
  xml += `</DIDL-Lite>`;

  return c.body(xml, 200, {
    "Content-Type": "text/xml; charset=\"utf-8\"",
    "Cache-Control": "no-cache",
  });
});

// ==================== DLNA 连续流 (链路 B 纯 renderer 档) ====================
// HiVi H5MKII 等纯音频 renderer 只能 Set 单个 URI:既不暴露 ContentDirectory(/castPlaylist
// 的 CDS 容器无效),也不支持 SetNext(无法 NextURI 预置)。把它们整队列串成**一根连续音频流**:
// 设备 SetAVTransportURI 这个 URL 即一路播到队列末尾——切窗口、手机进程被系统挂起/杀死,
// 设备仍自主连播到底,彻底摆脱对客户端进程与轮询的依赖。
// 鉴权同 /rest/stream;内部对每首复用单曲流逻辑(本地文件 / WebDAV / 远程代理 + 多源换源),
// 逐段写入响应体,无 Content-Length → chunked 无限续传。
async function* openCastStreamChunks(song: any): AsyncGenerator<Uint8Array> {
  if ((song.type || "local") === "web") {
    if (song.cachePath && fs.existsSync(song.cachePath)) {
      for await (const c of fs.createReadStream(song.cachePath)) yield new Uint8Array(c as Buffer);
      return;
    }
    if (!song.url) throw new Error("No stream url");
    const headers: Record<string, string> = {};
    try { Object.assign(headers, JSON.parse(song.streamHeaders || "{}")); } catch {}
    let upstream = await fetch(song.url, { headers });
    if ((upstream.status === 404 || upstream.status === 403 || upstream.status >= 500) && song.pluginEntry && song.sourceData) {
      try {
        const sd = JSON.parse(song.sourceData || "{}");
        const fb = await findFallbackStream(song.id, song.title || sd?.title || "", song.artist || sd?.artist || "", song.album || "", song.pluginEntry, sd?.source || "");
        if (fb) { await upstream.body?.cancel(); upstream = await fetch(fb.url, { headers }); }
      } catch {}
    }
    if (!upstream.body) throw new Error("Empty body");
    const reader = (upstream.body as ReadableStream<Uint8Array>).getReader();
    while (true) { const { done, value } = await reader.read(); if (done) break; yield value; }
    return;
  }
  const parsed = parseSongPath(song.path);
  if (!parsed) throw new Error("Invalid song path");
  if (parsed.type === "w") {
    const source = db.select().from(mediaSources).where(eq(mediaSources.id, parsed.sourceId)).get();
    if (!source) throw new Error("Source not found");
    const config = JSON.parse(source.config || "{}");
    if (!config.username || !config.password) throw new Error("Source auth not configured");
    const headers: Record<string, string> = {
      "Authorization": "Basic " + Buffer.from(`${config.username}:${config.password}`).toString("base64"),
    };
    const upstream = await fetch(getWebDAVUrl(config, parsed.filePath), { headers });
    if (!upstream.body) throw new Error("Empty body");
    const reader = (upstream.body as ReadableStream<Uint8Array>).getReader();
    while (true) { const { done, value } = await reader.read(); if (done) break; yield value; }
    return;
  }
  const filePath = parsed.filePath;
  if (!fs.existsSync(filePath)) throw new Error("File not found");
  for await (const c of fs.createReadStream(filePath)) yield new Uint8Array(c as Buffer);
}

// ---------- 连续流得统一为同一种可解码格式 ----------
// 纯 renderer 把整根 /castStream 当**单一音频流**解。若队列里 mp3/wav/flac 混排,
// 直接逐段拼接 WAV/FLAC(它们自带容器头)得到的字节流,renderer 会按首曲格式解码而
// 在格式切换处解出噪音/停顿。所以:只要队列里存在非 mp3 的歌曲,就用 ffmpeg 把非 mp3
// 的每首重编码为 mp3(LAME, 192k),与 mp3 曲目的原生帧一起拼成一根纯 mp3 连续流
// (mp3 帧自带边界,拼接天然合法)。全队列都是 mp3 时走 0 转码快速通道。

// 把单首不可直接拼接的歌曲经 ffmpeg 重编码为 mp3,逐块产出。
async function* transcodeSongToMp3(song: any): AsyncGenerator<Uint8Array> {
  const parsed = parseSongPath(song.path);
  // 输入: 本地文件最优先;否则用远程 URL(含必需 headers)。
  let input = "";
  let headers: Record<string, string> = {};
  if ((song.type || "local") === "web") {
    if (song.cachePath && fs.existsSync(song.cachePath)) {
      input = song.cachePath;
    } else if (song.url) {
      input = song.url;
      try { Object.assign(headers, JSON.parse(song.streamHeaders || "{}")); } catch {}
    } else {
      throw new Error("No stream source");
    }
  } else if (parsed) {
    if (parsed.type === "w") {
      const source = db.select().from(mediaSources).where(eq(mediaSources.id, parsed.sourceId)).get();
      if (!source) throw new Error("Source not found");
      const config = JSON.parse(source.config || "{}");
      if (!config.username || !config.password) throw new Error("Source auth not configured");
      input = getWebDAVUrl(config, parsed.filePath);
      headers = { "Authorization": "Basic " + Buffer.from(`${config.username}:${config.password}`).toString("base64") };
    } else {
      input = parsed.filePath;
      if (!fs.existsSync(input)) throw new Error("File not found");
    }
  } else {
    throw new Error("Unsupported source");
  }

  const args = ["-v", "error", "-nostdin", "-i", input];
  if (Object.keys(headers).length) {
    args.push("-headers", Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n"));
  }
  args.push("-f", "mp3", "-acodec", "libmp3lame", "-b:a", "192k",
    // 统一采样率/声道,避免混排时(如 48k 的 opus 段)中段采样率突变导致解码器报错。
    "-ar", "44100", "-ac", "2",
    // 去掉每段自带的 ID3v2 标签与 Xing/Info 头,让拼接处=纯 MPEG frame,无缝可解码。
    "-write_xing", "0", "-id3v2_version", "0", "-map_metadata", "-1",
    "-y", "pipe:1");

  const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  const errBuf: Buffer[] = [];
  proc.stderr?.on("data", (c) => errBuf.push(c as Buffer));
  let spawned = false;
  await new Promise<void>((resolve, reject) => {
    proc.once("spawn", () => { spawned = true; resolve(); });
    proc.once("error", reject);
  });
  for await (const chunk of proc.stdout) yield new Uint8Array(chunk as Buffer);
  await new Promise<void>((resolve, reject) => {
    proc.once("close", (code) => code === 0 ? resolve() : reject(new Error("ffmpeg exit " + code + ": " + Buffer.concat(errBuf).toString("utf8").slice(0, 200))));
  });
}

// 返回可剥头拼帧的本地 mp3 文件路径(web 有 cachePath / 本地非 webdav),否则 null。
function localMp3FilePath(song: any): string | null {
  if ((song.type || "local") === "web") {
    if (song.cachePath && fs.existsSync(song.cachePath)) return song.cachePath;
    return null;
  }
  const parsed = parseSongPath(song.path);
  if (parsed && parsed.type !== "w" && fs.existsSync(parsed.filePath)) return parsed.filePath;
  return null;
}

// 探测本地文件首帧是否为 MPEG1-Layer3 44.1kHz 立体声(与重编码目标完全一致)。
// 只读前 64KB 同步到首个帧头即可,微秒级;匹配则走快通道,不匹配则重编码——
// 保证整根流采样率/声道完全一致,纯 renderer 跨曲/跨格式连播不再"嘟嘟"。
function mp3MatchesTarget(filePath: string): boolean {
  let fd: number;
  try { fd = fs.openSync(filePath, "r"); } catch { return false; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= 4) return false;
    let offset = 0;
    // 跳过 ID3v2 头。
    {
      const b = Buffer.alloc(10);
      if (size >= 10 && fs.readSync(fd, b, 0, 10, 0) === 10 && b.toString("ascii", 0, 3) === "ID3") {
        const sz = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
        offset = Math.min(10 + sz + ((b[5] & 0x10) ? 10 : 0), size);
      }
    }
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, offset);
    // 找首个 0xFFE 帧同步:MPEG1(ver=3)+LayerIII(layer=1)+srIdx0(44.1k)+非 mono。
    for (let i = 0; i + 4 < n; i++) {
      if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
        const verBits = (buf[i + 1] >> 3) & 0x03;
        const layerBits = (buf[i + 1] >> 1) & 0x03;
        const srIdx = (buf[i + 2] >> 2) & 0x03;
        const chMode = (buf[i + 3] >> 6) & 0x03;
        return verBits === 3 && layerBits === 1 && srIdx === 0 && chMode !== 3;
      }
    }
    return false;
  } finally { fs.closeSync(fd); }
}

async function* remuxLocalFile(filePath: string): AsyncGenerator<Uint8Array> {
  let size = 0;
  try { size = fs.statSync(filePath).size; } catch { return; }
  if (size <= 0) return;
  // 剥掉开头的 ID3v2 头(10 字节主头 + 变长同步位标签长度,可能带 10 字节 footer)。
  let start = 0;
  try {
    const b = Buffer.alloc(10);
    const fd = fs.openSync(filePath, "r");
    try {
      if (fs.readSync(fd, b, 0, 10, 0) === 10 && b.toString("ascii", 0, 3) === "ID3") {
        const sz = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
        let skip = 10 + sz;
        if ((b[5] & 0x10) !== 0) skip += 10; // v2.4 footer
        start = Math.min(skip, size);
      }
    } finally { fs.closeSync(fd); }
  } catch {}
  // 剥掉结尾的 ID3v1 尾(128 字节,末尾 "TAG")。
  let end = size;
  if (size >= 128) {
    try {
      const tb = Buffer.alloc(128);
      const fd = fs.openSync(filePath, "r");
      try {
        if (fs.readSync(fd, tb, 0, 128, size - 128) === 128 && tb.toString("ascii", 0, 3) === "TAG") {
          end = size - 128;
        }
      } finally { fs.closeSync(fd); }
    } catch {}
  }
  if (end <= start) return;
  for await (const c of fs.createReadStream(filePath, { start, end: end - 1 })) {
    yield new Uint8Array(c as Buffer);
  }
}

// 连续流「短令牌」表:客户端把整队列一次交给服务端存成短 token,纯 renderer 再用一个很短的
// URL(/rest/castStream?token=xxx)拉流;把「队列条数」与「renderer 现场 URL 长度」解耦。
// 原因:300 首 UUID 逗号拼出的 ~12KB 超长 URI 会被 HiVi 等嵌入式 renderer 截断/拒拉。
// token 仅内存驻留,插入时惰性清理过期项防无界增长。
const castStreamTokens = new Map<string, { ids: string[]; ts: number; file?: string; size?: number }>();
function newCastStreamToken(ids: string[]): string {
  const now = Date.now();
  if (castStreamTokens.size > 2000) {
    for (const [k, v] of castStreamTokens) {
      if (now - v.ts > 24 * 3600 * 1000) castStreamTokens.delete(k);
    }
    if (castStreamTokens.size > 2000) castStreamTokens.clear(); // 极端兜底
  }
  const token = "cs_" + now.toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  castStreamTokens.set(token, { ids, ts: now });
  return token;
}

// 把整队列统一重编码为**一个**带 Content-Length、可 Range 的 mp3 文件,再按普通文件流
// (206/Range/Content-Length/Accept-Ranges)交给 renderer。原因:设备只对「有限大小、可探测
// 长度」的媒体稳定播放;旧的实时 chunked 无 Content-Length 连续流,会让 HiVi 等纯 renderer
// 在播放十几秒后自行停播并报错(两声嘟嘟)——与单曲 /stream 文件流能正常播放形成对照。
async function renderCastQueueToFile(ordered: any[]): Promise<{ file: string; size: number }> {
  const file = path.join(os.tmpdir(), `mf-cast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`);
  await pipeline(
    Readable.from(castQueueGenerator(ordered) as AsyncGenerator<Uint8Array>),
    fs.createWriteStream(file),
  );
  return { file, size: fs.statSync(file).size };
}

async function* castQueueGenerator(ordered: any[]): AsyncGenerator<Uint8Array> {
  for (const s of ordered) {
    try {
      const f = localMp3FilePath(s);
      // 仅当本地文件是 MPEG1-Layer3 44.1kHz 立体声时才走剥头快通道(零转码);
      // 其它(48k/22k、mono、非 mp3)一律重编码为统一 44.1k/2ch 无头 mp3。
      // 这是整根流采样率/声道完全一致的前提——纯 renderer 跨曲/跨格式连播不再"嘟嘟"。
      if (f && mp3MatchesTarget(f)) {
        yield* remuxLocalFile(f);
      } else {
        yield* transcodeSongToMp3(s);
      }
    } catch {
      // 单首不可播 → 跳过,不中断整段。
    }
  }
}
// 每个 token 只整根渲染一次;并发 Range/HEAD/GET 探针共享同一在途渲染,避免重复 ffmpeg。
const castRenderInflight = new Map<string, Promise<{ file: string; size?: number }>>();
async function ensureCastRender(
  rec: { file?: string; size?: number },
  ordered: any[],
  token: string,
): Promise<{ file: string; size: number }> {
  if (rec.file) return { file: rec.file, size: rec.size! };
  let p = castRenderInflight.get(token);
  if (!p) {
    p = (async () => {
      const r = await renderCastQueueToFile(ordered);
      rec.file = r.file;
      rec.size = r.size;
      return r;
    })();
    castRenderInflight.set(token, p);
    p.finally(() => castRenderInflight.delete(token)).catch(() => {});
  }
  const r = await p;
  return { file: r.file, size: r.size! };
}

function serveCastFile(c: any, file: string, size: number, rangeHeader: string | null) {
  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1]);
      const end = match[2] ? parseInt(match[2]) : size - 1;
      const chunkSize = end - start + 1;
      return new Response(fs.createReadStream(file, { start, end }) as any, {
        status: 206,
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Content-Length": String(chunkSize),
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-cache",
        },
      });
    }
  }
  return new Response(fs.createReadStream(file) as any, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
    },
  });
}

restRoutes.get("/castStream", permMiddleware(PERM.LIBRARY_STREAM), async (c) => {
  const token = (getParam(c, "token") || "").trim();
  const create = getParam(c, "create") === "1";

  // 已有 token:renderer 现场拉流,按短链解析队列(不再依赖超长的 songs 列表)。
  let ordered: any[];
  if (token) {
    const rec = castStreamTokens.get(token);
    if (!rec) return c.json(fail(0, "Invalid or expired stream token"));
    const ids = rec.ids;
    const trows = db.select().from(songs).where(inArray(songs.id, ids)).all();
    ordered = ids.map(id => trows.find(r => r.id === id)).filter((r): r is any => !!r);
    if (ordered.length === 0) return c.json(fail(0, "No playable songs"));
  } else {
    const songIds = getParams(c, "songs").flatMap(s => s.split(",")).map(s => s.trim()).filter(Boolean);
    if (songIds.length === 0) return c.json(fail(0, "No songs specified"));
    const rows = db.select().from(songs).where(inArray(songs.id, songIds)).all();
    ordered = songIds.map(id => rows.find(r => r.id === id)).filter((r): r is any => !!r);
    if (ordered.length === 0) return c.json(fail(0, "No playable songs"));
  }

  if (create) {
    // 客户端一次性把队列交给服务端:立刻返回短 token,整根连续流在后台渲染
    // (mp3 段走 remux 快通道亚秒级;非 mp3 段才 ffmpeg 转码)。这样 create 永不阻塞
    // 到超过客户端超时——修复此前「队列入库→后台慢转码→create 超时→回退超长 URL→
    // renderer 解码报错(两声嘟嘟)」的根因。
    const t = newCastStreamToken(ordered.map(s => s.id));
    const rec = castStreamTokens.get(t)!;
    ensureCastRender(rec, ordered, t).catch(() => {});
    return c.json(ok({ stream: { token: t } }));
  }

  // 末尾:整队列统一重编码为单个可 Range 的 mp3 文件后,按普通文件流交给 renderer。
  const rec = token ? castStreamTokens.get(token)! : ({ file: undefined, size: undefined } as any);
  const { file, size } = await ensureCastRender(rec, ordered, token || `inline:${ordered[0]?.id}:${ordered.length}`);
  return serveCastFile(c, file, size, c.req.header("range") ?? null);
});

// ==================== Remote stream proxy (未入库远程歌曲直播) ====================
// 搜索结果的远程歌曲(尚未「加入库」,无 DB 行)直接播放:按 provider/source/id 现场
// 调用插件的 streamUrl() 拿到真实流地址,再复用 serveWebStreamSong 的代理逻辑
// (Range + 按源补 Referer 等 headers)。主项目前端与 HA 卡片「搜索即播」都走这里,
// 播放不要求先入库。参数: provider, source, id, title, artist, album, duration, cover
restRoutes.get("/stream-remote", permMiddleware(PERM.LIBRARY_STREAM), async (c) => {
  const providerId = getParam(c, "provider") || "";
  const source = getParam(c, "source") || "";
  const id = getParam(c, "id") || "";
  if (!providerId || !source || !id) return c.json(fail(0, "Missing provider/source/id"));
  const cfg = getConfiguredProvider(providerId);
  if (!cfg) return c.json(fail(0, "在线源未启用或未配置"));
  const song = {
    id,
    source,
    name: getParam(c, "title") || "",
    artist: getParam(c, "artist") || "",
    album: getParam(c, "album") || "",
    duration: parseInt(getParam(c, "duration") || "0") || 0,
    cover: getParam(c, "cover") || "",
  };
  try {
    const streamUrl = cfg.provider.streamUrl(cfg.config, song);
    if (!streamUrl) return c.json(fail(0, "No stream url"));
    const streamHeaders: Record<string, string> = {};
    if (source === "bilibili") streamHeaders["Referer"] = "https://www.bilibili.com/";
    // 现场构造 web-song 形状(无 cachePath/未缓存),并补 pluginEntry/sourceData 让
    // serveWebSongStream 复用与 /rest/stream 同一套「多源换源」:原平台 404/VIP 时按
    // 严格「歌名-歌手」换到其它平台可播候选(与本机 DLNA 本地播放行为一致)。
    // id 用合成 key 隔离换源缓存,避免与库内真实歌曲混淆(无 DB 行,写回为 no-op)。
    return serveWebSongStream(c, {
      id: `remote:${providerId}:${source}:${id}`,
      title: song.name,
      artist: song.artist,
      album: song.album,
      suffix: "mp3",
      type: "web",
      url: streamUrl,
      streamHeaders: JSON.stringify(streamHeaders),
      cachePath: null,
      pluginEntry: providerId,
      sourceData: JSON.stringify({ source, title: song.name, artist: song.artist }),
    }, c.req.header("range"));
  } catch (e: any) {
    return c.json(fail(0, e.message || "Remote stream failed"));
  }
});

// ==================== DLNA stream (token-auth-free) ====================
// DLNA renderers pull bytes via a plain HTTP GET and cannot send auth headers.
// This endpoint resolves a cast token (created by castToDevice) to a songId,
// then streams the file exactly like /rest/stream. Registered without auth.
restRoutes.get("/dlna/stream/:token", async (c) => {
  const token = c.req.param("token");
  const songId = resolveCastToken(token);
  if (!songId) return c.text("Invalid or expired cast token", 403);

  const song = db.select().from(songs).where(eq(songs.id, songId)).get();
  if (!song) return c.text("Song not found", 404);

  const rangeHeader = c.req.header("range");
  // Online/plugin song (type="web", path like "web:provider:source"): proxy the
  // song's remote url (with per-song headers + Range), same as /rest/stream.
  if (song.type === "web") {
    return serveWebSongStream(c, song, rangeHeader);
  }

  const parsed = parseSongPath(song.path);
  if (!parsed) return c.text("Invalid song path", 400);

  try {
    if (parsed.type === "w") {
      const source = db.select().from(mediaSources).where(eq(mediaSources.id, parsed.sourceId)).get();
      if (!source) return c.text("Source not found", 404);
      const config = JSON.parse(source.config || "{}");
      const downloadUrl = getWebDAVUrl(config, parsed.filePath);
      const headers: Record<string, string> = {};
      if (config.username && config.password) {
        headers["Authorization"] = "Basic " + Buffer.from(`${config.username}:${config.password}`).toString("base64");
      }
      if (rangeHeader) headers["Range"] = rangeHeader;
      const upstream = await fetch(downloadUrl, { headers });
      const respHeaders: Record<string, string> = {
        "Content-Type": MIME_MAP[song.suffix || ""] || "application/octet-stream",
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
      };
      const ct = upstream.headers.get("content-type");
      if (ct) respHeaders["Content-Type"] = ct;
      const cl = upstream.headers.get("content-length");
      if (cl) respHeaders["Content-Length"] = cl;
      const cr = upstream.headers.get("content-range");
      if (cr) respHeaders["Content-Range"] = cr;
      return c.body(upstream.body as any, upstream.status as any, respHeaders);
    } else {
      const fs = await import("fs");
      const filePath = parsed.filePath;
      if (!fs.existsSync(filePath)) return c.text("File not found", 404);
      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const mime = MIME_MAP[song.suffix || ""] || "application/octet-stream";
      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (match) {
          const start = parseInt(match[1]);
          const end = match[2] ? parseInt(match[2]) : fileSize - 1;
          const chunkSize = end - start + 1;
          const stream = fs.createReadStream(filePath, { start, end });
          return new Response(stream as any, {
            status: 206,
            headers: {
              "Content-Type": mime,
              "Content-Range": `bytes ${start}-${end}/${fileSize}`,
              "Content-Length": String(chunkSize),
              "Accept-Ranges": "bytes",
            },
          });
        }
      }
      const stream = fs.createReadStream(filePath);
      return new Response(stream as any, {
        status: 200,
        headers: { "Content-Type": mime, "Content-Length": String(fileSize), "Accept-Ranges": "bytes" },
      });
    }
  } catch (e: any) {
    return c.text(e.message || "Stream failed", 500);
  }
});

restRoutes.get("/download", permMiddleware(PERM.LIBRARY_STREAM), async (c) => {
  const id = getParam(c, "id") || "";
  const song = db.select().from(songs).where(eq(songs.id, id)).get();
  if (!song) return c.json(fail(70, "Song not found"));
  const parsed = parseSongPath(song.path);
  if (!parsed) return c.json(fail(0, "Invalid song path"));
  try {
    if (parsed.type === "w") {
      const source = db.select().from(mediaSources).where(eq(mediaSources.id, parsed.sourceId)).get();
      if (!source) return c.json(fail(0, "Source not found"));
      const config = JSON.parse(source.config || "{}");
      const downloadUrl = getWebDAVUrl(config, parsed.filePath);
      const headers: Record<string, string> = {};
      if (config.username && config.password) {
        headers["Authorization"] = "Basic " + Buffer.from(`${config.username}:${config.password}`).toString("base64");
      }
      const upstream = await fetch(downloadUrl, { headers });
      const respHeaders: Record<string, string> = {
        "Content-Type": MIME_MAP[song.suffix || ""] || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(song.title)}.${song.suffix || "mp3"}"`,
      };
      return c.body(upstream.body as any, upstream.status as any, respHeaders);
    }
    return c.json(fail(0, "Not supported"));
  } catch (e: any) {
    return c.json(fail(0, e.message || "Download failed"));
  }
});

restRoutes.get("/getCoverArt", permMiddleware(PERM.COVER_VIEW), async (c) => {
  // 封面 <img> 经 URL ?token= 鉴权(前端 coverUrl 自动附加,与 /rest/stream 一致),
  // OpenSubsonic 规范要求 getCoverArt 鉴权,故保留 COVER_VIEW 门禁:撤销后 403。
  const id = getParam(c, "id") || "";
  const size = Number(getParam(c, "size") || "300") || 300;
  const accept = c.req.header("Accept") || "";
  const wantWebp = accept.toLowerCase().includes("image/webp");

  // Resolve a cover ref to an on-disk file, trying the same extension
  // fallbacks the old handler used (jpg<->png, plus a webp variant).
  const resolveCandidates = (ref: string | null): string | null => {
    if (!ref) return null;
    const candidates = [
      ref,
      ref.replace(/\.jpg$/i, ".png"),
      ref.replace(/\.png$/i, ".jpg"),
      ref.replace(/\.(?:jpg|png|gif)$/i, ".webp"),
    ];
    for (const cand of candidates) {
      const fp = resolveCoverFile(cand);
      if (fp) return fp;
    }
    return null;
  };

  let filePath: string | null = null;
  if (id.startsWith("al-")) {
    const album = db.select().from(albums).where(eq(albums.id, id.slice(3))).get();
    let coverRef = album?.coverArt || null;
    if (!coverRef && album) {
      // Web/online albums store artwork on their songs; fall back to the first
      // song-with-cover so direct al-<id> requests aren't blank.
      const song = db.select({ coverArt: songs.coverArt }).from(songs)
        .where(and(eq(songs.albumId, album.id), isNotNull(songs.coverArt)))
        .limit(1).get();
      coverRef = song?.coverArt || null;
    }
    filePath = resolveCandidates(coverRef);
  } else if (id.startsWith("so-")) {
    const song = db.select().from(songs).where(eq(songs.id, id.slice(3))).get();
    let coverRef: string | null = null;
    if (song?.albumId) {
      // Prefer album cover; fall back to the song's own cover (web/online songs
      // cache their cover on the song row, not on the album).
      const album = db.select().from(albums).where(eq(albums.id, song.albumId)).get();
      coverRef = album?.coverArt || song.coverArt || null;
    } else coverRef = song?.coverArt || null;
    filePath = resolveCandidates(coverRef);
    // 按需补封面(A):so- 直接请求歌曲封面、本地无文件、且歌曲本身没有
    // cover_art 时,经 coverProvider 插件拉取(独立选源 cover.providerId)。
    // 防风暴在 fetchCoverForSong 内(每首歌失败后短 TTL 不再自动重试)。
    if (!filePath && song && !song.coverArt) {
      try {
        const ref = await fetchCoverForSong(song as any, false);
        if (ref) filePath = resolveCandidates(ref);
      } catch { /* ignore */ }
    }
  } else if (id.startsWith("ar-")) {
    const artist = db.select().from(artists).where(eq(artists.id, id.slice(3))).get();
    if (artist) {
      // Prefer the scraped artist avatar (ar-<id>.jpg); fall back to the artist's first album cover
      let coverRef = artist.coverArt || null;
      if (!coverRef) {
        const firstAlbum = db.select().from(albums).where(eq(albums.artistId, artist.id)).get();
        coverRef = firstAlbum?.coverArt || null;
      }
      filePath = resolveCandidates(coverRef);
    }
  } else if (id.startsWith("pl-")) {
    // Playlist cover: plain local image (imported platform cover or first song's album cover)
    const playlistCover = getPlaylistCover(id.slice(3));
    if (playlistCover) filePath = resolveCoverFile(playlistCover.file);
  } else if (/^https?:\/\//i.test(id)) {
    // 远程封面直链(远程歌曲 / 远程歌单、专辑搜索结果的完整 http URL)在队列、播放器、
    // 详情页会经 getCoverArt 代理。浏览器直连会被部分平台防盗链拦截,后端代理取图稳定,
    // 且与本地封面走同一 <img> 渲染路径。失败静默回落到占位图。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const up = await fetch(id, { signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0" } });
      clearTimeout(timer);
      if (up.ok) {
        const ct = (up.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
        const buf = Buffer.from(await up.arrayBuffer());
        if (buf.length > 100 && /^image\//i.test(ct)) {
          return new Response(new Uint8Array(buf), {
            headers: {
              "Content-Type": ct,
              "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
            },
          });
        }
      }
    } catch { /* 代理失败 → 占位图 */ } finally { clearTimeout(timer); }
  } else {
    filePath = resolveCandidates(id);
  }

  if (filePath) {
    const out = await loadAndRenderCover(filePath, size, wantWebp);
    if (out) {
      const inm = c.req.header("If-None-Match");
      const headers: Record<string, string> = {
        "Content-Type": out.contentType,
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
        "ETag": out.etag,
        "Vary": "Accept",
      };
      if (inm && inm === out.etag) {
        return new Response(null, { status: 304, headers });
      }
      return new Response(out.data as unknown as BodyInit, { headers });
    }
  }

  // Placeholder: no cache so the cover updates as soon as a real one is available
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300"><rect fill="#1a1a2e" width="300" height="300"/><circle cx="150" cy="130" r="50" fill="#16213e"/><circle cx="150" cy="130" r="20" fill="#0f3460"/><rect x="135" y="160" width="30" height="60" rx="4" fill="#e94560" opacity="0.8"/></svg>`;
  return new Response(svg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" } });
});

// libopensonic/MA uses use_views=True by default, appending .view to every endpoint.
// Register .view aliases for all routes so they respond identically.
// libopensonic/MA uses use_views=True, appending .view to endpoints, and POSTs form data.
// Register .view aliases AND POST variants for every GET route so MA/libopensonic can connect.
(function registerCompatRoutes() {
  const seen = new Set<string>();
  for (const route of (restRoutes as any).routes) {
    if (!route.path || route.path === "/*" || route.path.includes(":")) continue;
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (route.path.endsWith(".view")) continue;
    const method = route.method as string;
    const handler = route.handler;
    const variants: string[] = [route.path];
    if (!route.path.endsWith(".view")) variants.push(route.path + ".view");
    for (const p of variants) {
      if (method === "ALL") {
        restRoutes.all(p, handler);
      } else {
        const m = method.toLowerCase();
        restRoutes.on(m as any, p, handler);
        if (m === "get") restRoutes.post(p, handler);
      }
    }
  }
})();
