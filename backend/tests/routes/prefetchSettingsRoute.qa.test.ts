// ==================== QA 独立回归:预取/判官参数设置端点(HTTP 合同) ====================
//
// 验证点(2026-10-12 用户拍板「不要完全写死」后的 UI 通道):
//   ① GET|PUT /rest/api/v1/playback-sources/prefetch-settings 真正注册且返回约定结构;
//   ② PUT 合并语义 + 越界钳制 + 即时生效(GET 回读一致);
//   ③ 落库键为 prefetch.settings(与别的设置键隔离);
//   ④ admin 端点受保护:非 admin → 403,无凭据 → 非 200。
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
import { getSetting } from "../../src/services/settings.js";
import { PREFETCH_SETTINGS_KEY } from "../../src/services/source/prefetchConfig.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const ADMIN_PASS = "hunter2";
const USER_PASS = "bobpass";
const CLIENT_SALT = "clientsalt123";
const qs = (u: string, plain: string) => `u=${u}&t=${md5(plain + CLIENT_SALT)}&s=${CLIENT_SALT}`;

async function req(method: string, path: string, opts: { qs?: string; body?: any } = {}) {
  const res = await app.request(`/rest/api/v1${path}?${opts.qs ?? qs("alice", ADMIN_PASS)}`, {
    method,
    headers: { "content-type": "application/json" },
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

describe("QA:playback-sources/prefetch-settings 路由合同", () => {
  it("R1 管理员 GET → 200,返回全量字段 + specs", async () => {
    const { status, body } = await req("GET", "/playback-sources/prefetch-settings");
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    for (const k of ["lookahead", "concurrency", "budgetRatio", "deadlineSec", "stallSec",
      "entryTtlSec", "maxAltSources", "integrityEnabled", "integrityDeltaSec",
      "integrityBitrateDeltaSec", "minAudioKB"]) {
      expect(body[k], k).toBeDefined();
    }
    expect(typeof body.integrityEnabled).toBe("boolean");
    // specs 供前端按同范围渲染/校验
    expect(body.specs.lookahead).toMatchObject({ min: 1, max: 5, def: 1 });
    expect(body.specs.integrityBitrateDeltaSec.def).toBe(80);
  });

  it("R2 PUT 合并 + 钳制 + 即时生效(回读一致)", async () => {
    const put = await req("PUT", "/playback-sources/prefetch-settings", {
      body: { lookahead: 3, integrityDeltaSec: 45, integrityEnabled: false, deadlineSec: 99999 },
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ success: true });
    expect(put.body.lookahead).toBe(3);
    expect(put.body.integrityDeltaSec).toBe(45);
    expect(put.body.integrityEnabled).toBe(false);
    expect(put.body.deadlineSec).toBe(600); // 99999 越界 ⇒ 钳到 max

    // 合并语义:第二次只带一个字段,其余保持
    const put2 = await req("PUT", "/playback-sources/prefetch-settings", { body: { stallSec: 90 } });
    expect(put2.body.lookahead).toBe(3);
    expect(put2.body.stallSec).toBe(90);

    const get = await req("GET", "/playback-sources/prefetch-settings");
    expect(get.body.lookahead).toBe(3);
    expect(get.body.integrityDeltaSec).toBe(45);
    expect(get.body.integrityEnabled).toBe(false);
    expect(get.body.stallSec).toBe(90);
  });

  it("R3 落库键为 prefetch.settings(与别的设置键隔离)", async () => {
    await req("PUT", "/playback-sources/prefetch-settings", { body: { maxAltSources: 2 } });
    const raw = getSetting(PREFETCH_SETTINGS_KEY, "MISSING");
    expect(raw).not.toBe("MISSING");
    expect(JSON.parse(raw).maxAltSources).toBe(2);
  });

  it("R4 端点受 admin 保护:非 admin → 403;无凭据 → 非 200", async () => {
    const bob = await req("GET", "/playback-sources/prefetch-settings", { qs: qs("bob", USER_PASS) });
    expect(bob.status).toBe(403);

    const anon = await req("GET", "/playback-sources/prefetch-settings", { qs: "u=&t=&s=" });
    expect(anon.status).not.toBe(200);

    const bobPut = await req("PUT", "/playback-sources/prefetch-settings", {
      qs: qs("bob", USER_PASS), body: { lookahead: 5 },
    });
    expect(bobPut.status).toBe(403);
  });
});
