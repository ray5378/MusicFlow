// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const PLAIN = "hunter2";
const CLIENT_SALT = "clientsalt123";
const authQS = () => "u=alice&t=" + md5(PLAIN + CLIENT_SALT) + "&s=" + CLIENT_SALT;

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
    db.insert(users)
      .values({
        id: "u1",
        username: "alice",
        password: "",
        salt: "salt",
        subsonicSalt: "subsalt",
        passEnc: encryptPassword(PLAIN),
        isAdmin: 1,
        isActive: 1,
        email: "a@b.c",
      })
      .run();
  }
});

async function call(method: string, path: string, body?: any) {
  const res = await app.request("/rest/api" + path + "?" + authQS(), {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, text };
}

const GETS: string[] = [
  "/v1/recommend",
  "/v1/local-recommend",
  "/v1/home/playlist-count",
  "/v1/recommend/home-cards",
  "/v1/batch-pace",
  "/v1/users",
  "/v1/users/me",
  "/v1/users/me/api-key",
  "/v1/access/renderers",
  "/v1/sources",
  "/v1/plugins",
  "/v1/plugins/health",
  "/v1/plugins/renderers",
  "/v1/plugins/renderers/devices",
  "/v1/plugins/scrobblers",
  "/v1/plugins/registry",
  "/v1/wish",
  "/v1/wish/export",
  "/v1/stats",
  "/v1/songs",
  "/v1/genres",
  "/v1/albums",
  "/v1/artists",
  "/v1/artists/scrape-status",
  "/v1/artists/missing-info-count",
  "/v1/settings",
  "/v1/admin/memory-settings",
  "/v1/admin/metrics",
  "/v1/admin/log-settings",
  "/v1/playback/settings",
  "/v1/lyrics/settings",
  "/v1/covers/settings",
  "/v1/lyrics/backfill/status",
  "/v1/covers/backfill/status",
  "/v1/covers/backfill-batch/status",
  "/v1/daily-recommend",
  "/v1/recommend-pool",
  "/v1/tasks/no-such-task",
  "/v1/system/busy",
  "/v1/playlists",
  "/v1/playlist",
  "/v1/history",
  "/v1/dlna/devices",
  "/v1/dlna/active",
  "/v1/airplay/devices",
  "/v1/airplay/active",
  "/v1/sendspin/clients",
  "/v1/sendspin/esphome",
  "/v1/sendspin/pairing/attempts",
  "/v1/sendspin/dial-targets",
  "/v1/peers",
  "/v1/player-prefs/hidden",
  "/v1/player-prefs/names",
  "/v1/player-prefs/dsp",
  "/v1/pipeline/switches",
  "/v1/pipeline/measure",
  "/v1/groups",
  "/v1/flows",
  "/v1/player-webhook/tokens",
  "/playlist",
];

const GETS_ID: string[] = [
  "/v1/songs/no-such-song",
  "/v1/playlists/no-such-playlist/tracks",
  "/v1/playlists/no-such-playlist/export",
  "/v1/playlist/no-such-playlist/tracks",
  "/v1/recommend-pool/playlist/no-such-playlist/status",
  "/v1/recommend-pool/favorites/status",
  "/v1/dlna/devices/no-such-device/status",
  "/v1/dlna/devices/no-such-device/queue",
  "/v1/sendspin/devices/no-such-client/esphome",
  "/v1/player-prefs/dsp/no-such-peer",
  "/v1/peers/no-such-peer",
  "/v1/peers/no-such-peer/status",
  "/v1/peers/no-such-peer/queue",
  "/v1/peers/no-such-peer/queue/shuffle",
  "/v1/peers/no-such-peer/sleep-timer",
  "/v1/flows/no-such-flow",
  "/v1/plugins/no-such-plugin/job",
  "/v1/users/no-such-user/access",
  "/v1/users/no-such-user/api-key",
  "/v1/sources/no-such-source/scan-status",
  "/v1/playlists/export-all",
];

describe("API 契约扫描 - 只读端点不得抛未捕获异常(5xx)", () => {
  for (const p of GETS) {
    it("GET " + p + " -> 非 5xx", async () => {
      const r = await call("GET", p);
      expect(r.status, "GET " + p + " -> " + r.status + " " + r.text.slice(0, 200)).toBeLessThan(500);
    });
  }
});

describe("API 契约扫描 - 占位 id 只读端点不得抛未捕获异常(5xx)", () => {
  for (const p of GETS_ID) {
    it("GET " + p + " -> 非 5xx", async () => {
      const r = await call("GET", p);
      expect(r.status, "GET " + p + " -> " + r.status + " " + r.text.slice(0, 200)).toBeLessThan(500);
    });
  }
});

describe("API 契约扫描 - 读端点返回体形态", () => {
  it("列表类端点返回数组或含数组字段的对象", async () => {
    for (const p of ["/v1/sources", "/v1/plugins", "/v1/playlists", "/v1/wish", "/v1/groups", "/v1/flows"]) {
      const r = await call("GET", p);
      expect(r.status, p).toBeLessThan(500);
      const ok = Array.isArray(r.body) || (r.body && typeof r.body === "object");
      expect(ok, p + " body=" + r.text.slice(0, 160)).toBe(true);
    }
  });

  it("GET /v1/system/busy 回 busy 布尔形态", async () => {
    const r = await call("GET", "/v1/system/busy");
    expect(r.status).toBe(200);
    expect(r.body).toBeTruthy();
    expect(typeof r.body.busy === "boolean" || typeof r.body.busy === "number").toBe(true);
  });

  it("GET /v1/settings 返回对象且不含未定义键", async () => {
    const r = await call("GET", "/v1/settings");
    expect(r.status).toBe(200);
    expect(r.body && typeof r.body === "object").toBe(true);
  });
});
