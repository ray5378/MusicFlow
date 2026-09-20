// per-player DSP 端点的**设备级授权**（P4-2 补的 `canControlPeer` 门）。
//
// 为什么单开一条：`RENDERER_USE` 只说明"能播放"，不能说明"能动别人的音色"——
// 音色是**设备属性**（落 `player_dsp_configs`，按 peerId 存、不跟账号走），
// 只过 renderer.use 的话，任何被授予播放能力的账号都能改全服务器每台设备的 EQ。
//
// 测试要点（刻意给用户 renderer.use，让第一层 permMiddleware 放行，
// 这样 403 只可能来自我们新加的 canControlPeer，而不是把权限门测成同一个东西）：
//   ① 未授权设备 → GET/PUT 403，且 **PUT 不落库**（拦在写之前）；
//   ② 授权该设备 → 200 且读写闭环；
//   ③ **自己的本机播放器**（掩码 `local:<uid>:<instanceKey>`）无需设备授权 → 200；
//   ④ 别人的本机播放器 → 403；
//   ⑤ admin 全通；
//   ⑥ 全量端点：普通用户只看到自己能控制的 peer（不可越权读别人设备的音色）。
import "../plugins/_env.js";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, userPermissions, userRendererGrants, playerDspConfigs } from "../../src/db/schema.js";
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

/** 授予 renderer.use（让 permMiddleware 放行，403 才只会来自 canControlPeer）。 */
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

const dspPath = (peerId: string) => `/rest/api/v1/player-prefs/dsp/${encodeURIComponent(peerId)}`;

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});
beforeEach(() => {
  invalidateAccessCaches();
  db.delete(userPermissions).run();
  db.delete(userRendererGrants).run();
  db.delete(playerDspConfigs).run();
  db.delete(users).run();
});

describe("DSP 端点：非授权设备一律 403", () => {
  it("有 renderer.use 但没被授权这台 DLNA → GET 403", async () => {
    const u = seedUser({ isAdmin: 0 });
    grantRendererUse(u);
    const { headers } = await authed(u, false);
    const res = await app.request(dspPath("dlna:dev-1"), { headers });
    expect(res.status).toBe(403);
  });

  it("没被授权 → PUT 403，且**不落库**（拦在写之前）", async () => {
    const u = seedUser({ isAdmin: 0 });
    grantRendererUse(u);
    const { headers } = await authed(u, false);
    const res = await app.request(dspPath("dlna:dev-1"), {
      method: "PUT",
      headers,
      body: JSON.stringify({ preampDb: -6 }),
    });
    expect(res.status).toBe(403);
    expect(db.select().from(playerDspConfigs).all()).toEqual([]);
  });

  it("被授权这台设备 → PUT 200 并落库、GET 读回同一份", async () => {
    const u = seedUser({ isAdmin: 0 });
    grantRendererUse(u);
    grantDevice(u, "dlna:dev-1");
    const { headers } = await authed(u, false);

    const put = await app.request(dspPath("dlna:dev-1"), {
      method: "PUT",
      headers,
      body: JSON.stringify({ preampDb: -6, tone: { bassDb: 3 } }),
    });
    expect(put.status).toBe(200);

    const get = await app.request(dspPath("dlna:dev-1"), { headers });
    expect(get.status).toBe(200);
    const body = await get.json();
    expect(body.config.preampDb).toBe(-6);
    expect(body.config.tone.bassDb).toBe(3);
  });

  it("授权是**按设备**的：授权了 dlna:dev-1，不代表能动 dlna:dev-2", async () => {
    const u = seedUser({ isAdmin: 0 });
    grantRendererUse(u);
    grantDevice(u, "dlna:dev-1");
    const { headers } = await authed(u, false);
    expect((await app.request(dspPath("dlna:dev-2"), { headers })).status).toBe(403);
  });
});

describe("DSP 端点：本机播放器按账号放行，别人的不放行", () => {
  it("自己的本机播放器（掩码形式 local:<uid>:<instanceKey>）无需设备授权 → 200", async () => {
    const u = seedUser({ isAdmin: 0 });
    grantRendererUse(u);
    const { headers } = await authed(u, false);
    const res = await app.request(dspPath(`local:${u}:web-abc123`), { headers });
    expect(res.status).toBe(200);
  });

  it("别人的本机播放器 → 403（管理员也不例外地看不到）", async () => {
    const u = seedUser({ isAdmin: 0 });
    const other = seedUser({ isAdmin: 0 });
    grantRendererUse(u);
    const { headers } = await authed(u, false);
    expect((await app.request(dspPath(`local:${other}:web-abc123`), { headers })).status).toBe(403);
  });
});

describe("DSP 端点：admin 全通", () => {
  it("admin 读写任意设备都不需要授权", async () => {
    const admin = seedUser({ isAdmin: 1 });
    const { headers } = await authed(admin, true);
    const put = await app.request(dspPath("dlna:someone-else"), {
      method: "PUT",
      headers,
      body: JSON.stringify({ gainDb: -3 }),
    });
    expect(put.status).toBe(200);
    const get = await app.request(dspPath("dlna:someone-else"), { headers });
    expect(get.status).toBe(200);
    expect((await get.json()).config.gainDb).toBe(-3);
  });
});

describe("DSP 全量端点：按可见性过滤，不越权读别人设备的音色", () => {
  it("普通用户只看到自己能控制的 peer；admin 看到全部", async () => {
    const u = seedUser({ isAdmin: 0 });
    const admin = seedUser({ isAdmin: 1 });
    grantRendererUse(u);
    grantDevice(u, "dlna:mine");

    // admin 先给两台设备各写一份配置
    const adminAuth = await authed(admin, true);
    for (const peerId of ["dlna:mine", "dlna:not-mine"]) {
      const r = await app.request(dspPath(peerId), {
        method: "PUT",
        headers: adminAuth.headers,
        body: JSON.stringify({ preampDb: -1 }),
      });
      expect(r.status).toBe(200);
    }

    const uAuth = await authed(u, false);
    const mine = await (await app.request("/rest/api/v1/player-prefs/dsp", { headers: uAuth.headers })).json();
    expect(Object.keys(mine.configs)).toEqual(["dlna:mine"]);

    const all = await (await app.request("/rest/api/v1/player-prefs/dsp", { headers: adminAuth.headers })).json();
    expect(Object.keys(all.configs).sort()).toEqual(["dlna:mine", "dlna:not-mine"]);
  });
});
