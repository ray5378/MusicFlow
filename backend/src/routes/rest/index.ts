import { Hono } from "hono";
import { db } from "../../db/index.js";
import { users, songs, albums, artists, playlists, playlistSongs, userFavoriteSongs, playHistory, mediaSources } from "../../db/schema.js";
import { eq, like, sql, or, and, isNotNull, inArray, desc } from "drizzle-orm";
import fs from "fs";
import { getLyricsForSongId, lrcToStructured } from "../../services/lyrics.js";
import { getPlaylistCover, cacheRemoteCover, clearPlaylistCoverCache, resolveCoverFile } from "../../services/playlistCover.js";
import { readCoverFile } from "../../services/coverCache.js";
import { loadAndRenderCover } from "../../services/coverImage.js";
import { DAILY_TAG } from "../../services/plugin/dailyRecommend.js";
import { resolveCastToken } from "../../services/dlna/control.js";
import { findFallbackStream } from "../../services/source/online/streamFallback.js";

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
const SERVER_VERSION = "1.0.0";
const MIME_MAP: Record<string, string> = {
  mp3: "audio/mpeg", flac: "audio/flac", wav: "audio/wav", aac: "audio/aac",
  ogg: "audio/ogg", m4a: "audio/mp4", wma: "audio/x-ms-wma", ape: "audio/ape",
  aiff: "audio/aiff", opus: "audio/opus",
};

// ==================== Helpers ====================

function ok(data: any = {}) {
  return { "subsonic-response": { status: "ok", version: API_VERSION, serverVersion: SERVER_VERSION, type: "MusicFree", openSubsonic: true, ...data } };
}

function err(code: number, message: string) {
  return (c: any) => c.json({ "subsonic-response": { status: "failed", version: API_VERSION, serverVersion: SERVER_VERSION, type: "MusicFree", openSubsonic: true, error: { code, message } } });
}

const ERR_NOT_FOUND = (what: string) => err(70, `${what} not found`);

function getStarredSet(userId?: string): Set<string> {
  if (!userId) return new Set();
  const favs = db.select().from(userFavoriteSongs).where(eq(userFavoriteSongs.userId, userId)).all();
  return new Set(favs.map(f => f.songId));
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
function songToChild(s: any, starredSet?: Set<string>): any {
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
    userRating: 0,
    isVideo: false,
    mediaType: "song",
  };
}

// OpenSubsonic AlbumID3
function albumToID3(a: any, starredSet?: Set<string>): any {
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
    mediaType: "album",
  };
}

// OpenSubsonic ArtistID3
function artistToID3(a: any, starredSet?: Set<string>): any {
  const starred = starredSet?.has(a.id);
  return {
    id: a.id,
    name: a.name,
    coverArt: a.coverArt ? `ar-${a.id}` : undefined,
    artistImageUrl: a.coverArt ? `/rest/getCoverArt?id=ar-${a.id}&size=600` : undefined,
    albumCount: a.albumCount || 0,
    starred: starred ? new Date().toISOString() : undefined,
    userRating: 0,
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
    { name: "transcoding", versions: [1] },
    { name: "playbackReport", versions: [1] },
    { name: "topSongsByArtistId", versions: [1] },
  ],
})));
restRoutes.get("/getScanStatus", (c) => c.json(ok({ scanStatus: { scanning: false, count: 0 } })));
restRoutes.all("/startScan", (c) => c.json(ok({ scanStatus: { scanning: false, count: 0 } })));
restRoutes.get("/getBookmarks", (c) => c.json(ok({ bookmarks: { bookmark: [] } })));
restRoutes.all("/createBookmark", (c) => c.json(ok()));
restRoutes.all("/deleteBookmark", (c) => c.json(ok()));
restRoutes.get("/getPlayQueue", (c) => c.json(ok({ playQueue: { entry: [], username: c.get("user")?.username || "", changed: new Date().toISOString(), changedBy: "MusicFree" } })));
restRoutes.all("/savePlayQueue", (c) => c.json(ok({ playQueue: { entry: [], username: c.get("user")?.username || "", changed: new Date().toISOString(), changedBy: "MusicFree" } })));
restRoutes.get("/getInternetRadioStations", (c) => c.json(ok({ internetRadioStations: { internetRadioStation: [] } })));
restRoutes.get("/getPodcasts", (c) => c.json(ok({ podcasts: { channel: [] } })));
restRoutes.get("/getNewestPodcasts", (c) => c.json(ok({ newestPodcasts: { episode: [] } })));
restRoutes.get("/getCaptions", (c) => c.json(ok()));

