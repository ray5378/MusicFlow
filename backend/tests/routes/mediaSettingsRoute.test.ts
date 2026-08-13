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
import { getSetting } from "../../src/services/settings.js";

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
  const res = await app.request(`/rest/api/v1${path}?${authQS()}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("媒体获取(歌词/封面)设置落库", () => {
  it("封面设置:PUT 后 GET 应回读一致,且写入 cover.* 键(非 covers.*)", async () => {
    await req("PUT", "/covers/settings", { providerId: "go-cover", onDemand: false, persist: false });
    const { body } = await req("GET", "/covers/settings");
    expect(body).toMatchObject({ providerId: "go-cover", onDemand: false, persist: false });
    // 必须是 cover.* 前缀,与 providers.ts / covers.ts / GET 一致
    expect(getSetting("cover.providerId", "")).toBe("go-cover");
    expect(getSetting("covers.providerId", "SHOULD_NOT_EXIST")).toBe("SHOULD_NOT_EXIST");
    // 复位
    await req("PUT", "/covers/settings", { providerId: "", onDemand: true, persist: true });
    const reset = await req("GET", "/covers/settings");
    expect(reset.body).toMatchObject({ providerId: "", onDemand: true, persist: true });
  });

  it("封面设置:清空 providerId(undefined)应落库为空串(=自动)", async () => {
    await req("PUT", "/covers/settings", { providerId: "go-cover", onDemand: true, persist: true });
    await req("PUT", "/covers/settings", { providerId: undefined, onDemand: true, persist: true });
    const { body } = await req("GET", "/covers/settings");
    expect(body.providerId).toBe("");
    expect(getSetting("cover.providerId", "X")).toBe("");
  });

  it("歌词设置:PUT 后 GET 应回读一致", async () => {
    await req("PUT", "/lyrics/settings", { providerId: "go-lyrics", onDemand: false, persist: true });
    const { body } = await req("GET", "/lyrics/settings");
    expect(body).toMatchObject({ providerId: "go-lyrics", onDemand: false, persist: true });
    expect(getSetting("lyrics.providerId", "")).toBe("go-lyrics");
    // 复位
    await req("PUT", "/lyrics/settings", { providerId: "", onDemand: true, persist: false });
    const reset = await req("GET", "/lyrics/settings");
    expect(reset.body).toMatchObject({ providerId: "", onDemand: true, persist: false });
  });
});
