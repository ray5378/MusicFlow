// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, plugins } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes, clearRecommendCache } from "../../src/routes/api/index.js";
import { recommendCache, RECOMMEND_CACHE_TTL_MS } from "../../src/routes/api/shared.js";
import { registerPlugin, unregisterPlugin } from "../../src/plugins/registry.js";

// /v1/recommend stale-while-revalidate 行为:
//   1) 无任何缓存 → 阻塞拉取(冷启动语义不变);
//   2) 新鲜缓存 → 立即返回,不触发插件调用;
//   3) 过期缓存 → 立即返回 stale,后台刷新被 single-flight 去重,成功后更新缓存。
// 假插件返回的频道名带调用序号(ch-1/ch-2...),用于区分 stale 与刷新后的数据。

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const PLAIN = "hunter2";
const CLIENT_SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + CLIENT_SALT)}&s=${CLIENT_SALT}`;

const FAKE_ID = "fake-swr-recommend";
const fakeManifest = {
  id: FAKE_ID,
  name: "Fake SWR Recommend",
  version: "1.0.0",
  type: "source",
  description: "test only",
  capabilities: ["recommend"],
  recommendPrefix: "gmdl://",
  platforms: ["netease"],
  configSchema: [],
};

let fakeCalls = 0;
let gate: Promise<void> | null = null;
let failNext = false;
const fakeImpl = {
  manifest: fakeManifest,
  async recommend(_config: any) {
    fakeCalls++;
    if (gate) await gate;
    if (failNext) throw new Error("plugin down");
    return {
      channels: [{ source: "netease", name: `ch-${fakeCalls}`, count: 1, playlists: [] }],
    };
  },
};

function seedUser() {
  if (db.select().from(users).where(eq(users.username, "alice")).get()) return;
  db.insert(users).values({ id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt", passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1, email: "a@b.c" }).run();
}

function soleCacheKey(): string {
  const keys = [...recommendCache.keys()];
  expect(keys.length).toBe(1);
  return keys[0];
}

async function getRecommend() {
  const res = await app.request(`/rest/api/v1/recommend?${authQS()}`);
  expect(res.status).toBe(200);
  return await res.json();
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  seedUser();
});

beforeEach(() => {
  fakeCalls = 0;
  gate = null;
  failNext = false;
  clearRecommendCache();
  db.delete(plugins).where(eq(plugins.name, FAKE_ID)).run();
  unregisterPlugin(FAKE_ID);
  registerPlugin(fakeManifest as any, fakeImpl as any);
  // 启用插件(getEnabledByCapability 读 DB 行)
  db.insert(plugins).values({ name: FAKE_ID, enabled: 1, config: "{}" }).run();
});

describe("GET /v1/recommend stale-while-revalidate", () => {
  it("无任何缓存:阻塞拉取并写缓存(冷启动语义不变)", async () => {
    const body = await getRecommend();
    expect(body.success).toBe(true);
    expect(body.channels[0].name).toBe("ch-1");
    expect(fakeCalls).toBe(1);
  });

  it("新鲜缓存:立即返回,不再触发插件调用", async () => {
    await getRecommend();
    const body = await getRecommend();
    expect(body.channels[0].name).toBe("ch-1");
    expect(fakeCalls).toBe(1);
  });

  it("过期缓存:立即返回 stale,后台刷新成功后更新缓存", async () => {
    await getRecommend(); // 冷启动,缓存 ch-1
    const key = soleCacheKey();
    recommendCache.set(key, { ts: Date.now() - RECOMMEND_CACHE_TTL_MS - 1, channels: recommendCache.get(key)!.channels });
    // 让下一次(后台)插件调用挂住,证明响应不等它
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    const t0 = Date.now();
    const body = await getRecommend();
    // 立即返回 stale(不等外网插件)
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(body.channels[0].name).toBe("ch-1");
    expect(fakeCalls).toBe(2); // 后台刷新已在途
    // 在途期间再来请求:仍是 stale,single-flight 不叠加调用
    const body2 = await getRecommend();
    expect(body2.channels[0].name).toBe("ch-1");
    expect(fakeCalls).toBe(2);
    // 放行后台刷新,缓存被更新
    release();
    await vi.waitFor(() => {
      expect(recommendCache.get(key)!.ts).toBeGreaterThan(Date.now() - 5000);
    }, { timeout: 2000, interval: 20 });
    expect(recommendCache.get(key)!.channels[0].name).toBe("ch-2");
    // 刷新完成后请求命中新缓存,不再调插件
    const body3 = await getRecommend();
    expect(body3.channels[0].name).toBe("ch-2");
    expect(fakeCalls).toBe(2);
  });

  it("过期缓存 + 后台刷新失败:保留旧缓存,后续请求仍可用", async () => {
    await getRecommend();
    const key = soleCacheKey();
    const oldChannels = recommendCache.get(key)!.channels;
    recommendCache.set(key, { ts: Date.now() - RECOMMEND_CACHE_TTL_MS - 1, channels: oldChannels });
    failNext = true; // 后台刷新将失败
    const body = await getRecommend();
    expect(body.channels).toEqual(oldChannels);
    await vi.waitFor(() => {
      // 刷新失败后 single-flight 槽位被释放(内部可观测:再次请求会再次尝试)
      expect(fakeCalls).toBe(2);
    }, { timeout: 2000, interval: 20 });
    // 缓存仍是旧数据(ts 未更新),且请求继续返回旧数据
    const body2 = await getRecommend();
    expect(body2.channels).toEqual(oldChannels);
    expect(fakeCalls).toBe(3); // 失败后再请求会再触发一次后台刷新
  });
});
