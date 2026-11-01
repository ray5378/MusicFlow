// POST /v1/groups/:id/delay-test 与 /delay-test/stop 接口测试(v4.11.0)。
// 门禁:renderer.use + 组 owner(或管理员);起停失败一律 400 INVALID_PARAM。
// 服务实现细节由 tests/group/delayTest.test.ts 覆盖,这里只钉路由面(鉴权/404/失败/回显)。
import "../plugins/_env.js";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, playerGroups, userPermissions } from "../../src/db/schema.js";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { generateToken } from "../../src/utils/auth.js";
import { PERM } from "../../src/services/access.js";
import { getGroupManager } from "../../src/services/group/index.js";
import { invalidateGroupDelays } from "../../src/services/group/delayCalib.js";

const h = vi.hoisted(() => {
  const state = { active: false, startFail: false, stopFail: false };
  return { state };
});

vi.mock("../../src/services/group/delayTest.js", () => ({
  isGroupDelayTestActive: () => h.state.active,
  startGroupDelayTest: async () => {
    if (h.state.startFail) throw new Error("起播失败");
    h.state.active = true;
    return { running: true, intervalMs: 5000, clickMs: 20, durationSec: 300 };
  },
  stopGroupDelayTest: async () => {
    if (h.state.stopFail) throw new Error("停止失败");
    h.state.active = false;
    return { running: false, restored: true };
  },
}));

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

function seedUser(isAdmin: boolean): string {
  const id = uuidv4();
  db.insert(users)
    .values({
      id,
      username: `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      password: "",
      salt: "salt",
      subsonicSalt: "subsalt",
      passEnc: encryptPassword("pw"),
      isAdmin: isAdmin ? 1 : 0,
      isActive: 1,
      email: "",
    })
    .run();
  return id;
}

function grant(uid: string): void {
  db.insert(userPermissions)
    .values({ userId: uid, permKey: PERM.RENDERER_USE, granted: 1, updatedAt: "" })
    .run();
}

function headers(uid: string): Record<string, string> {
  return { Authorization: `Bearer ${generateToken(uid, "tester", true)}`, "content-type": "application/json" };
}

function seedGroup(ownerUserId: string): string {
  const id = `g-${uuidv4()}`;
  db.insert(playerGroups)
    .values({ id, name: "客厅组", memberIds: JSON.stringify(["airplay:hivi"]), ownerUserId })
    .run();
  invalidateGroupDelays(id);
  getGroupManager().loadFromDb();
  return id;
}

const start = (id: string, hdrs: Record<string, string>) =>
  app.request(`/rest/api/v1/groups/${id}/delay-test`, { method: "POST", headers: hdrs });
const stop = (id: string, hdrs: Record<string, string>) =>
  app.request(`/rest/api/v1/groups/${id}/delay-test/stop`, { method: "POST", headers: hdrs });

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  // 起测要通过 getDlnaBaseUrl 推导 baseUrl:钉死环境值,避免测试里做网卡探测。
  process.env.DLNA_BASE_URL = "http://127.0.0.1:8080";
  initDatabase();
});

beforeEach(() => {
  db.delete(playerGroups).run();
  db.delete(userPermissions).run();
  db.delete(users).run();
  getGroupManager().loadFromDb();
  h.state.active = false;
  h.state.startFail = false;
  h.state.stopFail = false;
});

describe("POST /v1/groups/:id/delay-test", () => {
  it("owner 起测 → 200 + 咔哒参数;GET /delays 的 delayTest 字段回显 active", async () => {
    const uid = seedUser(true);
    const gid = seedGroup(uid);
    const hdrs = headers(uid);

    const res = await start(gid, hdrs);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ running: true, intervalMs: 5000, clickMs: 20, durationSec: 300 });

    const get = await app.request(`/rest/api/v1/groups/${gid}/delays`, { headers: hdrs });
    const body = (await get.json()) as any;
    expect(body.delayTest).toBe(true);
  });

  it("组不存在 → 404(管理员 isOwnedBy 恒真,必须先确认组存在)", async () => {
    const uid = seedUser(true);
    const res = await start("g-missing", headers(uid));
    expect(res.status).toBe(404);
  });

  it("非 owner 普通用户(有 renderer.use)→ 404(越组操作一律拒绝)", async () => {
    const owner = seedUser(true);
    const bob = seedUser(false);
    grant(bob);
    const gid = seedGroup(owner);
    const res = await start(gid, headers(bob));
    expect(res.status).toBe(404);
  });

  it("起测失败 → 400 INVALID_PARAM(错误码与文案走统一信封)", async () => {
    const uid = seedUser(true);
    const gid = seedGroup(uid);
    h.state.startFail = true;
    const res = await start(gid, headers(uid));
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.success).toBe(false);
    expect(body.code).toBe("INVALID_PARAM");
    expect(body.error).toContain("起播失败");
    expect(h.state.active).toBe(false);
  });
});

describe("POST /v1/groups/:id/delay-test/stop", () => {
  it("owner 停止 → 200 + {running:false, restored};delayTest 回显 false", async () => {
    const uid = seedUser(true);
    const gid = seedGroup(uid);
    h.state.active = true;
    const hdrs = headers(uid);

    const res = await stop(gid, hdrs);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ running: false, restored: true });

    const get = await app.request(`/rest/api/v1/groups/${gid}/delays`, { headers: hdrs });
    expect(((await get.json()) as any).delayTest).toBe(false);
  });

  it("组不存在 → 404", async () => {
    const uid = seedUser(true);
    const res = await stop("g-missing", headers(uid));
    expect(res.status).toBe(404);
  });

  it("停止失败 → 400 INVALID_PARAM(测试态不回滚,便于前端继续点停止)", async () => {
    const uid = seedUser(true);
    const gid = seedGroup(uid);
    h.state.active = true;
    h.state.stopFail = true;
    const res = await stop(gid, headers(uid));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe("INVALID_PARAM");
    expect(h.state.active).toBe(true);
  });

  it("未起测就停止 → 200 幂等({running:false, restored:false} 由服务返回)", async () => {
    const uid = seedUser(true);
    const gid = seedGroup(uid);
    h.state.active = false;
    const res = await stop(gid, headers(uid));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).running).toBe(false);
  });
});
