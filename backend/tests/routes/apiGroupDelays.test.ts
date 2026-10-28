// GET/PUT /v1/groups/:id/delays 接口测试(v4.8.0 起**按成员**)。
// 语义:**正数 = 该设备更晚出声,负数 = 该设备更早出声**;范围 ±30s,越界钳制不报错。
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

/** 直接落库建组(成员 allowlist 只在 createGroup/setMembers 校验,这里绕开):
 *  每个用例唯一 id,避免单例 GroupManager 内存里的陈旧组串场。 */
function seedGroup(uid: string, memberIds: string[] = ["airplay:hivi", "sendspin:esp1"]): string {
  const id = `g-${uuidv4()}`;
  db.insert(playerGroups)
    .values({ id, name: "客厅组", memberIds: JSON.stringify(memberIds), ownerUserId: uid })
    .run();
  invalidateGroupDelays(id);
  getGroupManager().loadFromDb(); // 让单例内存表看到新行(否则 GET/PUT 的 gm.get 拿不到)
  return id;
}

function putDelays(id: string, headers: Record<string, string>, body: Record<string, unknown>) {
  return app.request(`/rest/api/v1/groups/${id}/delays`, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

beforeEach(() => {
  db.delete(playerGroups).run();
  db.delete(users).run();
  getGroupManager().loadFromDb();
});

describe("/v1/groups/:id/delays(按成员)", () => {
  it("新组读到空成员表 + 钳制范围与步进(前端据此渲染 input-number)", async () => {
    const uid = seedAdmin();
    const id = seedGroup(uid);
    const res = await app.request(`/rest/api/v1/groups/${id}/delays`, { headers: adminHeaders(uid) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.memberDelays).toEqual({});
    expect(body.minMs).toBe(-30000);
    expect(body.maxMs).toBe(30000);
    expect(body.stepMs).toBe(10);
  });

  it("PUT 单成员写入并回读一致(正数=更晚,负数=更早);组无活跃桥 → rebuilt=0", async () => {
    const uid = seedAdmin();
    const id = seedGroup(uid);
    const headers = adminHeaders(uid);
    const put = await putDelays(id, headers, { memberId: "airplay:hivi", ms: 120 });
    expect(put.status).toBe(200);
    const saved = (await put.json()) as any;
    expect(saved.memberDelays["airplay:hivi"]).toBe(120);
    expect(saved.rebuilt).toBe(0);

    const get = await app.request(`/rest/api/v1/groups/${id}/delays`, { headers });
    const body = (await get.json()) as any;
    expect(body.memberDelays["airplay:hivi"]).toBe(120);
    expect(body.memberDelays["sendspin:esp1"]).toBeUndefined();
  });

  it("成员互相独立:再写另一台不影响已设成员(逐设备调不会被互相清零)", async () => {
    const uid = seedAdmin();
    const id = seedGroup(uid);
    const headers = adminHeaders(uid);
    await putDelays(id, headers, { memberId: "airplay:hivi", ms: 80 });
    const res = await putDelays(id, headers, { memberId: "sendspin:esp1", ms: -70 });
    const body = (await res.json()) as any;
    expect(body.memberDelays["airplay:hivi"]).toBe(80);
    expect(body.memberDelays["sendspin:esp1"]).toBe(-70);
  });

  it("越界值被钳到 ±30s 而不是 400", async () => {
    const uid = seedAdmin();
    const id = seedGroup(uid);
    const headers = adminHeaders(uid);
    const r1 = await putDelays(id, headers, { memberId: "airplay:hivi", ms: 999999 });
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as any).memberDelays["airplay:hivi"]).toBe(30000);
    const r2 = await putDelays(id, headers, { memberId: "sendspin:esp1", ms: -999999 });
    expect(((await r2.json()) as any).memberDelays["sendspin:esp1"]).toBe(-30000);
  });

  it("memberId 不在本组成员列表 → 400(越组写入拒绝)", async () => {
    const uid = seedAdmin();
    const id = seedGroup(uid);
    const res = await putDelays(id, adminHeaders(uid), { memberId: "airplay:ghost", ms: 10 });
    expect(res.status).toBe(400);
  });

  it("PUT body 带 trackLeadMs(已移除的手动口) → 未知字段忽略:响应不含该字段且不生效", async () => {
    const uid = seedAdmin();
    const id = seedGroup(uid);
    const headers = adminHeaders(uid);
    await putDelays(id, headers, { memberId: "airplay:hivi", ms: 5 });
    const res = await putDelays(id, headers, { trackLeadMs: 1500 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.memberDelays["airplay:hivi"]).toBe(5); // 成员表不受影响
    expect(body.trackLeadMs).toBeUndefined(); // v4.9.1 手动口已删,响应不再回显
    expect(body.mixedAnchorLeadMs).toBe(0); // mixedAnchor 三件套不受影响
  });

  it("组不存在 → 404(读写都是)", async () => {
    const uid = seedAdmin();
    const headers = adminHeaders(uid);
    const r1 = await app.request("/rest/api/v1/groups/nope/delays", { headers });
    expect(r1.status).toBe(404);
    const r2 = await putDelays("nope", headers, { memberId: "airplay:hivi", ms: 10 });
    expect(r2.status).toBe(404);
  });
});
