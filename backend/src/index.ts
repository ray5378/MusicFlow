import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { authRoutes } from "./routes/auth/index.js";
import { restRoutes } from "./routes/rest/index.js";
import { apiRoutes } from "./routes/api/index.js";
import { navidromeRoutes } from "./routes/navidrome/index.js";
import { initDatabase } from "./db/index.js";
import { authMiddleware } from "./middleware/auth.js";
import { syncAllEnabledPlaylists } from "./services/plugin/playlistSync.js";
import { scrapeArtistList } from "./services/scraper/artist.js";
import { db } from "./db/index.js";
import { artists } from "./db/schema.js";

const app = new Hono();

app.use("*", logger());
app.use("*", cors({ origin: "*" }));

app.route("/rest", authRoutes);
app.get("/rest/ping", (c) => c.json({ "subsonic-response": { status: "ok", version: "1.16.1", serverVersion: "1.0.0", openSubsonic: true, type: "MusicFree" } }));

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

initDatabase();

// Auto-sync imported playlists with syncEnabled=true every 6 hours
const AUTO_SYNC_INTERVAL = 6 * 60 * 60 * 1000; // 6h
setInterval(async () => {
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

const port = 3002;
serve({ fetch: app.fetch, port }, () => {
  console.log(`MusicFree backend listening on http://0.0.0.0:${port}`);
});
