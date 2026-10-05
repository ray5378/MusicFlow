// routes/api/sendspin.ts 路由层契约测试(18 条路由)。
//
// 重点在**安全语义**与**错误契约**:
//  - ESPHome 密钥回显分级:明文 psk 只回给有 RENDERER_MANAGE 的账号,设备列表端点永不回显;
//  - 配对/拨号端点的 404(未启用)/400(参数)/502(上游) 三态;
//  - 拨号目标的 host 白名单(禁止注入 ws:// 之外的东西)。
// 服务层用假体,路由层自己的分支全部走真路径。
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";

vi.mock("../../src/routes/api/shared.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { overrides } = await import("./_sharedFakes.js");
  return { ...actual, ...overrides };
});

vi.mock("../../src/services/sendspin/deviceState.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { sf } = await import("./_sendspinFakes.js");
  return { ...actual, ...sf };
});
vi.mock("../../src/services/sendspin/index.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { sf } = await import("./_sendspinFakes.js");
  return { ...actual, ...sf };
});
vi.mock("../../src/services/sendspin/esphomeBridge.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { sf } = await import("./_sendspinFakes.js");
  return { ...actual, ...sf };
});

import { registerSendspin } from "../../src/routes/api/sendspin.js";
import { fns, resetFakes } from "./_sharedFakes.js";
import { sf, resetSendspinFakes } from "./_sendspinFakes.js";

type Any = any;

let currentUser: Any = { id: "u-admin", isAdmin: true };

const app = new Hono();
app.use("*", async (c, next) => {
  if (currentUser) c.set("user", currentUser);
  await next();
});
registerSendspin(app);

