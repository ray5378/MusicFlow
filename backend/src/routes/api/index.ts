import { Hono } from "hono";
import { db } from "../../db/index.js";
import { users, playlists, playlistSongs, songs, albums, artists, mediaSources, plugins, wishes, userFavoriteSongs, playHistory, genres } from "../../db/schema.js";
import { eq, like, inArray, or, and, sql, desc, isNotNull } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import md5 from "md5";
import { adminMiddleware } from "../../middleware/auth.js";
import { scanLocalSource, scanWebDAVSource, testWebDAVConnection, cleanupOrphans, ScanProgress } from "../../services/source/scanner.js";
import { encryptPassword } from "../../db/index.js";
import { importPlaylistFromUrl, ImportedPlaylist, ImportedTrack, parseNativePlaylists, NATIVE_APP } from "../../services/plugin/playlistImport.js";
import { checkImportCooldown, rebuildPlaylistEntries, syncPlaylist, refreshPlaylistCounts, exportPlaylistEntries } from "../../services/plugin/playlistSync.js";
import {
  generateDailyPlaylist, loadCandidates, saveCandidates, pickDailyCandidate,
  isCandidateBlocked,
  DAILY_TAG, listRecommendPool, addToRecommendPool, removeFromRecommendPool, isInRecommendPool,
} from "../../services/plugin/dailyRecommend.js";
import { sqlite } from "../../db/index.js";
import { cacheRemoteCover, clearPlaylistCoverCache } from "../../services/playlistCover.js";
import { scrapeArtist, scrapeArtistList, artistsMissingCovers, artistsMissingInfo } from "../../services/scraper/artist.js";
import {
  refreshDevices, getCachedDevices, shouldRefreshDevices, castToDevice,
  playDevice, pauseDevice, stopDevice, seekDevice, setDeviceVolume, getDeviceStatus,
  enqueueNextTrack, getCurrentMedia, recordBaseUrl, getEffectiveBaseUrl, isPrivateLanHostname,
} from "../../services/dlna/control.js";
import { markStaleDevices } from "../../services/dlna/discovery.js";
import { getEventManager } from "../../services/dlna/eventing.js";
import { getQueueManager } from "../../services/dlna/queue.js";
import { getPeerManager, parsePeerId } from "../../services/peer.js";
import { resolveContentSongs, songsToQueueItems } from "../../services/content.js";
import { listFlows, createFlow, updateFlow, deleteFlow, getFlow, executeFlow, isFlowRunning } from "../../services/flows/index.js";
import {
  listPlayerWebhookTokens, createPlayerWebhookToken, deletePlayerWebhookToken,
  setPlayerWebhookTokenEnabled, resolvePlayerWebhookOwnerName,
} from "../../services/player/playerWebhook.js";
import { getGroupManager } from "../../services/group/index.js";
import { getGroupStatus, getGroupLeaderDeviceId } from "../../services/group/protocolPlayer.js";
import { getQueueController } from "../../services/player/index.js";
import { onlineRoutes } from "./online.js";

export const apiRoutes = new Hono();
apiRoutes.route("/", onlineRoutes);

// ==================== Users ====================
apiRoutes.get("/v1/users", adminMiddleware, (c) => {
  return c.json(db.select().from(users).all().map(u => ({ id: u.id, username: u.username, isAdmin: !!u.isAdmin, isActive: !!u.isActive, apiKeySet: !!u.apiKey, apiKeyExpiresAt: u.apiKeyExpiresAt, createdAt: u.createdAt, updatedAt: u.updatedAt })));
});

apiRoutes.post("/v1/users", adminMiddleware, async (c) => {
  const body = await c.req.json();
  const { username, password } = body;
  const subsonicSalt = Math.random().toString(16).substring(2, 10);
  const id = uuidv4();
  db.insert(users).values({ id, username, password: md5(password + subsonicSalt), salt: Math.random().toString(36).substring(2, 10), subsonicSalt, passEnc: encryptPassword(password), isAdmin: 0, isActive: 1 }).run();
  return c.json({ id, username });
});

apiRoutes.put("/v1/users/:id/password", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  if (id !== user?.id && !user?.isAdmin) return c.json({ error: "无权修改该用户密码" }, 403);
  const body = await c.req.json();
  if (!body.newPassword) return c.json({ error: "新密码不能为空" }, 400);
  const newSubsonicSalt = Math.random().toString(16).substring(2, 10);
  db.update(users).set({ password: md5(body.newPassword + newSubsonicSalt), subsonicSalt: newSubsonicSalt, passEnc: encryptPassword(body.newPassword), mustChangePassword: 0, apiKey: null, updatedAt: new Date().toISOString() }).where(eq(users.id, id)).run();
  return c.json({ success: true });
});

apiRoutes.put("/v1/users/:id/username", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  if (id !== user?.id && !user?.isAdmin) return c.json({ error: "无权修改该用户名" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.username || "").trim();
  if (!name) return c.json({ error: "用户名不能为空" }, 400);
  const existing = db.select().from(users).where(eq(users.username, name)).get();
  if (existing && existing.id !== id) return c.json({ error: "用户名已被占用" }, 409);
  db.update(users).set({ username: name, updatedAt: new Date().toISOString() }).where(eq(users.id, id)).run();
  return c.json({ success: true, username: name });
});

apiRoutes.delete("/v1/users/:id", adminMiddleware, (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  if (id === user?.id) return c.json({ error: "不能删除当前登录账号" }, 400);
  const target = db.select().from(users).where(eq(users.id, id)).get();
  if (!target) return c.json({ error: "用户不存在" }, 404);
  const owned = db.select().from(playlists).where(eq(playlists.ownerId, id)).all();
  if (owned.length > 0) {
    db.delete(playlistSongs).where(inArray(playlistSongs.playlistId, owned.map(p => p.id))).run();
    owned.forEach(p => clearPlaylistCoverCache(p.id));
    db.delete(playlists).where(inArray(playlists.id, owned.map(p => p.id))).run();
  }
  db.delete(userFavoriteSongs).where(eq(userFavoriteSongs.userId, id)).run();
  db.delete(playHistory).where(eq(playHistory.userId, id)).run();
  db.delete(wishes).where(eq(wishes.userId, id)).run();
  db.delete(users).where(eq(users.id, id)).run();
  return c.json({ success: true });
});

// ==================== Current user (HA integration health check) ====================
// Used by the hass-musicflow config flow to verify the API key works.
apiRoutes.get("/v1/users/me", (c) => {
  const user = c.get("user");
  return c.json({ id: user?.id, username: user?.username, isAdmin: user?.isAdmin });
});

// ==================== Sources ====================
apiRoutes.get("/v1/sources", adminMiddleware, (c) => c.json(db.select().from(mediaSources).all().map(s => ({ ...s, config: JSON.parse(s.config || "{}") }))));

apiRoutes.post("/v1/sources", adminMiddleware, async (c) => {
  const body = await c.req.json();
  const id = uuidv4();
  db.insert(mediaSources).values({ id, name: body.name, type: body.type || "webdav", enabled: body.enabled !== false ? 1 : 0, config: JSON.stringify(body.config || {}) }).run();
  return c.json({ id });
});

apiRoutes.put("/v1/sources/:id", adminMiddleware, async (c) => {
  const id = c.req.param("id")!;
  const body = await c.req.json();
  const existing = db.select().from(mediaSources).where(eq(mediaSources.id, id)).get();
  if (!existing) return c.json({ error: "Source not found" }, 404);
  db.update(mediaSources).set({
    name: body.name || existing.name,
    enabled: body.enabled !== undefined ? body.enabled : existing.enabled,
    config: body.config ? JSON.stringify(body.config) : existing.config,
    updatedAt: new Date().toISOString(),
  }).where(eq(mediaSources.id, id)).run();
  return c.json({ success: true });
});

apiRoutes.delete("/v1/sources/:id", adminMiddleware, (c) => {
  const id = c.req.param("id")!;
  // Find all songs belonging to this source (webdav: w:<id>:, local: l:<id>:)
  const sourceSongs = db.select().from(songs).all().filter(s => s.path.startsWith(`w:${id}:`) || s.path.startsWith(`l:${id}:`));
  const songIds = sourceSongs.map(s => s.id);
  if (songIds.length > 0) {
    // Delete dependent rows first (FK constraints)
    db.delete(playlistSongs).where(inArray(playlistSongs.songId, songIds)).run();
    db.delete(userFavoriteSongs).where(inArray(userFavoriteSongs.songId, songIds)).run();
    db.delete(playHistory).where(inArray(playHistory.songId, songIds)).run();
    db.delete(songs).where(inArray(songs.id, songIds)).run();
    cleanupOrphans();
  }
  db.delete(mediaSources).where(eq(mediaSources.id, id)).run();
  return c.json({ success: true, removedSongs: songIds.length });
});

// Test connection
apiRoutes.post("/v1/sources/:id/test", adminMiddleware, async (c) => {
  const id = c.req.param("id")!;
  const source = db.select().from(mediaSources).where(eq(mediaSources.id, id)).get();
  if (!source) return c.json({ success: false, error: "媒体源不存在" });

  const config = JSON.parse(source.config || "{}");

  if (source.type === "webdav") {
    try {
      console.log("[TEST] URL:", config.url, "root_path:", config.root_path, "user:", config.username);
      const result = await testWebDAVConnection(config.url, config.username, config.password, config.root_path);
      console.log("[TEST] Result:", JSON.stringify(result));
      return c.json(result);
    } catch (e: any) {
      console.log("[TEST] Error:", e.message);
      return c.json({ success: false, error: e.message || "连接失败" });
    }
  } else if (source.type === "local") {
    const fs = await import("fs");
    if (fs.existsSync(config.path)) {
      return c.json({ success: true, message: `路径 ${config.path} 存在` });
    } else {
      return c.json({ success: false, error: `路径 ${config.path} 不存在` });
    }
  }
  return c.json({ success: false, error: "不支持的媒体源类型" });
});

