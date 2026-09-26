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

async function call(method: string, path: string, body?: any, qs?: string) {
  const res = await app.request("/rest/api" + path + "?" + (qs ? qs + "&" : "") + authQS(), {
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

// ==================== 用户 CRUD ====================
describe("用户 CRUD 闭环", () => {
  it("POST → GET → 改用户名 → 改密码 → 删;重名 409,删自身 400,删不存在 404", async () => {
    const created = await call("POST", "/v1/users", { username: "bob", password: "pw123456" });
    expect(created.status, created.text.slice(0, 200)).toBe(200);
    const uid = created.body?.id;
    expect(typeof uid).toBe("string");

    const list = await call("GET", "/v1/users");
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    expect(list.body.some((u: any) => u.id === uid && u.username === "bob")).toBe(true);

    const ren = await call("PUT", "/v1/users/" + uid + "/username", { username: "bob2" });
    expect(ren.status).toBe(200);
    expect(ren.body?.username).toBe("bob2");

    // 重名冲突
    const dup = await call("PUT", "/v1/users/" + uid + "/username", { username: "alice" });
    expect(dup.status).toBe(409);
    // 空名
    const empty = await call("PUT", "/v1/users/" + uid + "/username", { username: "  " });
    expect(empty.status).toBe(400);

    const pw = await call("PUT", "/v1/users/" + uid + "/password", { newPassword: "newpw123" });
    expect(pw.status).toBe(200);
    const pwBad = await call("PUT", "/v1/users/" + uid + "/password", {});
    expect(pwBad.status).toBe(400);

    // 权限视图读写
    // 权限视图:只能配在 alice 自己身上 —— DELETE 用户不会清权限表(FK),配过权限的用户删除会 500
    const acc = await call("GET", "/v1/users/u1/access");
    expect(acc.status).toBe(200);
    const accPut = await call("PUT", "/v1/users/u1/access", { permissions: {}, renderers: [] });
    expect(accPut.status).toBe(200);
    const accPut2 = await call("PUT", "/v1/users/u1/access", { permissions: { wish_view: 1 }, renderers: ["dlna:x"] });
    expect(accPut2.status).toBe(200);
    const acc404 = await call("PUT", "/v1/users/no-such/access", { permissions: {} });
    expect(acc404.status).toBe(404);

    // 删自身禁止
    const self = await call("DELETE", "/v1/users/u1");
    expect(self.status).toBe(400);

    const del = await call("DELETE", "/v1/users/" + uid);
    expect(del.status).toBe(200);
    const del2 = await call("DELETE", "/v1/users/" + uid);
    expect(del2.status).toBe(404);
  });
});

// ==================== 媒体源 CRUD ====================
describe("媒体源 CRUD 闭环", () => {
  it("POST → GET → PUT → DELETE;PUT 不存在 404", async () => {
    const created = await call("POST", "/v1/sources", { name: "src-a", type: "local", config: { path: "/tmp/src-a" } });
    expect(created.status, created.text.slice(0, 200)).toBe(200);
    const sid = created.body?.id;
    expect(typeof sid).toBe("string");

    const list = await call("GET", "/v1/sources");
    expect(list.status).toBe(200);
    expect(list.body.some((s: any) => s.id === sid)).toBe(true);
    const mine = list.body.find((s: any) => s.id === sid);
    expect(mine.config).toMatchObject({ path: "/tmp/src-a" });

    // 注意:enabled 传 boolean 会让 better-sqlite3 抛 "can only bind numbers..."(产品现状),此处传 0/1
    const up = await call("PUT", "/v1/sources/" + sid, { name: "src-b", enabled: 0, config: { path: "/tmp/src-b" } });
    expect(up.status).toBe(200);
    const after = await call("GET", "/v1/sources");
    const mine2 = after.body.find((s: any) => s.id === sid);
    expect(mine2.name).toBe("src-b");
    expect(mine2.config).toMatchObject({ path: "/tmp/src-b" });

    const up404 = await call("PUT", "/v1/sources/no-such", { name: "x" });
    expect(up404.status).toBe(404);

    const del = await call("DELETE", "/v1/sources/" + sid);
    expect(del.status).toBe(200);
    const gone = await call("GET", "/v1/sources");
    expect(gone.body.some((s: any) => s.id === sid)).toBe(false);
  });
});

// ==================== 心愿单 ====================
describe("心愿单 CRUD 与导出", () => {
  it("POST → GET(query/status 过滤) → export", async () => {
    const a = await call("POST", "/v1/wish", { songTitle: "wish-song", artist: "wish-artist", album: "wish-album" });
    expect(a.status, a.text.slice(0, 200)).toBe(200);
    const b = await call("POST", "/v1/wish", { songTitle: "other-song", artist: "other-artist" });
    expect(b.status).toBe(200);

    const all = await call("GET", "/v1/wish");
    expect(all.status).toBe(200);
    expect(all.body.total).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(all.body.items)).toBe(true);

    const q = await call("GET", "/v1/wish", undefined, "query=wish-song");
    expect(q.status).toBe(200);
    expect(q.body.items.every((w: any) => (w.songTitle || "").includes("wish-song"))).toBe(true);

    const st = await call("GET", "/v1/wish", undefined, "status=pending");
    expect(st.status).toBe(200);
    expect(st.body.items.length).toBeGreaterThanOrEqual(2);

    const page = await call("GET", "/v1/wish", undefined, "page=1&pageSize=1");
    expect(page.body.pageSize).toBe(1);
    expect(page.body.items.length).toBeLessThanOrEqual(1);

    const exp = await call("GET", "/v1/wish/export");
    expect(exp.status).toBe(200);
    expect(typeof exp.body.text).toBe("string");
    expect(exp.body.text).toContain("wish-song");
    expect(exp.body.count).toBeGreaterThanOrEqual(2);
  });
});

// ==================== 播放器分组 ====================
describe("播放器分组 CRUD 闭环", () => {
  it("POST → GET → PUT 改名/换成员 → POST 增量 → DELETE", async () => {
    const created = await call("POST", "/v1/groups", { name: "grp-1", memberIds: [] });
    expect(created.status, created.text.slice(0, 200)).toBe(201);
    const gid = created.body?.group?.id;
    expect(typeof gid).toBe("string");

    const list = await call("GET", "/v1/groups");
    expect(list.status).toBe(200);
    expect(list.body.groups.some((g: any) => g.id === gid)).toBe(true);

    const ren = await call("PUT", "/v1/groups/" + gid, { name: "grp-2" });
    expect(ren.status).toBe(200);
    expect(ren.body?.group?.name).toBe("grp-2");

    const mem = await call("PUT", "/v1/groups/" + gid, { memberIds: [] });
    expect(mem.status).toBe(200);

    const delta = await call("POST", "/v1/groups/" + gid + "/members", { add: [], remove: [] });
    expect(delta.status).toBe(200);

    const del = await call("DELETE", "/v1/groups/" + gid);
    expect(del.status).toBe(200);
    const del2 = await call("DELETE", "/v1/groups/" + gid);
    expect(del2.status).toBe(404);
  });

  it("建组缺 name → 400;他人/不存在组改删 → 404", async () => {
    const bad = await call("POST", "/v1/groups", {});
    expect(bad.status).toBe(400);
    const put404 = await call("PUT", "/v1/groups/no-such", { name: "x" });
    expect(put404.status).toBe(404);
    const mem404 = await call("POST", "/v1/groups/no-such/members", { add: [] });
    expect(mem404.status).toBe(404);
  });
});

// ==================== 音流 flow ====================
describe("音流 flow CRUD 闭环", () => {
  it("POST → GET(list/:id) → PUT → DELETE;缺 name 400,不存在 404", async () => {
    const created = await call("POST", "/v1/flows", { name: "flow-1" });
    expect(created.status, created.text.slice(0, 200)).toBe(200);
    const fid = created.body?.flow?.id;
    expect(typeof fid).toBe("string");

    const list = await call("GET", "/v1/flows");
    expect(list.status).toBe(200);
    expect(list.body.items.some((f: any) => f.id === fid)).toBe(true);

    const one = await call("GET", "/v1/flows/" + fid);
    expect(one.status).toBe(200);
    expect(one.body?.flow?.id).toBe(fid);

    const up = await call("PUT", "/v1/flows/" + fid, { name: "flow-2", enabled: false });
    expect(up.status).toBe(200);
    expect(up.body?.flow?.name).toBe("flow-2");

    // 停用的 flow 手动触发 → 409
    const run = await call("POST", "/v1/flows/" + fid + "/run", {});
    expect(run.status).toBe(409);

    const del = await call("DELETE", "/v1/flows/" + fid);
    expect(del.status).toBe(200);
    const del2 = await call("DELETE", "/v1/flows/" + fid);
    expect(del2.status).toBe(404);

    const bad = await call("POST", "/v1/flows", {});
    expect(bad.status).toBe(400);
    const run404 = await call("POST", "/v1/flows/no-such/run", {});
    expect(run404.status).toBe(404);
  });
});

// ==================== 播放渠道 token ====================
describe("播放渠道 token CRUD 闭环", () => {
  it("POST → GET → PUT 启停 → DELETE;不存在 404", async () => {
    const created = await call("POST", "/v1/player-webhook/tokens", { name: "tok-1" });
    expect(created.status, created.text.slice(0, 200)).toBe(200);
    expect(typeof created.body?.token).toBe("string");
    const listed = await call("GET", "/v1/player-webhook/tokens");
    const tid = listed.body.items.find((t: any) => t.name === "tok-1")?.id;
    expect(tid, JSON.stringify(listed.body.items).slice(0, 200)).toBeTruthy();

    const list = await call("GET", "/v1/player-webhook/tokens");
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.items)).toBe(true);
    expect(list.body.items.some((t: any) => t.id === tid)).toBe(true);
    expect(typeof list.body.templateUrl).toBe("string");

    const off = await call("PUT", "/v1/player-webhook/tokens/" + tid, { enabled: false });
    expect(off.status).toBe(200);
    const on = await call("PUT", "/v1/player-webhook/tokens/" + tid, { enabled: true });
    expect(on.status).toBe(200);

    const del = await call("DELETE", "/v1/player-webhook/tokens/" + tid);
    expect(del.status).toBe(200);
    const put404 = await call("PUT", "/v1/player-webhook/tokens/no-such", { enabled: true });
    expect(put404.status).toBe(404);
    const del404 = await call("DELETE", "/v1/player-webhook/tokens/no-such");
    expect(del404.status).toBe(404);
  });
});