const post = (p: string, body?: unknown) =>
  app.request(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
const put = (p: string, body?: unknown) =>
  app.request(p, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
const del = (p: string, body?: unknown) =>
  app.request(p, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
const get = (p: string) => app.request(p);

/** 造一个受控的 sendspin 服务实例并交给 sendspinServerOr404。 */
function makeSrv(over: Any = {}) {
  const store = {
    getRecord: vi.fn(() => undefined as Any),
    isApproved: vi.fn(() => false),
    setApproved: vi.fn(async () => undefined),
    removeRecord: vi.fn(async () => true),
  };
  const pairing = {
    listAttempts: vi.fn(() => [] as Any[]),
    getAttempt: vi.fn(() => null as Any),
    start: vi.fn(async () => undefined),
    enterCode: vi.fn(async () => undefined),
    pairWithToken: vi.fn(async () => undefined),
    cancel: vi.fn(),
  };
  const srv = {
    port: 8928,
    serverId: "srv-1",
    clients: new Map<string, Any>(),
    pairingStore: store,
    pairing,
    dialPlayer: vi.fn(async () => ({ clientId: "c9", name: "音箱" })),
    clearNoRedial: vi.fn(),
    // 开环健康(ok / degraded / stalled):路由给在线连接行回 streamHealth。
    sinkHealthOf: vi.fn(() => "ok"),
    ...over,
  };
  fns.sendspinServerOr404.mockReturnValue(srv);
  return { srv, store, pairing };
}

function conn(over: Any = {}) {
  return {
    clientId: "c1", name: "客厅", roles: ["player@v1"], legacy: false,
    remoteHost: "192.168.1.9", dialed: false, dialHost: "", dialPort: 0,
    volume: 80, muted: false, ...over,
  };
}

beforeEach(() => {
  resetFakes();
  resetSendspinFakes();
  currentUser = { id: "u-admin", isAdmin: true };
});

// ==================== GET /v1/sendspin/clients ====================

describe("GET /v1/sendspin/clients", () => {
  it("服务未启用 → 空表 + enabled:false(前端据此隐藏整块)", async () => {
    fns.sendspinServerOr404.mockReturnValue(null);
    const r = await get("/v1/sendspin/clients");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ clients: [], enabled: false });
  });

  it("在线连接逐字段映射:配对记录 / 禁用标记 / 拨号来源 / pairing attempt", async () => {
    const { srv, store, pairing } = makeSrv();
    srv.clients.set("c1", conn({ dialed: true, dialHost: "10.0.0.2", dialPort: 8928 }));
    store.getRecord.mockReturnValue({ createdAt: 11, lastUsedAt: 22 });
    store.isApproved.mockReturnValue(true);
    pairing.getAttempt.mockReturnValue({ clientId: "c1", method: "digits" });
    sf.getDeviceDisabled.mockReturnValue(true);

    const b = await (await get("/v1/sendspin/clients")).json() as Any;
    expect(b.enabled).toBe(true);
    expect(b.port).toBe(8928);
    expect(b.clients).toHaveLength(1);
    const row = b.clients[0];
    expect(row.clientId).toBe("c1");
    expect(row.name).toBe("客厅");
    expect(row.paired).toBe(true);
    expect(row.pairedAt).toBe(11);
    expect(row.lastUsedAt).toBe(22);
    expect(row.approved).toBe(true);
    expect(row.disabled).toBe(true);
    expect(row.dialed).toBe(true);
    expect(row.host).toBe("10.0.0.2");
    expect(row.port).toBe(8928);
    expect(row.pairing).toEqual({ clientId: "c1", method: "digits" });
  });

  it("无配对记录时 paired/approved 为 false、时间戳为 null;未拨号时 host 空串 port 0", async () => {
    const { srv } = makeSrv();
    srv.clients.set("c2", conn({ clientId: "c2", name: "", dialed: false }));
    const b = await (await get("/v1/sendspin/clients")).json() as Any;
    const row = b.clients[0];
    expect(row.name).toBe("c2"); // name 空 → 回落 clientId
    expect(row.paired).toBe(false);
    expect(row.pairedAt).toBeNull();
    expect(row.lastUsedAt).toBeNull();
    expect(row.approved).toBe(false);
    expect(row.dialed).toBe(false);
    expect(row.host).toBe("");
    expect(row.port).toBe(0);
    expect(row.pairing).toBeNull();
  });

  it("clientId 为 null 的连接被过滤掉(未完成握手的连接不该出现在设备列表)", async () => {
    const { srv } = makeSrv();
    srv.clients.set("x", conn({ clientId: null }));
    srv.clients.set("c1", conn());
    const b = await (await get("/v1/sendspin/clients")).json() as Any;
    expect(b.clients.map((r: Any) => r.clientId)).toEqual(["c1"]);
  });

  it("pairingStore 缺失时不抛(paired/approved 走 false 兜底)", async () => {
    const { srv } = makeSrv({ pairingStore: null });
    srv.clients.set("c1", conn());
    const b = await (await get("/v1/sendspin/clients")).json() as Any;
    expect(b.clients[0].paired).toBe(false);
    expect(b.clients[0].approved).toBe(false);
  });

  it("ESPHome 索引:按 clientId 给「是否填了密钥 + 端口」,按 host 对齐桥接快照", async () => {
    const { srv } = makeSrv();
    srv.clients.set("c1", conn({ remoteHost: "192.168.1.9" }));
    sf.listEsphomeCreds.mockReturnValue([{ clientId: "c1", port: "6054" }, { clientId: "cX", port: 0 }]);
    sf.sendspinEsphomeStatus.mockResolvedValue({
      devices: [{ host: "192.168.1.9", connected: true, players: [{ volume: 0.42, muted: true }] }],
    });
    const b = await (await get("/v1/sendspin/clients")).json() as Any;
    expect(b.clients[0].esphome).toEqual({ pskConfigured: true, port: 6054, connected: true, volume: 42, muted: true });
  });

  it("ESPHome 索引:端口非法回落 6053;未连上时 connected=false / volume=null", async () => {
    const { srv } = makeSrv();
    srv.clients.set("c1", conn());
    sf.listEsphomeCreds.mockReturnValue([{ clientId: "c1", port: "abc" }]);
    const b = await (await get("/v1/sendspin/clients")).json() as Any;
    const e = b.clients[0].esphome;
    expect(e.port).toBe(6053);
    expect(e.connected).toBe(false);
    expect(e.volume).toBeNull();
    expect(e.muted).toBe(false);
  });

  it("读 ESPHome 状态抛错时被吞:设备行照常返回,只是都显示未连上", async () => {
    const { srv } = makeSrv();
    srv.clients.set("c1", conn());
    sf.sendspinEsphomeStatus.mockRejectedValue(new Error("桥接子进程未起"));
    const b = await (await get("/v1/sendspin/clients")).json() as Any;
    expect(b.clients).toHaveLength(1);
    expect(b.clients[0].esphome.connected).toBe(false);
  });

  it("设备列表绝不回显 PSK(只有 pskConfigured 布尔)", async () => {
    const { srv } = makeSrv();
    srv.clients.set("c1", conn());
    sf.listEsphomeCreds.mockReturnValue([{ clientId: "c1", port: 6053 }]);
    sf.getDeviceEsphome.mockReturnValue({ psk: "SECRET123", port: 6053 });
    const b = await (await get("/v1/sendspin/clients")).json() as Any;
    expect(b.clients[0].esphome.pskConfigured).toBe(true);
    expect(b.clients[0].esphome).not.toHaveProperty("psk");
    expect(JSON.stringify(b)).not.toContain("SECRET123");
  });

  it("已禁用但当前离线的设备补回列表(否则用户再无入口把它启用)", async () => {
    const { srv } = makeSrv();
    srv.clients.set("c1", conn());
    sf.listDisabledDeviceIds.mockReturnValue(["c1", "offline-1"]);
    const b = await (await get("/v1/sendspin/clients")).json() as Any;
    expect(b.clients.map((r: Any) => r.clientId)).toEqual(["c1", "offline-1"]);
    const off = b.clients[1];
    expect(off.offline).toBe(true);
    expect(off.disabled).toBe(true);
    expect(off.roles).toEqual([]);
    expect(off.dialed).toBe(false);
    expect(off.pairing).toBeNull();
  });
});

// ==================== PUT /v1/sendspin/devices/:clientId/disabled ====================

describe("PUT /v1/sendspin/devices/:clientId/disabled", () => {
  it("设备不存在(服务返回 false)→ 404", async () => {
    sf.sendspinSetDisabled.mockResolvedValue(false);
    const r = await put("/v1/sendspin/devices/ghost/disabled", { disabled: true });
    expect(r.status).toBe(404);
    expect((await r.json() as Any).code).toBe("NOT_FOUND");
  });

  it("成功 → 广播设备列表变化", async () => {
    const emit = vi.fn();
    fns.getEventManager.mockReturnValue({ getEventState: () => null, emitDeviceListChanged: emit });
    fns.getCachedDevices.mockReturnValue([devRow()]);
    const r = await put("/v1/sendspin/devices/c1/disabled", { disabled: true });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ success: true, disabled: true });
    expect(sf.sendspinSetDisabled).toHaveBeenCalledWith("c1", true);
    expect(emit).toHaveBeenCalledWith(1);
  });

  it("缺 disabled 字段 → 视为启用", async () => {
    await put("/v1/sendspin/devices/c1/disabled", {});
    expect(sf.sendspinSetDisabled).toHaveBeenCalledWith("c1", false);
  });

  it("广播抛错被吞(禁用状态已落库,不因 WS 失败而报错)", async () => {
    fns.getEventManager.mockReturnValue({
      getEventState: () => null,
      emitDeviceListChanged: vi.fn(() => { throw new Error("ws hub 未起"); }),
    });
    const r = await put("/v1/sendspin/devices/c1/disabled", { disabled: true });
    expect(r.status).toBe(200);
  });
});