// Scan source
const scanJobs = new Map<string, { status: string; startedAt: string; progress?: ScanProgress; result?: any; error?: string; mode?: string; controller?: AbortController }>();

apiRoutes.post("/v1/sources/:id/scan", adminMiddleware, async (c) => {
  const id = c.req.param("id")!;
  const source = db.select().from(mediaSources).where(eq(mediaSources.id, id)).get();
  if (!source) return c.json({ success: false, error: "媒体源不存在" });
  if (!source.enabled) return c.json({ success: false, error: "媒体源已禁用" });
  if (scanJobs.has(id) && scanJobs.get(id)!.status === "running") {
    return c.json({ success: false, error: "扫描正在进行中" });
  }

  const body = await c.req.json().catch(() => ({}));
  const mode: "full" | "incremental" = body.mode === "incremental" ? "incremental" : "full";

  const config = JSON.parse(source.config || "{}");
  const controller = new AbortController();
  const job = { status: "running", startedAt: new Date().toISOString(), progress: undefined as ScanProgress | undefined, mode, controller };
  scanJobs.set(id, job);

  const onProgress = (p: ScanProgress) => { job.progress = { ...p }; };

  // Snapshot of existing artist ids before the scan: after scanning we scrape
  // ONLY the newly-added artists' info (avatars), not the whole library.
  const preScanArtistIds = new Set(db.select().from(artists).all().map(a => a.id));

  (async () => {
    try {
      let result;
      if (source.type === "webdav") {
        result = await scanWebDAVSource(source.id, config, mode, onProgress, controller.signal);
      } else if (source.type === "local") {
        result = await scanLocalSource(source.id, config, mode, onProgress, controller.signal);
      } else {
        scanJobs.set(id, { status: "failed", error: "不支持的媒体源类型", startedAt: job.startedAt });
        return;
      }
      if (controller.signal.aborted) {
        scanJobs.set(id, { status: "stopped", result, startedAt: job.startedAt, progress: job.progress, mode });
      } else {
        scanJobs.set(id, { status: "completed", result, startedAt: job.startedAt, progress: job.progress, mode });
        // Auto-scrape ONLY the newly-added artists' info (avatars/bios),
        // QQ Music first then NetEase. Runs in background with progress.
        (async () => {
          try {
            const newArtists = db.select().from(artists).all()
              .filter(a => !preScanArtistIds.has(a.id) && !a.coverArt);
            if (newArtists.length > 0) {
              console.log(`[ARTIST-SCRAPE] ${newArtists.length} new artists, scraping...`);
              const job2 = { status: "running", startedAt: new Date().toISOString(), progress: undefined as any };
              scrapeJobs.set(SCRAPE_JOB_ID, job2);
              const onProgress = (p: any) => { job2.progress = { ...p }; };
              try {
                const r = await scrapeArtistList(newArtists.map(a => a.id), onProgress);
                scrapeJobs.set(SCRAPE_JOB_ID, { status: "done", startedAt: job2.startedAt, finishedAt: new Date().toISOString(), progress: r });
                console.log(`[ARTIST-SCRAPE] done: scraped ${r.scraped}, skipped ${r.skipped}, errors ${r.errors.length}`);
              } catch (e: any) {
                scrapeJobs.set(SCRAPE_JOB_ID, { status: "failed", startedAt: job2.startedAt, error: e.message || "刮削失败", progress: job2.progress });
              }
            }
          } catch (e: any) {
            console.error("[ARTIST-SCRAPE] error:", e.message);
          }
        })();
      }
    } catch (e: any) {
      console.error("Scan error:", e);
      scanJobs.set(id, { status: "failed", error: e.message || "扫描失败", startedAt: job.startedAt, progress: job.progress, mode });
    }
  })();

  return c.json({ success: true, message: mode === "incremental" ? "增量扫描已开始" : "全库扫描已开始" });
});

// Stop a running scan
apiRoutes.post("/v1/sources/:id/scan-stop", adminMiddleware, (c) => {
  const id = c.req.param("id")!;
  const job = scanJobs.get(id);
  if (!job || job.status !== "running") return c.json({ success: false, error: "没有正在运行的扫描" });
  job.controller?.abort();
  return c.json({ success: true, message: "正在停止扫描..." });
});

apiRoutes.get("/v1/sources/:id/scan-status", adminMiddleware, (c) => {
  const id = c.req.param("id")!;
  const job = scanJobs.get(id);
  if (!job) return c.json({ status: "idle" });
  return c.json({ status: job.status, progress: job.progress, result: job.result, error: job.error, startedAt: job.startedAt, mode: job.mode });
});

// ==================== Plugins ====================
apiRoutes.get("/v1/plugins", adminMiddleware, (c) => c.json(db.select().from(plugins).all()));
apiRoutes.post("/v1/plugins", adminMiddleware, async (c) => { const body = await c.req.json(); const id = uuidv4(); db.insert(plugins).values({ id, name: body.name, version: body.version || "", description: body.description || "", manifest: JSON.stringify(body.manifest || {}), enabled: body.enabled ? 1 : 0, config: JSON.stringify(body.config || {}) }).run(); return c.json({ id }); });
apiRoutes.put("/v1/plugins/:id", adminMiddleware, async (c) => { const p = db.select().from(plugins).where(eq(plugins.id, c.req.param("id")!)).get(); if (!p) return c.json({ error: "插件不存在" }, 404); const body = await c.req.json().catch(() => ({})); db.update(plugins).set({ config: body.config !== undefined ? JSON.stringify(body.config) : p.config, enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : p.enabled, description: typeof body.description === "string" ? body.description : p.description, version: typeof body.version === "string" ? body.version : p.version, name: typeof body.name === "string" ? body.name : p.name, updatedAt: new Date().toISOString() }).where(eq(plugins.id, p.id)).run(); return c.json({ success: true }); });
apiRoutes.put("/v1/plugins/:id/toggle", adminMiddleware, (c) => { const p = db.select().from(plugins).where(eq(plugins.id, c.req.param("id")!)).get(); if (p) db.update(plugins).set({ enabled: p.enabled ? 0 : 1 }).where(eq(plugins.id, p.id)).run(); return c.json({ success: true }); });

// ==================== Wish ====================
// ==================== Wish (paginated) ====================
apiRoutes.get("/v1/wish", adminMiddleware, (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") || "1") || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query("pageSize") || "20") || 20));
  const query = (c.req.query("query") || "").trim();
  const status = (c.req.query("status") || "").trim();
  let all = db.select().from(wishes).all();
  if (query) {
    const q = query.toLowerCase();
    all = all.filter(w => (w.songTitle || "").toLowerCase().includes(q) || (w.artist || "").toLowerCase().includes(q));
  }
  if (status) all = all.filter(w => w.status === status);
  const total = all.length;
  const items = all.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice((page - 1) * pageSize, page * pageSize);
  return c.json({ total, page, pageSize, items });
});
apiRoutes.post("/v1/wish", adminMiddleware, async (c) => { const user = c.get("user"); const body = await c.req.json(); const id = uuidv4(); db.insert(wishes).values({ id, userId: user?.id || "", songTitle: body.songTitle, artist: body.artist || "", album: body.album || "", status: "pending" }).run(); return c.json({ id }); });

// Export ALL wishes as "artist songTitle" lines (for copying to import into download tools)
apiRoutes.get("/v1/wish/export", adminMiddleware, (c) => {
  const all = db.select().from(wishes).all()
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const text = all.map(w => [w.artist, w.songTitle].filter(Boolean).join(" ")).filter(Boolean).join("\n");
  return c.json({ text, count: all.length });
});

// ==================== Stats ====================
apiRoutes.get("/v1/stats", (c) => {
  const songCount = db.select().from(songs).all().length;
  const albumCount = db.select().from(albums).all().length;
  const artistCount = db.select().from(artists).all().length;
  const userCount = db.select().from(users).all().length;
  return c.json({ songCount, albumCount, artistCount, userCount });
});

// ==================== Songs (paginated + searchable) ====================
apiRoutes.get("/v1/songs", (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") || "1") || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query("pageSize") || "50") || 50));
  const query = (c.req.query("query") || "").trim();
  const genre = (c.req.query("genre") || "").trim();
  // sort=recentAdded: 最新添加入库的歌曲（按入库时间倒序，封顶 500 首，新入库自动进入列表）
  const sort = (c.req.query("sort") || "").trim();
  const recentAdded = sort === "recentAdded";
  // SQL-level filtering + pagination (avoids loading the whole table into memory)
  const conds = [];
  if (genre) conds.push(eq(songs.genre, genre));
  if (query) {
    const q = `%${query}%`;
    conds.push(or(like(songs.title, q), like(songs.artist, q), like(songs.album, q)));
  }
  const where = conds.length > 0 ? (conds.length === 1 ? conds[0] : and(...conds)) : undefined;
  // 最近添加模式最多只取 500 首（超出部分不算在总数内）
  const RECENT_ADDED_CAP = 500;
  const start = (page - 1) * pageSize;
  // Fast SQL count for the total
  const totalRow = where
    ? db.select({ n: sql<number>`count(*)` }).from(songs).where(where).get()
    : db.select({ n: sql<number>`count(*)` }).from(songs).get();
  const rawTotal = totalRow?.n ?? 0;
  const total = recentAdded ? Math.min(RECENT_ADDED_CAP, rawTotal) : rawTotal;
  // 最近添加模式的分页不超出 500 首范围
  const safeStart = recentAdded ? Math.min(start, Math.max(0, total - pageSize)) : start;
  // SQL-level pagination
  const pageSongs = recentAdded
    ? (where
        ? db.select().from(songs).where(where).orderBy(desc(songs.createdAt)).limit(pageSize).offset(safeStart).all()
        : db.select().from(songs).orderBy(desc(songs.createdAt)).limit(pageSize).offset(safeStart).all())
    : (where
        ? db.select().from(songs).where(where).orderBy(songs.title).limit(pageSize).offset(start).all()
        : db.select().from(songs).orderBy(songs.title).limit(pageSize).offset(start).all());
  const items = pageSongs.map(s => ({
    id: s.id, title: s.title, artist: s.artist, album: s.album, artistId: s.artistId,
    albumId: s.albumId, duration: s.duration, bitRate: s.bitRate, suffix: s.suffix,
    contentType: s.contentType, size: s.size, playCount: s.playCount, genre: s.genre,
    track: s.track, discNumber: s.discNumber,
    coverArt: s.coverArt ? `so-${s.id}` : (s.albumId ? idToCoverArt(s.albumId, "al") : undefined),
  }));
  return c.json({ total, page, pageSize, items });
});

