// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, sqlite, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, plugins } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes, clearRecommendCache } from "../../src/routes/api/index.js";
import { recommendCache, RECOMMEND_CACHE_TTL_MS } from "../../src/routes/api/shared.js";
import { __resetRecommendRefreshStateForTest } from "../../src/routes/api/recommend.js";
import { registerPlugin, unregisterPlugin } from "../../src/plugins/registry.js";

// /v1/recommend stale-while-revalidate 行为:
//   1) 无任何缓存 → 立即返回 pending 空频道,后台 single-flight 首拉(冷启动不再阻塞);
//   2) 新鲜缓存 → 立即返回,不触发插件调用;
//   3) 过期缓存 → 立即返回 stale,后台刷新被 single-flight 去重,成功后更新缓存;
//   4) 刷新失败 → 记 60s 失败退避,退避内不再重 kick(测试钩子可清)。
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

/** 让后台首拉/后台刷新(纯微任务链)跑完:setTimeout 宏任务前微任务队列必清空。 */
const settle = () => new Promise((r) => setTimeout(r, 0));

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
  // 聚合缓存 write-through 的 settings 行跨用例残留会被 DB 回灌命中(DB 回灌不回写内存,
  // recommendCache 会是空的)→ 必须连同 DB 一起清,否则 soleCacheKey/冷启动语义被破坏。
  sqlite.prepare("DELETE FROM settings WHERE key LIKE 'recommend.aggCache.%'").run();
  __resetRecommendRefreshStateForTest(); // 清失败退避/在途刷新表,用例间隔离
  db.delete(plugins).where(eq(plugins.name, FAKE_ID)).run();
  unregisterPlugin(FAKE_ID);
  registerPlugin(fakeManifest as any, fakeImpl as any);
  // 启用插件(getEnabledByCapability 读 DB 行)
  db.insert(plugins).values({ name: FAKE_ID, enabled: 1, config: "{}" }).run();
});

describe("GET /v1/recommend stale-while-revalidate", () => {
  it("无任何缓存:先回 pending 空频道,后台首拉写缓存(冷启动不再阻塞)", async () => {
    const first = await getRecommend();
    expect(first.success).toBe(true);
    expect(first.pending).toBe(true);
    expect(first.channels).toEqual([]);
    await settle(); // 后台首拉 settle
    expect(fakeCalls).toBe(1);
    // 第二次请求命中首拉结果
    const body = await getRecommend();
    expect(body.channels[0].name).toBe("ch-1");
    expect(fakeCalls).toBe(1);
  });

  it("新鲜缓存:立即返回,不再触发插件调用", async () => {
    await getRecommend(); // 冷启动 pending
    await settle();       // 后台首拉写缓存
    const body = await getRecommend();
    expect(body.channels[0].name).toBe("ch-1");
    expect(fakeCalls).toBe(1);
    const body2 = await getRecommend();
    expect(body2.channels[0].name).toBe("ch-1");
    expect(fakeCalls).toBe(1);
  });

  it("过期缓存:立即返回 stale,后台刷新成功后更新缓存", async () => {
    const first = await getRecommend(); // 冷启动 pending
    expect(first.pending).toBe(true);
    await settle(); // 后台首拉写缓存 ch-1
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

  it("过期缓存 + 后台刷新失败:保留旧缓存;60s 退避内不重 kick,清退避后恢复重试", async () => {
    const first = await getRecommend(); // 冷启动 pending
    expect(first.pending).toBe(true);
    await settle(); // 后台首拉写缓存
    const key = soleCacheKey();
    const oldChannels = recommendCache.get(key)!.channels;
    recommendCache.set(key, { ts: Date.now() - RECOMMEND_CACHE_TTL_MS - 1, channels: oldChannels });
    failNext = true; // 后台刷新将失败
    const body = await getRecommend();
    expect(body.channels).toEqual(oldChannels);
    await vi.waitFor(() => {
      // 刷新失败后 single-flight 槽位被释放(内部可观测:失败已记入退避表)
      expect(fakeCalls).toBe(2);
    }, { timeout: 2000, interval: 20 });
    // 失败退避:下一个请求仍返回旧数据,但不再重 kick(60s 内)
    const body2 = await getRecommend();
    expect(body2.channels).toEqual(oldChannels);
    expect(fakeCalls).toBe(2);
    // 清退避(测试钩子)→ 恢复旧行为:再请求会再次触发后台刷新
    __resetRecommendRefreshStateForTest();
    const body3 = await getRecommend();
    expect(body3.channels).toEqual(oldChannels);
    expect(fakeCalls).toBe(3); // 退避清空后再请求会再次触发一次后台刷新
  });
});
