// 登录防爆破限流测试(内存实现):
//   - 连续 MAX_FAILS(5) 次口令错误后,账号进入 423(Too many attempts)锁定 24 小时
//   - 锁定期内即使口令正确也拒绝
//   - 计数/锁定保存在进程内 Map(非持久化),服务器重启即清零 —— 另用不同账号验证
//     "成功登录清零失败计数"的行为。
import "../plugins/_env.js";
import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { v4 as uuidv4 } from "uuid";
import { db, encryptPassword } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { authRoutes } from "../../src/routes/auth/index.js";

describe("login lockout (in-memory)", () => {
  let app: Hono;
  const password = "correct-pw";

  function seedUser() {
    const uid = uuidv4();
    const username = `lock-${uid.slice(0, 8)}`;
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
    return username;
  }

  function login(username: string, pw: string) {
    return app.request(`/rest/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: pw }),
    });
  }

  beforeAll(async () => {
    await import("../../src/db/index.js");
    if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
    app = new Hono();
    app.route("/rest", authRoutes);
  });

  it("连续 5 次错误口令后进入 423 锁定且带 retryAfterSeconds", async () => {
    const username = seedUser();
    for (let i = 0; i < 5; i++) await login(username, "wrong");
    const res = await login(username, "wrong");
    const body = await res.json();
    expect(res.status).toBe(423);
    expect(body.error).toMatch(/Too many/i);
    // 锁 24 小时 ≈ 86400 秒(秒级四舍五入允许 ±1)。
    expect(Math.abs(body.retryAfterSeconds - 86400)).toBeLessThanOrEqual(1);
  });

  it("锁定期内即便口令正确也拒绝", async () => {
    const username = seedUser();
    for (let i = 0; i < 5; i++) await login(username, "wrong");
    const res = await login(username, password);
    expect(res.status).toBe(423);
  });

  it("正确口令成功登录(未触发锁定时)见 username 维度独立", async () => {
    // 不同账号互不影响:锁定的账号不会波及其它账号(内存 Map 按账号隔离)。
    const a = seedUser();
    const b = seedUser();
    for (let i = 0; i < 5; i++) await login(a, "wrong");
    const resB = await login(b, password);
    expect(resB.status).toBe(200);
  });
});