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
import { registerPlugin, unregisterPlugin, getPlugin } from "../../src/plugins/registry.js";
import { _setPluginJobExecForTest } from "../../src/services/plugin/jobRunner.js";

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
  // 注入进程内直调的插件任务执行器:默认 jobRunner 会 fork 一次性批量子进程执行,
  // 但测试的假插件只注册在本进程内存注册表,子进程看不到;测试环境改用进程内直调。
  _setPluginJobExecForTest(async (pluginId, method, opts) => {
    const reg = getPlugin(pluginId);
    return reg?.impl?.[method]?.(opts);
  });
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
  const lb = fakePlugin("f-lb", "recommendPlaylist", {
    async runDailyJob(opts: any) { calls.push({ who: "f-lb", opts }); return "f-lb ok"; },
  });
  registerPlugin(daily.manifest as any, daily.impl as any);
  registerPlugin(local.manifest as any, local.impl as any);
  registerPlugin(roam.manifest as any, roam.impl as any);
  registerPlugin(lb.manifest as any, lb.impl as any);
  enablePlugin("f-daily");
  enablePlugin("f-local");
  enablePlugin("f-roam");
  // 注意:f-lb(recommendPlaylist)故意「不」在此处启用——插件Id 刷新用例需要时再按需启用,
  // 且不参与 dailyApi() 等能力门面的首插件位置。
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

  it("pluginId:异步启动后台任务(202+started),任务实际执行 runDailyJob(force)", async () => {
    enablePlugin("f-lb"); // 仅在按需启用,测完还原,避免污染 dailyApi()
    try {
      const { res, body } = await refresh({ pluginId: "f-lb" });
      // 异步任务通道:立即返回,不阻塞 HTTP
      expect(res.status).toBe(202);
      expect(body.success).toBe(true);
      expect(body.pluginId).toBe("f-lb");
      expect(body.started).toBe(true);
      // 任务在后台跑(jobRunner fire-and-forget):稍等一拍确认 runDailyJob 被调用
      await new Promise((r) => setTimeout(r, 50));
      expect(calls.map(c => c.who)).toEqual(["f-lb"]);
      expect(calls[0].opts).toEqual({ force: true });
    } finally {
      db.delete(plugins).where(eq(plugins.name, "f-lb")).run();
    }
  });

  it("pluginId 不存在 → 404", async () => {
    const { res, body } = await refresh({ pluginId: "nope" });
    expect(res.status).toBe(404);
    expect(calls.length).toBe(0);
  });

  it("GET /v1/plugins/:id/job 返回最近一次后台任务状态(含摘要)", async () => {
    enablePlugin("f-lb");
    try {
      await refresh({ pluginId: "f-lb" });
      await new Promise((r) => setTimeout(r, 50)); // 等后台任务收尾
      const res = await app.request(`/rest/api/v1/plugins/f-lb/job?${authQS()}`, { method: "GET" });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.pluginId).toBe("f-lb");
      expect(body.running).toBe(false);
      expect(body.job.status).toBe("ok");
      expect(body.job.summary).toBe("f-lb ok");
    } finally {
      db.delete(plugins).where(eq(plugins.name, "f-lb")).run();
    }
  });

  it("pluginId 无每日能力 → 400", async () => {
    const p = fakePlugin("f-other", "scrobbler", {});
    registerPlugin(p.manifest as any, p.impl as any);
    enablePlugin("f-other");
    const { res, body } = await refresh({ pluginId: "f-other" });
    expect(res.status).toBe(400);
    expect(body.error).toContain("手动刷新");
    db.delete(plugins).where(eq(plugins.name, "f-other")).run();
    unregisterPlugin("f-other");
  });

  it("pluginId 未启用 → 503", async () => {
    db.delete(plugins).where(eq(plugins.name, "f-lb")).run(); // 移除启用行
    const { res, body } = await refresh({ pluginId: "f-lb" });
    expect(res.status).toBe(503);
    enablePlugin("f-lb"); // 还原,供后续测试
  });
});