function idToCoverArt(id: string | null, prefix: string): string | undefined {
  if (!id) return undefined;
  const album = db.select().from(albums).where(eq(albums.id, id)).get();
  return album && album.coverArt ? `${prefix}-${album.id}` : undefined;
}

// Web/online-imported albums (go-music-dl etc.) cache artwork on the song rows
// (songs.cover_art), not the album row. Fall back to the first song-with-cover
// so imported albums aren't blank everywhere (grid, detail, artist pages).
function albumCoverRef(a: any): string | undefined {
  if (a?.coverArt) return `al-${a.id}`;
  const song = db.select({ id: songs.id }).from(songs)
    .where(and(eq(songs.albumId, a?.id), isNotNull(songs.coverArt)))
    .limit(1).get();
  return song ? `so-${song.id}` : undefined;
}

// ==================== Genres (with unique ids + song counts) ====================
// 风格 ID 由 genres 表分配(启动时 backfillGenres 回填;此处兜底按需补建)。
function genreIdFor(name: string): string {
  const row = sqlite.prepare("SELECT id FROM genres WHERE name = ?").get(name) as any;
  if (row?.id) return row.id;
  const id = uuidv4();
  const now = new Date().toISOString();
  sqlite.prepare("INSERT OR IGNORE INTO genres (id, name, song_count, created_at, updated_at) VALUES (?, ?, 0, ?, ?)").run(id, name, now, now);
  const re = sqlite.prepare("SELECT id FROM genres WHERE name = ?").get(name) as any;
  return re?.id || id;
}

apiRoutes.get("/v1/genres", (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") || "1") || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query("pageSize") || "50") || 50));
  const query = (c.req.query("query") || "").trim();
  const rows = db.select({
    name: songs.genre,
    songCount: sql<number>`count(*)`,
  }).from(songs)
    .where(sql`genre != ''`)
    .groupBy(songs.genre)
    .orderBy(sql`count(*) DESC`)
    .all();
  const mapped = rows.filter((r) => r.name).map(r => ({ id: genreIdFor(r.name as string), name: r.name, songCount: r.songCount }));
  const filtered = query ? mapped.filter(g => (g.name || "").toLowerCase().includes(query.toLowerCase())) : mapped;
  const total = filtered.length;
  const start = (page - 1) * pageSize;
  return c.json({ total, page, pageSize, items: filtered.slice(start, start + pageSize) });
});

// ==================== Albums (paginated + searchable) ====================
apiRoutes.get("/v1/albums", (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") || "1") || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query("pageSize") || "50") || 50));
  const query = (c.req.query("query") || "").trim();
  const allAlbums = db.select().from(albums).all();
  const filtered = query
    ? allAlbums.filter(a => {
        const q = query.toLowerCase();
        return (a.name || "").toLowerCase().includes(q) || (a.artist || "").toLowerCase().includes(q);
      })
    : allAlbums;
  const total = filtered.length;
  const start = (page - 1) * pageSize;
  const items = filtered.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice(start, start + pageSize).map(a => ({
    id: a.id, name: a.name, artist: a.artist, artistId: a.artistId, year: a.year,
    songCount: a.songCount, duration: a.duration, playCount: a.playCount,
    coverArt: albumCoverRef(a),
  }));
  return c.json({ total, page, pageSize, items });
});

// ==================== Artists (paginated + searchable) ====================
apiRoutes.get("/v1/artists", (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") || "1") || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query("pageSize") || "50") || 50));
  const query = (c.req.query("query") || "").trim();
  const allArtists = db.select().from(artists).all();
  const filtered = query
    ? allArtists.filter(a => (a.name || "").toLowerCase().includes(query.toLowerCase()))
    : allArtists;
  const total = filtered.length;
  const start = (page - 1) * pageSize;
  const items = filtered.sort((a, b) => (a.name || "").localeCompare(b.name || "")).slice(start, start + pageSize).map(a => ({
    id: a.id, name: a.name, albumCount: a.albumCount, coverArt: a.coverArt ? `ar-${a.id}` : undefined,
    scrapeMissing: a.scrapeMissing === 1,
  }));
  return c.json({ total, page, pageSize, items });
});

// ==================== Artist scrape (QQ Music first, NetEase fallback) ====================
// Manual scrape: scrapes ALL artists missing covers, with real-time progress.
// POST /v1/artists/scrape  { name? }  -> single artist when name given, else full scrape
// GET  /v1/artists/scrape-status     -> current progress { total, processed, scraped, skipped, current, status }
const scrapeJobs = new Map<string, any>();
const SCRAPE_JOB_ID = "default";

apiRoutes.post("/v1/artists/scrape", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = (body.name || "").trim();
  try {
    if (name) {
      const result = await scrapeArtist(name, body.artistId || undefined);
      if (!result) return c.json({ success: false, error: "未找到歌手信息(QQ 和网易云均无结果)" });
      return c.json({ success: true, name: result.name, platform: result.platform, coverArt: result.coverArt, bio: result.bio || undefined });
    }
    // Full scrape: all artists missing covers, run in background with progress
    if (scrapeJobs.get(SCRAPE_JOB_ID)?.status === "running") {
      return c.json({ success: false, error: "刮削正在进行中" });
    }
    const missing = artistsMissingCovers();
    const job = { status: "running", startedAt: new Date().toISOString(), progress: undefined as any };
    scrapeJobs.set(SCRAPE_JOB_ID, job);
    const onProgress = (p: any) => { job.progress = { ...p }; };
    (async () => {
      try {
        const result = await scrapeArtistList(missing.map(a => a.id), onProgress);
        scrapeJobs.set(SCRAPE_JOB_ID, { status: "done", startedAt: job.startedAt, finishedAt: new Date().toISOString(), progress: result });
      } catch (e: any) {
        scrapeJobs.set(SCRAPE_JOB_ID, { status: "failed", startedAt: job.startedAt, error: e.message || "刮削失败", progress: job.progress });
      }
    })();
    return c.json({ success: true, total: missing.length, message: "开始刮削" });
  } catch (e: any) {
    return c.json({ success: false, error: e.message || "刮削失败" });
  }
});

apiRoutes.get("/v1/artists/scrape-status", (c) => {
  const job = scrapeJobs.get(SCRAPE_JOB_ID);
  if (!job) return c.json({ status: "idle", progress: null });
  return c.json({ status: job.status, progress: job.progress || null, error: job.error || null, startedAt: job.startedAt });
});

// Retry scraping ONLY artists marked as missing-info (fallback cover in use).
// If the platform now has the artist, the avatar is replaced with the real one
// and the missing flag is cleared.
apiRoutes.post("/v1/artists/scrape-missing", async (c) => {
  try {
    if (scrapeJobs.get(SCRAPE_JOB_ID)?.status === "running") {
      return c.json({ success: false, error: "刮削正在进行中" });
    }
    const missing = artistsMissingInfo();
    if (missing.length === 0) {
      return c.json({ success: true, total: 0, message: "没有缺失歌手信息的歌手" });
    }
    const job = { status: "running", startedAt: new Date().toISOString(), progress: undefined as any };
    scrapeJobs.set(SCRAPE_JOB_ID, job);
    const onProgress = (p: any) => { job.progress = { ...p }; };
    (async () => {
      try {
        const result = await scrapeArtistList(missing.map(a => a.id), onProgress);
        scrapeJobs.set(SCRAPE_JOB_ID, { status: "done", startedAt: job.startedAt, finishedAt: new Date().toISOString(), progress: result });
      } catch (e: any) {
        scrapeJobs.set(SCRAPE_JOB_ID, { status: "failed", startedAt: job.startedAt, error: e.message || "刮削失败", progress: job.progress });
      }
    })();
    return c.json({ success: true, total: missing.length, message: "开始刮削缺失歌手信息" });
  } catch (e: any) {
    return c.json({ success: false, error: e.message || "刮削失败" });
  }
});

// Count of artists marked missing-info (for the frontend badge)
apiRoutes.get("/v1/artists/missing-info-count", (c) => {
  return c.json({ count: artistsMissingInfo().length });
});

// ==================== Settings ====================
apiRoutes.get("/v1/settings", adminMiddleware, (c) => c.json({ writeBackTags: false, fingerprintEnabled: false }));

// ==================== Daily recommend (combined: remote + pool + local) ====================
//
// These admin endpoints let you inspect / reconfigure / manually trigger the
// daily-recommend system. The actual generation logic lives in
// services/plugin/dailyRecommend.ts; the scheduler that fires it daily lives
// in index.ts.

// Snapshot of the current daily-recommend config + state, for the admin UI.
apiRoutes.get("/v1/daily-recommend", adminMiddleware, (c) => {
  const get = (k: string, def: string) => {
    const r = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(k) as any;
    return r?.value ?? def;
  };
  const getBool = (k: string, def: boolean) => {
    const v = get(k, def ? "true" : "false");
    return v === "true" || v === "1";
  };
  const candidates = loadCandidates();
  const picked = pickDailyCandidate();

  // Only TWO playlists ever exist: "今日推荐" and "昨日推荐" (combined:
  // remote charts + user pool + local history mix, all merged into one).
  const today = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  const findPl = (name: string, tag: string) =>
    sqlite.prepare("SELECT id, name, song_count, created_at, comment FROM playlists WHERE name = ? AND comment LIKE ?").get(name, `%${tag}%`) as any;

  const todayPl = findPl("今日推荐", DAILY_TAG);
  const yesterdayPl = findPl("昨日推荐", DAILY_TAG);

  const plInfo = (row: any) => row ? {
    id: row.id, name: row.name, songCount: row.song_count || 0,
    createdToday: (row.created_at || "").startsWith(today),
  } : null;

  return c.json({
    enabled: getBool("daily_recommend_enabled", true),
    hour: parseInt(get("daily_recommend_hour", "3"), 10) || 3,
    candidates,
    pickedToday: picked,
    today,
    playlists: {
      today: plInfo(todayPl),
      yesterday: plInfo(yesterdayPl),
    },
  });
});