function devRow(over: Any = {}) {
  return { id: "d1", name: "n", alias: "", manufacturer: "", model: "", renderingControlUrl: "", available: true, disabled: false, ...over };
}

// ==================== ESPHome 密钥端点 ====================

describe("GET /v1/sendspin/devices/:clientId/esphome", () => {
  it("管理员 → 回显明文 psk 与真实端口", async () => {
    sf.getDeviceEsphome.mockReturnValue({ psk: "SECRET123", port: 6054 });
    sf.sendspinGetEsphomeVolume.mockResolvedValue({ volume: 55, muted: true });
    const b = await (await get("/v1/sendspin/devices/c1/esphome")).json() as Any;
    expect(b).toEqual({ pskConfigured: true, psk: "SECRET123", port: 6054, connected: true, volume: 55, muted: true });
  });

  it("无 RENDERER_MANAGE 的账号 → psk 为 null(只给布尔)", async () => {
    currentUser = { id: "u-pleb", isAdmin: false };
    fns.hasPerm.mockReturnValue(false);
    sf.getDeviceEsphome.mockReturnValue({ psk: "SECRET123", port: 6053 });
    const b = await (await get("/v1/sendspin/devices/c1/esphome")).json() as Any;
    expect(b.pskConfigured).toBe(true);
    expect(b.psk).toBeNull();
  });

  it("未填密钥 / 设备未连上 → pskConfigured=false、端口回落 6053、connected=false", async () => {
    sf.getDeviceEsphome.mockReturnValue({ psk: "", port: 0 });
    const b = await (await get("/v1/sendspin/devices/c1/esphome")).json() as Any;
    expect(b.pskConfigured).toBe(false);
    // 有权限但未配置 → 空串(「给了,是空的」);无权限才是 null(「不给」)。两者不可混同。
    expect(b.psk).toBe("");
    expect(b.port).toBe(6053);
    expect(b.connected).toBe(false);
    expect(b.volume).toBeNull();
    expect(b.muted).toBe(false);
  });
});

