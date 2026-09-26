// 权限管理 API 集成测试:
//   - 管理员 GET/PUT /v1/users/:id/access(目录 + 功能权限 + 播放器授权)
//   - GET /v1/access/renderers 清单形状
//   - 细粒度门禁:普通用户缺权限 403、管理员短路 200、默认放行 200
import "../plugins/_env.js";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { v4 as uuidv4 } from "uuid";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, userPermissions, userRendererGrants, songs } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { generateToken } from "../../src/utils/auth.js";
import { invalidateAccessCaches, PERM } from "../../src/services/access.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

function seedUser(over: Record<string, unknown>) {
  const id = uuidv4();
  db.insert(users)
    .values({
      id,
      username: `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      password: "",
      salt: "salt",
      subsonicSalt: "subsalt",
      passEnc: encryptPassword("pw"),
      isAdmin: 0,
      isActive: 1,
      email: "",
      ...over,
    })
    .run();
  return id;
}

async function authed(uid: string, isAdmin = false) {
  const token = generateToken(uid, "tester", isAdmin);
  return {
    token,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
  };
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});
beforeEach(() => {
  invalidateAccessCaches();
  db.delete(userPermissions).run();
  db.delete(userRendererGrants).run();
  db.delete(songs).run();
  db.delete(users).run();
});

describe("GET /v1/users/:id/access", () => {
  it("管理员可读取普通用户的权限目录与有效值", async () => {
    const admin = seedUser({ isAdmin: 1 });
    const target = seedUser({ isAdmin: 0 });
    const { headers } = await authed(admin, true);
    const res = await app.request(`/rest/api/v1/users/${target}/access`, { headers });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.catalog.length).toBeGreaterThan(10);
    expect(body.permissions[PERM.LIBRARY_BROWSE]).toBe(true);
    expect(body.permissions[PERM.RENDERER_USE]).toBe(false);
    expect(body.rendererGrants).toEqual([]);
  });

  it("普通用户访问管理端点 → 403", async () => {
    const normal = seedUser({ isAdmin: 0 });
    const target = seedUser({ isAdmin: 0 });
    const { headers } = await authed(normal, false);
    const res = await app.request(`/rest/api/v1/users/${target}/access`, { headers });
    expect(res.status).toBe(403);
  });

  it("用户不存在 → 404", async () => {
    const admin = seedUser({ isAdmin: 1 });
    const { headers } = await authed(admin, true);
    const res = await app.request("/rest/api/v1/users/nope/access", { headers });
    expect(res.status).toBe(404);
  });
});

describe("PUT /v1/users/:id/access", () => {
  it("管理员一次性勾选提交:功能权限 + 播放器授权", async () => {
    const admin = seedUser({ isAdmin: 1 });
    const target = seedUser({ isAdmin: 0 });
    const { headers } = await authed(admin, true);

    const res = await app.request(`/rest/api/v1/users/${target}/access`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        permissions: { [PERM.LIBRARY_BROWSE]: false, [PERM.RENDERER_USE]: true },
        renderers: ["dlna:dev-1", "airplay:dev-2"],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.permissions[PERM.LIBRARY_BROWSE]).toBe(false);
    expect(body.permissions[PERM.RENDERER_USE]).toBe(true);
    expect(body.rendererGrants).toEqual(["airplay:dev-2", "dlna:dev-1"]);

    // 再读确认已落库
    const read = await app.request(`/rest/api/v1/users/${target}/access`, { headers });
    const readBody = await read.json();
    expect(readBody.permissions[PERM.LIBRARY_BROWSE]).toBe(false);
    expect(readBody.rendererGrants).toEqual(["airplay:dev-2", "dlna:dev-1"]);
  });

  it("回到默认时删除显式行", async () => {
    const admin = seedUser({ isAdmin: 1 });
    const target = seedUser({ isAdmin: 0 });
    const { headers } = await authed(admin, true);
    await app.request(`/rest/api/v1/users/${target}/access`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ permissions: { [PERM.LIBRARY_BROWSE]: false } }),
    });
    // 重新授权为默认 true → 应删行回退默认
    await app.request(`/rest/api/v1/users/${target}/access`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ permissions: { [PERM.LIBRARY_BROWSE]: true } }),
    });
    const rows = db.select().from(userPermissions).where(eq(userPermissions.userId, target)).all();
    expect(rows.length).toBe(0);
  });
});

describe("GET /v1/access/renderers", () => {
  it("返回清单形状(空库时为 [])", async () => {
    const admin = seedUser({ isAdmin: 1 });
    const { headers } = await authed(admin, true);
    const res = await app.request("/rest/api/v1/access/renderers", { headers });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.renderers)).toBe(true);
  });

  it("普通用户 → 403", async () => {
    const normal = seedUser({ isAdmin: 0 });
    const { headers } = await authed(normal, false);
    const res = await app.request("/rest/api/v1/access/renderers", { headers });
    expect(res.status).toBe(403);
  });
});

describe("功能权限门禁(端点级)", () => {
  it("普通用户默认可浏览曲库(/v1/songs 200)", async () => {
    const u = seedUser({ isAdmin: 0 });
    const { headers } = await authed(u, false);
    const res = await app.request("/rest/api/v1/songs?limit=10", { headers });
    expect(res.status).toBe(200);
  });

  it("撤销 library.browse → /v1/songs 403", async () => {
    const u = seedUser({ isAdmin: 0 });
    invalidateAccessCaches(u);
    // 先经管理端点撤销
    const admin = seedUser({ isAdmin: 1 });
    const adminAuth = await authed(admin, true);
    await app.request(`/rest/api/v1/users/${u}/access`, {
      method: "PUT",
      headers: adminAuth.headers,
      body: JSON.stringify({ permissions: { [PERM.LIBRARY_BROWSE]: false } }),
    });
    const { headers } = await authed(u, false);
    const res = await app.request("/rest/api/v1/songs?limit=10", { headers });
    expect(res.status).toBe(403);
  });

  it("无 renderer.use → /v1/wish 403;管理员短路 → 200", async () => {
    const u = seedUser({ isAdmin: 0 });
    const admin = seedUser({ isAdmin: 1 });
    const uAuth = await authed(u, false);
    const adminAuth = await authed(admin, true);

    // 普通用户:WISH_VIEW 默认 false → 403
    const denied = await app.request("/rest/api/v1/wish", { headers: uAuth.headers });
    expect(denied.status).toBe(403);

    // 管理员短路 → 200
    const ok = await app.request("/rest/api/v1/wish", { headers: adminAuth.headers });
    expect(ok.status).toBe(200);
  });

  it("授权 wish.view 后普通用户可访问 /v1/wish", async () => {
    const u = seedUser({ isAdmin: 0 });
    const admin = seedUser({ isAdmin: 1 });
    const adminAuth = await authed(admin, true);
    await app.request(`/rest/api/v1/users/${u}/access`, {
      method: "PUT",
      headers: adminAuth.headers,
      body: JSON.stringify({ permissions: { [PERM.WISH_VIEW]: true } }),
    });
    const uAuth = await authed(u, false);
    const res = await app.request("/rest/api/v1/wish", { headers: uAuth.headers });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// /v1/peers/:peerId/* 路径隔离(2026-09-26 实测定位的回归锁)
//
// Hono 的 `:peerId/*` 通配会吞掉字面量子路径:最小复现证明
//   POST /v1/peers/register → 中间件命中且 `peerId === "register"`
// ⇒ `canControlPeer(uid, false, "register")` 恒 false ⇒ 普通账号注册自己 403。
// 这是「非管理员在客户端看不到自己本机播放器」的根因(注册失败 ⇒ peer 未建立)。
// 修复 = 中间件显式放行 PEER_PATH_RESERVED 里的字面量段。
// ---------------------------------------------------------------------------
describe("/v1/peers 路径隔离", () => {
  it("普通用户 POST /v1/peers/register → 200(不再被 :peerId 通配当成 peerId 拦下)", async () => {
    const u = seedUser({ isAdmin: 0 });
    const uAuth = await authed(u, false);
    const res = await app.request("/rest/api/v1/peers/register", {
      method: "POST",
      headers: { ...uAuth.headers, "x-mf-client-id": "app-testregister" },
      body: JSON.stringify({ name: "", platform: "windows" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // 注册成功必须回自己那条(self 恒 true),字段与客户端消费口径一致。
    expect(body?.peer?.peerId).toContain(`local:${u}`);
    expect(body?.peer?.self).toBe(true);
  });

  it("register resp 的 peerId 能反查(带实例键),列表里认得出 self", async () => {
    const u = seedUser({ isAdmin: 0 });
    const uAuth = await authed(u, false);
    const headers = { ...uAuth.headers, "x-mf-client-id": "app-testregister2" };
    const reg = await app.request("/rest/api/v1/peers/register", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "", platform: "windows" }),
    });
    const regBody = (await reg.json()) as any;
    const masked = regBody?.peer?.peerId;
    expect(masked).toBeTruthy();

    const list = await app.request("/rest/api/v1/peers", { headers });
    const peers = ((await list.json()) as any)?.peers ?? [];
    // ⚠️ 出口口径(access.ts decoratePeersForClient):self 行的 `peerId` 会被归一化成
    // 账号级 `local:<uid>`(前端靠它判「自己那条」),而**带实例键**的稳定标识放在
    // `instancePeerId`。故不能用 register 回的 masked id 去比 `peerId`。
    const mine = peers.filter(
      (p: any) => p.self === true && p.instancePeerId === masked,
    );
    expect(mine.length).toBe(1);
    // 同一 clientId 视角下,自己那条必是 self —— 「在客户端看到自己」的判定依据。
    expect(mine[0].peerId).toBe(`local:${u}`);
  });

  it("保留段放行不误伤真实 peerId(带 register 前缀的 dlna 设备仍走鉴权)", async () => {
    const outsider = seedUser({ isAdmin: 0 });
    const oAuth = await authed(outsider, false);
    // dlna:register-xxx 不是保留段(精确等值匹配),普通用户无授权 → 仍 403。
    const res = await app.request("/rest/api/v1/peers/dlna:register-abc/heartbeat", {
      method: "POST",
      headers: oAuth.headers,
    });
    expect(res.status).toBe(403);
  });
});
