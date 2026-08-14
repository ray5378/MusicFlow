// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, plugins } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { registerPlugin, unregisterPlugin } from "../../src/plugins/registry.js";

// POST /rest/api/v1/recommend/refresh:按 daily → local → roam 顺序,以
// force + 随机 seedSalt 重新触发生成,并支持 targets 子集。核心按能力门面调用,
// 不写死插件名 —— 这里用三个假插件验证调用契约。
const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const PLAIN = "hunter2";
const CLIENT_SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + CLIENT_SALT)}&s=${CLIENT_SALT}`;

const calls: any[] = [];

function fakePlugin(id: string, cap: string, extra: Record<string, any> = {}) {
  const manifest = {
    id,
    name: id,
    version: "1.0.0",
    type: "recommender",
    capabilities: [cap],
    configSchema: [],
  };
  const impl: any = {
    manifest,
    ...extra,
  };
  return { manifest, impl };
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
    db.insert(users).values({ id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt", passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1, email: "a@b.c" }).run();
  }
});

function enablePlugin(name: string) {
  db.delete(plugins).where(eq(plugins.name, name)).run();
  db.insert(plugins).values({ name, enabled: 1, config: "{}" }).run();
}

beforeEach(() => {
  calls.length = 0;
  // 导入 apiRoutes 会经 services/source/online 顺带注册内置插件(daily-recommend 等),
  // 会抢走能力门面的"第一个插件"位置——先把内置推荐插件反注册 + 删行,只剩假插件。
  for (const id of ["f-daily", "f-local", "f-roam", "daily-recommend", "local-recommend", "daily-roam"]) {
    db.delete(plugins).where(eq(plugins.name, id)).run();
    unregisterPlugin(id);
  }
  const daily = fakePlugin("f-daily", "dailyPlaylist", {
    async generateDailyPlaylist(date: any, opts: any) { calls.push({ who: "daily", opts }); return { ok: true }; },
  });
  const local = fakePlugin("f-local", "localPlaylist", {
    async generateLocalDailyPlaylist(date: any, opts: any) { calls.push({ who: "local", opts }); return { ok: true }; },
  });
  const roam = fakePlugin("f-roam", "comboPlaylist", {
    async generateComboPlaylist(opts: any) { calls.push({ who: "roam", opts }); return { ok: true }; },
  });
  registerPlugin(daily.manifest as any, daily.impl as any);
  registerPlugin(local.manifest as any, local.impl as any);
  registerPlugin(roam.manifest as any, roam.impl as any);
  enablePlugin("f-daily");
  enablePlugin("f-local");
  enablePlugin("f-roam");
});

async function refresh(body?: any) {
  const res = await app.request(`/rest/api/v1/recommend/refresh?${authQS()}`, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { res, body: await res.json().catch(() => null) };
}

describe("POST /rest/api/v1/recommend/refresh", () => {
  it("默认全刷:daily → local → roam 顺序,带 force + seedSalt", async () => {
    const { res, body } = await refresh({});
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(typeof body.seedSalt).toBe("number");
    expect(calls.map(c => c.who)).toEqual(["daily", "local", "roam"]);
    // daily/local 收到 force + seedSalt;roam 收到 force
    expect(calls[0].opts).toMatchObject({ force: true });
    expect(typeof calls[0].opts.seedSalt).toBe("number");
    expect(calls[1].opts).toMatchObject({ force: true });
    expect(calls[2].opts).toEqual({ force: true });
  });

  it("targets 子集只刷指定项,且仍带 force", async () => {
    const { body } = await refresh({ targets: ["local"] });
    expect(body.success).toBe(true);
    expect(calls.map(c => c.who)).toEqual(["local"]);
    expect(calls[0].opts.force).toBe(true);
  });

  it("每日推荐插件未启用时返回 503", async () => {
    db.delete(plugins).where(eq(plugins.name, "f-daily")).run();
    const { res, body } = await refresh({});
    expect(res.status).toBe(503);
    expect(body.error).toContain("每日推荐");
  });
});