describe("PUT /v1/sendspin/devices/:clientId/esphome(保存密钥)", () => {
  it("psk 前后空白被 trim;合法端口原样落库;在线时回 online:true", async () => {
    sf.sendspinSaveEsphomeCreds.mockResolvedValue({ host: "192.168.1.9" });
    const r = await put("/v1/sendspin/devices/c1/esphome", { psk: "  KEY  ", port: 6054 });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ success: true, host: "192.168.1.9", online: true });
    expect(sf.sendspinSaveEsphomeCreds).toHaveBeenCalledWith("c1", "KEY", 6054);
  });

  it("端口越界/非整数 → 落 0(交服务层用默认值);psk 非字符串 → 空串(=撤销)", async () => {
    for (const [port, want] of [[70000, 0], [0, 0], [1.5, 0], ["x", 0], [undefined, 0], [65535, 65535]] as Any[]) {
      sf.sendspinSaveEsphomeCreds.mockClear();
      await put("/v1/sendspin/devices/c1/esphome", { psk: 123, port });
      expect(sf.sendspinSaveEsphomeCreds).toHaveBeenCalledWith("c1", "", want);
    }
  });

  it("设备离线 → host 空串、online:false(密钥已落库,等重连自动带上)", async () => {
    sf.sendspinSaveEsphomeCreds.mockResolvedValue({ host: "" });
    const b = await (await put("/v1/sendspin/devices/c1/esphome", { psk: "K" })).json() as Any;
    expect(b).toEqual({ success: true, host: "", online: false });
  });
});

describe("POST /v1/sendspin/devices/:clientId/esphome/test(一次性探针)", () => {
  it("未传 psk/port → 取落库值,端口落库为空时用 ESPHOME_API_PORT", async () => {
    sf.getDeviceEsphome.mockReturnValue({ psk: "DBKEY", port: 0 });
    sf.resolveEsphomeHost.mockReturnValue("192.168.1.9");
    sf.probeEsphome.mockResolvedValue({ ok: true, code: "" });
    const r = await post("/v1/sendspin/devices/c1/esphome/test", {});
    expect(r.status).toBe(200);
    expect(sf.probeEsphome).toHaveBeenCalledWith("192.168.1.9", "DBKEY", 6053, 10_000);
  });

  it("显式传 psk 时优先用传入值(测试不该改变常态连接)", async () => {
    sf.getDeviceEsphome.mockReturnValue({ psk: "DBKEY", port: 6054 });
    const r = await post("/v1/sendspin/devices/c1/esphome/test", { psk: "  NEW  ", port: 6055 });
    expect(r.status).toBe(200);
    expect(sf.probeEsphome.mock.calls[0][1]).toBe("NEW");
    expect(sf.probeEsphome.mock.calls[0][2]).toBe(6055);
  });

  it("显式传空串 ⇒ 按空密钥探测(不回落库里的旧密钥)", async () => {
    sf.getDeviceEsphome.mockReturnValue({ psk: "DBKEY", port: 6053 });
    await post("/v1/sendspin/devices/c1/esphome/test", { psk: "" });
    expect(sf.probeEsphome.mock.calls[0][1]).toBe("");
  });

  it("设备离线(host 空)→ 探针以 no_host 失败,但仍是 200(测试语义不 5xx)", async () => {
    sf.resolveEsphomeHost.mockReturnValue("");
    sf.probeEsphome.mockResolvedValue({ ok: false, code: "no_host" });
    const r = await post("/v1/sendspin/devices/c1/esphome/test", {});
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: false, code: "no_host" });
  });

  it("端口非法时回落落库端口(而非 6053)", async () => {
    sf.getDeviceEsphome.mockReturnValue({ psk: "K", port: 6054 });
    await post("/v1/sendspin/devices/c1/esphome/test", { port: 99999 });
    expect(sf.probeEsphome.mock.calls[0][2]).toBe(6054);
  });
});

