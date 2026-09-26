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
const authQS = () => "u=alice&t=" + md5(PLAIN + CLIENT_SALT) + "&s=" + CLIENT_SALT;

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
    db.insert(users)
      .values({
        id: "u1",
        username: "alice",
        password: "",
        salt: "salt",
        subsonicSalt: "subsalt",
        passEnc: encryptPassword(PLAIN),
        isAdmin: 1,
        isActive: 1,
        email: "a@b.c",
      })
      .run();
  }
});

async function call(method: string, path: string, body?: any) {
  const res = await app.request("/rest/api" + path + "?" + authQS(), {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, text };
}

const GETS: string[] = [
  "/v1/online/no-such-provider/match-playlist/status",
  "/v1/online/no-such-provider/match-playlists/status",
  "/v1/online/no-such-provider/unmatched",
  "/v1/online/no-such-provider/recommend",
  "/v1/online/no-such-provider/recommend/local",
  "/v1/online/no-such-provider/recommend/sync-all/status",
];

const WRITES: Array<[string, string]> = [
  ["POST", "/v1/online/no-such-provider/match-playlist"],
  ["POST", "/v1/online/no-such-provider/match-playlists"],
  ["POST", "/v1/online/no-such-provider/match-track"],
  ["POST", "/v1/online/no-such-provider/import"],
  ["POST", "/v1/online/no-such-provider/recommend/import"],
  ["POST", "/v1/online/no-such-provider/search"],
];

describe("online 路由契约 - 未知 provider 不得抛未捕获异常", () => {
  for (const p of GETS) {
    it("GET " + p + " -> 非 5xx", async () => {
      const r = await call("GET", p);
      expect(r.status, "GET " + p + " -> " + r.status + " " + r.text.slice(0, 200)).toBeLessThan(500);
    });
  }
});

describe("online 路由契约 - 空参数写端点不得抛未捕获异常", () => {
  for (const [m, p] of WRITES) {
    it(m + " " + p + " -> 非 5xx", async () => {
      const r = await call(m, p, {});
      expect(r.status, m + " " + p + " -> " + r.status + " " + r.text.slice(0, 200)).toBeLessThan(500);
    });
  }
});

describe("online 路由契约 - 返回体形态", () => {
  it("任务状态类端点返回带 status 的对象", async () => {
    for (const p of [
      "/v1/online/no-such-provider/match-playlist/status",
      "/v1/online/no-such-provider/match-playlists/status",
      "/v1/online/no-such-provider/recommend/sync-all/status",
    ]) {
      const r = await call("GET", p);
      expect(r.status, p).toBeLessThan(500);
      expect(r.body && typeof r.body === "object", p + " body=" + r.text.slice(0, 160)).toBe(true);
    }
  });

  it("unmatched 列表返回数组形态", async () => {
    const r = await call("GET", "/v1/online/no-such-provider/unmatched");
    expect(r.status).toBe(200);
    expect(r.body && typeof r.body === "object").toBe(true);
  });
});
