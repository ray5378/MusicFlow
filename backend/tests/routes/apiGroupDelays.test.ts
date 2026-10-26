// GET/PUT /v1/groups/:id/delays 接口测试。
// 语义:**正数 = 该侧更晚出声,负数 = 该侧更早出声**;范围 ±30s,越界钳制不报错。
// 只有「两侧差值」影响 A/V;分开设是为了纯 AirPlay / 纯 Sendspin 组也能各自微调。
import "../plugins/_env.js";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, playerGroups } from "../../src/db/schema.js";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { generateToken } from "../../src/utils/auth.js";
import { invalidateGroupDelays } from "../../src/services/group/delayCalib.js";
import { getGroupManager } from "../../src/services/group/index.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

function seedAdmin(): string {
  const id = uuidv4();
  db.insert(users)
    .values({
      id,
      username: `adm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      password: "",
      salt: "salt",
      subsonicSalt: "subsalt",
      passEnc: encryptPassword("pw"),
      isAdmin: 1,
      isActive: 1,
      email: "",
    })
    .run();
  return id;
}

function adminHeaders(uid: string): Record<string, string> {
  const token = generateToken(uid, "tester", true);
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

beforeEach(() => {
  db.delete(playerGroups).run();
  db.delete(users).run();
});

describe("/v1/groups/:id/delays", () => {
  it("新组读到 0/0,并带回钳制范围与步进(前端据此渲染 input-number)", async () => {
    const uid = seedAdmin();
    const g = getGroupManager().createGroup("客厅组", [], uid);
    const res = await app.request(`/rest/api/v1/groups/${g.id}/delays`, { headers: adminHeaders(uid) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.airplayMs).toBe(0);
    expect(body.airplay2Ms).toBe(0);
    expect(body.sendspinMs).toBe(0);
    expect(body.minMs).toBe(-30000);
    expect(body.maxMs).toBe(30000);
    expect(body.stepMs).toBe(10);
  });

  it("PUT 写入两侧并回读一致(正数=更晚,负数=更早)", async () => {
    const uid = seedAdmin();
    const g = getGroupManager().createGroup("客厅组", [], uid);
    const headers = adminHeaders(uid);
    const put = await app.request(`/rest/api/v1/groups/${g.id}/delays`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ airplayMs: 120, sendspinMs: -60 }),
    });
    expect(put.status).toBe(200);
    const saved = (await put.json()) as any;
    expect(saved.airplayMs).toBe(120);
    expect(saved.sendspinMs).toBe(-60);
    expect(saved.rebuilt).toBe(0); // 该组没有活跃桥 → 不需要重连

    const get = await app.request(`/rest/api/v1/groups/${g.id}/delays`, { headers });
    const body = (await get.json()) as any;
    expect(body.airplayMs).toBe(120);
    expect(body.sendspinMs).toBe(-60);
  });

  it("PUT 一次写三侧 airplay/airplay2/sendspin,回读三项都一致", async () => {
    const uid = seedAdmin();
    const g = getGroupManager().createGroup("混合组", [], uid);
    const headers = adminHeaders(uid);
    const put = await app.request(`/rest/api/v1/groups/${g.id}/delays`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ airplayMs: 120, airplay2Ms: -45, sendspinMs: -60 }),
    });
    expect(put.status).toBe(200);
    const saved = (await put.json()) as any;
    expect(saved.airplayMs).toBe(120);
    expect(saved.airplay2Ms).toBe(-45);
    expect(saved.sendspinMs).toBe(-60);

    const get = await app.request(`/rest/api/v1/groups/${g.id}/delays`, { headers });
    const body = (await get.json()) as any;
    expect(body.airplayMs).toBe(120);
    expect(body.airplay2Ms).toBe(-45);
    expect(body.sendspinMs).toBe(-60);
  });

  it("只改第三格时 AP1 / Sendspin 两格不受影响(前端逐格调不会互相清零)", async () => {
    const uid = seedAdmin();
    const g = getGroupManager().createGroup("只调AP2", [], uid);
    const headers = adminHeaders(uid);
    await app.request(`/rest/api/v1/groups/${g.id}/delays`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ airplayMs: 80, airplay2Ms: 10, sendspinMs: 20 }),
    });
    const res = await app.request(`/rest/api/v1/groups/${g.id}/delays`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ airplay2Ms: -70 }),
    });
    const body = (await res.json()) as any;
    expect(body.airplayMs).toBe(80);
    expect(body.airplay2Ms).toBe(-70);
    expect(body.sendspinMs).toBe(20);
  });

  it("第三格同样被钳到 ±30s(绕过 clamp 会把越界值写进 DB)", async () => {
    const uid = seedAdmin();
    const g = getGroupManager().createGroup("AP2越界", [], uid);
    const res = await app.request(`/rest/api/v1/groups/${g.id}/delays`, {
      method: "PUT",
      headers: adminHeaders(uid),
      body: JSON.stringify({ airplay2Ms: 999999 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).airplay2Ms).toBe(30000);
  });

  it("越界值被钳到 ±30s 而不是 400", async () => {
    const uid = seedAdmin();
    const g = getGroupManager().createGroup("客厅组", [], uid);
    const res = await app.request(`/rest/api/v1/groups/${g.id}/delays`, {
      method: "PUT",
      headers: adminHeaders(uid),
      body: JSON.stringify({ airplayMs: 999999, sendspinMs: -999999 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.airplayMs).toBe(30000);
    expect(body.sendspinMs).toBe(-30000);
  });

  it("只改一侧时另一侧不受影响", async () => {
    const uid = seedAdmin();
    const g = getGroupManager().createGroup("客厅组", [], uid);
    const headers = adminHeaders(uid);
    invalidateGroupDelays(g.id);
    await app.request(`/rest/api/v1/groups/${g.id}/delays`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ airplayMs: 80, sendspinMs: 0 }),
    });
    const res = await app.request(`/rest/api/v1/groups/${g.id}/delays`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ sendspinMs: 40 }),
    });
    const body = (await res.json()) as any;
    expect(body.airplayMs).toBe(80);
    expect(body.sendspinMs).toBe(40);
  });

  it("组不存在 → 404(读写都是)", async () => {
    const uid = seedAdmin();
    const headers = adminHeaders(uid);
    const r1 = await app.request("/rest/api/v1/groups/nope/delays", { headers });
    expect(r1.status).toBe(404);
    const r2 = await app.request("/rest/api/v1/groups/nope/delays", {
      method: "PUT",
      headers,
      body: JSON.stringify({ airplayMs: 10 }),
    });
    expect(r2.status).toBe(404);
  });
});
