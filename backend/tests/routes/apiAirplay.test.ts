// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { authMiddleware } from "../../src/middleware/auth.js";

const { airplayState, controlMock, discoveryMock } = vi.hoisted(() => ({
  airplayState: { enabled: true },
  controlMock: {
    isAirPlayEnabled: vi.fn(() => airplayState.enabled),
    listAirPlayDevices: vi.fn(() => [
      { id: "ap1", name: "客厅 HomePod", alias: "客厅", available: true, disabled: false },
      { id: "ap2", name: "书房", alias: "", available: true, disabled: true },
    ] as any[]),
    setAirPlayAlias: vi.fn((id: string, alias: string) => (id === "ap1" ? { id, alias } : undefined)),
    setAirPlayDisabled: vi.fn((id: string, disabled: boolean) => (id === "ap1" ? { id, disabled, name: "n", alias: "" } : undefined)),
    deleteAirPlayDeviceRecord: vi.fn((id: string) => id === "ap1"),
    castToAirPlayDevice: vi.fn(async () => ({ ok: true })),
    stopAirPlaySession: vi.fn(async () => undefined),
    getAirPlayPeerStatus: vi.fn(() => ({ media: { title: "T" } } as any)),
    setAirPlayMuted: vi.fn(async () => undefined),
  },
  discoveryMock: {
    rescanAirPlayDevices: vi.fn(async () => undefined),
  },
}));

vi.mock("../../src/services/airplay/control.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, ...controlMock };
});
vi.mock("../../src/services/airplay/discovery.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, ...discoveryMock };
});

import { registerAirplay } from "../../src/routes/api/airplay.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
const api = new Hono();
registerAirplay(api);
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
  ]).run();
});

beforeEach(() => {
  airplayState.enabled = true;
  controlMock.setAirPlayAlias.mockClear();
  discoveryMock.rescanAirPlayDevices.mockClear();
});

describe("airplay 域:总开关", () => {
  it("服务未启用时全部 /v1/airplay/* 直接 409", async () => {
    airplayState.enabled = false;
    for (const [m, p] of [["GET", "/v1/airplay/devices"], ["GET", "/v1/airplay/active"], ["POST", "/v1/airplay/scan"]] as const) {
      const r = await call("alice", m, p);
      expect(r.status, p).toBe(409);
    }
    const cast = await call("alice", "POST", "/v1/airplay/cast", { songId: "s1", deviceId: "ap1" });
    expect(cast.status).toBe(409);
  });
});

describe("airplay 域:设备列表与重扫", () => {
  it("GET /v1/airplay/devices 管理员看全部,普通用户只见已授权设备", async () => {
    const admin = await call("alice", "GET", "/v1/airplay/devices");
    expect(admin.status).toBe(200);
    expect(admin.body.devices.map((d: any) => d.id)).toEqual(["ap1", "ap2"]);
    // bob 无 renderer.use / 无设备授权 → 空(禁用设备也过滤掉)
    const normal = await call("bob", "GET", "/v1/airplay/devices");
    expect(normal.body.devices).toEqual([]);
  });

  it("POST /v1/airplay/scan 触发 mDNS 重扫并回列表", async () => {
    const r = await call("alice", "POST", "/v1/airplay/scan");
    expect(r.status).toBe(200);
    expect(discoveryMock.rescanAirPlayDevices).toHaveBeenCalled();
    expect(r.body.devices.length).toBe(2);
    const denied = await call("bob", "POST", "/v1/airplay/scan");
    expect(denied.status).toBe(403); // 普通用户无 renderer.use
  });

  it("GET /v1/airplay/active 挂上各设备的 currentMedia", async () => {
    const r = await call("alice", "GET", "/v1/airplay/active");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.active)).toBe(true);
  });
});

describe("airplay 域:设备管理", () => {
  it("PUT /v1/airplay/devices/:deviceId 别名长度校验 / 设备不存在 / 成功", async () => {
    const long = await call("alice", "PUT", "/v1/airplay/devices/ap1", { alias: "x".repeat(51) });
    expect(long.status).toBe(400);
    const missing = await call("alice", "PUT", "/v1/airplay/devices/nope", { alias: "nm" });
    expect(missing.status).toBe(404);
    const ok = await call("alice", "PUT", "/v1/airplay/devices/ap1", { alias: "  客厅音箱  " });
    expect(ok.body).toMatchObject({ success: true, device: { id: "ap1", alias: "客厅音箱" } });
    expect(controlMock.setAirPlayAlias).toHaveBeenCalledWith("ap1", "客厅音箱");
  });

  it("DELETE /v1/airplay/devices/:deviceId 清队列+peer+会话,不存在 404", async () => {
    const missing = await call("alice", "DELETE", "/v1/airplay/devices/nope");
    expect(missing.status).toBe(404);
    const ok = await call("alice", "DELETE", "/v1/airplay/devices/ap1");
    expect(ok.status, ok.text.slice(0, 200)).toBe(200);
    expect(ok.body).toMatchObject({ success: true });
    expect(controlMock.stopAirPlaySession).toHaveBeenCalledWith("ap1");
  });

  it("PUT /v1/airplay/devices/:deviceId/disabled 禁用停播清队列,启用只写状态", async () => {
    const on = await call("alice", "PUT", "/v1/airplay/devices/ap1/disabled", { disabled: true });
    expect(on.body).toMatchObject({ success: true, disabled: true, device: { id: "ap1", disabled: true } });
    const off = await call("alice", "PUT", "/v1/airplay/devices/ap1/disabled", { disabled: false });
    expect(off.body).toMatchObject({ success: true, disabled: false });
    const missing = await call("alice", "PUT", "/v1/airplay/devices/nope/disabled", { disabled: true });
    expect(missing.status).toBe(404);
  });

  it("设备子路径受播放器授权中间件保护(普通用户 403)", async () => {
    const r = await call("bob", "PUT", "/v1/airplay/devices/ap1/disabled", { disabled: true });
    expect(r.status).toBe(403);
  });
});

describe("airplay 域:投放", () => {
  it("POST /v1/airplay/cast 缺参数 400", async () => {
    expect((await call("alice", "POST", "/v1/airplay/cast", {})).status).toBe(400);
    expect((await call("alice", "POST", "/v1/airplay/cast", { songId: "s1" })).status).toBe(400);
  });

  it("POST /v1/airplay/cast 普通用户无设备授权 403", async () => {
    const r = await call("bob", "POST", "/v1/airplay/cast", { songId: "s1", deviceId: "ap1" });
    expect(r.status).toBe(403);
  });

  it("[D10] POST /v1/airplay/cast 管理员成功;上游失败 -> 502(原写 500,与 UPSTREAM_ERROR 映射打架)", async () => {
    const ok = await call("alice", "POST", "/v1/airplay/cast", { songId: "s1", deviceId: "ap1" });
    expect(ok.body).toMatchObject({ success: true });
    expect(controlMock.castToAirPlayDevice).toHaveBeenCalled();
    controlMock.castToAirPlayDevice.mockRejectedValueOnce(new Error("raop refused"));
    const bad = await call("alice", "POST", "/v1/airplay/cast", { songId: "s2", deviceId: "ap1" });
    expect(bad.status).toBe(502);
    expect(bad.body).toMatchObject({ success: false, code: "UPSTREAM_ERROR" });
    expect(bad.body.error).toContain("raop refused");
  });
});