// Update daily-recommend config (master switch, hour).
// Note: retention is no longer used — the rename mechanism ("今日推荐" →
// "昨日推荐") inherently keeps only two playlists at any time.
apiRoutes.put("/v1/daily-recommend/config", adminMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const set = (k: string, v: string) =>
    sqlite.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(k, v, new Date().toISOString());
  if (typeof body.enabled === "boolean") set("daily_recommend_enabled", body.enabled ? "true" : "false");
  if (body.hour !== undefined) {
    const h = parseInt(body.hour, 10);
    if (Number.isFinite(h) && h >= 0 && h <= 23) set("daily_recommend_hour", String(h));
    else return c.json({ error: "hour 必须是 0-23 的整数" }, 400);
  }
  return c.json({ success: true });
});

// Update the candidate pool. Body: { candidates: [{platform, url, name?}] }
// Charts named "新歌" or "欧美" (and known blocked URLs like QQ toplist/27,
// toplist/60, NetEase playlist 3779629) are filtered out and reported.
apiRoutes.put("/v1/daily-recommend/candidates", adminMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const arr = Array.isArray(body.candidates) ? body.candidates : null;
  if (!arr) return c.json({ error: "candidates 必须是数组" }, 400);
  const raw = arr
    .filter((x: any) => x && typeof x.url === "string" && typeof x.platform === "string" && (x.platform === "qq" || x.platform === "netease"))
    .map((x: any) => ({ platform: x.platform, url: x.url.trim(), name: typeof x.name === "string" ? x.name : undefined }));
  const blocked = raw.filter((x: any) => isCandidateBlocked(x));
  const clean = raw.filter((x: any) => !isCandidateBlocked(x));
  if (clean.length === 0) return c.json({ error: "候选池不能为空,且每项需要 platform (qq/netease) + url" }, 400);
  saveCandidates(clean);
  return c.json({ success: true, count: clean.length, blocked: blocked.length, blockedItems: blocked });
});

// Manually trigger today's daily-recommend generation.
// Builds a SINGLE combined "今日推荐" playlist from remote charts + user pool
// + local history mix. Idempotent: if today's playlist already exists, returns
// skipped=true.
apiRoutes.post("/v1/daily-recommend/trigger", adminMiddleware, async (c) => {
  try {
    const result = await generateDailyPlaylist();
    return c.json({ success: true, result }, 200);
  } catch (e: any) {
    const error = e.message || "今日推荐生成失败";
    console.error("[DAILY-RECOMMEND] trigger error:", error);
    return c.json({ success: false, error }, 500);
  }
});

// ==================== User recommend pool ====================
// A user can click "加入每日推荐池" on any playlist (or on "我喜欢的音乐")
// to add that source to the pool. Each daily-recommend run picks up to 50
// random playable songs from every pool member and merges them into the
// day's combined "今日推荐" playlist.

// List all pool members (for an admin management page if desired).
apiRoutes.get("/v1/recommend-pool", (c) => {
  const pool = listRecommendPool();
  return c.json({ pool });
});

// Add a playlist to the pool. Any logged-in user can do this (not admin-only)
// since it's a personalization feature, not a system config.
apiRoutes.post("/v1/recommend-pool/playlist/:playlistId", async (c) => {
  const user = c.get("user");
  const playlistId = c.req.param("playlistId");
  const row = sqlite.prepare("SELECT name FROM playlists WHERE id = ?").get(playlistId) as any;
  if (!row) return c.json({ success: false, error: "歌单不存在" }, 404);
  const added = addToRecommendPool("playlist", playlistId, row.name || "", user?.id || "");
  return c.json({ success: true, added, message: added ? "已加入每日推荐池" : "该歌单已在推荐池中" });
});

// Remove a playlist from the pool.
apiRoutes.delete("/v1/recommend-pool/playlist/:playlistId", (c) => {
  const playlistId = c.req.param("playlistId");
  const removed = removeFromRecommendPool("playlist", playlistId);
  return c.json({ success: true, removed });
});

// Check if a playlist is in the pool (for the UI to show toggle state).
apiRoutes.get("/v1/recommend-pool/playlist/:playlistId/status", (c) => {
  const playlistId = c.req.param("playlistId");
  return c.json({ inPool: isInRecommendPool("playlist", playlistId) });
});

// Add the current user's favorites ("我喜欢的音乐") to the pool.
apiRoutes.post("/v1/recommend-pool/favorites", async (c) => {
  const user = c.get("user");
  if (!user?.id) return c.json({ success: false, error: "未登录" }, 401);
  const added = addToRecommendPool("favorites", user.id, "我喜欢的音乐", user.id);
  return c.json({ success: true, added, message: added ? "已加入每日推荐池" : "我喜欢的音乐已在推荐池中" });
});

// Remove the current user's favorites from the pool.
apiRoutes.delete("/v1/recommend-pool/favorites", (c) => {
  const user = c.get("user");
  if (!user?.id) return c.json({ success: false, error: "未登录" }, 401);
  const removed = removeFromRecommendPool("favorites", user.id);
  return c.json({ success: true, removed });
});

// Check if the current user's favorites are in the pool.
apiRoutes.get("/v1/recommend-pool/favorites/status", (c) => {
  const user = c.get("user");
  if (!user?.id) return c.json({ inPool: false });
  return c.json({ inPool: isInRecommendPool("favorites", user.id) });
});

// ==================== Playlist import (built-in plugins: QQ / NetEase / MusicFlow native file) ====================
apiRoutes.post("/v1/playlists/import", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const url = (body.url || "").trim();
  const native = body.native; // MusicFlow-exported JSON (object) for native files
  if (!url && !native) return c.json({ success: false, error: "请输入歌单链接或选择歌单文件" });
  try {
    if (native) {
      // Native MusicFlow file — may contain one playlist or a whole export-all file
      const nativeList = parseNativePlaylists(native);
      const created: { id: string; name: string }[] = [];
      const totals = { total: 0, matched: 0, unmatched: 0, wishAdded: 0 };
      for (let i = 0; i < nativeList.length; i++) {
        const imp = nativeList[i];
        const name = imp.name.trim() || "导入歌单";
        const id = `pl-${Date.now()}-${i}`;
        db.insert(playlists).values({
          id, name, ownerId: user?.id || "",
          sourceUrl: null, sourcePlatform: imp.platform, externalId: null,
          syncEnabled: 0,
        }).run();
        const result = await rebuildPlaylistEntries(id, imp, {
          userId: user?.id,
          notes: `从本地歌单文件导入「${name}」`,
        });
        totals.total += result.total;
        totals.matched += result.matched;
        totals.unmatched += result.unmatched;
        totals.wishAdded += result.wishAdded;
        created.push({ id, name });
      }
      return c.json({
        success: true,
        playlistId: created[0]?.id,
        name: created[0]?.name || "导入歌单",
        platform: "local",
        trackCount: totals.total,
        matched: totals.matched,
        unmatched: totals.unmatched,
        wishAdded: totals.wishAdded,
        created: created.length,
      });
    }
    if (checkImportCooldown(user?.id || "", url)) {
      return c.json({ success: false, error: "相同歌单刚导入过,请稍候再试" });
    }
    const imported = await importPlaylistFromUrl(url);
    const name = (body.name || imported.name || "导入歌单").trim();
    const id = `pl-${Date.now()}`;
    // Cache the remote platform cover locally (native files carry no cover URL)
    let coverRef: string | undefined = undefined;
    if (imported.coverUrl) {
      const cached = await cacheRemoteCover(imported.coverUrl, `pl-${id}`);
      if (cached) coverRef = cached;
    }
    db.insert(playlists).values({
      id, name, ownerId: user?.id || "",
      sourceUrl: url,
      sourcePlatform: imported.platform,
      externalId: url,
      coverArt: coverRef,
      syncEnabled: body.autoSync ? 1 : 0,
    }).run();
    const result = await rebuildPlaylistEntries(id, imported, {
      userId: user?.id,
      notes: `来自歌单「${name}」导入`,
    });
    return c.json({
      success: true, playlistId: id, name, platform: imported.platform,
      trackCount: result.total, matched: result.matched, unmatched: result.unmatched,
      wishAdded: result.wishAdded, coverUrl: imported.coverUrl, autoSync: !!body.autoSync,
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message || "导入失败" });
  }
});

// Export a playlist as a MusicFlow-native JSON file that round-trips back
// through the import endpoint.
apiRoutes.get("/v1/playlists/:id/export", (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  const playlist = db.select().from(playlists).where(eq(playlists.id, id)).get();
  if (!playlist) return c.json({ error: "歌单不存在" }, 404);
  if (playlist.ownerId !== user?.id && !user?.isAdmin) return c.json({ error: "无权导出该歌单" }, 403);
  const { name, tracks } = exportPlaylistEntries(id);
  const payload = { app: NATIVE_APP, version: 1, exportedAt: new Date().toISOString(), name, tracks };
  const filename = `${(name || "歌单").replace(/[\\/:*?"<>|]/g, "_")}.json`;
  c.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  return c.json(payload);
});

// Export ALL of the current user's playlists into a single MusicFlow-native
// file (raw.playlists array). Re-imports through the same /import endpoint,
// which recreates each playlist.
apiRoutes.get("/v1/playlists/export-all", (c) => {
  const user = c.get("user");
  const mine = db.select().from(playlists)
    .where(eq(playlists.ownerId, user?.id || ""))
    .all();
  const playlistsOut = mine.map((p) => {
    const { name, tracks } = exportPlaylistEntries(p.id);
    return { name, tracks };
  });
  const filename = `MusicFlow全部歌单_${new Date().toISOString().slice(0, 10)}.json`;
  c.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  return c.json({ app: NATIVE_APP, version: 1, exportedAt: new Date().toISOString(), exportAll: true, playlists: playlistsOut });
});

