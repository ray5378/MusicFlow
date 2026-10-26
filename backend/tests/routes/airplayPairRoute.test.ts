// AP2 配对路由(POST /v1/airplay/devices/:deviceId/pair)钉定用例。
//
// 用户规则(2026-10-27):未配对的 AP2 设备不得进组、不得出现在「可选择播放器」,
// 只能在播放器页用设备屏幕上的 4 位 PIN 配对;失败必须给「能照做」的文案,
// 且**写库失败不得静默成功**(ap2-persist ⇒ 500,响应体 success:false)。
//
// 本文件钉路由层契约:入参校验、权限、错误码 → HTTP 状态映射、成功响应形态。
// 配对主流程本身(seed 落库 / 不静默成功 / 分类码)钉在
// tests/airplay/ap2PairService.test.ts(那里 ap2Session 与凭据表都是替身)。
//
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
      // 已配对 AP2:可选
      { id: "ap2-paired", name: "客厅 HomePod", alias: "客厅", available: true, disabled: false, supportsAp2: true, ap2Capable: true, ap2Paired: true, selectable: true },
      // 未配对 AP2:出现在列表里但不可选(可供用户发起配对)
      { id: "ap2-unpaired", name: "书房", alias: "", available: true, disabled: false, supportsAp2: true, ap2Capable: true, ap2Paired: false, selectable: false },
      // AP1-only:不受影响
      { id: "hivi", name: "HiVi", alias: "", available: true, disabled: false, supportsAp2: false, ap2Capable: false, ap2Paired: false, selectable: true },
    ] as any[]),
    pairAirPlayDevice: vi.fn(async () => ({ ok: true })),
    setAirPlayAlias: vi.fn((id: string, alias: string) => (id === "ap2-paired" ? { id, alias } : undefined)),
    setAirPlayDisabled: vi.fn((id: string, disabled: boolean) => (id === "ap2-paired" ? { id, disabled, name: "n", alias: "" } : undefined)),
    deleteAirPlayDeviceRecord: vi.fn((id: string) => id === "ap2-paired"),
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

const pair = (who: "alice" | "bob", deviceId: string, body?: any) =>
  call(who, "POST", `/v1/airplay/devices/${deviceId}/pair`, body);

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
  controlMock.pairAirPlayDevice.mockReset();
  controlMock.pairAirPlayDevice.mockResolvedValue({ ok: true });
});