// ==================== Users ====================

restRoutes.get("/getUser", (c) => {
  const username = getParam(c, "username") || c.get("user")?.username;
  const user = db.select().from(users).where(eq(users.username, username || "")).get();
  if (!user) return c.json(ok({ error: { code: 70, message: "User not found" } }));
  const roles = (b: boolean) => b;
  return c.json(ok({ user: {
    username: user.username,
    email: user.email || "",
    scrobblingEnabled: true,
    adminRole: roles(!!user.isAdmin),
    settingsRole: true,
    downloadRole: true,
    uploadRole: false,
    playlistRole: true,
    coverArtRole: true,
    commentRole: false,
    podcastRole: false,
    streamRole: true,
    jukeboxRole: false,
    shareRole: false,
    videoConversionRole: false,
    folder: [0],
  } }));
});

restRoutes.get("/getUsers", (c) => {
  const all = db.select().from(users).all();
  return c.json(ok({ users: { user: all.map(u => ({ username: u.username, email: u.email || "", scrobblingEnabled: true, adminRole: !!u.isAdmin, settingsRole: true, downloadRole: true, uploadRole: false, playlistRole: true, coverArtRole: true, commentRole: false, podcastRole: false, streamRole: true, jukeboxRole: false, shareRole: false, videoConversionRole: false, folder: [0] })) } }));
});

// ==================== Browsing ====================

restRoutes.get("/getMusicFolders", (c) => {
  const sources = db.select().from(mediaSources).where(eq(mediaSources.enabled, 1)).all();
  return c.json(ok({ musicFolders: { musicFolder: [{ id: 0, name: "Music" }, ...sources.map(s => ({ id: s.id as any, name: s.name }))] } }));
});

