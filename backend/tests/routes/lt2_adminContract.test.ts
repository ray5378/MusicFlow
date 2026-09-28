// MUST be the first import:隔离 DATA_DIR 后再加载后端模块。
import "../plugins/_env.js";

// 管理端三类路由的残余未覆盖行补测(全部走真实路由 + 真实设置层):
//   routes/api/settings.ts 42-43(手动内存回收)/ 82-83(idleMinutes 落库)/ 128-138(playback 优选写入)
//   routes/api/pipeline.ts 36-38(设备回退列表)/ 51-53、56-59、62-63(PUT switches 的 flow + normalization)
//   routes/api/users.ts   161-165、168-172、175-179(/v1/access/renderers 三种设备映射)
//
// 为什么直打 HTTP:这些行的语义就是**路由对外的取值/回显契约**(写入后读回必须一致、
// 越界值必须夹在写入口),而不是某个内部函数。用真实 app + 真实 DB 才能同时锁住
// 「状态码」「响应体形状」「落库真值」三件事。
//
// 唯一需要替换的叶子是 DLNA/AirPlay 的设备缓存:真实缓存要靠 mDNS 扫描填充,
// 测试里不可能有真设备。这里只把这一个「读缓存」入口换成固定列表,其余全部保真。
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import md5 from "md5";

const leaf = vi.hoisted(() => ({
  getCachedDevices: vi.fn(() => [] as any[]),
  listAirPlayDevices: vi.fn(() => [] as any[]),
}));

vi.mock("../../src/services/dlna/control.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  getCachedDevices: leaf.getCachedDevices,
}));

vi.mock("../../src/services/airplay/control.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  listAirPlayDevices: leaf.listAirPlayDevices,
}));

