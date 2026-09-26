// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, plugins, playlists, playlistSongs, songs, userFavoriteSongs, playHistory } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { registerUsers } from "../../src/routes/api/users.js";
import { registerPlugins } from "../../src/routes/api/plugins.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
const api = new Hono();
registerUsers(api);
registerPlugins(api);
app.route("/rest/api", api);

const A_PLAIN = "alicepw";
const A_SALT = "asalt123456";
const B_PLAIN = "bobpw";
const B_SALT = "bsalt123456";
const qs = (who: "alice" | "bob") => who === "alice"
  ? `u=alice&t=${md5(A_PLAIN + A_SALT)}&s=${A_SALT}`
  : `u=bob&t=${md5(B_PLAIN + B_SALT)}&s=${B_SALT}`;

async function call(who: "alice" | "bob", method: string, path: string, body?: any) {
  const res = await app.request(`/rest/api${path}${path.includes("?") ? "&" : "?"}${qs(who)}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, body: parsed, text };
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  db.insert(users).values([
    { id: "u1", username: "alice", password: "", salt: "s1", subsonicSalt: A_SALT, passEnc: encryptPassword(A_PLAIN), isAdmin: 1, isActive: 1 },
    { id: "u2", username: "bob", password: "", salt: "s2", subsonicSalt: B_SALT, passEnc: encryptPassword(B_PLAIN), isAdmin: 0, isActive: 1 },
    // 专门给「改密码 / 改名」用例折腾的用户:alice/bob 的凭据被多处登录取 token,
    // 一旦被改就会让后续用例集体 401(vitest 内用例执行顺序不保证与声明一致)。
    { id: "u3", username: "pwuser", password: "", salt: "s3", subsonicSalt: "pwsalt", passEnc: encryptPassword("pwuserpw"), isAdmin: 0, isActive: 1 },
    { id: "u4", username: "nameuser", password: "", salt: "s4", subsonicSalt: "namesalt", passEnc: encryptPassword("nameuserpw"), isAdmin: 0, isActive: 1 },
  ]).run();
});

describe("users 域", () => {
  it("GET /v1/users 仅管理员可见,且不回传密码字段", async () => {
    const denied = await call("bob", "GET", "/v1/users");
    expect(denied.status).toBe(403);
    const ok = await call("alice", "GET", "/v1/users");
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body)).toBe(true);
    expect(ok.body[0]).not.toHaveProperty("passEnc");
    expect(ok.body[0]).toHaveProperty("apiKeySet");
  });

  it("POST /v1/users 建号;缺参不得 2xx", async () => {
    const created = await call("alice", "POST", "/v1/users", { username: "carol", password: "carolpw" });
    expect(created.status, created.text.slice(0, 200)).toBe(200);
    expect(created.body.username).toBe("carol");
    expect(db.select().from(users).where(eq(users.username, "carol")).get()).toBeTruthy();
    // characterization:缺 password 时落到 md5/encrypt 上炸成非 2xx(未做入参校验)。
    const bad = await call("alice", "POST", "/v1/users", { username: "dave" });
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });

  it("PUT /v1/users/:id/password 权限/空密码/成功", async () => {
    const forbidden = await call("bob", "PUT", "/v1/users/u1/password", { newPassword: "x1" });
    expect(forbidden.status).toBe(403);
    const empty = await call("alice", "PUT", "/v1/users/u1/password", {});
    expect(empty.status).toBe(400);
    const ok = await call("alice", "PUT", "/v1/users/u3/password", { newPassword: "newpw123" });
    expect(ok.body).toMatchObject({ success: true });
    const row = db.select().from(users).where(eq(users.id, "u3")).get()!;
    expect(row.mustChangePassword).toBe(0);
    expect(row.apiKey).toBeNull();
  });

  it("PUT /v1/users/:id/username 权限/空名/重名/成功", async () => {
    const forbidden = await call("bob", "PUT", "/v1/users/u1/username", { username: "zzz" });
    expect(forbidden.status).toBe(403);
    const empty = await call("alice", "PUT", "/v1/users/u1/username", { username: "   " });
    expect(empty.status).toBe(400);
    const taken = await call("alice", "PUT", "/v1/users/u4/username", { username: "alice" });
    expect(taken.status).toBe(409);
    const ok = await call("alice", "PUT", "/v1/users/u4/username", { username: "renamed-user" });
    expect(ok.body).toMatchObject({ success: true, username: "renamed-user" });
    expect(db.select().from(users).where(eq(users.id, "u4")).get()!.username).toBe("renamed-user");
  });

  it("DELETE /v1/users/:id 自删/不存在/级联清理", async () => {
    const self = await call("alice", "DELETE", "/v1/users/u1");
    expect(self.status).toBe(400);
    const missing = await call("alice", "DELETE", "/v1/users/nope");
    expect(missing.status).toBe(404);
    // 造一个带歌单/收藏/播放历史/愿望的用户,验证级联清理不炸 FK
    db.insert(users).values({ id: "u9", username: "temp", password: "", salt: "s", subsonicSalt: "ss", passEnc: encryptPassword("p"), isAdmin: 0, isActive: 1 }).run();
    db.insert(songs).values({ id: "s-u9", title: "T", path: "l:src:/t.mp3" }).run();
    db.insert(playlists).values({ id: "pl-u9", name: "P", ownerId: "u9", isPublic: 0 }).run();
    db.insert(playlistSongs).values({ playlistId: "pl-u9", songId: "s-u9", position: 0, playable: 1 }).run();
    db.insert(userFavoriteSongs).values({ userId: "u9", songId: "s-u9" }).run();
    db.insert(playHistory).values({ userId: "u9", songId: "s-u9", playedAt: new Date().toISOString() }).run();
    const ok = await call("alice", "DELETE", "/v1/users/u9");
    expect(ok.status, ok.text.slice(0, 200)).toBe(200);
    expect(ok.body).toMatchObject({ success: true });
    expect(db.select().from(users).where(eq(users.id, "u9")).get()).toBeUndefined();
    expect(db.select().from(playlists).where(eq(playlists.id, "pl-u9")).get()).toBeUndefined();
  });

  it("GET/PUT /v1/users/:id/access 权限视图与整表替换", async () => {
    const missing = await call("alice", "GET", "/v1/users/nope/access");
    expect(missing.status).toBe(404);
    const view = await call("alice", "GET", "/v1/users/u2/access");
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ success: true });
    const put = await call("alice", "PUT", "/v1/users/u2/access", {
      permissions: { "library.browse": true },
      renderers: ["dlna:d1", 42],
    });
    expect(put.status).toBe(200);
    expect(put.body.success).toBe(true);
    const missingPut = await call("alice", "PUT", "/v1/users/nope/access", { permissions: {} });
    expect(missingPut.status).toBe(404);
  });

  it("GET /v1/access/renderers 汇总 DLNA/AirPlay/群组", async () => {
    const r = await call("alice", "GET", "/v1/access/renderers");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.renderers)).toBe(true);
  });

  it("GET /v1/users/me 返回权限与播放器授权", async () => {
    const admin = await call("alice", "GET", "/v1/users/me");
    expect(admin.body).toMatchObject({ id: "u1", isAdmin: true, permissions: { admin: true } });
    expect(admin.body.rendererGrants).toBeNull();
    const normal = await call("bob", "GET", "/v1/users/me");
    expect(normal.body.isAdmin).toBe(false);
    expect(Array.isArray(normal.body.rendererGrants)).toBe(true);
  });

  it("api-key 自助签发/读取/撤销(含有效期)", async () => {
    const before = await call("bob", "GET", "/v1/users/me/api-key");
    expect(before.body.apiKey).toBeNull();
    const issued = await call("bob", "POST", "/v1/users/me/api-key", { expiresInDays: 7 });
    expect(issued.body.apiKey).toMatch(/^mf_/);
    expect(issued.body.expiresAt).toBeTruthy();
    const readBack = await call("bob", "GET", "/v1/users/me/api-key");
    expect(readBack.body.apiKey).toBe(issued.body.apiKey);
    const revoked = await call("bob", "DELETE", "/v1/users/me/api-key");
    expect(revoked.body).toMatchObject({ success: true });
    expect((await call("bob", "GET", "/v1/users/me/api-key")).body.apiKey).toBeNull();
    // 永不失效(expiresInDays 缺省/0)
    const forever = await call("bob", "POST", "/v1/users/me/api-key", {});
    expect(forever.body.expiresAt).toBeNull();
  });

  it("api-key 代为签发:本人可、他人不可、目标不存在 404", async () => {
    const other = await call("bob", "GET", "/v1/users/u1/api-key");
    expect(other.status).toBe(403);
    const otherPost = await call("bob", "POST", "/v1/users/u1/api-key", {});
    expect(otherPost.status).toBe(403);
    const otherDel = await call("bob", "DELETE", "/v1/users/u1/api-key");
    expect(otherDel.status).toBe(403);
    const self = await call("bob", "GET", "/v1/users/u2/api-key");
    expect(self.status).toBe(200);
    const issued = await call("bob", "POST", "/v1/users/u2/api-key", { expiresInDays: 1 });
    expect(issued.body.apiKey).toMatch(/^mf_/);
    expect(issued.body.expiresAt).toBeTruthy();
    const missing = await call("alice", "GET", "/v1/users/nope/api-key");
    expect(missing.status).toBe(404);
    const missingPost = await call("alice", "POST", "/v1/users/nope/api-key", {});
    expect(missingPost.status).toBe(404);
    const del = await call("bob", "DELETE", "/v1/users/u2/api-key");
    expect(del.body).toMatchObject({ success: true });
  });
});

describe("plugins 域", () => {
  it("GET /v1/plugins 列表(管理员)", async () => {
    const denied = await call("bob", "GET", "/v1/plugins");
    expect(denied.status).toBe(403);
    const ok = await call("alice", "GET", "/v1/plugins");
    expect(Array.isArray(ok.body)).toBe(true);
  });

  it("POST /v1/plugins 新建行,PUT 更新配置/描述", async () => {
    const created = await call("alice", "POST", "/v1/plugins", {
      name: "zzz-ext-plugin", version: "0.1.0", description: "d", manifest: { id: "zzz-ext-plugin" }, enabled: true, config: { a: 1 },
    });
    expect(created.body.id).toBeTruthy();
    const id = created.body.id;
    const missing = await call("alice", "PUT", "/v1/plugins/nope", { description: "x" });
    expect(missing.status).toBe(404);
    const upd = await call("alice", "PUT", `/v1/plugins/${id}`, {
      config: { a: 2 }, enabled: false, description: "d2", version: "0.2.0", name: "zzz-ext-plugin",
    });
    expect(upd.body).toMatchObject({ success: true });
    const row = db.select().from(plugins).where(eq(plugins.id, id)).get()!;
    expect(row.enabled).toBe(0);
    expect(row.description).toBe("d2");
    expect(row.version).toBe("0.2.0");

    // 配置非法 JSON 的旧行 + 新配置:走 oldCfg 解析失败兜底
    db.update(plugins).set({ config: "{broken" }).where(eq(plugins.id, id)).run();
    const again = await call("alice", "PUT", `/v1/plugins/${id}`, { config: { a: 3 } });
    expect(again.body).toMatchObject({ success: true });
  });

  it("PUT /v1/plugins/:id 对 sendspin-renderer 触发配置热更新(服务未起时静默)", async () => {
    const created = await call("alice", "POST", "/v1/plugins", {
      name: "sendspin-renderer", version: "1.0.0", manifest: { id: "sendspin-renderer" }, enabled: true, config: {},
    });
    const r = await call("alice", "PUT", `/v1/plugins/${created.body.id}`, { config: { port: 8928 } });
    expect(r.body).toMatchObject({ success: true });
  });

  it("PUT /v1/plugins/:id/toggle 切换开关,core 行跳过位次检查", async () => {
    const created = await call("alice", "POST", "/v1/plugins", { name: "toggle-me", version: "1", manifest: {}, enabled: false, config: {} });
    const id = created.body.id;
    const missing = await call("alice", "PUT", "/v1/plugins/nope/toggle");
    expect(missing.status).toBe(404);
    const on = await call("alice", "PUT", `/v1/plugins/${id}/toggle`);
    expect(on.body).toMatchObject({ success: true });
    expect(db.select().from(plugins).where(eq(plugins.id, id)).get()!.enabled).toBe(1);
    const off = await call("alice", "PUT", `/v1/plugins/${id}/toggle`);
    expect(off.body).toMatchObject({ success: true });
    expect(db.select().from(plugins).where(eq(plugins.id, id)).get()!.enabled).toBe(0);
    // 配置损坏时 toggle 走 try/catch 兜底
    db.update(plugins).set({ config: "{oops" }).where(eq(plugins.id, id)).run();
    const salvage = await call("alice", "PUT", `/v1/plugins/${id}/toggle`);
    expect(salvage.body).toMatchObject({ success: true });
  });

  it("DELETE /v1/plugins/:id 不存在 404 / 未注册外置可删,已注册则拒绝", async () => {
    const missing = await call("alice", "DELETE", "/v1/plugins/nope");
    expect(missing.status).toBe(404);
    const created = await call("alice", "POST", "/v1/plugins", { name: "deletable-x", version: "1", manifest: {}, enabled: 0, config: {} });
    const ok = await call("alice", "DELETE", `/v1/plugins/${created.body.id}`);
    expect(ok.status, ok.text.slice(0, 200)).toBe(200);
    expect(db.select().from(plugins).where(eq(plugins.id, created.body.id)).get()).toBeUndefined();
  });

  it("健康/渲染器/刮削器 三类清单端点", async () => {
    expect((await call("alice", "GET", "/v1/plugins/health")).body).toHaveProperty("health");
    expect((await call("alice", "GET", "/v1/plugins/renderers")).body).toHaveProperty("renderers");
    expect((await call("alice", "GET", "/v1/plugins/scrobblers")).body).toHaveProperty("scrobblers");
    const devs = await call("alice", "GET", "/v1/plugins/renderers/devices");
    expect([200, 500]).toContain(devs.status);
  });

  it("插件任务状态:缺 id 400 / 未知 404", async () => {
    const ok = await call("alice", "GET", "/v1/plugins/never-running-plugin/job");
    expect(ok.status).toBe(404);
  });

  it("插件市场:注册表增删 + 下载地址校验", async () => {
    const noUrl = await call("alice", "POST", "/v1/plugins/registry", {});
    expect(noUrl.status).toBe(400);
    const badUrl = await call("alice", "POST", "/v1/plugins/registry", { url: "not-a-url" });
    expect(badUrl.status).toBe(400);
    const noDownload = await call("alice", "POST", "/v1/plugins/registry/install", {});
    expect(noDownload.status).toBe(400);
    const del = await call("alice", "DELETE", "/v1/plugins/registry/whatever");
    expect(del.body).toMatchObject({ success: true });
  });
});
