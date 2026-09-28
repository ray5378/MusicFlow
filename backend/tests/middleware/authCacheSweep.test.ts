// MUST be the first import:隔离 DATA_DIR 后再加载后端模块。
import "../plugins/_env.js";

// middleware/auth.ts 的**用户缓存 TTL 清扫**补测(auth.ts:42-48)。
//
// 为什么必须单独一个文件:清扫定时器是**模块加载时**用 setInterval 建起来的,
// 要让它被假时钟接管,就必须在 import auth.js **之前**装好 vi.useFakeTimers() ——
// 而 ESM 静态 import 会在任何语句之前求值,所以这里只能动态 import。混在同一个
// 文件里会让「假时钟」污染其它鉴权用例(它们的 jwt exp / 缓存时间都要真时钟)。
//
// 产品契约:userCache 是进程内有界缓存,TTL 只在**读取时惰性校验** —— 也就是说
// 没人再请求这个用户时,条目会一直留在 map 里。清扫定时器是唯一兜底:没有它,
// 一台长期运行的机器上「只登录过一次然后被删掉」的用户会永久占着条目;有了它,
// 缓存最多滞留一个 TTL。这里验的是「到点真会被清掉」,而不是「永远清不掉」。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { generateToken } from "../../src/utils/auth.js";

type Any = any;

let authMod: typeof import("../../src/middleware/auth.js");

beforeAll(async () => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  // 关键:先装假时钟,再加载模块 —— 模块顶层的 setInterval 才会被接管。
  vi.useFakeTimers();
  authMod = await import("../../src/middleware/auth.js");
});

afterAll(() => {
  vi.useRealTimers();
});

function makeApp() {
  const app = new Hono();
  app.use("*", authMod.authMiddleware);
  app.get("/ping", (c) => c.json({ ok: true, user: c.get("user") }));
  return app;
}

function insertUser() {
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
    })
    .run();
  return id;
}

beforeEach(() => {
  authMod.invalidateAuthCaches();
  db.delete(users).run();
});

describe("用户缓存 TTL 清扫(60s)", () => {
  it("到点清扫:被删掉的用户在 TTL 之后重新查库 → 401(缓存不会永久驻留)", async () => {
    const id = insertUser();
    const token = generateToken(id, "sweep-a", false);
    const app = makeApp();

    // 第一次请求:把用户写进缓存
    expect((await app.request(`/ping?token=${token}`)).status).toBe(200);
    db.delete(users).where(eq(users.id, id)).run(); // 行没了,但缓存还在

    // 还没到 TTL:仍走缓存 → 200(与既有用例一致,证明缓存真的生效)
    expect((await app.request(`/ping?token=${token}`)).status).toBe(200);

    // 推进一个 TTL → 清扫定时器跑一轮,过期条目被删
    vi.advanceTimersByTime(60_000);
    expect((await app.request(`/ping?token=${token}`)).status).toBe(401);
  });

  it("清扫按**条目自身**的 TTL 判定:未过期的条目不被误删", async () => {
    const idA = insertUser();
    const tokenA = generateToken(idA, "sweep-a2", false);
    const app = makeApp();

    // t0:A 进缓存
    expect((await app.request(`/ping?token=${tokenA}`)).status).toBe(200);
    db.delete(users).where(eq(users.id, idA)).run();

    // t0+30s:B 首次认证 → 进缓存(at = t0+30s)
    vi.advanceTimersByTime(30_000);
    const idB = insertUser();
    const tokenB = generateToken(idB, "sweep-b", false);
    expect((await app.request(`/ping?token=${tokenB}`)).status).toBe(200);
    db.delete(users).where(eq(users.id, idB)).run();

    // t0+60s:清扫跑一轮 —— A 已满 60s(删),B 只有 30s(留)
    vi.advanceTimersByTime(30_000);
    expect((await app.request(`/ping?token=${tokenA}`)).status).toBe(401); // A 被清 → 查库落空
    expect((await app.request(`/ping?token=${tokenB}`)).status).toBe(200); // B 未到期 → 仍命中缓存
  });
});
