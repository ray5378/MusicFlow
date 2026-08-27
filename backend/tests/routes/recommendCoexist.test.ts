// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, plugins } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes, clearRecommendCache } from "../../src/routes/api/index.js";
import { registerPlugin, unregisterPlugin } from "../../src/plugins/registry.js";

// 复现用户场景:go-music-dl(recommend + recommendPlaylist)与 榜单插件(recommendPlaylist)
// 共存时,go-music-dl 的 channels 是否还能出现在 /v1/recommend 响应里。
const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const PLAIN = "hunter2";
const CLIENT_SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + CLIENT_SALT)}&s=${CLIENT_SALT}`;

const GMDL_ID = "go-music-dl";
const QQ_ID = "qq-chart";

const gmdlManifest: any = {
  id: GMDL_ID,
  name: "go-music-dl 全网聚合",
  version: "1.0.0",
  type: "source",
  description: "test",
  capabilities: ["recommend", "recommendPlaylist"],
  platforms: ["netease", "qq"],
};
let gmdlCalls = 0;
const gmdlImpl: any = {
  manifest: gmdlManifest,
  async recommend() {
    gmdlCalls++;
    return {
      channels: [
        { source: "qq", name: "QQ 音乐", count: 1, sortOrder: 10, playlists: [{ id: "gqq-1", source: "qq", name: "QQ精选", cover: "" }] },
        { source: "netease", name: "网易云", count: 1, sortOrder: 10, playlists: [{ id: "gne-1", source: "netease", name: "网易精选", cover: "" }] },
      ],
    };
  },
};

const qqManifest: any = {
  id: QQ_ID,
  name: "QQ音乐榜单",
  version: "1.0.0",
  type: "recommender",
  description: "test",
  capabilities: ["recommendPlaylist"],
};
const qqImpl: any = {
  manifest: qqManifest,
  async recommend() {
    return {
      channels: [
        { source: "qq", name: "QQ 音乐", count: 1, sortOrder: 30, playlists: [{ id: "qchart-1", source: "qq", name: "QQ热歌榜", cover: "" }] },
      ],
    };
  },
};

function seedUser() {
  if (db.select().from(users).where(eq(users.username, "alice")).get()) return;
  db.insert(users).values({ id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt", passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1, email: "a@b.c" }).run();
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  seedUser();
});

beforeEach(() => {
  gmdlCalls = 0;
  clearRecommendCache();
  db.delete(plugins).where(eq(plugins.name, GMDL_ID)).run();
  db.delete(plugins).where(eq(plugins.name, QQ_ID)).run();
  unregisterPlugin(GMDL_ID);
  unregisterPlugin(QQ_ID);
});

async function getRecommend() {
  const res = await app.request(`/rest/api/v1/recommend?${authQS()}`);
  return { res, body: await res.json().catch(() => null) };
}

describe("GET /v1/recommend (go-music-dl recommend + chart recommendPlaylist coexist)", () => {
  it("returns BOTH go-music-dl channels and chart channels", async () => {
    db.insert(plugins).values({ name: GMDL_ID, enabled: 1, config: JSON.stringify({ baseUrl: "http://g:8080", sortOrder: 10 }) }).run();
    db.insert(plugins).values({ name: QQ_ID, enabled: 1, config: JSON.stringify({ sortOrder: 30 }) }).run();
    registerPlugin(gmdlManifest, gmdlImpl);
    registerPlugin(qqManifest, qqImpl);

    const { body } = await getRecommend();
    const sources = body.channels.map((c: any) => `${c.source}@${c._pluginId}@${c.sortOrder}`);
    console.log("CHANNELS:", JSON.stringify(body.channels));
    expect(body.success).toBe(true);
    expect(body.providerId).toBe(GMDL_ID);
    // go-music-dl 的两条 channel 必须都在
    expect(sources).toContain("qq@go-music-dl@10");
    expect(sources).toContain("netease@go-music-dl@10");
    // 榜单插件的 channel 也必须都在
    expect(sources).toContain("qq@qq-chart@30");
    // 去重:go-music-dl + qq-chart 各有 qq,但 source 相同、_pluginId 不同 → 不应被丢
  });

  it("go-music-dl STILL returned even when qq-chart disabled (only gmdl enabled)", async () => {
    db.insert(plugins).values({ name: GMDL_ID, enabled: 1, config: JSON.stringify({ baseUrl: "http://g:8080", sortOrder: 10 }) }).run();
    registerPlugin(gmdlManifest, gmdlImpl);
    // qq-chart not enabled
    registerPlugin(qqManifest, qqImpl);

    const { body } = await getRecommend();
    const sources = body.channels.map((c: any) => c.source);
    console.log("ONLY-GMDL CHANNELS:", JSON.stringify(body.channels));
    expect(sources).toContain("qq");
    expect(sources).toContain("netease");
  });
});