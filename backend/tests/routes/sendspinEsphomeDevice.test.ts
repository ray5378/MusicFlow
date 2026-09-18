// ESPHome 6053「每台设备各自一把密钥」端点契约测试。
//
// 背景:6053 的开关/密钥曾经是**内置插件页的全局配置** —— 一把密钥连多台必然串台
// (每台 ESPHome 的 api.encryption.key 都是各自生成的),而且那时的「测试连接」取的是
// 「任意一台已连设备的 IP」,填 A 的密钥却拿 B 的门去试,必然 auth 失败。现全部下放到
// 播放器页的设备行:密钥按 clientId 落库(host 会被 DHCP 换掉,clientId 不会),
// host 由后端从当前连接派生。
//
// 本文件**不启动 sendspin 服务** —— 全程走「设备离线」路径,不产生任何真实 6053 网络
// 连接。锁定的契约:
//   1. 密钥按 clientId 落库;GET 只回报 pskConfigured/port/connected,**永不回显 PSK**;
//   2. psk 传空串 = 撤销这一台,不影响其它设备;
//   3. 没有桥接时写设备音量/静音 → 200 + code:"no-bridge"(不 5xx,文案交前端映射);
//   4. 参数校验:volume 非数字 / muted 非布尔 → 400;
//   5. 设备离线时探针 → 200 + ok:false + errorCode:"no_host"(绝不去试别人的 IP);
//   6. 旧的全局端点 POST /v1/sendspin/esphome/test 已删除(404),GET 也不再回全局开关。
//
// ⚠️ 本仓 vitest 开了 `sequence.shuffle`(见 vitest.config),**用例顺序是随机的** ——
// 每个 it 必须自己铺前置状态,不许依赖上一个 it 留下的行。
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { db, initDatabase, encryptPassword, sqlite } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { generateToken } from "../../src/utils/auth.js";
import { getDeviceEsphome } from "../../src/services/sendspin/deviceState.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const A = "esphome-dev-route-a";
const B = "esphome-dev-route-b";
let adminId = "";
let plainId = "";

function headers(uid: string, isAdmin: boolean) {
  return {
    Authorization: `Bearer ${generateToken(uid, "tester", isAdmin)}`,
    "content-type": "application/json",
  };
}

function put(clientId: string, uid = adminId, isAdmin = true, body: any = {}) {
  return app.request(`/rest/api/v1/sendspin/devices/${encodeURIComponent(clientId)}/esphome`, {
    method: "PUT",
    headers: headers(uid, isAdmin),
    body: JSON.stringify(body),
  });
}

function get(clientId: string, uid = adminId, isAdmin = true) {
  return app.request(`/rest/api/v1/sendspin/devices/${encodeURIComponent(clientId)}/esphome`, {
    headers: headers(uid, isAdmin),
  });
}

function writeVolume(clientId: string, body: any) {
  return app.request(`/rest/api/v1/sendspin/devices/${encodeURIComponent(clientId)}/esphome/volume`, {
    method: "PUT",
    headers: headers(adminId, true),
    body: JSON.stringify(body),
  });
}

function writeMuted(clientId: string, body: any) {
  return app.request(`/rest/api/v1/sendspin/devices/${encodeURIComponent(clientId)}/esphome/muted`, {
    method: "PUT",
    headers: headers(adminId, true),
    body: JSON.stringify(body),
  });
}

function probe(clientId: string) {
  return app.request(`/rest/api/v1/sendspin/devices/${encodeURIComponent(clientId)}/esphome/test`, {
    method: "POST",
    headers: headers(adminId, true),
    body: JSON.stringify({}),
  });
}

/** 铺前置状态:用例顺序随机,谁都不能指望别人先把密钥写好。 */
async function setCreds(clientId: string, psk: string, port = 6053): Promise<void> {
  const res = await put(clientId, adminId, true, { psk, port });
  expect(res.status).toBe(200);
}

beforeAll(() => {
  initDatabase();
  adminId = uuidv4();
  plainId = uuidv4();
  db.insert(users)
    .values({
      id: adminId,
      username: `esp-admin-${Date.now()}`,
      password: "",
      salt: "salt",
      subsonicSalt: "subsalt",
      passEnc: encryptPassword("pw"),
      isAdmin: 1,
      isActive: 1,
      email: "",
    })
    .run();
  // 非管理员且无任何授权 → permMiddleware(RENDERER_MANAGE) 必须拦下带密钥的操作。
  db.insert(users)
    .values({
      id: plainId,
      username: `esp-user-${Date.now()}`,
      password: "",
      salt: "salt",
      subsonicSalt: "subsalt",
      passEnc: encryptPassword("pw"),
      isAdmin: 0,
      isActive: 1,
      email: "",
    })
    .run();
  sqlite.prepare("DELETE FROM sendspin_device_state WHERE client_id IN (?, ?)").run(A, B);
});

afterAll(() => {
  sqlite.prepare("DELETE FROM sendspin_device_state WHERE client_id IN (?, ?)").run(A, B);
  db.delete(users).where(eq(users.id, adminId)).run();
  db.delete(users).where(eq(users.id, plainId)).run();
});

