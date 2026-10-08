// 目标采样率端点的**设备级授权**（batch48 第一步，与 per-player 音色同一层）。
//
// 为什么单开一条（照 dspPerm.test.ts 的理由）：`RENDERER_USE` 只说明"能播放"，
// 不能说明"能动别人设备的输出采样率"——采样率是**设备属性**（落
// `player_rate_configs`，按 peerId 存、不跟账号走），只过 renderer.use 的话，
// 任何被授予播放能力的账号都能改全服务器每台设备的出流采样率（把别人的音箱调成
// 它吃不动的档位，听感直接坏掉）。
//
// 测试要点（刻意给用户 renderer.use，让第一层 permMiddleware 放行，
// 这样 403 只可能来自我们新加的 canControlPeer）：
//   ① 未授权设备 → GET/PUT 403，且 **PUT 不落库**（拦在写之前）；
//   ② 授权该设备 → 200 且读写闭环（含 effectiveRate 回显）；
//   ③ **非法档位 → 400**（静默"清除"会把"传错了"伪装成"设置成功"）；
//   ④ 显式 null → 清除手动值，但**保留设备自动宣告值**；
//   ⑤ admin 全通；自己的本机播放器放行、别人的 403；
//   ⑥ 全量端点：普通用户只看到自己能控制的 peer。
import "../plugins/_env.js";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, userPermissions, userRendererGrants, playerRateConfigs } from "../../src/db/schema.js";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { generateToken } from "../../src/utils/auth.js";
import { invalidateAccessCaches, PERM } from "../../src/services/access.js";
import { recordProbedRate } from "../../src/services/playerRate.js";

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

function grantRendererUse(userId: string): void {
  db.insert(userPermissions).values({ userId, permKey: PERM.RENDERER_USE, granted: 1, updatedAt: "" }).run();
  invalidateAccessCaches(userId);
}

function grantDevice(userId: string, deviceKey: string): void {
  db.insert(userRendererGrants).values({ userId, deviceKey, createdAt: "" }).run();
  invalidateAccessCaches(userId);
}

async function authed(uid: string, isAdmin = false) {
  const token = generateToken(uid, "tester", isAdmin);
  return { token, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" } };
}

const ratePath = (peerId: string) => `/rest/api/v1/player-prefs/rate/${encodeURIComponent(peerId)}`;
const rateAll = "/rest/api/v1/player-prefs/rate";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});
beforeEach(() => {
  invalidateAccessCaches();
  db.delete(userPermissions).run();
  db.delete(userRendererGrants).run();
  db.delete(playerRateConfigs).run();
  db.delete(users).run();
});

describe("采样率端点：非授权设备一律 403", () => {
  it("有 renderer.use 但没被授权这台 DLNA → GET 403", async () => {
    const u = seedUser({ isAdmin: 0 });
    grantRendererUse(u);
    const { headers } = await authed(u, false);
    expect((await app.request(ratePath("dlna:rate-dev-1"), { headers })).status).toBe(403);
  });

  it("没被授权 → PUT 403，且**不落库**（拦在写之前）", async () => {
    const u = seedUser({ isAdmin: 0 });
    grantRendererUse(u);
    const { headers } = await authed(u, false);
    const res = await app.request(ratePath("dlna:rate-dev-1"), {
      method: "PUT",
      headers,
      body: JSON.stringify({ rate: 96000 }),
    });
    expect(res.status).toBe(403);
    expect(db.select().from(playerRateConfigs).all()).toEqual([]);
  });

  it("授权是**按设备**的：授权 dlna:rate-dev-1 不代表能动 dlna:rate-dev-2", async () => {
    const u = seedUser({ isAdmin: 0 });
    grantRendererUse(u);
    grantDevice(u, "dlna:rate-dev-1");
    const { headers } = await authed(u, false);
    expect((await app.request(ratePath("dlna:rate-dev-2"), { headers })).status).toBe(403);
  });
});

