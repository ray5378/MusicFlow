// 细粒度权限服务测试:双层模型(功能权限 + 播放器授权)、管理员短路、缓存失效、
// permMiddleware / rendererGrantParamMiddleware 行为。通过公开 API(中间件 + 写侧函数)
// 验证,不触碰私有实现。
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import md5 from "md5";
import { db } from "../../src/db/index.js";
import { users, userPermissions, userRendererGrants } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import {
  PERM,
  PERMISSION_CATALOG,
  hasPerm,
  canUseRenderer,
  canControlPeer,
  peerToDeviceKey,
  filterPeersByAccess,
  getUserPermissions,
  getUserRendererGrants,
  setUserPermission,
  replaceUserPermissions,
  grantRenderer,
  revokeRenderer,
  replaceRendererGrants,
  effectiveAccessView,
  getPermissionDefaults,
  invalidateAccessCaches,
  permMiddleware,
  rendererGrantParamMiddleware,
} from "../../src/services/access.js";
import { authMiddleware } from "../../src/middleware/auth.js";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
});
beforeEach(() => {
  invalidateAccessCaches();
  db.delete(userPermissions).run();
  db.delete(userRendererGrants).run();
  db.delete(users).run();
});

/** 建一个普通用户并返回 id(user_permissions / user_renderer_grants 有 FK)。 */
function mkUser(isAdmin = 0): string {
  const id = uuidv4();
  db.insert(users)
    .values({
      id,
      username: `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      password: md5("x"),
      salt: "s",
      subsonicSalt: "ss",
      isAdmin,
      isActive: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
  return id;
}

function makeApp(route: (c: any) => any, key: string) {
  const app = new Hono();
  app.use("*", authMiddleware);
  app.get("/test", permMiddleware(key), route);
  return app;
}

/** 注入一个已认证的普通用户上下文(直接走 permMiddleware 的判定路径)。 */
function authedApp(key: string, userId: string, isAdmin = false) {
  const app = new Hono();
  app.use("*", (c, next) => {
    c.set("user", { id: userId, username: "u", isAdmin });
    return next();
  });
  app.get("/test", permMiddleware(key), (c) => c.json({ ok: true }));
  return app;
}

describe("默认权限(无显式行 → PERMISSION_CATALOG.defaultGranted)", () => {
  it("库功能默认放行,播放器/管理类默认收紧", () => {
    const d = getPermissionDefaults();
    expect(d[PERM.LIBRARY_BROWSE]).toBe(true);
    expect(d[PERM.LIBRARY_SEARCH]).toBe(true);
    expect(d[PERM.LIBRARY_STREAM]).toBe(true);
    expect(d[PERM.PLAYLIST_VIEW]).toBe(true);
    expect(d[PERM.RENDERER_USE]).toBe(false);
    expect(d[PERM.RENDERER_MANAGE]).toBe(false);
    expect(d[PERM.SETTINGS_MANAGE]).toBe(false);
    expect(d[PERM.USER_MANAGE]).toBe(false);
    expect(d[PERM.FLOW_MANAGE]).toBe(false);
    expect(d[PERM.WISH_VIEW]).toBe(false);
  });

  it("目录完整且 key 唯一、分类覆盖", () => {
    const keys = new Set(PERMISSION_CATALOG.map((p) => p.key));
    expect(keys.size).toBe(PERMISSION_CATALOG.length);
    for (const k of Object.values(PERM)) expect(keys.has(k)).toBe(true);
  });

  it("hasPerm: 无显式行 → 默认值", () => {
    expect(hasPerm("u1", false, PERM.LIBRARY_BROWSE)).toBe(true);
    expect(hasPerm("u1", false, PERM.RENDERER_USE)).toBe(false);
    expect(hasPerm("u1", false, PERM.SETTINGS_MANAGE)).toBe(false);
  });
});

describe("管理员短路", () => {
  it("hasPerm / canUseRenderer 恒通过", () => {
    expect(hasPerm("admin", true, PERM.SETTINGS_MANAGE)).toBe(true);
    expect(hasPerm("admin", true, PERM.RENDERER_USE)).toBe(true);
    expect(canUseRenderer("admin", true, "dlna:whatever")).toBe(true);
    expect(canControlPeer("admin", true, "group:g1")).toBe(true);
  });

  it("middleware: 管理员无权限也放行", async () => {
    const app = authedApp(PERM.SETTINGS_MANAGE, "admin", true);
    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });
});

describe("功能权限写侧", () => {
  it("setUserPermission 显式覆盖并缓存失效", () => {
    const uid = mkUser();
    setUserPermission(uid, PERM.LIBRARY_BROWSE, false);
    expect(hasPerm(uid, false, PERM.LIBRARY_BROWSE)).toBe(false);
    // 回到默认 → 删除显式行,回退默认
    setUserPermission(uid, PERM.LIBRARY_BROWSE, true);
    expect(hasPerm(uid, false, PERM.LIBRARY_BROWSE)).toBe(true);
    const rows = db.select().from(userPermissions).where(eq(userPermissions.userId, uid)).all();
    expect(rows.length).toBe(0);
  });

  it("replaceUserPermissions 整表替换", () => {
    const uid = mkUser();
    replaceUserPermissions(uid, { [PERM.LIBRARY_BROWSE]: false, [PERM.LIBRARY_STREAM]: false });
    const p = getUserPermissions(uid);
    expect(p[PERM.LIBRARY_BROWSE]).toBe(false);
    expect(p[PERM.LIBRARY_STREAM]).toBe(false);
    expect(p[PERM.PLAYLIST_VIEW]).toBe(true); // 未涉及 → 默认
  });

  it("无效 key 被忽略", () => {
    const uid = mkUser();
    replaceUserPermissions(uid, { "not.a.real.perm": false });
    const rows = db.select().from(userPermissions).where(eq(userPermissions.userId, uid)).all();
    expect(rows.length).toBe(0);
  });
});

describe("播放器授权(双层门禁)", () => {
  it("无 renderer.use + 无授权 → 不可用", () => {
    expect(canUseRenderer(mkUser(), false, "dlna:d1")).toBe(false);
  });

  it("有 renderer.use + 有设备授权 → 可用", () => {
    const uid = mkUser();
    setUserPermission(uid, PERM.RENDERER_USE, true);
    grantRenderer(uid, "dlna:d1");
    expect(canUseRenderer(uid, false, "dlna:d1")).toBe(true);
    expect(canUseRenderer(uid, false, "dlna:d2")).toBe(false);
    expect(canUseRenderer(uid, false, "airplay:a1")).toBe(false);
  });

  it("有设备授权但无 renderer.use → 仍不可用", () => {
    const uid = mkUser();
    grantRenderer(uid, "dlna:d1");
    expect(canUseRenderer(uid, false, "dlna:d1")).toBe(false);
  });

  it("revokeRenderer / replaceRendererGrants", () => {
    const uid = mkUser();
    setUserPermission(uid, PERM.RENDERER_USE, true);
    grantRenderer(uid, "dlna:d1");
    grantRenderer(uid, "airplay:a1");
    revokeRenderer(uid, "dlna:d1");
    expect(canUseRenderer(uid, false, "dlna:d1")).toBe(false);
    expect(canUseRenderer(uid, false, "airplay:a1")).toBe(true);

    replaceRendererGrants(uid, ["dlna:d9"]);
    const grants = getUserRendererGrants(uid);
    expect(grants.has("dlna:d9")).toBe(true);
    expect(grants.has("airplay:a1")).toBe(false);
  });

  it("grantRenderer 幂等(冲突忽略)", () => {
    const uid = mkUser();
    setUserPermission(uid, PERM.RENDERER_USE, true);
    grantRenderer(uid, "dlna:d1");
    grantRenderer(uid, "dlna:d1");
    const grants = getUserRendererGrants(uid);
    expect(grants.has("dlna:d1")).toBe(true);
  });
});

describe("peer 判定", () => {
  it("peerToDeviceKey 只认 dlna/airplay/group", () => {
    expect(peerToDeviceKey("dlna:d1")).toBe("dlna:d1");
    expect(peerToDeviceKey("airplay:a1")).toBe("airplay:a1");
    expect(peerToDeviceKey("group:g1")).toBe("group:g1");
    expect(peerToDeviceKey("local:u1")).toBe(null);
    expect(peerToDeviceKey("bogus:x")).toBe(null);
    expect(peerToDeviceKey("no-colon")).toBe(null);
  });

  it("本机播放器 local:<userId> 恒可用", () => {
    const uid = mkUser();
    expect(canControlPeer(uid, false, `local:${uid}`)).toBe(true);
    expect(canControlPeer(uid, false, "local:other")).toBe(false);
  });

  it("filterPeersByAccess 按授权过滤(管理员全量)", () => {
    const uid = mkUser();
    setUserPermission(uid, PERM.RENDERER_USE, true);
    grantRenderer(uid, "dlna:d1");
    const peers = [
      { peerId: `local:${uid}` },
      { peerId: "local:other" },
      { peerId: "dlna:d1" },
      { peerId: "dlna:d2" },
    ];
    const visible = filterPeersByAccess(uid, false, peers as any);
    expect(visible.map((p) => p.peerId).sort()).toEqual(["dlna:d1", `local:${uid}`]);
    expect(filterPeersByAccess(uid, true, peers as any).length).toBe(4);
  });
});

describe("permMiddleware", () => {
  it("未认证 → 401", async () => {
    const app = new Hono();
    app.get("/test", permMiddleware(PERM.LIBRARY_BROWSE), (c) => c.json({ ok: true }));
    const res = await app.request("/test");
    expect(res.status).toBe(401);
  });

  it("无权限 → 403", async () => {
    const app = authedApp(PERM.SETTINGS_MANAGE, "u1", false);
    const res = await app.request("/test");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe("string");
  });

  it("有权限 → 200", async () => {
    const uid = mkUser();
    const app = authedApp(PERM.SETTINGS_MANAGE, uid, false);
    setUserPermission(uid, PERM.SETTINGS_MANAGE, true);
    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });

  it("管理员短路 → 200", async () => {
    const app = authedApp(PERM.SETTINGS_MANAGE, "admin", true);
    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });
});

describe("rendererGrantParamMiddleware", () => {
  function rendererApp(kind: "dlna" | "airplay", userId: string, isAdmin = false) {
    const app = new Hono();
    app.use("*", (c, next) => {
      c.set("user", { id: userId, username: "u", isAdmin });
      return next();
    });
    app.get("/device/:deviceId/pause", rendererGrantParamMiddleware(kind), (c) => c.json({ ok: true }));
    return app;
  }

  it("未授权设备 → 403", async () => {
    const app = rendererApp("dlna", mkUser());
    const res = await app.request("/device/d1/pause");
    expect(res.status).toBe(403);
  });

  it("授权设备 + renderer.use → 200", async () => {
    const uid = mkUser();
    setUserPermission(uid, PERM.RENDERER_USE, true);
    grantRenderer(uid, "dlna:d1");
    const app = rendererApp("dlna", uid);
    const res = await app.request("/device/d1/pause");
    expect(res.status).toBe(200);
  });

  it("管理员任意设备 → 200", async () => {
    const app = rendererApp("airplay", "admin", true);
    const res = await app.request("/device/anything/pause");
    expect(res.status).toBe(200);
  });

  it("未认证 → 401", async () => {
    const app = new Hono();
    app.get("/device/:deviceId/pause", rendererGrantParamMiddleware("dlna"), (c) => c.json({ ok: true }));
    const res = await app.request("/device/d1/pause");
    expect(res.status).toBe(401);
  });
});

describe("effectiveAccessView", () => {
  it("普通用户:目录 + 有效权限 + 授权设备", () => {
    const uid = mkUser();
    setUserPermission(uid, PERM.LIBRARY_BROWSE, false);
    setUserPermission(uid, PERM.RENDERER_USE, true);
    grantRenderer(uid, "dlna:d1");
    const view = effectiveAccessView(uid, false);
    expect(view.catalog.length).toBe(PERMISSION_CATALOG.length);
    expect(view.permissions[PERM.LIBRARY_BROWSE]).toBe(false);
    expect(view.permissions[PERM.RENDERER_USE]).toBe(true);
    expect(view.rendererGrants).toEqual(["dlna:d1"]);
  });

  it("管理员:权限快照默认值,授权设备为空", () => {
    const view = effectiveAccessView("admin", true);
    expect(view.permissions[PERM.SETTINGS_MANAGE]).toBe(false);
    expect(view.rendererGrants).toEqual([]);
  });
});