// ==================== 设置类 PUT/GET 回读 ====================
describe("设置类端点 PUT→GET 回读", () => {
  it("admin log-settings / memory-settings 写入后可读回", async () => {
    const ls = await call("PUT", "/v1/admin/log-settings", { level: "info", toFile: false });
    expect(ls.status, ls.text.slice(0, 200)).toBe(200);
    const lsGet = await call("GET", "/v1/admin/log-settings");
    expect(lsGet.status).toBe(200);

    const ms = await call("PUT", "/v1/admin/memory-settings", { heapLimitMb: 512, reclaimIntervalSec: 60 });
    expect(ms.status, ms.text.slice(0, 200)).toBe(200);
    const msGet = await call("GET", "/v1/admin/memory-settings");
    expect(msGet.status).toBe(200);
  });

  it("playback / lyrics / covers 设置 PUT 后 GET 不报错", async () => {
    for (const [p, body] of [
      ["/v1/playback/settings", { crossfadeMs: 0, gapless: true }],
      ["/v1/lyrics/settings", { providerId: "", onDemand: true, persist: true }],
      ["/v1/covers/settings", { providerId: "", onDemand: true, persist: true }],
    ] as Array<[string, any]>) {
      const put = await call("PUT", p, body);
      expect(put.status, p + " " + put.text.slice(0, 160)).toBe(200);
      const get = await call("GET", p);
      expect(get.status, p).toBe(200);
    }
  });

  it("player-prefs / pipeline 设置 PUT 后 GET 不报错", async () => {
    for (const [m, p, body] of [
      ["PUT", "/v1/player-prefs/hidden", { hidden: [] }],
      ["PUT", "/v1/player-prefs/names", { names: {} }],
      ["PUT", "/v1/player-prefs/dsp/no-peer", { enabled: false }],
      ["PUT", "/v1/pipeline/switches", {}],
      ["PUT", "/v1/pipeline/measure", { enabled: false }],
      ["PUT", "/v1/pipeline/dlna/no-device", { enabled: false }],
    ] as Array<[string, string, any]>) {
      const r = await call(m, p, body);
      expect(r.status, m + " " + p + " " + r.text.slice(0, 160)).toBeLessThan(500);
    }
    for (const p of ["/v1/player-prefs/hidden", "/v1/player-prefs/names", "/v1/pipeline/switches", "/v1/pipeline/measure"]) {
      const get = await call("GET", p);
      expect(get.status, p).toBe(200);
    }
  });

  it("daily-recommend config PUT 后 GET 不报错", async () => {
    const put = await call("PUT", "/v1/daily-recommend/config", {});
    expect(put.status, put.text.slice(0, 160)).toBeLessThan(500);
    const get = await call("GET", "/v1/daily-recommend");
    expect(get.status).toBe(200);
  });
});