describe("PUT .../esphome/volume 与 /muted(写设备硬件旋钮)", () => {
  it("volume 非数字/缺失 → 400,不下发", async () => {
    for (const body of [{}, { volume: "50" }, { volume: null }]) {
      expect((await put("/v1/sendspin/devices/c1/esphome/volume", body)).status).toBe(400);
    }
    expect(sf.sendspinSetEsphomeVolume).not.toHaveBeenCalled();
  });

  it("volume 钳到 0..100 并取整", async () => {
    for (const [raw, want] of [[150, 100], [-20, 0], [33.6, 34], [0, 0], [100, 100]] as Any[]) {
      await put("/v1/sendspin/devices/c1/esphome/volume", { volume: raw });
      expect(sf.sendspinSetEsphomeVolume).toHaveBeenLastCalledWith("c1", want);
    }
  });

  it("volume 失败不 5xx:透传机器可读 code 给前端映射文案", async () => {
    sf.sendspinSetEsphomeVolume.mockResolvedValue({ ok: false, code: "no-bridge", sent: false });
    const b = await (await put("/v1/sendspin/devices/c1/esphome/volume", { volume: 50 })).json() as Any;
    expect(b).toEqual({ success: false, code: "no-bridge", sent: false, volume: 50 });
  });

  it("muted 非布尔 → 400;布尔透传", async () => {
    expect((await put("/v1/sendspin/devices/c1/esphome/muted", { muted: 1 })).status).toBe(400);
    sf.sendspinSetEsphomeMuted.mockResolvedValue({ ok: true, code: "", sent: true });
    const b = await (await put("/v1/sendspin/devices/c1/esphome/muted", { muted: false })).json() as Any;
    expect(b).toEqual({ success: true, code: "", sent: true, muted: false });
    expect(sf.sendspinSetEsphomeMuted).toHaveBeenCalledWith("c1", false);
  });
});

describe("GET /v1/sendspin/esphome(聚合快照)", () => {
  it("回 devices 数组(排障用)", async () => {
    sf.sendspinEsphomeStatus.mockResolvedValue({ devices: [{ host: "a", connected: true }] });
    const b = await (await get("/v1/sendspin/esphome")).json() as Any;
    expect(b.devices).toHaveLength(1);
  });

  it("服务返回空 devices 时给空数组而非 undefined", async () => {
    sf.sendspinEsphomeStatus.mockResolvedValue({ devices: [] });
    expect(await (await get("/v1/sendspin/esphome")).json()).toEqual({ devices: [] });
  });
});

// ==================== 配对端点 ====================