// ==================== Playlist sync ====================
apiRoutes.post("/v1/playlists/:id/sync", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  const playlist = db.select().from(playlists).where(eq(playlists.id, id)).get();
  if (!playlist) return c.json({ success: false, error: "歌单不存在" });
  // Only owner (or admin) can sync
  if (playlist.ownerId !== user?.id && !user?.isAdmin) return c.json({ success: false, error: "无权同步该歌单" });
  try {
    const result = await syncPlaylist(id, { userId: user?.id });
    return c.json({ success: true, ...result });
  } catch (e: any) {
    return c.json({ success: false, error: e.message || "同步失败" });
  }
});

// ==================== Playlist settings (rename / public toggle / auto-sync toggle) ====================
apiRoutes.put("/v1/playlists/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  const body = await c.req.json().catch(() => ({}));
  const playlist = db.select().from(playlists).where(eq(playlists.id, id)).get();
  if (!playlist) return c.json({ success: false, error: "歌单不存在" });
  if (playlist.ownerId !== user?.id && !user?.isAdmin) return c.json({ success: false, error: "无权修改该歌单" });
  const update: any = { updatedAt: new Date().toISOString() };
  if (body.name !== undefined) update.name = String(body.name).trim() || playlist.name;
  if (body.isPublic !== undefined) update.isPublic = body.isPublic ? 1 : 0;
  if (body.syncEnabled !== undefined) update.syncEnabled = body.syncEnabled ? 1 : 0;
  db.update(playlists).set(update).where(eq(playlists.id, id)).run();
  return c.json({ success: true });
});

// ==================== Playlists (paginated) ====================
apiRoutes.get("/v1/playlists", (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") || "1") || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query("pageSize") || "20") || 20));
  const query = (c.req.query("query") || "").trim();
  const user = c.get("user");
  let all = db.select().from(playlists).all().filter(p => p.ownerId === user?.id || p.isPublic || user?.isAdmin);
  if (query) {
    const q = query.toLowerCase();
    all = all.filter(p => (p.name || "").toLowerCase().includes(q));
  }
  const total = all.length;
  // Sort: daily-recommend playlists ("今日推荐"/"昨日推荐") first (today before
  // yesterday), then the rest by updated_at desc.
  const dailyRank = (p: any) => {
    const c = p.comment || "";
    if (c.includes(DAILY_TAG) && p.name === "今日推荐") return 0;
    if (c.includes(DAILY_TAG) && p.name === "昨日推荐") return 1;
    return 2;
  };
  const items = all.sort((a, b) => {
    const ra = dailyRank(a), rb = dailyRank(b);
    if (ra !== rb) return ra - rb;
    return (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || "");
  }).slice((page - 1) * pageSize, page * pageSize).map(p => ({
    id: p.id, name: p.name, owner: p.ownerId, public: !!p.isPublic,
    songCount: p.songCount || 0, duration: p.duration || 0,
    // Always expose a cover ref; getCoverArt falls back to a 4-grid collage for self-built playlists
    coverArt: `pl-${p.id}`, sourcePlatform: p.sourcePlatform || "",
    isImported: !!p.sourceUrl, syncEnabled: !!p.syncEnabled,
    created: p.createdAt, changed: p.updatedAt,
  }));
  return c.json({ total, page, pageSize, items });
});

// ==================== Navidrome compatible ====================
apiRoutes.get("/playlist", (c) => {
  const user = c.get("user");
  const all = db.select().from(playlists).all().filter(p => p.ownerId === user?.id || p.isPublic);
  const dailyRank = (p: any) => {
    const c = p.comment || "";
    if (c.includes(DAILY_TAG) && p.name === "今日推荐") return 0;
    if (c.includes(DAILY_TAG) && p.name === "昨日推荐") return 1;
    return 2;
  };
  return c.json(all.sort((a, b) => {
    const ra = dailyRank(a), rb = dailyRank(b);
    if (ra !== rb) return ra - rb;
    return (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || "");
  }));
});
apiRoutes.get("/playlist/:id/tracks", (c) => c.json(db.select().from(playlistSongs).where(eq(playlistSongs.playlistId, c.req.param("id"))).all().filter(e => e.playable && e.songId)));
apiRoutes.delete("/playlist/:id", (c) => { const user = c.get("user"); const id = c.req.param("id")!; const pl = db.select().from(playlists).where(eq(playlists.id, id)).get(); if (!pl) return c.json({ error: "Playlist not found" }, 404); if (pl.ownerId !== user?.id && !user?.isAdmin) return c.json({ error: "无权删除该歌单" }, 403); db.delete(playlistSongs).where(eq(playlistSongs.playlistId, id)).run(); db.delete(playlists).where(eq(playlists.id, id)).run(); clearPlaylistCoverCache(id); return c.json({ success: true }); });

// ==================== Playlist tracks (paginated) ====================
apiRoutes.get("/v1/playlists/:id/tracks", (c) => {
  const id = c.req.param("id")!;
  const page = Math.max(1, parseInt(c.req.query("page") || "1") || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query("pageSize") || "50") || 50));
  const playlist = db.select().from(playlists).where(eq(playlists.id, id)).get();
  if (!playlist) return c.json({ error: "Playlist not found" }, 404);
  const allEntries = db.select().from(playlistSongs).where(eq(playlistSongs.playlistId, id)).all();
  const total = allEntries.length;
  const matched = allEntries.filter(e => e.playable && e.songId).length;
  const items = allEntries.slice((page - 1) * pageSize, page * pageSize).map(e => {
    if (e.playable && e.songId) {
      const song = db.select().from(songs).where(eq(songs.id, e.songId)).get();
      if (song) {
        const album = song.albumId ? db.select().from(albums).where(eq(albums.id, song.albumId)).get() : undefined;
        return {
          id: song.id, title: song.title, artist: song.artist, album: song.album,
          artistId: song.artistId, albumId: song.albumId, duration: song.duration || 0,
          bitRate: song.bitRate, suffix: song.suffix, contentType: song.contentType,
          coverArt: album?.coverArt ? `al-${album.id}` : (song.coverArt ? `so-${song.id}` : undefined),
          playable: true, isMatched: true,
        };
      }
    }
    return {
      id: e.externalSongId || `ext-${e.id}`, entryId: e.id, title: e.externalTitle || "", artist: e.externalArtist || "",
      album: e.externalAlbum || "", duration: Math.round((e.externalDuration || 0) / 1000),
      playable: false, isMatched: false, unavailableReason: e.unavailableReason || "曲库中未找到",
    };
  });
  return c.json({ total, matched, page, pageSize, items, playlist: { id: playlist.id, name: playlist.name, songCount: playlist.songCount || 0, matched, duration: playlist.duration || 0, coverArt: `pl-${playlist.id}`, sourcePlatform: playlist.sourcePlatform || "", isImported: !!playlist.sourceUrl, syncEnabled: !!playlist.syncEnabled, public: !!playlist.isPublic, owner: playlist.ownerId } });
});

// ==================== Play history (paginated) ====================
apiRoutes.get("/v1/history", (c) => {
  const user = c.get("user");
  const page = Math.max(1, parseInt(c.req.query("page") || "1") || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query("pageSize") || "50") || 50));
  if (!user) return c.json({ total: 0, page, pageSize, items: [] });
  const all = db.select().from(playHistory).where(eq(playHistory.userId, user.id)).all()
    .sort((a, b) => (b.playedAt || "").localeCompare(a.playedAt || ""));
  const total = all.length;
  const items = all.slice((page - 1) * pageSize, page * pageSize).map(h => {
    const song = db.select().from(songs).where(eq(songs.id, h.songId)).get();
    if (!song) return null;
    const album = song.albumId ? db.select().from(albums).where(eq(albums.id, song.albumId)).get() : undefined;
    return {
      id: song.id, title: song.title, artist: song.artist, album: song.album,
      artistId: song.artistId, albumId: song.albumId, duration: song.duration || 0,
      bitRate: song.bitRate, suffix: song.suffix, contentType: song.contentType,
      coverArt: album?.coverArt ? `al-${album.id}` : (song.coverArt ? `so-${song.id}` : undefined),
      playedAt: h.playedAt || "",
    };
  }).filter(Boolean);
  return c.json({ total, page, pageSize, items });
});

// Clear the current user's play history. Does not touch playCount on songs
// (that's a historical counter, not a history record).
apiRoutes.delete("/v1/history", (c) => {
  const user = c.get("user");
  if (!user) return c.json({ deleted: 0 });
  const result = db.delete(playHistory).where(eq(playHistory.userId, user.id)).run();
  return c.json({ deleted: result.changes || 0 });
});

// ==================== DLNA cast ====================
const DLNA_MIME: Record<string, string> = {
  mp3: "audio/mpeg", flac: "audio/flac", wav: "audio/wav", aac: "audio/aac",
  ogg: "audio/ogg", m4a: "audio/mp4", wma: "audio/x-ms-wma", ape: "audio/ape",
  aiff: "audio/aiff", opus: "audio/opus",
};

// Derive the LAN base URL the DLNA renderer should use to pull the stream.
// Uses the request Host header's hostname + the backend's actual listening
// port (so it works even when fronted by a dev proxy on a different port).
// Also records it for the internal cast paths (auto-advance / stalled retry)
// so they reuse the same reachable address.
//
// 关键:只信任「局域网可达」的 Host(私有 IP / .local)。通过公网域名访问时,Host 头是
// 公网域名,设备在同一 LAN 内无法解析回连 → 直接回退到自动探测的 LAN IP,确保推给 DLNA
// 设备的永远是局域网地址。DLNA_BASE_URL 环境变量优先级最高,可显式覆盖。
export function getDlnaBaseUrl(c: any): string {
  const envBase = process.env.DLNA_BASE_URL;
  if (envBase) { const u = envBase.replace(/\/+$/, ""); recordBaseUrl(u); return u; }
  const host = c.req.header("host") || "";
  const hostname = host.split(":")[0] || "";
  const port = process.env.PORT || "46400";
  // 仅当 Host 是局域网可达地址(私有 IP / .local)时才直接复用;公网域名与回环地址
  // 一律回退到自动探测的 LAN IP,避免把公网域名推给设备。
  if (!isPrivateLanHostname(hostname)) return getEffectiveBaseUrl();
  const u = `http://${hostname}:${port}`;
  recordBaseUrl(u);
  return u;
}

