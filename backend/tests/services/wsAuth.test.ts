// services/ws/auth.ts 分支补测。
//
// WS 握手不复用 Hono 的 authMiddleware(它绑在 Hono 上,raw upgrade 请求跑不动),
// 这里镜像了一份「先 JWT、后 API key」的判定。此前这 24 行一行没被覆盖过 ——
// 也就是说 WS 握手到底认不认 API key、过期/停用的 key 怎么处理,全靠「应该没问题」。
// 用例全部打在真实 SQLite 与真实 jwt.verify 上。
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { initDatabase, sqlite } from "../../src/db/index.js";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../../src/utils/env.js";
import { authenticateWsToken } from "../../src/services/ws/auth.js";

function makeUser(o: {
  id: string;
  username?: string;
  isAdmin?: 0 | 1;
  isActive?: 0 | 1;
  apiKey?: string | null;
  apiKeyExpiresAt?: string | null;
}) {
  sqlite.prepare(
    `INSERT OR REPLACE INTO users (id, username, password, salt, subsonic_salt,
        is_admin, is_active, api_key, api_key_expires_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    o.id,
    o.username ?? o.id,
    "x",
    "x",
    "x",
    o.isAdmin ?? 0,
    o.isActive ?? 1,
    o.apiKey ?? null,
    o.apiKeyExpiresAt ?? null,
    new Date().toISOString(),
    new Date().toISOString(),
  );
}

const tokenFor = (uid: string) => jwt.sign({ uid }, JWT_SECRET, { expiresIn: "1h" });
const subTokenFor = (sub: string) => jwt.sign({ sub }, JWT_SECRET, { expiresIn: "1h" });

beforeAll(() => {
  initDatabase();
});

beforeEach(() => {
  sqlite.prepare("DELETE FROM users WHERE id LIKE 'u-wsa-%'").run();
});

describe("authenticateWsToken: JWT 分支", () => {
  it("空 token 直接拒绝,不查库", () => {
    expect(authenticateWsToken("")).toBeNull();
    expect(authenticateWsToken("   ")).toBeNull();
  });

  it("有效 JWT ⇒ 返回用户(带 username 与 isAdmin)", () => {
    makeUser({ id: "u-wsa-1", username: "alice", isAdmin: 1 });
    const u = authenticateWsToken(tokenFor("u-wsa-1"));
    expect(u).toMatchObject({ id: "u-wsa-1", username: "alice", isAdmin: true });
  });

  it("非 admin 用户 isAdmin 为 false,不是 undefined", () => {
    makeUser({ id: "u-wsa-2" });
    expect(authenticateWsToken(tokenFor("u-wsa-2"))).toMatchObject({ id: "u-wsa-2", isAdmin: false });
  });

  it("payload 里只有 sub 时也能取到用户", () => {
    makeUser({ id: "u-wsa-3" });
    expect(authenticateWsToken(subTokenFor("u-wsa-3"))).toMatchObject({ id: "u-wsa-3" });
  });

  it("JWT 有效但用户已停用 ⇒ 不通过,且不会回落到同一用户的 API key 绕开停用", () => {
    makeUser({ id: "u-wsa-4", isActive: 0, apiKey: "k4" });
    expect(authenticateWsToken(tokenFor("u-wsa-4"))).toBeNull();
    expect(authenticateWsToken("k4")).toBeNull();
  });

  it("JWT 签名不对 ⇒ 静默落到 API key 分支,不抛错", () => {
    makeUser({ id: "u-wsa-5", apiKey: "k5" });
    const forged = jwt.sign({ uid: "u-wsa-5" }, "wrong-secret", { expiresIn: "1h" });
    // forged 不是有效 JWT ⇒ 进 API key 线性扫描,但它不等于 k5 ⇒ 拒绝
    expect(authenticateWsToken(forged)).toBeNull();
    // 而 forged 本身恰好就是某人的 key 时,握手应当通过(两条凭据共用一次判定)
    makeUser({ id: "u-wsa-5b", apiKey: forged });
    expect(authenticateWsToken(forged)).toMatchObject({ id: "u-wsa-5b" });
  });

  it("JWT 过期 ⇒ 同样落到 API key 分支,但过期的 key 依然过期", () => {
    makeUser({ id: "u-wsa-6", apiKey: "k6" });
    const expired = jwt.sign({ uid: "u-wsa-6" }, JWT_SECRET, { expiresIn: "-10s" });
    expect(authenticateWsToken(expired)).toBeNull();
  });
});

describe("authenticateWsToken: API key 分支", () => {
  it("命中未过期的 API key ⇒ 通过", () => {
    makeUser({ id: "u-wsa-7", apiKey: "key-7" });
    expect(authenticateWsToken("key-7")).toMatchObject({ id: "u-wsa-7", isAdmin: false });
  });

  it("key 对应用户是 admin ⇒ isAdmin 为真", () => {
    makeUser({ id: "u-wsa-8", apiKey: "key-8", isAdmin: 1 });
    expect(authenticateWsToken("key-8")!.isAdmin).toBe(true);
  });

  it("key 对应用户已被停用 ⇒ 拒绝(停用是账号级,不是 key 级)", () => {
    makeUser({ id: "u-wsa-9", apiKey: "key-9", isActive: 0 });
    expect(authenticateWsToken("key-9")).toBeNull();
  });

  it("key 已过期 ⇒ 即便账号正常也拒绝", () => {
    makeUser({ id: "u-wsa-10", apiKey: "key-10", apiKeyExpiresAt: new Date(Date.now() - 60_000).toISOString() });
    expect(authenticateWsToken("key-10")).toBeNull();
  });

  it("key 未过期(边界前 1 秒)⇒ 通过", () => {
    makeUser({ id: "u-wsa-11", apiKey: "key-11", apiKeyExpiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(authenticateWsToken("key-11")).toMatchObject({ id: "u-wsa-11" });
  });

  it("账号没有设 key ⇒ 拒绝,不抛错", () => {
    makeUser({ id: "u-wsa-12" });
    expect(authenticateWsToken("随便一个串")).toBeNull();
  });

  it("一条 JWT 都不是的串(穿过线性扫描)⇒ null", () => {
    makeUser({ id: "u-wsa-13", apiKey: "key-13" });
    expect(authenticateWsToken("key-13-x")).toBeNull();
  });
});
