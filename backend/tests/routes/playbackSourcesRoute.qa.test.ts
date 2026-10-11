// ==================== QA 独立回归:播放来源优先级设置端点(HTTP 合同) ====================
//
// 验证点(team-lead 要求):
//   ① GET|PUT /rest/api/v1/playback-sources/settings 真正注册且返回约定结构;
//   ② PUT 传非数组 → 400 + 正确 i18n 码(zh 与 en 均非裸 key);
//   ③ admin 端点受保护:非 admin → 403,无凭据 → 非 200。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { runWithLocale, parseLocale, translate } from "../../src/i18n.js";
import { getSetting } from "../../src/services/settings.js";

const app = new Hono();
app.use("*", async (c, next) => {
  return runWithLocale(parseLocale(c.req.header("x-mf-lang") ?? c.req.header("accept-language")), () => next());
});
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const ADMIN_PASS = "hunter2";
const USER_PASS = "bobpass";
const CLIENT_SALT = "clientsalt123";
const qs = (u: string, plain: string) => `u=${u}&t=${md5(plain + CLIENT_SALT)}&s=${CLIENT_SALT}`;

async function req(method: string, path: string, opts: { qs?: string; body?: any; lang?: string } = {}) {
  const res = await app.request(`/rest/api/v1${path}?${opts.qs ?? qs("alice", ADMIN_PASS)}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.lang ? { "x-mf-lang": opts.lang } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: res.status, body };
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  const mk = (id: string, name: string, plain: string, isAdmin: number) => {
    if (!db.select().from(users).where(eq(users.username, name)).get()) {
      db.insert(users).values({
        id, username: name, password: "", salt: "salt", subsonicSalt: "subsalt",
        passEnc: encryptPassword(plain), isAdmin, isActive: 1, email: `${name}@b.c`,
      }).run();
    }
  };
  mk("u1", "alice", ADMIN_PASS, 1);
  mk("u2", "bob", USER_PASS, 0);
});

describe("QA:playback-sources/settings 路由合同", () => {
  it("R1 管理员 GET → 200,返回 { priority: string[], available: [...] }", async () => {
    const { status, body } = await req("GET", "/playback-sources/settings");
    expect(status).toBe(200);
    expect(Array.isArray(body.priority)).toBe(true);
    expect(Array.isArray(body.available)).toBe(true);
  });

  it("R2 管理员 PUT 合法列表(含重复/非法项)→ 200 并回读规范化结果", async () => {
    const put = await req("PUT", "/playback-sources/settings", { body: { priority: ["qa-x", "qa-x", "qa-y", 5, ""] } });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ success: true });
    expect(put.body.priority).toEqual(["qa-x", "qa-y"]);

    const get = await req("GET", "/playback-sources/settings");
    expect(get.body.priority).toEqual(["qa-x", "qa-y"]);
    // 落库键为 stream.sourcePriority
    expect(getSetting("stream.sourcePriority", "MISSING")).toBe(JSON.stringify(["qa-x", "qa-y"]));

    // 复位
    await req("PUT", "/playback-sources/settings", { body: { priority: [] } });
  });

  it("R2b PUT 历史 pluginId:platform 条目 → 收敛为插件级", async () => {
    const put = await req("PUT", "/playback-sources/settings", { body: { priority: ["qa-y:kuwo"] } });
    expect(put.status).toBe(200);
    expect(put.body.priority).toEqual(["qa-y"]); // "qa-y:kuwo" → "qa-y"

    const converge = await req("PUT", "/playback-sources/settings", { body: { priority: ["qa-z:netease", "qa-z:kuwo", ":qq"] } });
    expect(converge.body.priority).toEqual(["qa-z"]); // 同插件两条收敛 + 空 pluginId 丢弃

    const get = await req("GET", "/playback-sources/settings");
    expect(get.body.priority).toEqual(["qa-z"]);
    expect(getSetting("stream.sourcePriority", "MISSING")).toBe(JSON.stringify(["qa-z"]));

    // 复位
    await req("PUT", "/playback-sources/settings", { body: { priority: [] } });
  });

  it("R3 PUT 非数组 → 400 + INVALID_PARAM + i18n 码在 zh/en 均可解析", async () => {
    const zh = await req("PUT", "/playback-sources/settings", { body: { priority: "not-an-array" }, lang: "zh-CN" });
    expect(zh.status).toBe(400);
    expect(zh.body.code).toBe("INVALID_PARAM");
    expect(zh.body.success).toBe(false);
    expect(zh.body.error).not.toContain("errors."); // 非裸 key
    expect(zh.body.error).toBe(translate("errors.streamSourcePriority.invalidList"));

    const en = await req("PUT", "/playback-sources/settings", { body: { priority: "not-an-array" }, lang: "en-US" });
    expect(en.status).toBe(400);
    expect(en.body.code).toBe("INVALID_PARAM");
    expect(en.body.error).not.toContain("errors.");
    expect(en.body.error).not.toBe(zh.body.error); // 两种语言文案不同 = 真翻译而非原样 key
  });

  it("R4 PUT 缺 priority 字段 → 400", async () => {
    const { status, body } = await req("PUT", "/playback-sources/settings", { body: {} });
    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_PARAM");
  });

  it("R5 端点受 admin 保护:非 admin → 403;无凭据 → 非 200", async () => {
    const bob = await req("GET", "/playback-sources/settings", { qs: qs("bob", USER_PASS) });
    expect(bob.status).toBe(403);

    const anon = await req("GET", "/playback-sources/settings", { qs: "u=&t=&s=" });
    expect(anon.status).not.toBe(200);

    const bobPut = await req("PUT", "/playback-sources/settings", { qs: qs("bob", USER_PASS), body: { priority: [] } });
    expect(bobPut.status).toBe(403);
  });
});
