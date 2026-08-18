// 鉴权缓存测试:apiKey 内存索引命中/失效/过期 + JWT Bearer 走用户缓存。
// 通过 authMiddleware 行为验证(公开 API),不触碰私有函数。
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import md5 from "md5";
import { db } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware, invalidateAuthCaches } from "../../src/middleware/auth.js";
import { generateToken, hashApiKey } from "../../src/utils/auth.js";

function makeApp() {
  const app = new Hono();
  app.use("*", authMiddleware);
  app.get("/ping", (c) => c.json({ ok: true, user: c.get("user") }));
  return app;
}

function insertUser(over: Record<string, unknown>) {
  const id = uuidv4();
  db.insert(users)
    .values({
      id,
      username: `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      password: md5("x"),
      salt: "s",
      subsonicSalt: "ss",
      isAdmin: 0,
      isActive: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...over,
    })
    .run();
  return id;
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
});
beforeEach(() => {
  invalidateAuthCaches();
  sqliteClean();
});

function sqliteClean() {
  // 每个用例清理 users,避免跨用例缓存/数据残留
  db.delete(users).run();
}

describe("鉴权缓存: apiKey 索引", () => {
  it("X-API-Key 命中索引并返回用户", async () => {
    const apiKey = `mf_${uuidv4().replace(/-/g, "")}`;
    insertUser({ apiKey, apiKeyHash: hashApiKey(apiKey), apiKeyExpiresAt: null });
    invalidateAuthCaches(); // 确保索引重建看到新行

    const app = makeApp();
    const res = await app.request("/ping", { headers: { "X-API-Key": apiKey } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.user).toBeTruthy();
  });

  it("未知 apiKey → 401", async () => {
    const app = makeApp();
    const res = await app.request("/ping", { headers: { "X-API-Key": "mf_unknown_key" } });
    expect(res.status).toBe(401);
  });

  it("撤销(删 apiKey + invalidate)后立即失效 → 401", async () => {
    const apiKey = `mf_${uuidv4().replace(/-/g, "")}`;
    const id = insertUser({ apiKey, apiKeyHash: hashApiKey(apiKey), apiKeyExpiresAt: null });
    invalidateAuthCaches();

    const app = makeApp();
    expect((await app.request("/ping", { headers: { "X-API-Key": apiKey } })).status).toBe(200);

    // 撤销:清 apiKey + hash,并失效缓存(与 api/index.ts 写侧一致)
    db.update(users).set({ apiKey: null, apiKeyHash: null, apiKeyExpiresAt: null }).where(eq(users.id, id)).run();
    invalidateAuthCaches();
    expect((await app.request("/ping", { headers: { "X-API-Key": apiKey } })).status).toBe(401);
  });

  it("过期 apiKey → 401", async () => {
    const apiKey = `mf_${uuidv4().replace(/-/g, "")}`;
    insertUser({ apiKey, apiKeyHash: hashApiKey(apiKey), apiKeyExpiresAt: new Date(Date.now() - 1000).toISOString() });
    invalidateAuthCaches();

    const app = makeApp();
    expect((await app.request("/ping", { headers: { "X-API-Key": apiKey } })).status).toBe(401);
  });

  it("存量用户(有明文无 hash)构建索引时自愈回填 apiKeyHash", async () => {
    const apiKey = `mf_${uuidv4().replace(/-/g, "")}`;
    insertUser({ apiKey, apiKeyHash: null, apiKeyExpiresAt: null }); // 模拟存量
    invalidateAuthCaches();

    const app = makeApp();
    expect((await app.request("/ping", { headers: { "X-API-Key": apiKey } })).status).toBe(200);
    // 回填已写库
    const row = db.select().from(users).where(eq(users.apiKey, apiKey)).get();
    expect(row?.apiKeyHash).toBe(hashApiKey(apiKey));
  });
});

describe("鉴权缓存: JWT Bearer", () => {
  it("JWT 命中用户缓存并返回用户", async () => {
    const id = insertUser({});
    const token = generateToken(id, "tester", false);
    const app = makeApp();
    const res = await app.request("/ping", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.id).toBe(id);
  });

  it("禁用用户 → 401(缓存会反映 isActive=false)", async () => {
    const id = insertUser({ isActive: 1 });
    const token = generateToken(id, "tester", false);
    const app = makeApp();
    expect((await app.request("/ping", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);

    // 禁用 + 失效 → 立即拒绝
    db.update(users).set({ isActive: 0 }).where(eq(users.id, id)).run();
    invalidateAuthCaches();
    expect((await app.request("/ping", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });
});
