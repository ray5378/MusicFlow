import { Hono } from "hono";
import { db } from "../../db/index.js";
import { users, playlists, playlistSongs, songs, albums, artists, mediaSources, plugins, wishes, userFavoriteSongs, playHistory } from "../../db/schema.js";
import { eq, like, inArray, or, and, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import md5 from "md5";
import { adminMiddleware } from "../../middleware/auth.js";
import { scanLocalSource, scanWebDAVSource, testWebDAVConnection, cleanupOrphans, ScanProgress } from "../../services/source/scanner.js";
import { encryptPassword } from "../../db/index.js";
import { importPlaylistFromUrl, ImportedPlaylist, ImportedTrack } from "../../services/plugin/playlistImport.js";
import { checkImportCooldown, rebuildPlaylistEntries, syncPlaylist, refreshPlaylistCounts } from "../../services/plugin/playlistSync.js";
import {
  generateDailyPlaylist, loadCandidates, saveCandidates, pickDailyCandidate,
  isCandidateBlocked,
  DAILY_TAG, listRecommendPool, addToRecommendPool, removeFromRecommendPool, isInRecommendPool,
} from "../../services/plugin/dailyRecommend.js";
import { sqlite } from "../../db/index.js";
import { cacheRemoteCover, clearPlaylistCoverCache } from "../../services/playlistCover.js";
import { scrapeArtist, scrapeArtistList, artistsMissingCovers, artistsMissingInfo } from "../../services/scraper/artist.js";

export const apiRoutes = new Hono();

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
  // SQL-level filtering + pagination (avoids loading the whole table into memory)
  const conds = [];
  if (genre) conds.push(eq(songs.genre, genre));
  if (query) {
    const q = `%${query}%`;
    conds.push(or(like(songs.title, q), like(songs.artist, q), like(songs.album, q)));
  }
  const where = conds.length > 0 ? (conds.length === 1 ? conds[0] : and(...conds)) : undefined;
  const start = (page - 1) * pageSize;
  // Fast SQL count for the total
  const totalRow = where
    ? db.select({ n: sql<number>`count(*)` }).from(songs).where(where).get()
    : db.select({ n: sql<number>`count(*)` }).from(songs).get();
  const total = totalRow?.n ?? 0;
  // SQL-level pagination: load only the requested page (ordered by title)
  const pageSongs = (where
    ? db.select().from(songs).where(where).orderBy(songs.title).limit(pageSize).offset(start).all()
    : db.select().from(songs).orderBy(songs.title).limit(pageSize).offset(start).all());
  const items = pageSongs.map(s => ({
    id: s.id, title: s.title, artist: s.artist, album: s.album, artistId: s.artistId,
    albumId: s.albumId, duration: s.duration, bitRate: s.bitRate, suffix: s.suffix,
    contentType: s.contentType, size: s.size, playCount: s.playCount, genre: s.genre,
    track: s.track, discNumber: s.discNumber,
    coverArt: s.albumId ? idToCoverArt(s.albumId, "al") : undefined,
  }));
  return c.json({ total, page, pageSize, items });
});

function idToCoverArt(id: string | null, prefix: string): string | undefined {
  if (!id) return undefined;
  const album = db.select().from(albums).where(eq(albums.id, id)).get();
  return album && album.coverArt ? `${prefix}-${album.id}` : undefined;
}

// ==================== Genres (with song counts) ====================
apiRoutes.get("/v1/genres", (c) => {
  const genreMap = new Map<string, number>();
  for (const s of db.select().from(songs).all()) {
    if (!s.genre) continue;
    genreMap.set(s.genre, (genreMap.get(s.genre) || 0) + 1);
  }
  const items = Array.from(genreMap.entries())
    .map(([name, songCount]) => ({ name, songCount }))
    .sort((a, b) => b.songCount - a.songCount);
  return c.json({ total: items.length, items });
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
    coverArt: a.coverArt ? `al-${a.id}` : undefined,
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

// ==================== Playlist import (built-in plugins: QQ / NetEase) ====================
apiRoutes.post("/v1/playlists/import", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const url = (body.url || "").trim();
  if (!url) return c.json({ success: false, error: "请输入歌单链接" });
  try {
    if (checkImportCooldown(user?.id || "", url)) {
      return c.json({ success: false, error: "相同歌单刚导入过,请稍候再试" });
    }
    const imported = await importPlaylistFromUrl(url);
    const name = (body.name || imported.name || "导入歌单").trim();
    const id = `pl-${Date.now()}`;
    // Cache the remote platform cover locally (fallback to collage if download fails)
    let coverRef: string | undefined = undefined;
    if (imported.coverUrl) {
      const cached = await cacheRemoteCover(imported.coverUrl, `pl-${id}`);
      if (cached) coverRef = cached;
    }
    db.insert(playlists).values({
      id, name, ownerId: user?.id || "", sourceUrl: url, sourcePlatform: imported.platform,
      externalId: url, coverArt: coverRef,
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
  const items = all.sort((a, b) => (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || "")).slice((page - 1) * pageSize, page * pageSize).map(p => ({
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
apiRoutes.get("/playlist", (c) => { const user = c.get("user"); return c.json(db.select().from(playlists).all().filter(p => p.ownerId === user?.id || p.isPublic)); });
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
          coverArt: album?.coverArt ? `al-${album.id}` : undefined,
          playable: true, isMatched: true,
        };
      }
    }
    return {
      id: e.externalSongId || `ext-${e.id}`, title: e.externalTitle || "", artist: e.externalArtist || "",
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
      coverArt: album?.coverArt ? `al-${album.id}` : undefined,
      playedAt: h.playedAt || "",
    };
  }).filter(Boolean);
  return c.json({ total, page, pageSize, items });
});

