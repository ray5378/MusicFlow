// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const PLAIN = "hunter2";
const CLIENT_SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + CLIENT_SALT)}&s=${CLIENT_SALT}`;

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
    db.insert(users).values({ id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt", passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1, email: "a@b.c" }).run();
  }
});

async function req(method: string, path: string, body?: any) {
  const res = await app.request(`/rest/api/v1/proxy${path}?${authQS()}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("GET/PUT/POST /v1/proxy (admin)", () => {
  it("GET 默认返回关闭、无地址", async () => {
    const { body } = await req("GET", "");
    expect(body).toMatchObject({ success: true, enabled: false, url: "" });
  });

  it("PUT 合法地址保存成功并可回读", async () => {
    await req("PUT", "", { enabled: true, url: "http://192.168.1.10:7890" });
    const { body } = await req("GET", "");
    expect(body).toMatchObject({ enabled: true, url: "http://192.168.1.10:7890" });
    // 复位
    await req("PUT", "", { enabled: false, url: "" });
  });

  it("PUT 开启但地址非法返回 400", async () => {
    const { status, body } = await req("PUT", "", { enabled: true, url: "1.2.3.4:99" });
    expect(status).toBe(400);
    expect(body.error).toContain("http://ip:port");
  });

  it("POST test 未启用代理时返回失败提示", async () => {
    await req("PUT", "", { enabled: false, url: "" });
    const { body } = await req("POST", "/test", {});
    expect(body.success).toBe(false);
    expect(body.error).toContain("未启用");
  });
});
