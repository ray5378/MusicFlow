// POST /auth/login(短路径登录入口,src/routes/auth/index.ts 103-108)路由覆盖(cv_ 前缀)。
//
// 既有 authLockout.test.ts 打的是长路径 /rest/api/v1/auth/login(行 94-100);
// 这里覆盖同文件的**短路径**入口:成功 → 200 + loginPayload;失败 → r.body + r.code
// (401 口令错 / 账号不存在、400 缺参)。
// 手法照抄 authLockout.test.ts:真 DB 造用户、挂 authRoutes 后打真实路由;
// handleLogin 走真实逻辑(不 mock),锁定态用例由 authLockout 覆盖,不重复。
import "../plugins/_env.js";
import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { v4 as uuidv4 } from "uuid";
import { db, encryptPassword } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { authRoutes } from "../../src/routes/auth/index.js";

describe("POST /auth/login(短路径入口)", () => {
  let app: Hono;
  const password = "correct-pw";

  function seedUser() {
    const uid = uuidv4();
    const username = `cvlogin-${uid.slice(0, 8)}`;
    db.insert(users)
      .values({
        id: uid,
        username,
        password: md5(password + "subsalt"),
        salt: "salt",
        subsonicSalt: "subsalt",
        passEnc: encryptPassword(password),
        isAdmin: 0,
        isActive: 1,
        email: "",
      })
      .run();
    return { uid, username };
  }

  function login(username: unknown, pw: unknown) {
    return app.request(`/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: pw }),
    });
  }

  beforeAll(async () => {
    await import("../../src/db/index.js");
    if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
    app = new Hono();
    app.route("/", authRoutes);
  });

  it("登录成功 → 200 + payload(token / subsonicToken / rendererGrants)", async () => {
    const { uid, username } = seedUser();
    const res = await login(username, password);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe(uid);
    expect(body.username).toBe(username);
    expect(body.isAdmin).toBe(false);
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);
    // subsonicToken = md5(存储口令哈希 + subsonicSalt),逐字节可推。
    expect(body.subsonicToken).toBe(md5(md5(password + "subsalt") + "subsalt"));
    expect(Array.isArray(body.rendererGrants)).toBe(true);
    expect(body.mustChangePassword).toBe(false);
  });

  it("口令错误 → 401 Invalid credentials(返回 r.body + r.code)", async () => {
    const { username } = seedUser();
    const res = await login(username, "wrong-pw");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid credentials" });
  });

  it("账号不存在 → 401 同文案(不区分账号是否存在,防枚举)", async () => {
    const res = await login("no-such-user-xyz", "whatever");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid credentials" });
  });

  it("缺 username/password → 400", async () => {
    const res = await login("", "");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Username and password required" });
  });
});