// List discovered DLNA renderers (refreshes cache if stale).
apiRoutes.get("/v1/dlna/devices", async (c) => {
  if (shouldRefreshDevices() || getCachedDevices().length === 0) {
    await refreshDevices();
  }
  const devices = markStaleDevices(getCachedDevices()).map(d => ({
    id: d.id, name: d.name, manufacturer: d.manufacturer, model: d.model,
    hasVolumeControl: !!d.renderingControlUrl,
    available: d.available,
  }));
  return c.json({ devices });
});

// Force a fresh SSDP discovery scan.
apiRoutes.post("/v1/dlna/scan", async (c) => {
  const devices = await refreshDevices();
  return c.json({ devices: devices.map(d => ({
    id: d.id, name: d.name, manufacturer: d.manufacturer, model: d.model,
    hasVolumeControl: !!d.renderingControlUrl,
    available: d.available,
  })) });
});

// Cast a song to a DLNA renderer.
apiRoutes.post("/v1/dlna/cast", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { songId, deviceId } = body;
  if (!songId || !deviceId) return c.json({ error: "需要 songId 和 deviceId" }, 400);
  const song = db.select().from(songs).where(eq(songs.id, songId)).get();
  if (!song) return c.json({ error: "歌曲不存在" }, 404);
  const mime = DLNA_MIME[song.suffix || ""] || "audio/mpeg";
  try {
    await castToDevice({
      songId, deviceId,
      title: song.title || "未知",
      artist: song.artist || undefined,
      album: song.album || undefined,
      mime,
      baseUrl: getDlnaBaseUrl(c),
      coverArt: song.coverArt || undefined,
    });
    return c.json({ success: true, message: `已投屏到设备` });
  } catch (e: any) {
    return c.json({ error: e.message || "投屏失败" }, 500);
  }
});

// Preload the next track on the device for gapless playback (SetNextAVTransportURI).
// The frontend calls this after a successful cast, and again whenever the
// device finishes a track, so the next song is ready before the current one ends.
apiRoutes.post("/v1/dlna/enqueue", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { songId, deviceId } = body;
  if (!songId || !deviceId) return c.json({ error: "需要 songId 和 deviceId" }, 400);
  const song = db.select().from(songs).where(eq(songs.id, songId)).get();
  if (!song) return c.json({ error: "歌曲不存在" }, 404);
  const mime = DLNA_MIME[song.suffix || ""] || "audio/mpeg";
  try {
    const supported = await enqueueNextTrack({
      songId, deviceId,
      title: song.title || "未知",
      artist: song.artist || undefined,
      album: song.album || undefined,
      mime,
      baseUrl: getDlnaBaseUrl(c),
      coverArt: song.coverArt || undefined,
    });
    return c.json({ success: true, enqueueSupported: supported });
  } catch (e: any) {
    return c.json({ error: e.message || "预加载失败" }, 500);
  }
});

// Transport controls.
apiRoutes.post("/v1/dlna/devices/:deviceId/play", async (c) => {
  try { await playDevice(c.req.param("deviceId")); return c.json({ success: true }); }
  catch (e: any) { return c.json({ error: e.message }, 500); }
});

apiRoutes.post("/v1/dlna/devices/:deviceId/pause", async (c) => {
  try { await pauseDevice(c.req.param("deviceId")); return c.json({ success: true }); }
  catch (e: any) { return c.json({ error: e.message }, 500); }
});

apiRoutes.post("/v1/dlna/devices/:deviceId/stop", async (c) => {
  try { await stopDevice(c.req.param("deviceId")); return c.json({ success: true }); }
  catch (e: any) { return c.json({ error: e.message }, 500); }
});

apiRoutes.post("/v1/dlna/devices/:deviceId/seek", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  // Accept either `seconds` (frontend) or `position` (HA integration) for
  // the seek target, in seconds.
  const seconds = typeof body.seconds === "number" ? body.seconds : body.position;
  if (typeof seconds !== "number") return c.json({ error: "需要 seconds 或 position" }, 400);
  try { await seekDevice(c.req.param("deviceId"), seconds); return c.json({ success: true }); }
  catch (e: any) { return c.json({ error: e.message }, 500); }
});

apiRoutes.post("/v1/dlna/devices/:deviceId/volume", async (c) => {
  const { volume } = await c.req.json().catch(() => ({}));
  if (typeof volume !== "number") return c.json({ error: "需要 volume" }, 400);
  try { await setDeviceVolume(c.req.param("deviceId"), volume); return c.json({ success: true }); }
  catch (e: any) { return c.json({ error: e.message }, 500); }
});

