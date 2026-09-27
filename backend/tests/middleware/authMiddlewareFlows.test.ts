// middleware/auth.ts 补测:既有 auth.test.ts 只覆盖了 apiKey 索引的命中/失效/过期
// 与 JWT Bearer,本文件补齐其余入口与所有「假分支」。
//
// 为什么值得单独测:鉴权是唯一的信任边界,它的每个凭据入口(URL ?token=、OpenSubsonic
// u/t/s、旧式 u/p、X-ND-Authorization)都直接决定「谁被当成谁」。而这些分支的真实触发
// 需要造出「老版本用户行」「只有明文 apiKey 的存量行」等历史数据形态 —— 靠人工在真机上
// 复现几乎不可能,正好是测试该补的地方。
//
// 一条实现层面的观察(可读性/死代码,非缺陷):getParam 的 `|| q[name]?.[0]` 第三级在
// Hono 下不可达 —— c.req.query(name) 与 c.req.queries()[name][0] 同源,前者有值时后者
// 也有值,前者无值时后者同样无值。保留无害,仅为兼容写法。
import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import md5 from "md5";
import jwt from "jsonwebtoken";
import { db, encryptPassword } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware, adminMiddleware, invalidateAuthCaches, credentialsProfile } from "../../src/middleware/auth.js";
import { generateToken, hashApiKey } from "../../src/utils/auth.js";
import { JWT_SECRET } from "../../src/utils/env.js";

type Any = any;

function makeApp() {
  const app = new Hono();
  app.use("*", authMiddleware);
  app.get("/ping", (c) => c.json({ ok: true, user: c.get("user") }));
  app.post("/ping", (c) => c.json({ ok: true, user: c.get("user") }));
  app.use("/admin/*", adminMiddleware);
  app.get("/admin/dash", (c) => c.json({ ok: true }));
  return app;
}