describe("PUT/GET /v1/sendspin/devices/:clientId/esphome", () => {
  it("设备离线也能保存密钥:落库 + online:false(等重连自动生效)", async () => {
    const res = await put(A, adminId, true, { psk: "  key-a  ", port: 6054 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.online).toBe(false);
    // 未连上 → host 空串(没有可作用的连接),但密钥必须已经落库
    expect(body.host).toBe("");
    expect(getDeviceEsphome(A)).toEqual({ psk: "key-a", port: 6054 });
  });

  it("GET 只回报 pskConfigured/port/connected,绝不回显 PSK", async () => {
    await setCreds(A, "key-secret", 6054);
    const res = await get(A);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toEqual({ pskConfigured: true, port: 6054, connected: false, volume: null, muted: false });
    // 整个响应体里不许出现密钥明文
    expect(JSON.stringify(body)).not.toContain("key-secret");
  });

  it("每台设备各存各的:改 A 不动 B", async () => {
    await setCreds(B, "key-b", 6053);
    await setCreds(A, "key-a2", 6054);
    expect(getDeviceEsphome(B)).toEqual({ psk: "key-b", port: 6053 });
    expect(getDeviceEsphome(A)).toEqual({ psk: "key-a2", port: 6054 });
  });

  it("psk 传空串 = 撤销这一台(pskConfigured 回落 false)", async () => {
    await setCreds(B, "key-b", 6053);
    await setCreds(A, "key-a", 6054);
    await put(A, adminId, true, { psk: "", port: 6054 });
    const body = (await (await get(A)).json()) as any;
    expect(body.pskConfigured).toBe(false);
    expect(getDeviceEsphome(A)).toEqual({ psk: "", port: 6054 });
    // B 不受影响
    expect(getDeviceEsphome(B).psk).toBe("key-b");
  });

  it("非法端口落 0(上层回退 6053),不报错", async () => {
    await put(B, adminId, true, { psk: "key-b2", port: 70000 });
    expect(getDeviceEsphome(B).port).toBe(0);
  });

  it("空 clientId 不建行(路径参数为空时 404,不误伤)", async () => {
    const res = await put("", adminId, true, { psk: "x" });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("非管理员无 RENDERER_MANAGE → 403,且密钥原样不动;GET 状态不受此限", async () => {
    await setCreds(A, "key-guarded", 6053);
    const denied = await put(A, plainId, false, { psk: "hack" });
    expect(denied.status).toBe(403);
    // 被拒的写入必须完全没有副作用
    expect(getDeviceEsphome(A)).toEqual({ psk: "key-guarded", port: 6053 });

    const state = await get(A, plainId, false);
    expect(state.status).toBe(200);
  });
});

describe("PUT /v1/sendspin/devices/:clientId/esphome/volume|muted", () => {
  it("没有桥接 → 200 + success:false + code:no-bridge(不 5xx)", async () => {
    const res = await writeVolume(B, { volume: 55 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(false);
    expect(body.code).toBe("no-bridge");
    expect(body.volume).toBe(55); // 回带回显值,前端乐观更新可用
  });

  it("音量夹取到 0..100(超界/负数都不越界)", async () => {
    expect((await (await writeVolume(B, { volume: 999 })).json() as any).volume).toBe(100);
    expect((await (await writeVolume(B, { volume: -20 })).json() as any).volume).toBe(0);
    expect((await (await writeVolume(B, { volume: 33.6 })).json() as any).volume).toBe(34);
  });

  it("volume 非数字 → 400", async () => {
    for (const bad of ["60", null, undefined, {}]) {
      const res = await writeVolume(B, { volume: bad });
      expect(res.status).toBe(400);
    }
  });

  it("静音:同样 no-bridge 不 5xx;muted 非布尔 → 400", async () => {
    const ok = await writeMuted(B, { muted: true });
    expect(ok.status).toBe(200);
    expect((await ok.json() as any).code).toBe("no-bridge");

    for (const bad of ["yes", 1, null]) {
      const res = await writeMuted(B, { muted: bad });
      expect(res.status).toBe(400);
    }
  });
});

describe("探针与旧全局端点", () => {
  it("设备离线 → 200 + ok:false + no_host(绝不去试别人的 IP)", async () => {
    // 先铺好密钥:探针里 no_psk 的判定在 no_host 之前,不铺就测不到 host 这一层。
    await setCreds(A, "key-probe", 6053);
    const res = await probe(A);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    // 离线时 host 派生为空 ⇒ 探针以 no_host 失败,而不是退化成「随便找一台已连设备」
    expect(body.errorCode).toBe("no_host");
    expect(body.host).toBe("");
  });

  it("旧的全局端点已删除:POST /v1/sendspin/esphome/test → 404", async () => {
    const res = await app.request("/rest/api/v1/sendspin/esphome/test", {
      method: "POST",
      headers: headers(adminId, true),
      body: JSON.stringify({ psk: "whatever" }),
    });
    expect(res.status).toBe(404);
  });

  it("GET /v1/sendspin/esphome 只回逐台快照,不再有全局 enabled/pskConfigured", async () => {
    const res = await app.request("/rest/api/v1/sendspin/esphome", { headers: headers(adminId, true) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.devices)).toBe(true);
    expect(body.enabled).toBeUndefined();
    expect(body.pskConfigured).toBeUndefined();
  });
});