// Query device status (state / position / duration / volume).
// Merges the freshest GENA event state (if any) with a live SOAP snapshot so
// the frontend gets low-latency updates from event push + a periodic SOAP
// ground-truth to correct any drift.
apiRoutes.get("/v1/dlna/devices/:deviceId/status", async (c) => {
  try {
    const deviceId = c.req.param("deviceId");
    const status = await getDeviceStatus(deviceId);
    const evt = getEventManager().getEventState(deviceId);
    if (evt) {
      // Event state is fresher for the fields it carries; prefer it over SOAP
      // when available, but keep SOAP as the fallback (events may lag).
      if (evt.state) status.state = evt.state;
      if (typeof evt.position === "number" && evt.position > 0) status.position = evt.position;
      if (typeof evt.duration === "number" && evt.duration > 0) status.duration = evt.duration;
      if (typeof evt.volume === "number") status.volume = evt.volume;
    }
    return c.json(status);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ==================== Queue management ====================
// Per-device playback queue. Used by the HA integration's play_media (album /
// playlist) and next/prev track commands. baseUrl is resolved from the
// request host so DLNA renderers can pull the stream back from this server.
apiRoutes.get("/v1/dlna/devices/:deviceId/queue", (c) => {
  const deviceId = c.req.param("deviceId")!;
  // 新 QueueSnapshot 不再带 currentMedia(改为 ended);路由层补回以保持前端/HA 响应形状兼容。
  return c.json({ ...getQueueManager().snapshot(deviceId), currentMedia: getCurrentMedia(deviceId) });
});

// Replace the queue and start playing from `startIndex` (default 0).
// Body: { items: QueueItem[], startIndex?: number }
apiRoutes.post("/v1/dlna/devices/:deviceId/queue/play", async (c) => {
  const deviceId = c.req.param("deviceId")!;
  const { items, startIndex } = await c.req.json().catch(() => ({} as any));
  if (!Array.isArray(items)) return c.json({ error: "需要 items 数组" }, 400);
  try {
    await getQueueManager().playFrom(deviceId, items, startIndex || 0, getDlnaBaseUrl(c));
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// Append items to the queue without switching playback.
// Body: { items: QueueItem[] }
apiRoutes.post("/v1/dlna/devices/:deviceId/queue/enqueue", async (c) => {
  const deviceId = c.req.param("deviceId")!;
  const { items } = await c.req.json().catch(() => ({} as any));
  if (!Array.isArray(items)) return c.json({ error: "需要 items 数组" }, 400);
  try {
    await getQueueManager().enqueue(deviceId, items, getDlnaBaseUrl(c));
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

apiRoutes.post("/v1/dlna/devices/:deviceId/next", async (c) => {
  try {
    await getQueueManager().next(c.req.param("deviceId")!, getDlnaBaseUrl(c));
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

apiRoutes.post("/v1/dlna/devices/:deviceId/prev", async (c) => {
  try {
    await getQueueManager().prev(c.req.param("deviceId")!, getDlnaBaseUrl(c));
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

apiRoutes.delete("/v1/dlna/devices/:deviceId/queue", (c) => {
  getQueueManager().clear(c.req.param("deviceId")!);
  return c.json({ success: true });
});

// List all devices that currently have an active queue. The Web frontend
// calls this on load to restore the cast state (which device was playing,
// what queue, what index) after the tab was closed or the backend restarted.
apiRoutes.get("/v1/dlna/active", (c) => {
  // 每个 snapshot 补 currentMedia,保持原响应形状(新 QueueSnapshot 改用 ended)。
  const active = getQueueManager().activeDevices().map((a) => ({
    deviceId: a.deviceId,
    snapshot: { ...a.snapshot, currentMedia: getCurrentMedia(a.deviceId) },
  }));
  return c.json({ active });
});

// Set the play mode (order | one | all | shuffle) for a device's queue.
// Body: { mode: PlayMode }
apiRoutes.post("/v1/dlna/devices/:deviceId/play-mode", async (c) => {
  const { mode } = await c.req.json().catch(() => ({} as any));
  if (!["order", "one", "all", "shuffle"].includes(mode)) {
    return c.json({ error: "无效的 mode" }, 400);
  }
  getQueueManager().setPlayMode(c.req.param("deviceId")!, mode);
  return c.json({ success: true });
});

// Remove a single item from the queue by index. Playback stays coherent:
// if the removed item was current, the next one starts playing.
apiRoutes.delete("/v1/dlna/devices/:deviceId/queue/:index", async (c) => {
  const deviceId = c.req.param("deviceId")!;
  const index = parseInt(c.req.param("index")!, 10);
  if (Number.isNaN(index)) return c.json({ error: "无效的 index" }, 400);
  getQueueManager().removeAt(deviceId, index, getDlnaBaseUrl(c));
  return c.json({ success: true });
});

// Mark a device's queue inactive without clearing it (used when the user
// stops cast from the Web client — the queue stays in DB for reuse, but the
// device is no longer considered "actively casting" for restore purposes).
apiRoutes.post("/v1/dlna/devices/:deviceId/deactivate", (c) => {
  getQueueManager().deactivate(c.req.param("deviceId")!);
  return c.json({ success: true });
});

// ==================== Unified peer API ====================
//
// One API surface for both local (Web client) and DLNA peers. The peerId
// encodes the kind: "local:<userId>" or "dlna:<deviceId>". The colon in the
// path segment is URL-safe; clients send it encoded (encodeURIComponent) and
// we decode here so handlers always see the canonical form.
//
// For local peers the backend only stores queue metadata (audio runs on the
// Web client). Transport controls (play/pause/next/prev/seek/volume) are
// accepted but are no-ops server-side — the Web client owns Howl and reports
// state changes back via /queue/index and /play-mode.
//
// For dlna peers every call delegates to the existing queue manager + control
// layer, so HA and Web share the exact same queue + auto-advance logic.
const pm = getPeerManager();

function decodePeerId(c: any): string {
  return decodeURIComponent(c.req.param("peerId") || "");
}

// 可投屏/可控制 peer:dlna 设备与播放器群组(group)。两者队列都归
// QueueController 管(内部按裸 id),传输控制一个走 control.ts、一个走组扇出。
function isCastPeer(parsed: { kind: string }): boolean {
  return parsed.kind === "dlna" || parsed.kind === "group";
}

// List all known peers (local + dlna) with their queue snapshots. The Web
// client calls this to populate the player-switcher popup.
apiRoutes.get("/v1/peers", (c) => {
  return c.json({ peers: pm.listWithQueues() });
});

// Register/refresh the calling user's local peer. Body: { name?: string }.
// name defaults to the username so the switcher shows a friendly label.
apiRoutes.post("/v1/peers/register", (c) => {
  const user = c.get("user")!;
  const body = c.req.json().catch(() => ({})) as any;
  const name = (body && typeof body.name === "string" && body.name) || user.username;
  const peer = pm.registerLocal(user.id, name);
  return c.json({ peer });
});

// Heartbeat: keep a local peer alive. Called periodically by the Web client.
apiRoutes.post("/v1/peers/:peerId/heartbeat", (c) => {
  const peerId = decodePeerId(c);
  const ok = pm.heartbeat(peerId);
  return c.json({ success: ok });
});

// Get a peer's queue snapshot (local: from local_queues; dlna/group: from queue manager).
apiRoutes.get("/v1/peers/:peerId/queue", (c) => {
  const peerId = decodePeerId(c);
  const snap = pm.getQueueSnapshot(peerId);
  if (!snap) return c.json({ error: "无效的 peerId" }, 400);
  // dlna peer:补 currentMedia(原 QueueSnapshot 字段,新 snapshot 改用 ended)。
  const parsed = parsePeerId(peerId);
  const currentMedia = parsed && parsed.kind === "dlna" ? getCurrentMedia(parsed.id) : undefined;
  return c.json({ ...snap, currentMedia });
});

// Replace the queue and (for dlna/group) start playing from startIndex.
// For local peers this just persists the queue; the Web client starts Howl.
// Body: { items: QueueItem[], startIndex?: number }
apiRoutes.post("/v1/peers/:peerId/queue/play", async (c) => {
  const peerId = decodePeerId(c);
  const { items, startIndex } = await c.req.json().catch(() => ({} as any));
  if (!Array.isArray(items)) return c.json({ error: "需要 items 数组" }, 400);
  const start = typeof startIndex === "number" ? startIndex : 0;
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (isCastPeer(parsed)) {
    try {
      await getQueueManager().playFrom(parsed.id, items, start, getDlnaBaseUrl(c));
      return c.json({ success: true });
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  // local
  pm.localPlayFrom(peerId, c.get("user")!.id, items, start);
  return c.json({ success: true });
});

// Append items to the queue without switching playback.
// Body: { items: QueueItem[] }
apiRoutes.post("/v1/peers/:peerId/queue/enqueue", async (c) => {
  const peerId = decodePeerId(c);
  const { items } = await c.req.json().catch(() => ({} as any));
  if (!Array.isArray(items)) return c.json({ error: "需要 items 数组" }, 400);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (isCastPeer(parsed)) {
    try {
      await getQueueManager().enqueue(parsed.id, items, getDlnaBaseUrl(c));
      return c.json({ success: true });
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  pm.localEnqueue(peerId, c.get("user")!.id, items);
  return c.json({ success: true });
});

// Clear the queue.
apiRoutes.delete("/v1/peers/:peerId/queue", (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (isCastPeer(parsed)) {
    getQueueManager().clear(parsed.id);
  } else {
    pm.localClear(peerId);
  }
  return c.json({ success: true });
});

// Remove a single item by index.
apiRoutes.delete("/v1/peers/:peerId/queue/:index", async (c) => {
  const peerId = decodePeerId(c);
  const index = parseInt(c.req.param("index")!, 10);
  if (Number.isNaN(index)) return c.json({ error: "无效的 index" }, 400);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (isCastPeer(parsed)) {
    getQueueManager().removeAt(parsed.id, index, getDlnaBaseUrl(c));
  } else {
    pm.localRemoveAt(peerId, index);
  }
  return c.json({ success: true });
});

// Set the play mode (order | one | all | shuffle).
// Body: { mode: PlayMode }
apiRoutes.post("/v1/peers/:peerId/play-mode", async (c) => {
  const peerId = decodePeerId(c);
  const { mode } = await c.req.json().catch(() => ({} as any));
  if (!["order", "one", "all", "shuffle"].includes(mode)) {
    return c.json({ error: "无效的 mode" }, 400);
  }
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (isCastPeer(parsed)) {
    getQueueManager().setPlayMode(parsed.id, mode);
  } else {
    pm.localSetPlayMode(peerId, mode);
  }
  return c.json({ success: true });
});

// Report the current track index for a local peer (Web client → backend).
// Body: { index: number }
apiRoutes.post("/v1/peers/:peerId/queue/index", async (c) => {
  const peerId = decodePeerId(c);
  const { index } = await c.req.json().catch(() => ({} as any));
  if (typeof index !== "number") return c.json({ error: "需要 index" }, 400);
  const parsed = parsePeerId(peerId);
  if (!parsed || parsed.kind !== "local") return c.json({ error: "仅 local peer 支持" }, 400);
  pm.localSetIndex(peerId, index);
  return c.json({ success: true });
});

// ==================== Peer transport controls ====================
// For dlna peers these command the device. For local peers they are no-ops
// server-side (the Web client owns the audio) — they exist only so HA can use
// a single URL shape; local-peer playback is not controllable from HA.

apiRoutes.post("/v1/peers/:peerId/play", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (parsed.kind === "dlna") {
    try { await playDevice(parsed.id); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "group") {
    try { await getQueueController().transport(parsed.id, "play"); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  return c.json({ success: true }); // local: no-op
});

apiRoutes.post("/v1/peers/:peerId/pause", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (parsed.kind === "dlna") {
    try { await pauseDevice(parsed.id); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "group") {
    try { await getQueueController().transport(parsed.id, "pause"); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  return c.json({ success: true });
});

apiRoutes.post("/v1/peers/:peerId/stop", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (parsed.kind === "dlna") {
    try { await stopDevice(parsed.id); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "group") {
    try { await getQueueController().transport(parsed.id, "stop"); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  return c.json({ success: true });
});

apiRoutes.post("/v1/peers/:peerId/next", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (isCastPeer(parsed)) {
    try { await getQueueManager().next(parsed.id, getDlnaBaseUrl(c)); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  return c.json({ success: true });
});

apiRoutes.post("/v1/peers/:peerId/prev", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (isCastPeer(parsed)) {
    try { await getQueueManager().prev(parsed.id, getDlnaBaseUrl(c)); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  return c.json({ success: true });
});

apiRoutes.post("/v1/peers/:peerId/seek", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (parsed.kind === "dlna") {
    const body = await c.req.json().catch(() => ({} as any));
    const seconds = typeof body.seconds === "number" ? body.seconds : body.position;
    if (typeof seconds !== "number") return c.json({ error: "需要 seconds 或 position" }, 400);
    try { await seekDevice(parsed.id, seconds); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "group") {
    const body = await c.req.json().catch(() => ({} as any));
    const seconds = typeof body.seconds === "number" ? body.seconds : body.position;
    if (typeof seconds !== "number") return c.json({ error: "需要 seconds 或 position" }, 400);
    try { await getQueueController().transport(parsed.id, "seek", seconds); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  return c.json({ success: true });
});

apiRoutes.post("/v1/peers/:peerId/volume", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (parsed.kind === "dlna") {
    const { volume } = await c.req.json().catch(() => ({} as any));
    if (typeof volume !== "number") return c.json({ error: "需要 volume" }, 400);
    try { await setDeviceVolume(parsed.id, volume); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "group") {
    const { volume } = await c.req.json().catch(() => ({} as any));
    if (typeof volume !== "number") return c.json({ error: "需要 volume" }, 400);
    try { await getQueueController().transport(parsed.id, "volume", volume); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  return c.json({ success: true });
});

// Peer status: for dlna returns the device transport state; for groups the
// leader's state (MA 同款:组状态从 leader 派生);for local returns the stored
// queue metadata (HA uses this to read the local peer's queue).
apiRoutes.get("/v1/peers/:peerId", (c) => {
  const peerId = decodePeerId(c);
  const p = getPeerManager().get(peerId);
  if (!p) return c.json({ error: "无效的 peerId" }, 400);
  return c.json({ peer: { ...p, queue: getPeerManager().getQueueSnapshot(peerId) } });
});

apiRoutes.get("/v1/peers/:peerId/status", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  if (parsed.kind === "dlna") {
    try {
      const deviceId = parsed.id;
      const status = await getDeviceStatus(deviceId);
      const evt = getEventManager().getEventState(deviceId);
      if (evt) {
        if (evt.state) status.state = evt.state;
        if (typeof evt.position === "number" && evt.position > 0) status.position = evt.position;
        if (typeof evt.duration === "number" && evt.duration > 0) status.duration = evt.duration;
        if (typeof evt.volume === "number") status.volume = evt.volume;
      }
      return c.json(status);
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "group") {
    try {
      const status = await getGroupStatus(parsed.id);
      const evt = getEventManager().getEventState(getGroupLeaderDeviceId(parsed.id) || "");
      if (evt) {
        if (evt.state) status.state = evt.state;
        if (typeof evt.position === "number" && evt.position > 0) status.position = evt.position;
        if (typeof evt.duration === "number" && evt.duration > 0) status.duration = evt.duration;
        if (typeof evt.volume === "number") status.volume = evt.volume;
      }
      return c.json(status);
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  // local: return queue snapshot as "status"
  return c.json(pm.getQueueSnapshot(peerId) || {});
});

// ==================== 播放器群组 API ====================
// 一个组聚合多台 DLNA 设备(组持队列、播放时并发向成员 cast 同一首歌,
// 仿 MA Sync Group / Universal Group)。成员勾选提交全量 memberIds(PUT)。
// 组播放控制复用 peer API:peerId = "group:<groupId>"(阶段 2 接入)。
const gm = getGroupManager();

// 列出全部组(含成员设备信息:名称/可用性)。
apiRoutes.get("/v1/groups", (c) => {
  return c.json({ groups: gm.listWithMembers() });
});

// 新建组。Body: { name: string, memberIds?: string[] }
apiRoutes.post("/v1/groups", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const name = typeof body.name === "string" ? body.name : "";
  const memberIds = Array.isArray(body.memberIds) ? body.memberIds : [];
  try {
    const g = gm.createGroup(name, memberIds);
    return c.json({ group: gm.getWithMembers(g.id) }, 201);
  } catch (e: any) {
    return c.json({ error: e.message || "创建组失败" }, 400);
  }
});

// 更新组:改名(name)和/或全量替换成员(memberIds)。Body: { name?, memberIds? }
apiRoutes.put("/v1/groups/:id", async (c) => {
  const id = c.req.param("id")!;
  const body = await c.req.json().catch(() => ({} as any));
  try {
    if (typeof body.name === "string") {
      const renamed = gm.renameGroup(id, body.name);
      if (!renamed) return c.json({ error: "组不存在" }, 404);
    }
    if (Array.isArray(body.memberIds)) {
      const before = gm.get(id)?.memberIds || [];
      const updated = gm.setMembers(id, body.memberIds);
      if (!updated) return c.json({ error: "组不存在" }, 404);
      const after = gm.get(id)?.memberIds || [];
      const added = after.filter(d => !before.includes(d));
      if (added.length > 0) {
        // 成员加入播放中的组:把当前曲 cast 给新成员并 seek 到 leader 进度
        // (仅加入时一次,不做周期漂移校正——纯 MA 忠实策略)。
        getQueueController().rejoinMembers(id, added).catch((e: any) => {
          console.warn(`[group] ${id}: 成员加入对齐失败: ${e?.message || e}`);
        });
      }
    }
    const g = gm.getWithMembers(id);
    if (!g) return c.json({ error: "组不存在" }, 404);
    return c.json({ group: g });
  } catch (e: any) {
    return c.json({ error: e.message || "更新组失败" }, 400);
  }
});

// 删除组(组队列随之删除,成员设备恢复单独控制)。
apiRoutes.delete("/v1/groups/:id", (c) => {
  const ok = gm.deleteGroup(c.req.param("id")!);
  if (!ok) return c.json({ error: "组不存在" }, 404);
  return c.json({ success: true });
});

// ==================== 统一内容点播(webhook / 外部 API) ====================
// POST /v1/play { peerId, type: playlist|artist|album|genre, id, startIndex?, playMode?, enqueue? }
// 服务器端把内容 ID 解析成歌曲队列并投递到指定播放器:
//   - dlna / group → 直接开始播放(后端控制音频,无需浏览器)
//   - local → 注入队列(音频仍由 Web 客户端 Howl 驱动)

apiRoutes.post("/v1/play", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const { peerId, type, id, startIndex, playMode, enqueue } = body || {};
  if (typeof peerId !== "string" || typeof type !== "string" || typeof id !== "string") {
    return c.json({ error: "需要 peerId / type / id" }, 400);
  }
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json({ error: "无效的 peerId" }, 400);
  const resolved = resolveContentSongs(type, id);
  if (!resolved) return c.json({ error: `无效的 ${type} id` }, 404);
  const items = songsToQueueItems(resolved.rows);
  if (items.length === 0) return c.json({ error: `「${resolved.name}」没有可播放的歌曲` }, 422);
  const start = typeof startIndex === "number" && startIndex >= 0 && startIndex < items.length ? Math.floor(startIndex) : 0;
  const baseUrl = getDlnaBaseUrl(c);
  if (isCastPeer(parsed)) {
    try {
      if (enqueue) await getQueueManager().enqueue(parsed.id, items, baseUrl);
      else await getQueueManager().playFrom(parsed.id, items, start, baseUrl);
    } catch (e: any) { return c.json({ error: e.message || "播放失败" }, 500); }
  } else {
    if (enqueue) pm.localEnqueue(peerId, c.get("user")?.id, items);
    else pm.localPlayFrom(peerId, c.get("user")?.id, items, start);
  }
  if (typeof playMode === "string" && ["order", "one", "all", "shuffle"].includes(playMode)) {
    const mode = playMode as "order" | "one" | "all" | "shuffle";
    if (isCastPeer(parsed)) getQueueManager().setPlayMode(parsed.id, mode);
    else pm.localSetPlayMode(peerId, mode);
  }
  return c.json({ success: true, peerId, type, id, name: resolved.name, queued: items.length, startIndex: enqueue ? undefined : start });
});

// ==================== 音流(MusicFlow) ====================
// 每条音流 = 目标设备/组(多选) + 等上线 + 音量 + 播放模式 + 播歌单,
// 通过唯一 token 的公开 webhook 链接(/api/v1/webhooks/flows/:token)异步触发。

const DEFAULT_DEFINITION = {
  targets: [],
  waitTimeoutSec: 0,
  scanIntervalSec: 5,
  volume: { enabled: true, value: 80 },
  playmode: { enabled: true, mode: "shuffle" },
  content: { enabled: true, type: "playlist", id: "", startIndex: 0 },
};

// 对外可复制链接:用局域网可达 base,保证外部 webhook 能命中。/rest、/api 均受鉴权,
// 音流链接悬停在 /webhooks/... 路径上(免鉴权)。
function flowWithWebhook(flow: any) {
  return { ...flow, webhookUrl: `${getEffectiveBaseUrl()}/webhooks/flows/${flow.token}` };
}

apiRoutes.get("/v1/flows", (c) => {
  const items = listFlows().map(flowWithWebhook);
  return c.json({ total: items.length, items });
});

apiRoutes.get("/v1/flows/:id", (c) => {
  const flow = getFlow(c.req.param("id")!);
  if (!flow) return c.json({ error: "流程不存在" }, 404);
  return c.json({ flow: flowWithWebhook(flow) });
});

apiRoutes.post("/v1/flows", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "需要 name" }, 400);
  const flow = createFlow(name, body.definition || { ...DEFAULT_DEFINITION });
  return c.json({ flow: flowWithWebhook(flow) });
});

apiRoutes.put("/v1/flows/:id", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const flow = updateFlow(c.req.param("id")!, {
    name: typeof body.name === "string" ? body.name : undefined,
    definition: body.definition,
    enabled: body.enabled === undefined ? undefined : !!body.enabled,
  });
  if (!flow) return c.json({ error: "流程不存在" }, 404);
  return c.json({ flow: flowWithWebhook(flow) });
});

apiRoutes.delete("/v1/flows/:id", (c) => {
  const ok = deleteFlow(c.req.param("id")!);
  if (!ok) return c.json({ error: "流程不存在" }, 404);
  return c.json({ success: true });
});

// UI 手动触发(异步执行,返回当前运行状态)。
apiRoutes.post("/v1/flows/:id/run", async (c) => {
  const flow = getFlow(c.req.param("id")!);
  if (!flow) return c.json({ error: "流程不存在" }, 404);
  if (!flow.enabled) return c.json({ error: "流程已停用" }, 409);
  const started = await executeFlow(flow.id, getDlnaBaseUrl(c));
  return c.json({ success: true, started: started === "started", running: isFlowRunning(flow.id) });
});

// ==================== 通用播放器控制渠道 token(独立管理,可多条) ====================
// 每条渠道 token 可独立启用/停用/删除;「我喜欢」收藏归属各自 owner(创建者)。
// 免鉴权端点 /webhook/player 凭任一启用的 token 执行。与音流(flow)流程完全解耦。

apiRoutes.get("/v1/player-webhook/tokens", (c) => {
  const items = listPlayerWebhookTokens().map(t => ({
    id: t.id, name: t.name, token: t.token, enabled: t.enabled,
    ownerName: resolvePlayerWebhookOwnerName(t.ownerUserId),
    createdAt: t.createdAt, updatedAt: t.updatedAt,
  }));
  return c.json({ items, templateUrl: `${getEffectiveBaseUrl()}/webhook/player` });
});

apiRoutes.post("/v1/player-webhook/tokens", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const name = (body && typeof body.name === "string" && body.name.trim()) || "渠道 " + (listPlayerWebhookTokens().length + 1);
  const token = createPlayerWebhookToken(c.get("user")!.id, name);
  return c.json({ token, name });
});

apiRoutes.put("/v1/player-webhook/tokens/:id", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const enabled = !!(body && body.enabled);
  const ok = setPlayerWebhookTokenEnabled(c.req.param("id")!, enabled);
  if (!ok) return c.json({ error: "token 不存在" }, 404);
  return c.json({ success: true });
});

apiRoutes.delete("/v1/player-webhook/tokens/:id", (c) => {
  const ok = deletePlayerWebhookToken(c.req.param("id")!);
  if (!ok) return c.json({ error: "token 不存在" }, 404);
  return c.json({ success: true });
});