function insertUser(over: Record<string, unknown> = {}) {
  const id = uuidv4();
  db.insert(users)
    .values({
      id,
      username: `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

function userRow(id: string) {
  return db.select().from(users).where(eq(users.id, id)).get() as Any;
}

const body = (res: Response) => res.json() as Promise<Any>;

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
});

beforeEach(() => {
  invalidateAuthCaches();
  db.delete(users).run();
});

// ==================== ?token= 查询参数(播放器 / HA media_source 只能带 URL) ====================

describe("?token= 查询参数", () => {
  it("有效 JWT → 通过(uid)", async () => {
    const id = insertUser({ username: "streamer" });
    const app = makeApp();
    const res = await app.request(`/ping?token=${encodeURIComponent(generateToken(id, "streamer", false))}`);
    expect(res.status).toBe(200);
    expect((await body(res)).user.id).toBe(id);
  });

  it("JWT 只带 sub(无 uid)→ 也能定位用户", async () => {
    const id = insertUser({ username: "subonly" });
    const token = jwt.sign({ sub: id }, JWT_SECRET);
    const res = await makeApp().request(`/ping?token=${token}`);
    expect(res.status).toBe(200);
    expect((await body(res)).user.id).toBe(id);
  });

  it("有效 apiKey → JWT 解析失败后回落 apiKey,通过", async () => {
    const apiKey = `mf_${uuidv4().replace(/-/g, "")}`;
    const id = insertUser({ apiKey, apiKeyHash: hashApiKey(apiKey), apiKeyExpiresAt: null });
    invalidateAuthCaches();
    const res = await makeApp().request(`/ping?token=${apiKey}`);
    expect(res.status).toBe(200);
    expect((await body(res)).user.id).toBe(id);
  });

  it("JWT 合法但 uid 指向已删除用户 → 401(不回落成任何人)", async () => {
    const token = jwt.sign({ uid: "ghost-user" }, JWT_SECRET);
    const res = await makeApp().request(`/ping?token=${token}`);
    expect(res.status).toBe(401);
  });

  it("token 既不是 JWT 也不是 apiKey → 401", async () => {
    insertUser();
    const res = await makeApp().request("/ping?token=not-a-credential");
    expect(res.status).toBe(401);
    const b = await body(res);
    expect(b["subsonic-response"].error.code).toBe(40);
  });

  it("完全没有凭据 → 401", async () => {
    const res = await makeApp().request("/ping");
    expect(res.status).toBe(401);
  });
});

// ==================== OpenSubsonic u/t/s ====================

describe("OpenSubsonic u/t/s(token = md5(明文口令 + 客户端盐))", () => {
  it("pass_enc 可解密且 md5(明文+盐) 匹配 → 通过", async () => {
    const id = insertUser({ username: "os-user", passEnc: encryptPassword("P@ssw0rd") });
    const salt = "abc123";
    const res = await makeApp().request(
      `/ping?u=os-user&s=${salt}&t=${md5("P@ssw0rd" + salt)}`,
    );
    expect(res.status).toBe(200);
    expect((await body(res)).user.id).toBe(id);
  });

  it("历史用户无 pass_enc → 回落 md5(password+salt)", async () => {
    const id = insertUser({ username: "legacy1", password: md5("secret"), passEnc: null });
    const salt = "s1";
    const res = await makeApp().request(`/ping?u=legacy1&s=${salt}&t=${md5(md5("secret") + salt)}`);
    expect(res.status).toBe(200);
    expect((await body(res)).user.id).toBe(id);
  });

  it("历史用户另一种口径 → md5(md5(password)+salt) 也认", async () => {
    const id = insertUser({ username: "legacy2", password: md5("secret"), passEnc: null });
    const salt = "s2";
    // 注意:此处 password 存的就是 md5("secret"),故 md5(md5(plain)+salt)
    const res = await makeApp().request(`/ping?u=legacy2&s=${salt}&t=${md5(md5(md5("secret")) + salt)}`);
    expect(res.status).toBe(200);
    expect((await body(res)).user.id).toBe(id);
  });

  it("token 不匹配 → 401", async () => {
    insertUser({ username: "os-user2", passEnc: encryptPassword("right") });
    const res = await makeApp().request("/ping?u=os-user2&s=s&t=deadbeef");
    expect(res.status).toBe(401);
  });

  it("用户不存在 → 401", async () => {
    const res = await makeApp().request("/ping?u=nobody&s=s&t=deadbeef");
    expect(res.status).toBe(401);
  });

  it("用户被禁用 → 401(即使口令正确)", async () => {
    insertUser({ username: "os-disabled", passEnc: encryptPassword("right"), isActive: 0 });
    const salt = "s";
    const res = await makeApp().request(`/ping?u=os-disabled&s=${salt}&t=${md5("right" + salt)}`);
    expect(res.status).toBe(401);
  });

  it("u/t/s 只给一部分 → 不走 OpenSubsonic 分支(仍 401)", async () => {
    insertUser({ username: "os-partial", passEnc: encryptPassword("right") });
    const ref = makeApp();
    expect((await ref.request("/ping?u=os-partial&t=deadbeef")).status).toBe(401); // 缺 s
    expect((await ref.request("/ping?u=os-partial&s=s")).status).toBe(401);       // 缺 t
    expect((await ref.request("/ping?s=s&t=deadbeef")).status).toBe(401);         // 缺 u
  });
});

// ==================== 旧式 u/p ====================

describe("旧式 u/p(明文或 enc:hex)", () => {
  it("p = 明文口令且与 pass_enc 明文一致 → 通过", async () => {
    const id = insertUser({ username: "pw-plain", passEnc: encryptPassword("hello") });
    const res = await makeApp().request("/ping?u=pw-plain&p=hello");
    expect(res.status).toBe(200);
    expect((await body(res)).user.id).toBe(id);
  });

  it("p = enc:hex(明文) → 解出明文后通过", async () => {
    const id = insertUser({ username: "pw-enc", passEnc: encryptPassword("hello") });
    const hex = Buffer.from("hello", "utf8").toString("hex");
    const res = await makeApp().request(`/ping?u=pw-enc&p=enc:${hex}`);
    expect(res.status).toBe(200);
    expect((await body(res)).user.id).toBe(id);
  });

  it("p 与 password 列的 md5(明文+subsonicSalt) 对上 → 通过(无 pass_enc 的历史用户)", async () => {
    const id = insertUser({ username: "pw-salt", subsonicSalt: "SS", password: md5("pw" + "SS"), passEnc: null });
    const res = await makeApp().request("/ping?u=pw-salt&p=pw");
    expect(res.status).toBe(200);
    expect((await body(res)).user.id).toBe(id);
  });

  it("enc: 后面的 hex 非法 → 解出空串,认证失败(不抛 500)", async () => {
    insertUser({ username: "pw-badhex", passEnc: encryptPassword("hello") });
    const res = await makeApp().request("/ping?u=pw-badhex&p=enc:zzzz");
    expect(res.status).toBe(401);
  });

  it("口令错误 / 用户不存在 / 被禁用 → 401", async () => {
    insertUser({ username: "pw-wrong", passEnc: encryptPassword("hello") });
    insertUser({ username: "pw-off", passEnc: encryptPassword("hello"), isActive: 0 });
    const app = makeApp();
    expect((await app.request("/ping?u=pw-wrong&p=nope")).status).toBe(401);
    expect((await app.request("/ping?u=ghost&p=hello")).status).toBe(401);
    expect((await app.request("/ping?u=pw-off&p=hello")).status).toBe(401);
  });
});

// ==================== 凭据来源:URL 查询 vs 表单体 ====================

describe("凭据来源(query 与 form body 都必须认)", () => {
  it("表单体(application/x-www-form-urlencoded)里的 u/p 也能认证", async () => {
    const id = insertUser({ username: "form-user", passEnc: encryptPassword("formpw") });
    const res = await makeApp().request("/ping", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ u: "form-user", p: "formpw" }).toString(),
    });
    expect(res.status).toBe(200);
    expect((await body(res)).user.id).toBe(id);
  });

  it("查询串优先于表单体(同名参数)", async () => {
    const id = insertUser({ username: "both-src", passEnc: encryptPassword("fromquery") });
    const res = await makeApp().request("/ping?p=fromquery", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ u: "both-src", p: "frombody" }).toString(),
    });
    expect(res.status).toBe(200);
    expect((await body(res)).user.id).toBe(id);
  });
});

// ==================== X-ND-Authorization ====================

describe("X-ND-Authorization(Bearer)", () => {
  it("有效 JWT → 通过", async () => {
    const id = insertUser({ username: "nd" });
    const res = await makeApp().request("/ping", {
      headers: { "X-ND-Authorization": `Bearer ${generateToken(id, "nd", false)}` },
    });
    expect(res.status).toBe(200);
    expect((await body(res)).user.id).toBe(id);
  });

  it("Bearer 形式但凭据无效 → 401(不静默放行)", async () => {
    insertUser();
    const res = await makeApp().request("/ping", { headers: { "X-ND-Authorization": "Bearer garbage" } });
    expect(res.status).toBe(401);
  });

  it("非 Bearer 前缀 → 该头被忽略,仍 401", async () => {
    const id = insertUser({ username: "nd2" });
    const res = await makeApp().request("/ping", {
      headers: { "X-ND-Authorization": generateToken(id, "nd2", false) },
    });
    expect(res.status).toBe(401);
  });
});

// ==================== apiKey 索引:存量自愈 / 过期 / 禁用 ====================

describe("apiKey 索引", () => {
  it("存量行只有明文 apiKey(无 hash)→ 建索引时即时回填 hash 并认证成功", async () => {
    const apiKey = `mf_${uuidv4().replace(/-/g, "")}`;
    const id = insertUser({ apiKey, apiKeyHash: null, apiKeyExpiresAt: null });

    const res = await makeApp().request("/ping", { headers: { "X-API-Key": apiKey } });
    expect(res.status).toBe(200);
    // 自愈:回填后的 hash 已落库,下次无需再算
    expect(userRow(id).apiKeyHash).toBe(hashApiKey(apiKey));
  });

  it("已过期的 apiKey → 401", async () => {
    const apiKey = `mf_${uuidv4().replace(/-/g, "")}`;
    insertUser({ apiKey, apiKeyHash: hashApiKey(apiKey), apiKeyExpiresAt: "2000-01-01T00:00:00.000Z" });
    const res = await makeApp().request("/ping", { headers: { "X-API-Key": apiKey } });
    expect(res.status).toBe(401);
  });

  it("凭据有效但用户被禁用 → 401", async () => {
    const apiKey = `mf_${uuidv4().replace(/-/g, "")}`;
    insertUser({ apiKey, apiKeyHash: hashApiKey(apiKey), apiKeyExpiresAt: null, isActive: 0 });
    const res = await makeApp().request("/ping", { headers: { "X-API-Key": apiKey } });
    expect(res.status).toBe(401);
  });

  it("X-API-Key 无效时继续尝试其它凭据(不直接 401)", async () => {
    const id = insertUser({ username: "fallthrough" });
    const res = await makeApp().request("/ping", {
      headers: { "X-API-Key": "mf_bogus", Authorization: `Bearer ${generateToken(id, "fallthrough", false)}` },
    });
    expect(res.status).toBe(200);
    expect((await body(res)).user.id).toBe(id);
  });
});

// ==================== 用户缓存 ====================

describe("用户缓存(60s TTL)", () => {
  it("命中缓存:删掉用户行后 TTL 内仍可通过(证明没有每请求查库)", async () => {
    const id = insertUser({ username: "cached" });
    const token = generateToken(id, "cached", false);
    const app = makeApp();

    expect((await app.request(`/ping?token=${token}`)).status).toBe(200);
    db.delete(users).where(eq(users.id, id)).run(); // 行没了,但缓存还在
    expect((await app.request(`/ping?token=${token}`)).status).toBe(200);

    invalidateAuthCaches(); // 写侧失效后立即收敛
    expect((await app.request(`/ping?token=${token}`)).status).toBe(401);
  });

  it("缓存里标记为禁用 → 直接 401(不再放行)", async () => {
    const id = insertUser({ username: "turn-off" });
    const token = generateToken(id, "turn-off", false);
    const app = makeApp();
    expect((await app.request(`/ping?token=${token}`)).status).toBe(200);

    db.update(users).set({ isActive: 0 }).where(eq(users.id, id)).run();
    invalidateAuthCaches();
    expect((await app.request(`/ping?token=${token}`)).status).toBe(401);
  });
});

// ==================== adminMiddleware ====================

describe("adminMiddleware", () => {
  it("管理员 → 放行", async () => {
    const id = insertUser({ username: "root", isAdmin: 1 });
    const res = await makeApp().request("/admin/dash", {
      headers: { Authorization: `Bearer ${generateToken(id, "root", true)}` },
    });
    expect(res.status).toBe(200);
  });

  it("普通用户 → 403 且错误码为 50", async () => {
    const id = insertUser({ username: "pleb", isAdmin: 0 });
    const res = await makeApp().request("/admin/dash", {
      headers: { Authorization: `Bearer ${generateToken(id, "pleb", false)}` },
    });
    expect(res.status).toBe(403);
    expect((await body(res))["subsonic-response"].error.code).toBe(50);
  });

  it("JWT 里自称 isAdmin=true 但库里不是 → 以库为准,403", async () => {
    const id = insertUser({ username: "liar", isAdmin: 0 });
    // generateToken 的 isAdmin 只进 JWT 载荷,真正判定走 DB 用户缓存
    const res = await makeApp().request("/admin/dash", {
      headers: { Authorization: `Bearer ${generateToken(id, "liar", true)}` },
    });
    expect(res.status).toBe(403);
  });

  it("未认证 → 先被 authMiddleware 拦成 401", async () => {
    const res = await makeApp().request("/admin/dash");
    expect(res.status).toBe(401);
  });
});

// ==================== HTTP Basic 认证 + D26 401 现场 ====================
// 为什么合在一起:这两件事是**同一次排障**会一起用到的 ——
// 「客户端走 Basic 而后端不认」既是功能缺口(D:Basic),也是 401 查不出原因的一半原因(D26)。

/** 给指定用户配一个有效 apiKey,返回明文。 */
function apiKeyFor(id: string): string {
  const apiKey = `mf_${uuidv4().replace(/-/g, "")}`;
  db.update(users)
    .set({ apiKey, apiKeyHash: hashApiKey(apiKey), apiKeyExpiresAt: null })
    .where(eq(users.id, id))
    .run();
  invalidateAuthCaches();
  return apiKey;
}

describe("HTTP Basic 认证(Authorization: Basic)", () => {
  it("明文口令 → 通过", async () => {
    const id = insertUser({ username: "basicuser", passEnc: encryptPassword("pw") });
    const res = await makeApp().request("/ping", {
      headers: { Authorization: `Basic ${Buffer.from("basicuser:pw").toString("base64")}` },
    });
    expect(res.status).toBe(200);
    expect((await body(res)).user.id).toBe(id);
  });

  it("口令里自带 ':' 也能通过(只按第一个冒号切分)", async () => {
    // 防回归要点:用 split(":") 会把 `col:on:side` 截成 `col`,这种口令会**恒定失败**
    // 且失败提示看不出原因 —— 正是 HA 侧 401 最难查的那类形态。
    const id = insertUser({ username: "colonuser", passEnc: encryptPassword("col:on:side") });
    const res = await makeApp().request("/ping", {
      headers: { Authorization: `Basic ${Buffer.from("colonuser:col:on:side").toString("base64")}` },
    });
    expect(res.status).toBe(200);
    expect((await body(res)).user.id).toBe(id);
  });

  it("口令错误 → 401", async () => {
    insertUser({ username: "basicuser2", passEnc: encryptPassword("pw") });
    const res = await makeApp().request("/ping", {
      headers: { Authorization: `Basic ${Buffer.from("basicuser2:wrong").toString("base64")}` },
    });
    expect(res.status).toBe(401);
  });

  it("Basic 解码后没有冒号时,不挡住后面的凭据分支", async () => {
    const id = insertUser({ passEnc: encryptPassword("pw") });
    const apiKey = apiKeyFor(id);
    const res = await makeApp().request("/ping", {
      headers: {
        Authorization: `Basic ${Buffer.from("no-colon-here").toString("base64")}`,
        "X-API-Key": apiKey,
      },
    });
    expect(res.status).toBe(200);
  });
});

describe("D26: 401 现场可诊断(脱敏)", () => {
  // 直接验「画像」本身 —— 它决定 401 日志里会出现什么。
  // 不去 spy logger:logger 是 createLogger() 现造的实例,与本文件 import 的未必是同一份,
  // 那种断言一改 logger 实现就红,而这里要保证的真正内容是「画像正确 + 不含密钥原文」。
  async function profileOf(url: string, headers: Record<string, string> = {}) {
    const app = new Hono();
    app.get("*", (c) => c.json(credentialsProfile(c, (n) => c.req.query(n) ?? undefined)));
    const res = await app.request(url, { headers });
    expect(res.status).toBe(200);
    return res.json();
  }

  it("客户端走 Basic → 记 scheme=basic(一眼看出不是 Bearer)", async () => {
    expect(await profileOf("/ping", { Authorization: "Basic dXNlcjpwYXNz" })).toMatchObject({
      scheme: "basic",
      path: "/ping",
    });
  });

  it("什么都没带 → scheme=none,且没有 subsonicUser", async () => {
    expect(await profileOf("/ping")).toMatchObject({ scheme: "none", subsonicUser: null });
  });

  it("u/p 失败时记下用户名(便于核对「谁的凭据过期了」)", async () => {
    expect(await profileOf("/ping?u=ghost&p=whatever")).toMatchObject({
      scheme: "none",
      subsonicUser: "ghost",
      hasSubsonicPassword: true,
    });
  });

  it("带 token 时能被识别,便于区分「播放器走 URL token」", async () => {
    expect(await profileOf("/ping?token=mf_abc")).toMatchObject({ queryToken: true });
  });

  it("画像里绝不含口令/密钥原文", async () => {
    const dump = JSON.stringify(await profileOf("/ping?u=xyz&p=SuperSecret123"));
    expect(dump).not.toContain("SuperSecret123");
  });
});