describe("配对端点(未启用 / 参数 / 上游三态)", () => {
  it("未启用(pairing 为 null)→ 404", async () => {
    makeSrv({ pairing: null });
    for (const p of ["/start", "/code", "/token", "/cancel"]) {
      const r = await post(`/v1/sendspin/pairing${p}`, { clientId: "c1" });
      expect(r.status, p).toBe(404);
      expect((await r.json() as Any).code).toBe("NOT_FOUND");
    }
  });

  it("service 完全未运行 → attempts 空表 + enabled:false", async () => {
    fns.sendspinServerOr404.mockReturnValue(null);
    expect(await (await get("/v1/sendspin/pairing/attempts")).json()).toEqual({ attempts: [], enabled: false });
  });

  it("attempts:pairing 存在时透传 listAttempts", async () => {
    const { pairing } = makeSrv();
    pairing.listAttempts.mockReturnValue([{ clientId: "c1" }]);
    const b = await (await get("/v1/sendspin/pairing/attempts")).json() as Any;
    expect(b.enabled).toBe(true);
    expect(b.attempts).toHaveLength(1);
  });

  it("attempts:pairing 为 null 时给空数组(不炸)", async () => {
    makeSrv({ pairing: null });
    expect(await (await get("/v1/sendspin/pairing/attempts")).json()).toEqual({ attempts: [], enabled: true });
  });

  it("start:缺 clientId → 400;format 非法 → 400;缺 format 默认 digits", async () => {
    const { pairing } = makeSrv();
    expect((await post("/v1/sendspin/pairing/start", {})).status).toBe(400);
    expect((await post("/v1/sendspin/pairing/start", { clientId: "c1", format: "sms" })).status).toBe(400);
    expect(pairing.start).not.toHaveBeenCalled();

    expect((await post("/v1/sendspin/pairing/start", { clientId: "c1", method: "code" })).status).toBe(200);
    expect(pairing.start).toHaveBeenCalledWith("c1", "code", "digits");
  });

  it("start:显式 qr_code 透传;上游抛错 → 502", async () => {
    const { pairing } = makeSrv();
    await post("/v1/sendspin/pairing/start", { clientId: "c1", method: "code", format: "qr_code" });
    expect(pairing.start).toHaveBeenCalledWith("c1", "code", "qr_code");

    pairing.start.mockRejectedValue(new Error("设备拒绝配对"));
    const r = await post("/v1/sendspin/pairing/start", { clientId: "c1", method: "code" });
    expect(r.status).toBe(502);
    expect((await r.json() as Any).code).toBe("UPSTREAM_ERROR");
  });

  it("start:上游抛空 message → 回落 i18n key(渲染后非空)", async () => {
    const { pairing } = makeSrv();
    pairing.start.mockRejectedValue(new Error(""));
    const r = await post("/v1/sendspin/pairing/start", { clientId: "c1", method: "code" });
    expect(r.status).toBe(502);
    const b = await r.json() as Any;
    expect(b.code).toBe("UPSTREAM_ERROR");
    expect(b.error.length).toBeGreaterThan(0);
  });

  it("token:上游抛空 message → 回落 i18n key(渲染后非空)", async () => {
    const { pairing } = makeSrv();
    pairing.pairWithToken.mockRejectedValue(new Error(""));
    const r = await post("/v1/sendspin/pairing/token", { clientId: "c1", token: "t" });
    expect(r.status).toBe(502);
    const b = await r.json() as Any;
    expect(b.code).toBe("UPSTREAM_ERROR");
    expect(b.error.length).toBeGreaterThan(0);
  });

  it("clientId 空段请求不落入处理器(路由不匹配防御分支保持不可达)", async () => {
    makeSrv();
    // `/devices//esphome` 这类空段路径不应匹配 :clientId —— 处理器里的
    // `if (!clientId)` 是纯防御,正常路由永远拿不到空串。
    const r = await get("/v1/sendspin/devices//esphome");
    expect(r.status).toBe(404);
  });

  it("code:缺 clientId 或 code → 400;成功透传", async () => {
    const { pairing } = makeSrv();
    expect((await post("/v1/sendspin/pairing/code", { clientId: "c1" })).status).toBe(400);
    expect((await post("/v1/sendspin/pairing/code", { code: "1234" })).status).toBe(400);
    expect((await post("/v1/sendspin/pairing/code", { clientId: "c1", code: "1234" })).status).toBe(200);
    expect(pairing.enterCode).toHaveBeenCalledWith("c1", "1234");
  });

  it("code:上游抛错 → 502", async () => {
    const { pairing } = makeSrv();
    pairing.enterCode.mockRejectedValue(new Error(""));
    const r = await post("/v1/sendspin/pairing/code", { clientId: "c1", code: "1" });
    expect(r.status).toBe(502);
    expect((await r.json() as Any).error.length).toBeGreaterThan(0);
  });

  it("token:缺参 → 400;成功;上游抛错 → 502", async () => {
    const { pairing } = makeSrv();
    expect((await post("/v1/sendspin/pairing/token", { clientId: "c1" })).status).toBe(400);
    expect((await post("/v1/sendspin/pairing/token", { clientId: "c1", token: "t" })).status).toBe(200);
    expect(pairing.pairWithToken).toHaveBeenCalledWith("c1", "t");
    pairing.pairWithToken.mockRejectedValue(new Error("token 过期"));
    expect((await post("/v1/sendspin/pairing/token", { clientId: "c1", token: "t" })).status).toBe(502);
  });

  it("cancel:缺 clientId → 400;成功是同步 void(不 await)", async () => {
    const { pairing } = makeSrv();
    expect((await post("/v1/sendspin/pairing/cancel", {})).status).toBe(400);
    expect((await post("/v1/sendspin/pairing/cancel", { clientId: "c1" })).status).toBe(200);
    expect(pairing.cancel).toHaveBeenCalledWith("c1");
  });
});

