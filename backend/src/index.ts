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

const port = 3002;
serve({ fetch: app.fetch, port }, () => {
  console.log(`MusicFree backend listening on http://0.0.0.0:${port}`);
});