describe("POST /v1/airplay/devices/:deviceId/pair", () => {
  it("配对成功:200 { ok:true, ap2Paired:true },且 PIN 去空白后交给服务层", async () => {
    const r = await pair("alice", "ap2-unpaired", { pin: " 1234 " });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ ok: true, ap2Paired: true });
    expect(controlMock.pairAirPlayDevice).toHaveBeenCalledWith("ap2-unpaired", "1234");
  });

  it("PIN 错误:400,文案可照做(提示重新输入 4 位码)", async () => {
    controlMock.pairAirPlayDevice.mockResolvedValueOnce({
      ok: false,
      code: "ap2-pin",
      message: "PIN 不正确,请重新输入设备屏幕上显示的 4 位码",
    });
    const r = await pair("alice", "ap2-unpaired", { pin: "9999" });
    expect(r.status, r.text).toBe(400);
    expect(r.body).toMatchObject({ success: false, code: "INVALID_PARAM" });
    expect(r.body.error).toContain("PIN 不正确");
    expect(r.body.error).toContain("4 位码");
  });

  it("失败体带 ap2Code:ap2-pin 与 ap2-unsupported 在 code 上同塌缩成 INVALID_PARAM,但 ap2Code 可区分", async () => {
    // 前端只读 body.ap2Code 分支:error 文案已本地化(英文用户看不到中文),
    // code 又把「PIN 错」和「设备不支持 AP2」压成同一档 —— 只有 ap2Code 能区分。
    controlMock.pairAirPlayDevice.mockResolvedValueOnce({
      ok: false,
      code: "ap2-pin",
      message: "PIN 不正确,请重新输入设备屏幕上显示的 4 位码",
    });
    const pinWrong = await pair("alice", "ap2-unpaired", { pin: "9999" });
    expect(pinWrong.status, pinWrong.text).toBe(400);
    expect(pinWrong.body).toMatchObject({ success: false, code: "INVALID_PARAM", ap2Code: "ap2-pin" });

    controlMock.pairAirPlayDevice.mockResolvedValueOnce({
      ok: false,
      code: "ap2-unsupported",
      message: "该设备不支持 AirPlay 2(未广播 _airplay._tcp),无需配对",
    });
    const unsupported = await pair("alice", "hivi", { pin: "1234" });
    expect(unsupported.status, unsupported.text).toBe(400);
    // 同一个业务 code,但 ap2Code 不同 —— 这正是新增字段的全部意义。
    expect(unsupported.body).toMatchObject({ success: false, code: "INVALID_PARAM", ap2Code: "ap2-unsupported" });
    expect(unsupported.body.ap2Code).not.toBe(pinWrong.body.ap2Code);
  });

  it("设备不支持 AP2(AP1-only)或不存在:400,提示无需配对", async () => {
    controlMock.pairAirPlayDevice.mockResolvedValueOnce({
      ok: false,
      code: "ap2-unsupported",
      message: "该设备不支持 AirPlay 2(未广播 _airplay._tcp),无需配对",
    });
    const r = await pair("alice", "hivi", { pin: "1234" });
    expect(r.status, r.text).toBe(400);
    expect(r.body).toMatchObject({ success: false, code: "INVALID_PARAM" });
    expect(r.body.error).toContain("不支持 AirPlay 2");
  });

  it("设备超时(没进配对态):504", async () => {
    controlMock.pairAirPlayDevice.mockResolvedValueOnce({
      ok: false,
      code: "ap2-timeout",
      message: "设备配对超时,请确认设备屏幕上正显示 4 位码(重新进入配对状态)后重试",
    });
    const r = await pair("alice", "ap2-unpaired", { pin: "1234" });
    expect(r.status, r.text).toBe(504);
    expect(r.body.error).toContain("配对超时");
  });

  it("凭据写库失败:500 且 success:false(绝不静默成功)", async () => {
    controlMock.pairAirPlayDevice.mockResolvedValueOnce({
      ok: false,
      code: "ap2-persist",
      message: "配对已通过但凭据写入失败,该设备仍需重新配对,请检查存储空间后重试",
    });
    const r = await pair("alice", "ap2-unpaired", { pin: "1234" });
    expect(r.status, r.text).toBe(500);
    expect(r.body.success).toBe(false);
    expect(r.body.code).toBe("INTERNAL");
    expect(r.body.ok).toBeUndefined();
  });

  it("协议/网络失败:502(UPSTREAM_ERROR)", async () => {
    controlMock.pairAirPlayDevice.mockResolvedValueOnce({
      ok: false,
      code: "ap2-fail",
      message: "AirPlay 2 配对失败,请重试或重启设备",
    });
    const r = await pair("alice", "ap2-unpaired", { pin: "1234" });
    expect(r.status, r.text).toBe(502);
    expect(r.body).toMatchObject({ success: false, code: "UPSTREAM_ERROR" });
  });

  it("PIN 非 4 位数字:400,且不进入配对流程", async () => {
    for (const body of [{}, { pin: "" }, { pin: "12" }, { pin: "12345" }, { pin: "abcd" }, { pin: 12.34 }]) {
      const r = await pair("alice", "ap2-unpaired", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(controlMock.pairAirPlayDevice).not.toHaveBeenCalled();
  });

  it("权限不足:普通用户 403(与重命名/禁用同权限 renderer.manage),且不进入配对流程", async () => {
    const r = await pair("bob", "ap2-unpaired", { pin: "1234" });
    expect(r.status, r.text).toBe(403);
    expect(controlMock.pairAirPlayDevice).not.toHaveBeenCalled();
  });

  it("设备列表接口不拆端点:未配对 AP2 也在列表里,并带 ap2Capable/ap2Paired/selectable", async () => {
    const r = await call("alice", "GET", "/v1/airplay/devices");
    expect(r.status).toBe(200);
    const byId = Object.fromEntries((r.body.devices as any[]).map((d) => [d.id, d]));
    // 未配对:仍在列表(可发起配对),但不可选(不得进组/不得出现在可选择播放器)
    expect(byId["ap2-unpaired"]).toMatchObject({ ap2Capable: true, ap2Paired: false, selectable: false });
    // 已配对:可选
    expect(byId["ap2-paired"]).toMatchObject({ ap2Capable: true, ap2Paired: true, selectable: true });
    // AP1-only:不受影响
    expect(byId["hivi"]).toMatchObject({ ap2Capable: false, selectable: true });
  });
});