describe("POST /v1/sendspin/approve 与 /unpair", () => {
  it("approve:无 pairingStore → 404;缺 clientId → 400", async () => {
    makeSrv({ pairingStore: null });
    expect((await post("/v1/sendspin/approve", { clientId: "c1" })).status).toBe(404);

    const { store } = makeSrv();
    expect((await post("/v1/sendspin/approve", {})).status).toBe(400);
    expect(store.setApproved).not.toHaveBeenCalled();
  });

  it("approve:approved 缺省视为 true,显式 false 才拒绝", async () => {
    const { store } = makeSrv();
    await post("/v1/sendspin/approve", { clientId: "c1" });
    expect(store.setApproved).toHaveBeenCalledWith("c1", true);
    await post("/v1/sendspin/approve", { clientId: "c1", approved: false });
    expect(store.setApproved).toHaveBeenLastCalledWith("c1", false);
  });

  it("unpair:无 pairingStore → 404;缺 clientId → 400;成功调用 sendspinUnpair", async () => {
    makeSrv({ pairingStore: null });
    expect((await post("/v1/sendspin/unpair", { clientId: "c1" })).status).toBe(404);

    makeSrv();
    expect((await post("/v1/sendspin/unpair", {})).status).toBe(400);
    const r = await post("/v1/sendspin/unpair", { clientId: "c1" });
    expect(r.status).toBe(200);
    expect(sf.sendspinUnpair).toHaveBeenCalledWith("c1");
  });
});

// ==================== 拨号 ====================

