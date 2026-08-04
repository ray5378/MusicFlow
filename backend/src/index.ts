import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import fs from "fs";
import path from "path";
import { serveStatic } from "@hono/node-server/serve-static";
import { authRoutes } from "./routes/auth/index.js";
import { restRoutes } from "./routes/rest/index.js";
import { apiRoutes } from "./routes/api/index.js";
import { navidromeRoutes } from "./routes/navidrome/index.js";
import { initDatabase, cleanupPlayHistory } from "./db/index.js";
import { authMiddleware } from "./middleware/auth.js";
import { syncAllEnabledPlaylists } from "./services/plugin/playlistSync.js";
import { scrapeArtistList } from "./services/scraper/artist.js";
import { db } from "./db/index.js";
import { artists } from "./db/schema.js";
import { getCorsOrigins, getPlayHistoryRetentionDays } from "./utils/env.js";

const app = new Hono();

// Log only what's useful: auth failures get a readable Chinese hint, real
// server errors (5xx) keep a bare record; everything else stays quiet.
app.use("*", async (c, next) => {
  await next();
  const status = c.res.status;
  const ts = new Date().toLocaleString("zh-CN", { hour12: false });
  if (status === 401) {
    console.log(`[${ts}] 认证失败,请检查账号密码: ${c.req.method} ${c.req.path}`);
  } else if (status >= 500) {
    console.log(`[${ts}] ${c.req.method} ${c.req.path} -> ${status}`);
  }
});

// Same-origin requests (the frontend proxies /api and /rest through Vite) never
// trigger CORS, so the default allowlist only needs to cover localhost. Direct
// cross-origin callers must be whitelisted via CORS_ORIGINS (comma separated),
// or set CORS_ORIGINS=* to allow all origins (previous behavior).
const allowedOrigins = getCorsOrigins();
app.use("*", cors({
  origin: (origin) => {
    if (!origin) return origin;
    if (allowedOrigins.includes("*")) return origin;
    return allowedOrigins.includes(origin) ? origin : undefined;
  },
}));

app.route("/rest", authRoutes);
app.get("/rest/ping", (c) => c.json({ "subsonic-response": { status: "ok", version: "1.16.1", serverVersion: "1.0.0", openSubsonic: true, type: "MusicFlow" } }));

app.use("/rest/*", async (c, next) => {
  // Cover art is loaded via <img> tags which cannot send auth headers — make it public
  if (c.req.path === "/getCoverArt" || c.req.path.endsWith("/getCoverArt")) return next();
  return authMiddleware(c, next);
});
app.route("/rest", restRoutes);
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);
app.use("/api/*", authMiddleware);
app.route("/api", navidromeRoutes);
app.get("/ping", (c) => c.json({ status: "ok" }));

// ==================== Static frontend (production build) ====================
// In production the built frontend lives in ./public next to the backend;
// API paths below are already registered, so the SPA fallback only serves
// index.html for unknown non-API routes.
const staticDir = process.env.STATIC_DIR ? path.resolve(process.env.STATIC_DIR) : path.resolve(process.cwd(), "public");
app.use("/assets/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "public, max-age=31536000, immutable");
});
app.get("/assets/*", serveStatic({ root: staticDir }));
app.get("*", async (c, next) => {
  if (c.req.path.startsWith("/rest") || c.req.path.startsWith("/api") || c.req.path === "/ping") return next();
  // Serve real static files first (e.g. /favicon.svg), then fall back to the
  // SPA shell so client-side routes like /songs still render index.html.
  // (Pre-check with fs: serveStatic's own "not found" path calls next(), which
  // finalizes a 404 response that the subsequent fallback can no longer override.)
  const rel = decodeURIComponent(c.req.path).replace(/^\/+/, "");
  const filePath = path.resolve(staticDir, rel);
  const inside = filePath === staticDir || filePath.startsWith(staticDir + path.sep);
  if (rel && inside && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return serveStatic({ root: staticDir })(c, next);
  }
  return serveStatic({ path: "index.html", root: staticDir })(c, next);
});

initDatabase();

// Retention cleanup for play history (play_history grows with every play).
cleanupPlayHistory(getPlayHistoryRetentionDays());

// Auto-sync imported playlists with syncEnabled=true every 6 hours
const AUTO_SYNC_INTERVAL = 6 * 60 * 60 * 1000; // 6h
setInterval(async () => {
  cleanupPlayHistory(getPlayHistoryRetentionDays());
  try {
    const result = await syncAllEnabledPlaylists();
    if (result.synced > 0 || result.errors.length > 0) {
      console.log(`[AUTO-SYNC] synced ${result.synced} playlists, errors: ${result.errors.length}`);
    }
  } catch (e: any) {
    console.error("[AUTO-SYNC] error:", e.message);
  }
  // Auto-scrape artist info for artists added in the last 7 days that still
  // have no cover (QQ first, NetEase fallback). Older artists are left alone
  // unless the user triggers a manual full scrape.
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recent = db.select().from(artists).all()
      .filter(a => !a.coverArt && (a.createdAt || "") >= since);
    if (recent.length > 0) {
      const r = await scrapeArtistList(recent.map(a => a.id));
      console.log(`[ARTIST-SCRAPE] scheduled run: scraped ${r.scraped}, skipped ${r.skipped}, errors ${r.errors.length}`);
    }
  } catch (e: any) {
    console.error("[ARTIST-SCRAPE] error:", e.message);
  }
}, AUTO_SYNC_INTERVAL);

const port = parseInt(process.env.PORT || "46400", 10);
serve({ fetch: app.fetch, port }, () => {
  console.log(`MusicFree backend listening on http://0.0.0.0:${port}`);
});
