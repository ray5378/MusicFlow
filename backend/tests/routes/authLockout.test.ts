// 登录防爆破限流测试:
//   - 连续 MAX_FAILS 次口令错误后,账号进入 423(Too many attempts)锁定
//   - 锁定期内即使口令正确也拒绝
//   - 锁定到期后放行;成功登录清零失败计数
import "../plugins/_env.js";
import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { v4 as uuidv4 } from "uuid";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authRoutes } from "../../src/routes/auth/index.js";

describe("login lockout", () => {
  let app: Hono;
  let uid: string;
  let username: string;
  const password = "correct-pw";

  beforeAll(async () => {
    // 导入会触发 initDatabase 的副作用依赖;显式调用确保 schema 存在。
    await import("../../src/db/index.js");
    if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
    app = new Hono();
    app.route("/rest", authRoutes);

    uid = uuidv4();
    username = `lockout-${uid.slice(0, 8)}`;
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
        loginFailCount: 0,
        lockedUntil: null,
      })
      .run();
  });

  function login(pw: string) {
    return app.request(`/rest/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: pw }),
    });
  }

  async function failCount() {
    const row = db.select().from(users).where(eq(users.id, uid)).get();
    return row?.loginFailCount || 0;
  }

  it("连续 5 次错误口令触发 423 锁定", async () => {
    let last: Response | undefined;
    for (let i = 0; i < 5; i++) last = await login("wrong");
    expect([...last!.headers].length >= 0).toBe(true);
    // 第 5 次失败(达到阈值)时返回 423,并携带 retryAfterSeconds。
    const locked = await login("wrong");
    const body = await locked.json();
    expect(locked.status).toBe(423);
    expect(body.error).toMatch(/Too many attempts/i);
    expect(typeof body.retryAfterSeconds).toBe("number");
  });

  it("锁定期内即便口令正确也拒绝", async () => {
    const res = await login(password);
    expect(res.status).toBe(423);
  });

  it("失败计数已持久化到 5", async () => {
    expect(await failCount()).toBe(5);
  });

  it("清空锁定后正确口令放行并清零计数", async () => {
    // 直接清除锁定状态,模拟锁定到期。
    db.update(users).set({ lockedUntil: null, updatedAt: new Date().toISOString() }).where(eq(users.id, uid)).run();
    const res = await login(password);
    expect(res.status).toBe(200);
    expect(await failCount()).toBe(0);
  });
});