restRoutes.get("/getIndexes", (c) => {
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

restRoutes.get("/getArtists", (c) => {
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

restRoutes.get("/getArtist", (c) => {
  const id = getParam(c, "id") || "";
  const user = c.get("user");
  const artist = db.select().from(artists).where(eq(artists.id, id)).get();
  if (!artist) return c.json(ok({ error: { code: 70, message: "Artist not found" } }));
  const artistAlbums = db.select().from(albums).where(eq(albums.artistId, id)).all();
  const starredSet = getAlbumStarredSet(user?.id);
  return c.json(ok({ artist: { ...artistToID3(artist, getArtistStarredSet(user?.id)), album: artistAlbums.map(al => albumToID3(al, starredSet)) } }));
});

restRoutes.get("/getArtistInfo", (c) => {
  const id = getParam(c, "id");
  const artist = db.select().from(artists).where(eq(artists.id, id || "")).get();
  if (!artist) return c.json(ok({ error: { code: 70, message: "Artist not found" } }));
  return c.json(ok({ artistInfo: { biography: artist.bio || "", musicBrainzId: "", lastFmUrl: "", smallImageUrl: artist.coverArt ? `/rest/getCoverArt?id=ar-${artist.id}&size=200` : "", mediumImageUrl: artist.coverArt ? `/rest/getCoverArt?id=ar-${artist.id}&size=500` : "", largeImageUrl: artist.coverArt ? `/rest/getCoverArt?id=ar-${artist.id}&size=1200` : "", similarArtist: { artist: [] } } }));
});

restRoutes.get("/getArtistInfo2", (c) => {
  const id = getParam(c, "id");
  const artist = db.select().from(artists).where(eq(artists.id, id || "")).get();
  if (!artist) return c.json(ok({ error: { code: 70, message: "Artist not found" } }));
  return c.json(ok({ artistInfo2: { biography: artist.bio || "", musicBrainzId: "", lastFmUrl: "", smallImageUrl: artist.coverArt ? `/rest/getCoverArt?id=ar-${artist.id}&size=200` : "", mediumImageUrl: artist.coverArt ? `/rest/getCoverArt?id=ar-${artist.id}&size=500` : "", largeImageUrl: artist.coverArt ? `/rest/getCoverArt?id=ar-${artist.id}&size=1200` : "", similarArtist: { artist: [] } } }));
});

restRoutes.get("/getAlbum", (c) => {
  const id = getParam(c, "id") || "";
  const user = c.get("user");
  const album = db.select().from(albums).where(eq(albums.id, id)).get();
  if (!album) return c.json(ok({ error: { code: 70, message: "Album not found" } }));
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
  return c.json(ok({ album: { ...albumToID3(album, getAlbumStarredSet(user?.id)), songCount: songsArr.length, songTotal, duration: totalDuration, song: songsArr } }));
});

restRoutes.get("/getAlbumInfo", (c) => {
  const id = getParam(c, "id");
  const album = db.select().from(albums).where(eq(albums.id, id || "")).get();
  if (!album) return c.json(ok({ error: { code: 70, message: "Album not found" } }));
  const coverRef = albumCoverRef(album);
  return c.json(ok({ albumInfo: { notes: "", musicBrainzId: "", lastFmUrl: "", smallImageUrl: coverRef ? `/rest/getCoverArt?id=${coverRef}&size=200` : "", mediumImageUrl: coverRef ? `/rest/getCoverArt?id=${coverRef}&size=500` : "", largeImageUrl: coverRef ? `/rest/getCoverArt?id=${coverRef}&size=1200` : "" } }));
});

restRoutes.get("/getAlbumInfo2", (c) => {
  const id = getParam(c, "id");
  const album = db.select().from(albums).where(eq(albums.id, id || "")).get();
  if (!album) return c.json(ok({ error: { code: 70, message: "Album not found" } }));
  const coverRef = albumCoverRef(album);
  return c.json(ok({ albumInfo: { notes: "", musicBrainzId: "", lastFmUrl: "", smallImageUrl: coverRef ? `/rest/getCoverArt?id=${coverRef}&size=200` : "", mediumImageUrl: coverRef ? `/rest/getCoverArt?id=${coverRef}&size=500` : "", largeImageUrl: coverRef ? `/rest/getCoverArt?id=${coverRef}&size=1200` : "" } }));
});

restRoutes.get("/getSong", (c) => {
  const id = getParam(c, "id") || "";
  const user = c.get("user");
  const song = db.select().from(songs).where(eq(songs.id, id)).get();
  if (!song) return c.json(ok({ error: { code: 70, message: "Song not found" } }));
  return c.json(ok({ song: songToChild(song, getStarredSet(user?.id)) }));
});

restRoutes.get("/getMusicDirectory", (c) => {
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

restRoutes.get("/getAlbumList", (c) => {
  const { paged, user } = getAlbumListData(c);
  const starredSet = getAlbumStarredSet(user?.id);
  return c.json(ok({ albumList: { album: paged.map(al => albumToChild(al, starredSet)) } }));
});

restRoutes.get("/getAlbumList2", (c) => {
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
    // Empty query: return everything (used by clients to page through the whole library)
    foundSongs = db.select().from(songs).all().sort((a, b) => (a.title || "").localeCompare(b.title || ""));
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

restRoutes.get("/search2", (c) => c.json(ok({ searchResult2: searchHandler(c) })));
restRoutes.get("/search3", (c) => c.json(ok({ searchResult3: searchHandler(c) })));

restRoutes.get("/getSongsByGenre", (c) => {
  const genre = getParam(c, "genre") || "";
  const count = parseInt(getParam(c, "count") || "10") || 10;
  const offset = parseInt(getParam(c, "offset") || "0") || 0;
  const user = c.get("user");
  const allSongs = db.select().from(songs).where(eq(songs.genre, genre)).all();
  return c.json(ok({ songsByGenre: { song: paginate(allSongs, offset, count).map(s => songToChild(s, getStarredSet(user?.id))) } }));
});

restRoutes.get("/getRandomSongs", (c) => {
  const size = parseInt(getParam(c, "size") || "10") || 10;
  const user = c.get("user");
  const allSongs = db.select().from(songs).all().sort(() => Math.random() - 0.5).slice(0, size);
  return c.json(ok({ randomSongs: { song: allSongs.map(s => songToChild(s, getStarredSet(user?.id))) } }));
});

restRoutes.get("/getGenres", (c) => {
  const genreMap = new Map<string, { songCount: number; albumCount: number }>();
  for (const s of db.select().from(songs).all()) {
    if (!s.genre) continue;
    const entry = genreMap.get(s.genre) || { songCount: 0, albumCount: 0 };
    entry.songCount++;
    genreMap.set(s.genre, entry);
  }
  for (const a of db.select().from(albums).all()) {
    if (!a.genre) continue;
    const entry = genreMap.get(a.genre);
    if (entry) entry.albumCount++;
  }
  return c.json(ok({ genres: { genre: Array.from(genreMap.entries()).map(([name, counts]) => ({ value: name, songCount: counts.songCount, albumCount: counts.albumCount })) } }));
});

restRoutes.get("/getTopSongs", (c) => {
  const artistName = getParam(c, "artist") || "";
  const count = parseInt(getParam(c, "count") || "50") || 50;
  const user = c.get("user");
  const allSongs = db.select().from(songs).where(eq(songs.artist, artistName)).all().slice(0, count);
  return c.json(ok({ topSongs: { song: allSongs.map(s => songToChild(s, getStarredSet(user?.id))) } }));
});

restRoutes.get("/getSimilarSongs", (c) => c.json(ok({ similarSongs: { song: [] } })));
restRoutes.get("/getSimilarSongs2", (c) => c.json(ok({ similarSongs2: { song: [] } })));

// ==================== Playlists ====================

restRoutes.get("/getPlaylists", (c) => {
  const user = c.get("user");
  // Visibility: admin sees all; others see their own + public. Pushed to SQL,
  // and the daily-recommend-first ordering is expressed as a CASE + recency.
  const where = user?.isAdmin
    ? undefined
    : or(eq(playlists.isPublic, 1), eq(playlists.ownerId, user?.id ?? ""));
  const dailyOrder = sql`CASE WHEN ${playlists.comment} LIKE ${`%${DAILY_TAG}%`} AND ${playlists.name} = '今日推荐' THEN 0 WHEN ${playlists.comment} LIKE ${`%${DAILY_TAG}%`} AND ${playlists.name} = '昨日推荐' THEN 1 ELSE 2 END`;
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
  return c.json(ok({ playlists: { total, playlist: page.map(p => ({ id: p.id, name: p.name, owner: p.ownerId, public: !!p.isPublic, created: p.createdAt || new Date().toISOString(), changed: p.updatedAt || new Date().toISOString(), songCount: p.songCount || 0, duration: p.duration || 0, coverArt: `pl-${p.id}`, comment: p.comment || "", isImported: !!p.sourceUrl, syncEnabled: !!p.syncEnabled, sourcePlatform: p.sourcePlatform || "" })) } }));
});

restRoutes.get("/getPlaylist", (c) => {
  const id = getParam(c, "id") || "";
  const user = c.get("user");
  const playlist = db.select().from(playlists).where(eq(playlists.id, id)).get();
  if (!playlist) return c.json(ok({ error: { code: 70, message: "Playlist not found" } }));
  // Private playlists are only visible to the owner (admins can view all)
  if (!playlist.isPublic && playlist.ownerId !== user?.id && !user?.isAdmin) {
    return c.json(ok({ error: { code: 50, message: "Playlist is private" } }));
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
    isImported: !!playlist.sourceUrl,
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

restRoutes.all("/createPlaylist", async (c) => {
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

restRoutes.all("/updatePlaylist", async (c) => {
  const user = c.get("user");
  const body = await parseBody(c);
  const playlistId = (body.playlistId as string) || (body.id as string) || "";
  if (!playlistId) return c.json(ok({ error: { code: 10, message: "Missing playlistId" } }));
  const playlist = db.select().from(playlists).where(eq(playlists.id, playlistId)).get();
  if (!playlist) return c.json(ok({ error: { code: 70, message: "Playlist not found" } }));
  // Only owner (or admin) can modify a playlist; others' public playlists are read-only
  if (playlist.ownerId !== user?.id && !user?.isAdmin) {
    return c.json(ok({ error: { code: 50, message: "Not authorized to modify this playlist" } }));
  }
  const isImported = !!playlist.sourceUrl;
  // Imported playlists are read-only for tracks: track list follows the platform, sync via /sync
  const wantsTrackEdit = toIdArray(body.songIdToAdd).length > 0 || toIdArray(body.songIdToRemove).length > 0 || toIdArray(body.songIndexToRemove).length > 0;
  if (isImported && wantsTrackEdit) {
    return c.json(ok({ error: { code: 50, message: "导入歌单的曲目只读,请在原平台修改后同步" } }));
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

restRoutes.all("/deletePlaylist", async (c) => {
  const user = c.get("user");
  const body = await parseBody(c);
  const id = (body.id as string) || (body.playlistId as string) || "";
  if (!id) return c.json(ok({ error: { code: 10, message: "Missing id" } }));
  const playlist = db.select().from(playlists).where(eq(playlists.id, id)).get();
  if (!playlist) return c.json(ok({ error: { code: 70, message: "Playlist not found" } }));
  // Only owner (or admin) can delete; others' public playlists are read-only
  if (playlist.ownerId !== user?.id && !user?.isAdmin) {
    return c.json(ok({ error: { code: 50, message: "Not authorized to delete this playlist" } }));
  }
  db.delete(playlistSongs).where(eq(playlistSongs.playlistId, id)).run();
  db.delete(playlists).where(eq(playlists.id, id)).run();
  clearPlaylistCoverCache(id);
  return c.json(ok());
});

function refreshPlaylistCounts(playlistId: string) {
  const entries = db.select().from(playlistSongs).where(eq(playlistSongs.playlistId, playlistId)).all();
  let duration = 0, count = 0;
  for (const e of entries) {
    if (e.playable && e.songId) {
      const song = db.select().from(songs).where(eq(songs.id, e.songId)).get();
      if (song) { duration += song.duration || 0; count++; }
    } else if (e.externalTitle) {
      duration += (e.externalDuration || 0) / 1000;
      count++;
    }
  }
  db.update(playlists).set({ songCount: count, duration, updatedAt: new Date().toISOString() }).where(eq(playlists.id, playlistId)).run();
}

// ==================== Starring ====================

function parseStarIds(raw: string | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  return String(raw).split(",").filter(Boolean);
}

restRoutes.get("/star", (c) => {
  const user = c.get("user");
  if (!user) return c.json(ok({ error: { code: 40, message: "Unauthorized" } }));
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

restRoutes.get("/unstar", (c) => {
  const user = c.get("user");
  if (!user) return c.json(ok({ error: { code: 40, message: "Unauthorized" } }));
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

restRoutes.get("/getStarred", (c) => {
  const user = c.get("user");
  if (!user) return c.json(ok({ starred: { song: [], album: [], artist: [] } }));
  const favs = db.select().from(userFavoriteSongs).where(eq(userFavoriteSongs.userId, user.id)).all();
  const starredSet = new Set(favs.map(f => f.songId));
  const favSongs = favs.map(f => { const song = db.select().from(songs).where(eq(songs.id, f.songId)).get(); return song ? songToChild(song, starredSet) : null; }).filter(Boolean);
  return c.json(ok({ starred: { song: favSongs, album: [], artist: [] } }));
});

restRoutes.get("/getStarred2", (c) => {
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

// Dedupe window: some Subsonic clients (and the web frontend's onplay +
// external clients used simultaneously) send submission=true twice for the
// same track within a few seconds. Drop the duplicate so play_history stays
// clean — keep only the first submission per (user, song) within 10s.
const SCROBBLE_DEDUPE_MS = 10_000;
const recentScrobbles = new Map<string, number>(); // key: userId|songId → ms epoch

restRoutes.get("/scrobble", (c) => {
  const user = c.get("user");
  const id = getParam(c, "id");
  if (!user || !id) return c.json(ok());
  const submission = (getParam(c, "submission") || "true") !== "false";
  if (submission) {
    const key = `${user.id}|${id}`;
    const now = Date.now();
    const last = recentScrobbles.get(key) || 0;
    // Opportunistic cleanup of stale dedupe entries (keep map small).
    if (recentScrobbles.size > 200) {
      for (const [k, t] of recentScrobbles) if (now - t > SCROBBLE_DEDUPE_MS) recentScrobbles.delete(k);
    }
    if (now - last > SCROBBLE_DEDUPE_MS) {
      recentScrobbles.set(key, now);
      db.insert(playHistory).values({ userId: user.id, songId: id, playedAt: new Date().toISOString() }).run();
      db.update(songs).set({ playCount: sql`${songs.playCount} + 1` }).where(eq(songs.id, id)).run();
    }
  }
  return c.json(ok());
});

restRoutes.get("/getNowPlaying", (c) => c.json(ok({ nowPlaying: { entry: [] } })));

// ==================== Lyrics ====================

restRoutes.get("/getLyrics", async (c) => {
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

restRoutes.get("/getLyricsBySongId", async (c) => {
  const id = getParam(c, "id") || "";
  const song = db.select().from(songs).where(eq(songs.id, id)).get();
  if (!song) return c.json(ok({ lyricsList: { structuredLyrics: [] } }));
  const lines = await getLyricsForSongId(song.id);
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
    if (!song.url) return c.json(ok({ error: { code: 0, message: "No stream url" } }));
    const headers: Record<string, string> = {};
    try { Object.assign(headers, JSON.parse(song.streamHeaders || "{}")); } catch {}
    if (rangeHeader) headers["Range"] = rangeHeader;

    let url = song.url;
    let upstream = await fetch(url, { headers });

    // If the original platform could not resolve this song, try an automatic
    // multi-source fallback (search the same provider for a working alternative).
    if ((upstream.status === 404 || upstream.status >= 500) && song.pluginEntry && song.sourceData) {
      try {
        await upstream.body?.cancel();
        const sd = JSON.parse(song.sourceData || "{}");
        const fb = await findFallbackStream(
          song.id, song.title || sd?.title || "", song.artist || sd?.artist || "", song.album || "",
          song.pluginEntry, sd?.source || "",
        );
        if (fb) { url = fb.url; upstream = await fetch(url, { headers }); }
      } catch { /* keep original upstream result */ }
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
    return c.json(ok({ error: { code: 0, message: e.message || "Stream failed" } }));
  }
}

restRoutes.get("/stream", async (c) => {
  const id = getParam(c, "id") || "";
  const song = db.select().from(songs).where(eq(songs.id, id)).get();
  if (!song) return c.json(ok({ error: { code: 70, message: "Song not found" } }));

  const rangeHeader = c.req.header("range");
  const timeOffset = parseInt(getParam(c, "timeOffset") || "0") || 0;
  const format = getParam(c, "format"); // "raw" = no transcode; other formats unsupported

  // Online song (built-in source plugin): serve local cache first, else proxy `url` with its headers.
  if ((song.type || "local") === "web") {
    return serveWebSongStream(c, song, rangeHeader);
  }

  const parsed = parseSongPath(song.path);
  if (!parsed) return c.json(ok({ error: { code: 0, message: "Invalid song path" } }));

  try {
    if (parsed.type === "w") {
      const source = db.select().from(mediaSources).where(eq(mediaSources.id, parsed.sourceId)).get();
      if (!source) return c.json(ok({ error: { code: 0, message: "Source not found" } }));
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
      if (!fs.existsSync(filePath)) return c.json(ok({ error: { code: 70, message: "File not found" } }));
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
    return c.json(ok({ error: { code: 0, message: e.message || "Stream failed" } }));
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

restRoutes.get("/download", async (c) => {
  const id = getParam(c, "id") || "";
  const song = db.select().from(songs).where(eq(songs.id, id)).get();
  if (!song) return c.json(ok({ error: { code: 70, message: "Song not found" } }));
  const parsed = parseSongPath(song.path);
  if (!parsed) return c.json(ok({ error: { code: 0, message: "Invalid song path" } }));
  try {
    if (parsed.type === "w") {
      const source = db.select().from(mediaSources).where(eq(mediaSources.id, parsed.sourceId)).get();
      if (!source) return c.json(ok({ error: { code: 0, message: "Source not found" } }));
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
    return c.json(ok({ error: { code: 0, message: "Not supported" } }));
  } catch (e: any) {
    return c.json(ok({ error: { code: 0, message: e.message || "Download failed" } }));
  }
});

restRoutes.get("/getCoverArt", async (c) => {
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
