// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, plugins, playlists } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes, clearRecommendCache } from "../../src/routes/api/index.js";
import { registerPlugin, unregisterPlugin } from "../../src/plugins/registry.js";

// 能力路由测试:GET /rest/api/v1/recommend 经 capability("recommend") 查插件、
// 透传 channels、补全远程封面 URL、标注 imported、5min 缓存。核心不写死插件名。
const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const PLAIN = "hunter2";
const CLIENT_SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + CLIENT_SALT)}&s=${CLIENT_SALT}`;

const FAKE_ID = "fake-recommend";
const fakeManifest = {
  id: FAKE_ID,
  name: "Fake Recommend",
  version: "1.0.0",
  type: "source",
  description: "test only",
  capabilities: ["recommend"],
  recommendPrefix: "gmdl://", // 声明推荐歌单 sourceUrl 前缀,使 findRecommendPlaylist 能匹配已入库歌单
  platforms: ["netease", "qq"],
  configSchema: [
    { key: "baseUrl", label: "服务地址", type: "url", required: true },
    { key: "homeCount", label: "平台首页每平台歌单数", type: "number" },
  ],
};

let fakeCalls = 0;
const fakeImpl = {
  manifest: fakeManifest,
  async recommend(_config: any) {
    fakeCalls++;
    return {
      channels: [
        {
          source: "netease",
          name: "网易云",
          count: 2,
          playlists: [
            { id: "pl-1", source: "netease", name: "歌单一", creator: "a", cover: "/cover/1.jpg", trackCount: "100", link: "/music/playlist?source=netease&id=pl-1" },
            { id: "pl-2", source: "netease", name: "歌单二", creator: "b", cover: "http://cdn.example.com/2.jpg", trackCount: "50", link: "" },
          ],
        },
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
  fakeCalls = 0;
  clearRecommendCache(); // 路由缓存跨用例残留会导致后续用例命中旧数据
  db.delete(plugins).where(eq(plugins.name, FAKE_ID)).run();
  unregisterPlugin(FAKE_ID);
  registerPlugin(fakeManifest as any, fakeImpl as any);
});

async function getRecommend() {
  const res = await app.request(`/rest/api/v1/recommend?${authQS()}`);
  return { res, body: await res.json().catch(() => null) };
}

describe("GET /rest/api/v1/recommend (capability-driven)", () => {
  it("returns empty channels when no enabled recommend plugin", async () => {
    unregisterPlugin(FAKE_ID);
    const { body } = await getRecommend();
    expect(body.success).toBe(true);
    expect(body.channels).toEqual([]);
    expect(body.providerId).toBe("");
  });

  it("resolves the enabled recommend plugin and returns its channels", async () => {
    db.insert(plugins).values({ name: FAKE_ID, enabled: 1, config: JSON.stringify({ baseUrl: "http://gmdl:8080", homeCount: 3 }) }).run();
    // 已入库本地歌单(与插件返回的 pl-1 通过 sourceUrl 前缀匹配),songCount 即数据库中真实数量
    db.insert(playlists).values({ id: "local-pl-1", name: "歌单一", ownerId: "u1", sourceUrl: "gmdl://pl-1", songCount: 58 }).run();
    const { body } = await getRecommend();
    expect(body.success).toBe(true);
    expect(body.providerId).toBe(FAKE_ID);
    expect(body.channels).toHaveLength(1);
    const pl = body.channels[0].playlists;
    expect(pl).toHaveLength(2);
    // 相对封面路径用插件 baseUrl 补全为完整 URL
    expect(pl[0].cover).toBe("http://gmdl:8080/cover/1.jpg");
    // 绝对 URL 原样透传
    expect(pl[1].cover).toBe("http://cdn.example.com/2.jpg");
    // 已入库歌单:imported=true,曲目数量取本地库真实 songCount
    expect(pl[0].imported).toBe(true);
    expect(pl[0].trackCount).toBe("58");
    // 未入库歌单:不取插件 trackCount(无本地候补)
    expect(pl[1].imported).toBe(false);
    expect(pl[1].trackCount).toBe("");
  });

  it("fallback: matches an imported playlist via externalId + platform when sourceUrl does not match", async () => {
    db.insert(plugins).values({ name: FAKE_ID, enabled: 1, config: JSON.stringify({ baseUrl: "http://gmdl:8080" }) }).run();
    // sourceUrl 不是 "gmdl://94123"(故意错开),迫使走 externalId+平台 命中
    db.insert(playlists).values({ id: "local-ext", name: "外部歌单", ownerId: "u1", sourceUrl: "http://import/94123", externalId: "94123", sourcePlatform: "netease", songCount: 77 }).run();
    const custom = {
      manifest: fakeManifest,
      async recommend() {
        return {
          channels: [{ source: "netease", name: "网易云", count: 1, playlists: [
            { id: "94123", source: "netease", name: "外部歌单", creator: "a", cover: "", trackCount: "999", link: "" },
          ] }],
        };
      },
    };
    unregisterPlugin(FAKE_ID);
    registerPlugin(fakeManifest as any, custom as any);
    const { body } = await getRecommend();
    const pl = body.channels[0].playlists[0];
    expect(pl.imported).toBe(true);
    expect(pl.trackCount).toBe("77"); // 取本地库真实数量,而非插件 trackCount
  });

  it("fallback: matches an imported playlist by name + platform when no platform id is alignable", async () => {
    db.insert(plugins).values({ name: FAKE_ID, enabled: 1, config: JSON.stringify({ baseUrl: "http://gmdl:8080" }) }).run();
    // URL/搜索导入:sourceUrl 为整份 URL、externalId 为 URL,无法按 id 对齐,仅剩歌名
    db.insert(playlists).values({ id: "local-nm", name: "深夜民谣电台", ownerId: "u1", sourceUrl: "http://import/y.d.f.3", externalId: "http://import/y.d.f.3", sourcePlatform: "netease", songCount: 33 }).run();
    const custom = {
      manifest: fakeManifest,
      async recommend() {
        return {
          channels: [{ source: "netease", name: "网易云", count: 1, playlists: [
            { id: "y.d.f.3", source: "netease", name: "深夜民谣电台", creator: "a", cover: "", trackCount: "999", link: "" },
          ] }],
        };
      },
    };
    unregisterPlugin(FAKE_ID);
    registerPlugin(fakeManifest as any, custom as any);
    const { body } = await getRecommend();
    const pl = body.channels[0].playlists[0];
    expect(pl.imported).toBe(true);
    expect(pl.trackCount).toBe("33");
  });

  it("caches the result for 5min (second call does not hit the plugin again)", async () => {
    db.insert(plugins).values({ name: FAKE_ID, enabled: 1, config: JSON.stringify({ baseUrl: "http://gmdl:8080" }) }).run();
    await getRecommend();
    expect(fakeCalls).toBe(1);
    const { body } = await getRecommend();
    expect(fakeCalls).toBe(1); // cache hit
    expect(body.channels).toHaveLength(1);
  });

  it("degrades to empty channels when the plugin throws", async () => {
    db.insert(plugins).values({ name: FAKE_ID, enabled: 1, config: "{}" }).run();
    const throwing = { manifest: fakeManifest, async recommend() { throw new Error("boom"); } };
    unregisterPlugin(FAKE_ID);
    registerPlugin(fakeManifest as any, throwing as any);
    const { body } = await getRecommend();
    expect(body.success).toBe(true);
    expect(body.channels).toEqual([]);
    expect(body.providerId).toBe(FAKE_ID);
    expect(body.error).toContain("boom");
  });
});