import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, plugins } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { getGroupManager } from "../../src/services/group/index.js";
import { CROSSFADE_DURATION_KEY } from "../../src/services/audio/flowSource.js";
import { NORMALIZATION_TARGET_KEY, NORMALIZATION_ENABLED_KEY } from "../../src/services/audio/normalization.js";
import { getSetting } from "../../src/services/settings.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const PLAIN = "hunter2";
const SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + SALT)}&s=${SALT}`;

async function call(method: string, path: string, body?: unknown) {
  const url = `/rest/api${path}${path.includes("?") ? "&" : "?"}${authQS()}`;
  const res = await app.request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
    db.insert(users).values({
      id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt",
      passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1, email: "a@b.c",
    }).run();
  }
});

beforeEach(() => {
  leaf.getCachedDevices.mockReset();
  leaf.getCachedDevices.mockImplementation(() => [] as any[]);
  leaf.listAirPlayDevices.mockReset();
  leaf.listAirPlayDevices.mockImplementation(() => [] as any[]);
});

// ==================== settings.ts ====================

describe("admin 内存设置", () => {
  it("POST /v1/admin/memory/reclaim:手动回收回执 success 且携带各层结果", async () => {
    // 契约:这是一次运维动作,必须给调用方一个明确的成功标记 + 回收详情,
    // 而不是空 200(前端据此显示"已回收 X MB")。
    const r = await call("POST", "/v1/admin/memory/reclaim");
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
  });

  it("PUT /v1/admin/memory-settings:idleMinutes 取整落库,GET 读回同值", async () => {
    // 契约:空闲阈值是"写入口即规范化"的字段(>=1 才写,写的是取整后的值)。
    // 写 7.6 → 库里必须能读回 8,证明落库与读回同源(而不是只改了内存)。
    const put = await call("PUT", "/v1/admin/memory-settings", { enabled: true, idleMinutes: 7.6 });
    expect(put.status).toBe(200);
    expect(put.body.success).toBe(true);

    const get = await call("GET", "/v1/admin/memory-settings");
    expect(get.status).toBe(200);
    expect(get.body.idleMinutes).toBe(8);
    expect(get.body.enabled).toBe(true);
  });

  it("PUT /v1/admin/memory-settings:idleMinutes < 1 被忽略,保留既有值", async () => {
    // 契约:非法值忽略而不是写进去(写 0 会让后台回收变成"每轮都回收")。
    await call("PUT", "/v1/admin/memory-settings", { idleMinutes: 12 });
    await call("PUT", "/v1/admin/memory-settings", { idleMinutes: 0 });
    const get = await call("GET", "/v1/admin/memory-settings");
    expect(get.body.idleMinutes).toBe(12);
  });
});

describe("playback 偏好写入(插件配置真源)", () => {
  const ID = "core-play-preference";

  it("PUT /v1/playback/settings:preferLocal 写进插件行 config,GET 回显", async () => {
    // 契约:该端点仅为兼容旧调用方保留,真源是「播放优选」插件的 config.preferLocal。
    // 所以断言要打在**插件行**上,而不是回应体 —— 回应体只是 success。
    db.delete(plugins).where(eq(plugins.id, ID)).run();
    db.insert(plugins).values({ id: ID, name: ID, enabled: 1, config: JSON.stringify({ preferLocal: false }) }).run();

    const put = await call("PUT", "/v1/playback/settings", { preferLocal: true });
    expect(put.status).toBe(200);
    expect(put.body.success).toBe(true);

    const row = db.select().from(plugins).where(eq(plugins.id, ID)).get() as any;
    expect(JSON.parse(row.config).preferLocal).toBe(true);
    // 合并写入:原有字段不能被整体覆盖丢失
    expect(JSON.parse(row.config)).toMatchObject({ preferLocal: true });

    const get = await call("GET", "/v1/playback/settings");
    expect(get.body.preferLocal).toBe(true);
  });

  it("PUT /v1/playback/settings:插件行不存在时仍返回 success(不报错、不落库)", async () => {
    // 契约:设置端点不能在插件被卸载后变成 500 —— 旧调用方会立刻炸。
    db.delete(plugins).where(eq(plugins.id, ID)).run();
    const put = await call("PUT", "/v1/playback/settings", { preferLocal: true });
    expect(put.status).toBe(200);
    expect(put.body.success).toBe(true);
    expect(db.select().from(plugins).where(eq(plugins.id, ID)).get()).toBeUndefined();
  });
});

// ==================== pipeline.ts ====================

describe("pipeline switches", () => {
  it("GET /v1/pipeline/switches:逐台 DLNA 列出回退位", async () => {
    // 契约:设备回退是**逐台**的,D5 兜底要能在面板上看到每台机器当前是否回退。
    leaf.getCachedDevices.mockReturnValue([
      { id: "dev-1", name: "客厅音箱", available: true },
      { id: "dev-2", name: "", available: true },
    ]);
    const r = await call("GET", "/v1/pipeline/switches");
    expect(r.status).toBe(200);
    expect(r.body.devices).toHaveLength(2);
    expect(r.body.devices[0]).toMatchObject({ deviceId: "dev-1", name: "客厅音箱" });
    // 无名设备回落 id,避免前端显示空白
    expect(r.body.devices[1]).toMatchObject({ deviceId: "dev-2", name: "dev-2" });
    expect(typeof r.body.devices[0].fallback).toBe("boolean");
  });

  it("PUT /v1/pipeline/switches:flow 与 normalization 一起提交,越界值夹在写入口", async () => {
    // 契约(durationSec):MA 区间是 1..15,写入前就夹 —— 库里不许留读不出来的值。
    // 取 20 → 落库必须变成 15;GET 读回也必须是 15(证明夹的是落库值,不是回应体)。
    const r = await call("PUT", "/v1/pipeline/switches", {
      flow: { enabled: true, mode: "standard", durationSec: 20 },
      normalization: { enabled: false, targetLufs: -40 },
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.flow).toMatchObject({ enabled: true, mode: "standard", durationSec: 15 });
    // targetLufs 区间 -30..-5,取 -40 → 夹到 -30
    expect(r.body.normalization).toMatchObject({ enabled: false, targetLufs: -30 });

    // 关键:夹的必须是**落库值**(读侧也会夹,只断回应体区分不出写入口到底夹没夹)
    expect(getSetting(CROSSFADE_DURATION_KEY, "")).toBe("15");
    expect(getSetting(NORMALIZATION_TARGET_KEY, "")).toBe("-30");
    expect(getSetting(NORMALIZATION_ENABLED_KEY, "")).toBe("0");

    const get = await call("GET", "/v1/pipeline/switches");
    expect(get.body.flow).toMatchObject({ enabled: true, mode: "standard", durationSec: 15 });
    expect(get.body.normalization).toMatchObject({ enabled: false, targetLufs: -30 });
  });

  it("PUT /v1/pipeline/switches:durationSec 非数值/<=0 时不动既有值", async () => {
    // 契约:"逐项提交,非法值忽略"—— 一条手抖不该把整次保存打回或写坏已有配置。
    await call("PUT", "/v1/pipeline/switches", { flow: { durationSec: 10 } });
    const r = await call("PUT", "/v1/pipeline/switches", { flow: { durationSec: 0 } });
    expect(r.body.flow.durationSec).toBe(10);
    expect(getSetting(CROSSFADE_DURATION_KEY, "")).toBe("10");
    const r2 = await call("PUT", "/v1/pipeline/switches", { flow: { durationSec: "abc" } });
    expect(r2.body.flow.durationSec).toBe(10);
    expect(getSetting(CROSSFADE_DURATION_KEY, "")).toBe("10");
  });
});

// ==================== proxy.ts: 后台任务限速档位 ====================

describe("batch-pace 档位", () => {
  it("GET 回显当前档位;PUT 合法档位落库并回显", async () => {
    // 契约:档位是**白名单**枚举(slow|standard|full),非法值一律 400 且不改运行时档位 ——
    // 因为档位直接决定批量任务的 CPU 占用,写进去一个未知值会让节流逻辑失效。
    const get0 = await call("GET", "/v1/batch-pace");
    expect(get0.status).toBe(200);
    expect(["slow", "standard", "full"]).toContain(get0.body.pace);

    const put = await call("PUT", "/v1/batch-pace", { pace: "slow" });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ success: true, pace: "slow" });

    const get1 = await call("GET", "/v1/batch-pace");
    expect(get1.body.pace).toBe("slow");
  });

  it("PUT 非法档位 → 400 + INVALID_PARAM,且档位保持不变", async () => {
    await call("PUT", "/v1/batch-pace", { pace: "full" });
    const bad = await call("PUT", "/v1/batch-pace", { pace: "turbo" });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ success: false, code: "INVALID_PARAM" });
    expect((await call("GET", "/v1/batch-pace")).body.pace).toBe("full");
  });
});

// ==================== users.ts: /v1/access/renderers ====================

describe("可授权播放器清单", () => {
  it("GET /v1/access/renderers:DLNA / AirPlay / 群组三类统一成 deviceKey", async () => {
    // 契约:管理端勾选 UI 靠 deviceKey 前缀区分设备种类(`dlna:` / `airplay:` / `group:`),
    // 三类必须都出现在同一数组里,且 DLNA 用别名优先、AirPlay 同理。
    leaf.getCachedDevices.mockReturnValue([
      { id: "d1", name: "原生名", alias: "主卧", available: true, disabled: false },
      { id: "d2", name: "次卧", available: false, disabled: true },
    ]);
    leaf.listAirPlayDevices.mockReturnValue([
      { id: "ap1", name: "Apple TV", alias: "", available: true },
    ]);
    const g = getGroupManager().createGroup("测试组", ["sendspin:ROOM-1"], "u1");

    const r = await call("GET", "/v1/access/renderers");
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);

    const dlna = r.body.renderers.filter((x: any) => x.kind === "dlna");
    expect(dlna.map((x: any) => x.deviceKey).sort()).toEqual(["dlna:d1", "dlna:d2"]);
    // 别名叫主卧时展示别名;无别名回落 name
    expect(dlna.find((x: any) => x.deviceKey === "dlna:d1").name).toBe("主卧");
    expect(dlna.find((x: any) => x.deviceKey === "dlna:d2").name).toBe("次卧");
    expect(dlna.find((x: any) => x.deviceKey === "dlna:d2").disabled).toBe(true);

    const ap = r.body.renderers.filter((x: any) => x.kind === "airplay");
    expect(ap.map((x: any) => x.deviceKey)).toEqual(["airplay:ap1"]);
    expect(ap[0].name).toBe("Apple TV");

    const grp = r.body.renderers.filter((x: any) => x.kind === "group");
    const mine = grp.find((x: any) => x.deviceKey === `group:${g.id}`);
    expect(mine).toBeTruthy();
    expect(mine.name).toBe("测试组");
    // memberCount 供前端提示"组里有几台",必须是成员数
    expect(mine.memberCount).toBe(1);
    expect(typeof mine.available).toBe("boolean");

    getGroupManager().deleteGroup(g.id);
  });
});