describe("POST /v1/sendspin/dial", () => {
  it("服务未启用 → 404", async () => {
    fns.sendspinServerOr404.mockReturnValue(null);
    expect((await post("/v1/sendspin/dial", { host: "1.2.3.4" })).status).toBe(404);
  });

  it("host 为空 / 端口越界 / 端口非整数 → 400,且不发起连接", async () => {
    const { srv } = makeSrv();
    for (const body of [{}, { host: "" }, { host: "1.2.3.4", port: 0 }, { host: "1.2.3.4", port: 70000 }, { host: "1.2.3.4", port: "x" }, { host: "1.2.3.4", port: 1.5 }]) {
      expect((await post("/v1/sendspin/dial", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(srv.dialPlayer).not.toHaveBeenCalled();
  });

  it("host 含非法字符 → 400(禁止拼出 ws:// 之外的东西)", async () => {
    const { srv } = makeSrv();
    for (const host of ["a b", "a/b", "a?b", "http://x", "a;b"]) {
      expect((await post("/v1/sendspin/dial", { host })).status, host).toBe(400);
    }
    expect(srv.dialPlayer).not.toHaveBeenCalled();
  });

  it("host 允许字符集(a-z A-Z 0-9 . - _ :)均放行", async () => {
    const { srv } = makeSrv();
    for (const host of ["192.168.1.50", "fe80::1", "my_host.local", "A-B.C"]) {
      await post("/v1/sendspin/dial", { host, port: 8928 });
    }
    expect(srv.dialPlayer).toHaveBeenCalledTimes(4);
  });

  it("端口缺省 8928;成功后清重拨抑制 + 记住目标", async () => {
    const { srv } = makeSrv();
    const r = await post("/v1/sendspin/dial", { host: "192.168.1.50" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ success: true, clientId: "c9", name: "音箱" });
    expect(srv.dialPlayer).toHaveBeenCalledWith("ws://192.168.1.50:8928/sendspin");
    expect(srv.clearNoRedial).toHaveBeenCalledWith("192.168.1.50", 8928);
    expect(sf.rememberDialTarget).toHaveBeenCalledWith("192.168.1.50", 8928);
  });

  it("记住目标失败不影响已建连接(仍 200)", async () => {
    makeSrv();
    sf.rememberDialTarget.mockRejectedValue(new Error("DB 只读"));
    const r = await post("/v1/sendspin/dial", { host: "1.2.3.4" });
    expect(r.status).toBe(200);
  });

  it("上游拨号失败 → 502;空 message 回落 i18n key", async () => {
    const { srv } = makeSrv();
    srv.dialPlayer.mockRejectedValue(new Error("Noise 握手超时"));
    const r = await post("/v1/sendspin/dial", { host: "1.2.3.4" });
    expect(r.status).toBe(502);
    expect((await r.json() as Any).code).toBe("UPSTREAM_ERROR");

    srv.dialPlayer.mockRejectedValue(new Error(""));
    const r2 = await post("/v1/sendspin/dial", { host: "1.2.3.4" });
    expect((await r2.json() as Any).error.length).toBeGreaterThan(0);
  });
});

describe("拨号目标(dial-targets)", () => {
  it("GET:服务未启用 → 空表 + enabled:false", async () => {
    fns.sendspinServerOr404.mockReturnValue(null);
    expect(await (await get("/v1/sendspin/dial-targets")).json()).toEqual({ targets: [], enabled: false });
  });

  it("GET:按「host:port 是否在已拨号连接里」标注 online", async () => {
    const { srv } = makeSrv();
    srv.clients.set("a", conn({ clientId: "a", dialed: true, dialHost: "10.0.0.2", dialPort: 8928 }));
    srv.clients.set("b", conn({ clientId: "b", dialed: false, dialHost: "10.0.0.9", dialPort: 8928 }));
    sf.listDialTargets.mockResolvedValue([
      { host: "10.0.0.2", port: 8928 },
      { host: "10.0.0.9", port: 8928 },
      { host: "10.0.0.3", port: 8928 },
    ]);
    const b = await (await get("/v1/sendspin/dial-targets")).json() as Any;
    expect(b.targets.map((t: Any) => t.online)).toEqual([true, false, false]);
  });

  it("DELETE:服务未启用 → 404;host/port 非法 → 400", async () => {
    fns.sendspinServerOr404.mockReturnValue(null);
    expect((await del("/v1/sendspin/dial-targets", { host: "1.2.3.4", port: 8928 })).status).toBe(404);

    makeSrv();
    for (const body of [{}, { host: "1.2.3.4" }, { host: "", port: 1 }, { host: "1.2.3.4", port: 1.5 }]) {
      expect((await del("/v1/sendspin/dial-targets", body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("DELETE:目标不存在 → 404;存在 → 200", async () => {
    makeSrv();
    sf.forgetDialTarget.mockResolvedValue(false);
    expect((await del("/v1/sendspin/dial-targets", { host: "1.2.3.4", port: 8928 })).status).toBe(404);
    sf.forgetDialTarget.mockResolvedValue(true);
    const r = await del("/v1/sendspin/dial-targets", { host: "1.2.3.4", port: 8928 });
    expect(r.status).toBe(200);
    expect(sf.forgetDialTarget).toHaveBeenCalledWith("1.2.3.4", 8928);
  });
});
