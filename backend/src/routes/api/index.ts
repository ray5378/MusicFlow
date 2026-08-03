import { Hono } from "hono";
import { db } from "../../db/index.js";
import { users, playlists, playlistSongs, songs, albums, artists, mediaSources, plugins, wishes, userFavoriteSongs, playHistory } from "../../db/schema.js";
import { eq, like, inArray } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import md5 from "md5";
import { adminMiddleware } from "../../middleware/auth.js";
import { scanLocalSource, scanWebDAVSource, testWebDAVConnection, cleanupOrphans, ScanProgress } from "../../services/source/scanner.js";
import { encryptPassword } from "../../db/index.js";

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

apiRoutes.put("/v1/users/:id/password", adminMiddleware, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const newSubsonicSalt = Math.random().toString(16).substring(2, 10);
  db.update(users).set({ password: md5(body.newPassword + newSubsonicSalt), subsonicSalt: newSubsonicSalt, passEnc: encryptPassword(body.newPassword), apiKey: null, updatedAt: new Date().toISOString() }).where(eq(users.id, id)).run();
  return c.json({ success: true });
});

// ==================== Sources ====================
apiRoutes.get("/v1/sources", (c) => c.json(db.select().from(mediaSources).all().map(s => ({ ...s, config: JSON.parse(s.config || "{}") }))));

apiRoutes.post("/v1/sources", adminMiddleware, async (c) => {
  const body = await c.req.json();
  const id = uuidv4();
  db.insert(mediaSources).values({ id, name: body.name, type: body.type || "webdav", enabled: body.enabled !== false ? 1 : 0, config: JSON.stringify(body.config || {}) }).run();
  return c.json({ id });
});

apiRoutes.put("/v1/sources/:id", adminMiddleware, async (c) => {
  const id = c.req.param("id");
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
  const id = c.req.param("id");
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
  const id = c.req.param("id");
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
apiRoutes.get("/v1/plugins", (c) => c.json(db.select().from(plugins).all()));
apiRoutes.post("/v1/plugins", adminMiddleware, async (c) => { const body = await c.req.json(); const id = uuidv4(); db.insert(plugins).values({ id, name: body.name, version: body.version || "", description: body.description || "", manifest: JSON.stringify(body.manifest || {}), enabled: body.enabled ? 1 : 0, config: JSON.stringify(body.config || {}) }).run(); return c.json({ id }); });
apiRoutes.put("/v1/plugins/:id/toggle", adminMiddleware, (c) => { const p = db.select().from(plugins).where(eq(plugins.id, c.req.param("id"))).get(); if (p) db.update(plugins).set({ enabled: p.enabled ? 0 : 1 }).where(eq(plugins.id, p.id)).run(); return c.json({ success: true }); });

// ==================== Wish ====================
apiRoutes.get("/v1/wish", (c) => c.json(db.select().from(wishes).all()));
apiRoutes.post("/v1/wish", async (c) => { const user = c.get("user"); const body = await c.req.json(); const id = uuidv4(); db.insert(wishes).values({ id, userId: user?.id || "", songTitle: body.songTitle, artist: body.artist || "", album: body.album || "", status: "pending" }).run(); return c.json({ id }); });

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
  const allSongs = db.select().from(songs).all();
  const filtered = query
    ? allSongs.filter(s => {
        const q = query.toLowerCase();
        return (s.title || "").toLowerCase().includes(q) || (s.artist || "").toLowerCase().includes(q) || (s.album || "").toLowerCase().includes(q);
      })
    : allSongs;
  const total = filtered.length;
  const start = (page - 1) * pageSize;
  const items = filtered.sort((a, b) => (a.title || "").localeCompare(b.title || "")).slice(start, start + pageSize).map(s => ({
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
  }));
  return c.json({ total, page, pageSize, items });
});

// ==================== Settings ====================
apiRoutes.get("/v1/settings", (c) => c.json({ writeBackTags: false, fingerprintEnabled: false }));

// ==================== Navidrome compatible ====================
apiRoutes.get("/playlist", (c) => { const user = c.get("user"); return c.json(db.select().from(playlists).all().filter(p => p.ownerId === user?.id || p.isPublic)); });
apiRoutes.get("/playlist/:id/tracks", (c) => c.json(db.select().from(playlistSongs).where(eq(playlistSongs.playlistId, c.req.param("id"))).all().filter(e => e.playable && e.songId)));
apiRoutes.delete("/playlist/:id", adminMiddleware, (c) => { const id = c.req.param("id"); db.delete(playlistSongs).where(eq(playlistSongs.playlistId, id)).run(); db.delete(playlists).where(eq(playlists.id, id)).run(); return c.json({ success: true }); });
