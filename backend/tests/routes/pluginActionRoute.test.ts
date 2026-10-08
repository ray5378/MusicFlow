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

// POST /rest/api/v1/plugins/:id/action(T05 扫码登录门面)端点门禁与归一化测试:
//   ① 未声明 qrLogin capability → 拒;
//   ② 声明了但插件未实现该方法 → 拒;
//   ③ method 白名单外 / 缺失 → 拒;
//   ④ startBind 响应归一化:image 透传 / url·text 生成 imageDataUrl / 超长 url → null 且 value 保留;
//   ⑤ pollBind / cancelBind 透传 result;
//   ⑥ 插件方法抛错 → apiError 透出(UPSTREAM_ERROR),不吞。
const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const PLAIN = "hunter2";
const CLIENT_SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + CLIENT_SALT)}&s=${CLIENT_SALT}`;

const QR_PAYLOAD = {
  kind: "url",
  value: "https://example.com/qr?token=abc",
  ttlSec: 120,
  pollIntervalMs: 1500,
  sessionKey: "sess-1",
};

function qrPlugin(id: string, caps: string[], impl: Record<string, any>) {
  const manifest = {
    id,
    name: id,
    version: "1.0.0",
    type: "source",
    capabilities: caps,
    configSchema: [],
  };
  return { manifest, impl: { manifest, ...impl } };
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
    db.insert(users).values({ id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt", passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1, email: "a@b.c" }).run();
  }
});

beforeEach(() => {
  // 假插件只注册在本进程内存注册表;每次重置,按用例装配。
  for (const id of ["f-qr", "f-noqr", "f-halfqr"]) {
    db.delete(plugins).where(eq(plugins.name, id)).run();
    unregisterPlugin(id);
  }
});

function post(id: string, body: unknown) {
  return app.request(`/rest/api/v1/plugins/${id}/action?${authQS()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/plugins/:id/action · 门禁", () => {
  it("未声明 qrLogin capability → 400 errors.plugin.noQrLogin(即便实现了 startBind)", async () => {
    const p = qrPlugin("f-noqr", ["recommend"], { async startBind() { return QR_PAYLOAD; } });
    registerPlugin(p.manifest as any, p.impl as any);
    db.insert(plugins).values({ name: "f-noqr", enabled: 1, config: "{}" }).run();
    const res = await post("f-noqr", { method: "startBind" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("INVALID_PARAM");
  });

  it("插件 id 不存在 / 未启用 → 400 noQrLogin(不在 qrLogin 可用集)", async () => {
    const p = qrPlugin("f-qr", ["qrLogin"], { async startBind() { return QR_PAYLOAD; } });
    registerPlugin(p.manifest as any, p.impl as any);
    // 故意不插 enabled=1 的行
    const res = await post("f-qr", { method: "startBind" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_PARAM");
  });

  it("声明了 qrLogin 但未实现该方法 → 503 UNAVAILABLE", async () => {
    const p = qrPlugin("f-halfqr", ["qrLogin"], { async pollBind() { return { code: 801 }; } });
    registerPlugin(p.manifest as any, p.impl as any);
    db.insert(plugins).values({ name: "f-halfqr", enabled: 1, config: "{}" }).run();
    const res = await post("f-halfqr", { method: "startBind" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("UNAVAILABLE");
  });

  it("method 白名单外(插件自有方法 runDailyJob)→ 400", async () => {
    const p = qrPlugin("f-qr", ["qrLogin"], { async runDailyJob() { return {}; }, async startBind() { return QR_PAYLOAD; } });
    registerPlugin(p.manifest as any, p.impl as any);
    db.insert(plugins).values({ name: "f-qr", enabled: 1, config: "{}" }).run();
    const res = await post("f-qr", { method: "runDailyJob" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_PARAM");
  });

  it("method 缺失 / 非字符串 → 400", async () => {
    const p = qrPlugin("f-qr", ["qrLogin"], { async startBind() { return QR_PAYLOAD; } });
    registerPlugin(p.manifest as any, p.impl as any);
    db.insert(plugins).values({ name: "f-qr", enabled: 1, config: "{}" }).run();
    for (const body of [{}, { method: 42 }, { method: null }]) {
      const res = await post("f-qr", body);
      expect(res.status).toBe(400);
    }
  });
});

describe("POST /v1/plugins/:id/action · startBind 归一化", () => {
  beforeEach(() => {
    unregisterPlugin("f-qr");
    const p = qrPlugin("f-qr", ["qrLogin"], {
      async startBind(params: any) { return { ...QR_PAYLOAD, params }; },
      async pollBind(params: any) { return { code: 801, params }; },
      async cancelBind(params: any) { return { code: 0, params }; },
    });
    registerPlugin(p.manifest as any, p.impl as any);
    db.delete(plugins).where(eq(plugins.name, "f-qr")).run();
    db.insert(plugins).values({ name: "f-qr", enabled: 1, config: "{}" }).run();
  });

  it("kind=url → imageDataUrl 以 data:image/svg+xml;base64, 开头,payload 键全在响应顶层", async () => {
    const res = await post("f-qr", { method: "startBind", params: {} });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.kind).toBe("url");
    expect(body.value).toBe(QR_PAYLOAD.value);
    expect(body.sessionKey).toBe("sess-1");
    expect(body.pollIntervalMs).toBe(1500);
    expect(body.imageDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("kind=image → imageDataUrl 原样透传,不重绘", async () => {
    unregisterPlugin("f-qr");
    const img = "data:image/png;base64,aGVsbG8=";
    const p = qrPlugin("f-qr", ["qrLogin"], {
      async startBind() { return { kind: "image", value: img, sessionKey: "s2" }; },
    });
    registerPlugin(p.manifest as any, p.impl as any);
    db.insert(plugins).values({ name: "f-qr", enabled: 1, config: "{}" }).run();
    const body = await (await post("f-qr", { method: "startBind" })).json();
    expect(body.imageDataUrl).toBe(img);
  });

  it("超长 url → imageDataUrl=null 且 value 原样保留(前端降级链接)", async () => {
    unregisterPlugin("f-qr");
    const longUrl = "https://example.com/" + "x".repeat(10000);
    const p = qrPlugin("f-qr", ["qrLogin"], {
      async startBind() { return { kind: "url", value: longUrl, sessionKey: "s3" }; },
    });
    registerPlugin(p.manifest as any, p.impl as any);
    db.insert(plugins).values({ name: "f-qr", enabled: 1, config: "{}" }).run();
    const body = await (await post("f-qr", { method: "startBind" })).json();
    expect(body.imageDataUrl).toBeNull();
    expect(body.value).toBe(longUrl);
  });

  it("params 透传插件(默认 {})", async () => {
    const body = await (await post("f-qr", { method: "startBind" })).json();
    expect(body.params).toEqual({});
  });
});

describe("POST /v1/plugins/:id/action · pollBind / cancelBind / 抛错", () => {
  beforeEach(() => {
    unregisterPlugin("f-qr");
    const p = qrPlugin("f-qr", ["qrLogin"], {
      async startBind() { return QR_PAYLOAD; },
      async pollBind(params: any) { return { code: 801, params }; },
      async cancelBind(params: any) { return { code: 0, params }; },
    });
    registerPlugin(p.manifest as any, p.impl as any);
    db.delete(plugins).where(eq(plugins.name, "f-qr")).run();
    db.insert(plugins).values({ name: "f-qr", enabled: 1, config: "{}" }).run();
  });

  it("pollBind / cancelBind:result 原样返回,params 透传", async () => {
    const r1 = await (await post("f-qr", { method: "pollBind", params: { sessionKey: "sess-1" } })).json();
    expect(r1.success).toBe(true);
    expect(r1.result).toEqual({ code: 801, params: { sessionKey: "sess-1" } });
    const r2 = await (await post("f-qr", { method: "cancelBind", params: { sessionKey: "sess-1" } })).json();
    expect(r2.success).toBe(true);
    expect(r2.result).toEqual({ code: 0, params: { sessionKey: "sess-1" } });
  });

  it("插件方法抛错 → 502 UPSTREAM_ERROR,message 透出,不吞", async () => {
    unregisterPlugin("f-qr");
    const p = qrPlugin("f-qr", ["qrLogin"], {
      async startBind() { throw new Error("上游超时"); },
    });
    registerPlugin(p.manifest as any, p.impl as any);
    db.insert(plugins).values({ name: "f-qr", enabled: 1, config: "{}" }).run();
    const res = await post("f-qr", { method: "startBind" });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("UPSTREAM_ERROR");
    expect(body.error).toContain("上游超时");
  });
});
