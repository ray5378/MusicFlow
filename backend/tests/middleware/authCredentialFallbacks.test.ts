// MUST be the first import:隔离 DATA_DIR 后再加载后端模块。
import "../plugins/_env.js";

// middleware/auth.ts 的「凭据入口兜底」补测。
//
// 既有 authMiddlewareFlows.test.ts 已把六条凭据分支逐条走过一遍;这里补的是它没
// 覆盖的三处**真实线上形态**:
//   ① `Authorization: Bearer <apiKey>` —— HA 集成与 /rest/* 客户端按惯例只发 Bearer,
//      里面装的却是长期 apiKey(而不是 JWT)。这条链路必须靠 jwt.verify 抛错后回落
//      apiKey 索引才能通;一旦回落被砍掉,HA 集成会集体 401。
//   ② JWT 载荷只有 `sub` 没有 `uid`(外部签发 / 老版本 token)—— Bearer 与
//      X-ND-Authorization 两个头都必须认,不能只认 ?token= 那一条。
//   ③ 存量行 apiKeyHash 回填**写库失败**(磁盘只读 / 锁冲突)—— 索引仍要建起来,
//      认证照常通过;回填只是「下次不用再算」的优化,不是通过的前提。
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import jwt from "jsonwebtoken";
import { db } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware, invalidateAuthCaches } from "../../src/middleware/auth.js";
import { generateToken, hashApiKey } from "../../src/utils/auth.js";
import { JWT_SECRET } from "../../src/utils/env.js";

type Any = any;

function makeApp() {
  const app = new Hono();
  app.use("*", authMiddleware);
  app.get("/ping", (c) => c.json({ ok: true, user: c.get("user") }));
  return app;
}

function insertUser(over: Record<string, unknown> = {}) {
  const id = uuidv4();
  db.insert(users)
    .values({
      id,
      username: `u-${uuidv4().slice(0, 8)}`,
      password: "",
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

const userRow = (id: string) => db.select().from(users).where(eq(users.id, id)).get() as Any;
const body = (res: Response) => res.json() as Promise<Any>;

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
});

beforeEach(() => {
  invalidateAuthCaches();
  db.delete(users).run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ==================== Authorization: Bearer <apiKey>(HA / OpenSubsonic 客户端) ====================

describe("Bearer 头里装 apiKey(不是 JWT)", () => {
  it("jwt.verify 抛错后回落 apiKey 索引 → 通过(HA 集成的常规形态)", async () => {
    const apiKey = `mf_${uuidv4().replace(/-/g, "")}`;
    const id = insertUser({ apiKey, apiKeyHash: hashApiKey(apiKey), apiKeyExpiresAt: null });

    const res = await makeApp().request("/ping", { headers: { Authorization: `Bearer ${apiKey}` } });
    expect(res.status).toBe(200);
    expect((await body(res)).user.id).toBe(id);
  });

  it("Bearer 装的是**无效** apiKey → 401(回落失败不得静默放行)", async () => {
    insertUser();
    const res = await makeApp().request("/ping", { headers: { Authorization: "Bearer mf_not_a_real_key" } });
    expect(res.status).toBe(401);
  });
});

// ==================== JWT 载荷只有 sub(无 uid) ====================

describe("JWT 载荷只有 sub", () => {
  it("Authorization: Bearer 的 sub-only token → 通过", async () => {
    const id = insertUser();
    const token = jwt.sign({ sub: id, username: "sub-only" }, JWT_SECRET);
    const res = await makeApp().request("/ping", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect((await body(res)).user.id).toBe(id);
  });

  it("X-ND-Authorization 的 sub-only token → 通过(与 Bearer 头同一口径)", async () => {
    const id = insertUser();
    const token = jwt.sign({ sub: id, username: "nd-sub-only" }, JWT_SECRET);
    const res = await makeApp().request("/ping", { headers: { "X-ND-Authorization": `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect((await body(res)).user.id).toBe(id);
  });

  it("uid 与 sub 同时存在时以 uid 为准(sub 指向另一个用户也不认)", async () => {
    const real = insertUser();
    const other = insertUser();
    const token = jwt.sign({ uid: real, sub: other }, JWT_SECRET);
    const res = await makeApp().request("/ping", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect((await body(res)).user.id).toBe(real);
  });
});

// ==================== apiKeyHash 回填失败 ====================

describe("存量行 apiKeyHash 回填失败", () => {
  it("写库抛错 → 不阻断:索引照样建起来,本次认证通过", async () => {
    const apiKey = `mf_${uuidv4().replace(/-/g, "")}`;
    const id = insertUser({ apiKey, apiKeyHash: null, apiKeyExpiresAt: null });

    // 模拟回填目标不可写(只读盘 / 锁冲突)。回填只是缓存优化,绝不是认证的前提。
    vi.spyOn(db as Any, "update").mockImplementation(() => {
      throw new Error("database is locked");
    });

    const res = await makeApp().request("/ping", { headers: { "X-API-Key": apiKey } });
    expect(res.status).toBe(200);
    expect((await body(res)).user.id).toBe(id);
    // 回填确实没成功(不伪造「已自愈」的假象),下次建索引会再算一次
    expect(userRow(id).apiKeyHash).toBeNull();
  });

  it("回填失败后索引仍可用:同一个 apiKey 连续两次都能通过", async () => {
    const apiKey = `mf_${uuidv4().replace(/-/g, "")}`;
    insertUser({ apiKey, apiKeyHash: null, apiKeyExpiresAt: null });
    vi.spyOn(db as Any, "update").mockImplementation(() => {
      throw new Error("database is locked");
    });

    const app = makeApp();
    expect((await app.request("/ping", { headers: { "X-API-Key": apiKey } })).status).toBe(200);
    expect((await app.request("/ping", { headers: { "X-API-Key": apiKey } })).status).toBe(200);
  });
});

// ==================== 缓存与库的收敛边界 ====================

describe("用户缓存命中期间以缓存为准", () => {
  it("TTL 内改库禁用 → 缓存仍放行(证明没有每请求查库),invalidate 后立即收敛", async () => {
    const id = insertUser({ isActive: 1 });
    const token = generateToken(id, "x", false);
    const app = makeApp();

    expect((await app.request(`/ping?token=${token}`)).status).toBe(200);

    db.update(users).set({ isActive: 0 }).where(eq(users.id, id)).run();
    // 不 invalidate:TTL 内仍走缓存 → 200(这是设计取舍,不是漏判)
    expect((await app.request(`/ping?token=${token}`)).status).toBe(200);

    invalidateAuthCaches();
    expect((await app.request(`/ping?token=${token}`)).status).toBe(401);
  });
});