describe("采样率端点：读写闭环与归一化", () => {
  it("授权设备 → PUT 96000 落库，GET 读回同一份并回显 effectiveRate", async () => {
    const u = seedUser({ isAdmin: 0 });
    grantRendererUse(u);
    grantDevice(u, "dlna:rate-dev-1");
    const { headers } = await authed(u, false);

    const put = await app.request(ratePath("dlna:rate-dev-1"), {
      method: "PUT",
      headers,
      body: JSON.stringify({ rate: 96000 }),
    });
    expect(put.status).toBe(200);
    expect((await put.json()).config).toEqual({ manualRate: 96000, probedRate: null });

    const get = await app.request(ratePath("dlna:rate-dev-1"), { headers });
    expect(get.status).toBe(200);
    const body = await get.json();
    expect(body.options).toEqual([48000, 88200, 96000, 176400, 192000]);
    expect(body.defaultRate).toBe(48000);
    expect(body.config).toEqual({ manualRate: 96000, probedRate: null });
    expect(body.effectiveRate).toBe(96000);
    // 允许字符串形式（下拉/表单可能给字符串）
    const put2 = await app.request(ratePath("dlna:rate-dev-1"), {
      method: "PUT",
      headers,
      body: JSON.stringify({ rate: "192000" }),
    });
    expect((await put2.json()).effectiveRate).toBe(192000);
  });

  it("非法档位 → 400，且**不落库**（不静默当成「清除」）", async () => {
    const u = seedUser({ isAdmin: 0 });
    grantRendererUse(u);
    grantDevice(u, "dlna:rate-dev-1");
    const { headers } = await authed(u, false);
    for (const bad of [44100, 12345, 0, -1, 999999, "abc"]) {
      const res = await app.request(ratePath("dlna:rate-dev-1"), {
        method: "PUT",
        headers,
        body: JSON.stringify({ rate: bad }),
      });
      expect(res.status, `rate=${bad}`).toBe(400);
    }
    expect(db.select().from(playerRateConfigs).all()).toEqual([]);
  });

  it("显式 null → 清除手动值但**保留**设备自动宣告值", async () => {
    const u = seedUser({ isAdmin: 0 });
    grantRendererUse(u);
    grantDevice(u, "sendspin:rate-dev-x");
    const { headers } = await authed(u, false);

    // 设备上线时服务端自己记的探测值（不由 API 写）
    recordProbedRate("sendspin:rate-dev-x", 96000);

    await app.request(ratePath("sendspin:rate-dev-x"), {
      method: "PUT",
      headers,
      body: JSON.stringify({ rate: 48000 }),
    });
    const cleared = await app.request(ratePath("sendspin:rate-dev-x"), {
      method: "PUT",
      headers,
      body: JSON.stringify({ rate: null }),
    });
    const body = await cleared.json();
    expect(body.config).toEqual({ manualRate: null, probedRate: 96000 });
    expect(body.effectiveRate).toBe(96000);
  });

  it("全量端点同样要 renderer.use：没这个权限 → 403", async () => {
    const u = seedUser({ isAdmin: 0 }); // 刻意不授 renderer.use
    const { headers } = await authed(u, false);
    expect((await app.request(rateAll, { headers })).status).toBe(403);
    expect((await app.request(ratePath("dlna:rate-dev-1"), { headers })).status).toBe(403);
  });
});

describe("采样率端点：admin 全通、本机播放器按账号放行", () => {
  it("admin 读写任意设备都不需要授权", async () => {
    const admin = seedUser({ isAdmin: 1 });
    const { headers } = await authed(admin, true);
    const put = await app.request(ratePath("dlna:someone-else"), {
      method: "PUT",
      headers,
      body: JSON.stringify({ rate: 176400 }),
    });
    expect(put.status).toBe(200);
    expect((await put.json()).effectiveRate).toBe(176400);
  });

  it("自己的本机播放器无需设备授权 → 200；别人的 → 403", async () => {
    const u = seedUser({ isAdmin: 0 });
    const other = seedUser({ isAdmin: 0 });
    grantRendererUse(u);
    const { headers } = await authed(u, false);
    expect((await app.request(ratePath(`local:${u}:web-abc123`), { headers })).status).toBe(200);
    expect((await app.request(ratePath(`local:${other}:web-abc123`), { headers })).status).toBe(403);
  });
});

describe("采样率全量端点：按可见性过滤", () => {
  it("普通用户只看到自己能控制的 peer；admin 看到全部", async () => {
    const u = seedUser({ isAdmin: 0 });
    const admin = seedUser({ isAdmin: 1 });
    grantRendererUse(u);
    grantDevice(u, "dlna:mine");

    const adminAuth = await authed(admin, true);
    for (const peerId of ["dlna:mine", "dlna:not-mine"]) {
      const r = await app.request(ratePath(peerId), {
        method: "PUT",
        headers: adminAuth.headers,
        body: JSON.stringify({ rate: 96000 }),
      });
      expect(r.status).toBe(200);
    }

    const asUser = await (await app.request(rateAll, { headers: (await authed(u, false)).headers })).json();
    expect(Object.keys(asUser.configs)).toEqual(["dlna:mine"]);

    const asAdmin = await (await app.request(rateAll, { headers: adminAuth.headers })).json();
    expect(Object.keys(asAdmin.configs).sort()).toEqual(["dlna:mine", "dlna:not-mine"]);
    expect(asAdmin.defaultRate).toBe(48000);
  });
});
