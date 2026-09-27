// routes/api/dlna.ts 路由层契约测试。
//
// 只测**路由层自己的逻辑**:参数校验(400)、找不到(404)、禁用(403)、上游失败映射(500/502)、
// 响应形状、以及「该调用的服务函数到底有没有被调用、参数对不对」。
// 服务层行为由各自的单测覆盖 —— 所以这里把 shared.ts 的服务入口换成 vi.fn()。
//
// 价值点:这些 400/404/500 分支是**错误契约的落点**,却恰好是最难用真实设备触发的一批
// (要真让 DLNA 设备掉线、真让 ffmpeg 失败),不换假体就只能长期零覆盖。
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../src/routes/api/shared.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { overrides } = await import("./_sharedFakes.js");
  return { ...actual, ...overrides };
});

import { db, initDatabase } from "../../src/db/index.js";
import { songs } from "../../src/db/schema.js";
import { registerDlna } from "../../src/routes/api/dlna.js";
import { fns, resetFakes } from "./_sharedFakes.js";

type Any = any;

let currentUser: Any = undefined;

const app = new Hono();
// 用户上下文注入:真实链路里由 authMiddleware 提供;这里按用例切换 admin / 普通用户。
app.use("*", async (c, next) => {
  if (currentUser) c.set("user", currentUser);
  await next();
});
registerDlna(app);

const admin = { id: "u-admin", isAdmin: true, username: "admin" };
const pleb = { id: "u-pleb", isAdmin: false, username: "pleb" };

const post = (p: string, body?: unknown) =>
  app.request(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
const put = (p: string, body?: unknown) =>
  app.request(p, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
const del = (p: string, body?: unknown) =>
  app.request(p, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
const get = (p: string) => app.request(p);

function dev(over: Any = {}) {
  return {
    id: "dev1", name: "客厅音箱", alias: "", manufacturer: "MUZO", model: "H5MKII",
    renderingControlUrl: "http://192.168.10.30:49152/rcs", available: true, disabled: false,
    ...over,
  };
}

let tmpDir = "";

function seedSong(over: Any = {}) {
  const id = uuidv4();
  db.insert(songs).values({
    id,
    title: `dlna-${id.slice(0, 6)}`,
    path: "l:t:/nonexistent/x.mp3",
    type: "local",
    suffix: "mp3",
    ...over,
  }).run();
  return id;
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dlna-routes-"));
});

beforeEach(() => {
  resetFakes();
  currentUser = admin;
});

// ==================== GET /v1/dlna/devices ====================

describe("GET /v1/dlna/devices", () => {
  it("缓存为空时触发一次 discovery,并返回设备", async () => {
    // 第一次读缓存判「是否为空」→ 空;刷新后的第二次读 → 已有设备。
    fns.getCachedDevices.mockReturnValueOnce([]).mockReturnValue([dev()]);
    fns.refreshDevices.mockResolvedValue([dev()]);
    const r = await get("/v1/dlna/devices");
    expect(r.status).toBe(200);
    expect(fns.refreshDevices).toHaveBeenCalledTimes(1);
    expect((await r.json() as Any).devices).toHaveLength(1);
  });

  it("缓存非空且未到刷新周期 → 不再 discovery(避免每次列表都 SSDP)", async () => {
    fns.getCachedDevices.mockReturnValue([dev()]);
    fns.shouldRefreshDevices.mockReturnValue(false);
    const r = await get("/v1/dlna/devices");
    expect(r.status).toBe(200);
    expect(fns.refreshDevices).not.toHaveBeenCalled();
  });

  it("到达刷新周期 → discovery 即使缓存非空", async () => {
    fns.getCachedDevices.mockReturnValue([dev()]);
    fns.shouldRefreshDevices.mockReturnValue(true);
    await get("/v1/dlna/devices");
    expect(fns.refreshDevices).toHaveBeenCalledTimes(1);
  });

  it("管理员看到全部设备(含禁用/离线),不做权限过滤", async () => {
    fns.getCachedDevices.mockReturnValue([dev({ id: "a" }), dev({ id: "b", disabled: true })]);
    const r = await get("/v1/dlna/devices");
    expect((await r.json() as Any).devices.map((d: Any) => d.id)).toEqual(["a", "b"]);
    expect(fns.canUseRenderer).not.toHaveBeenCalled();
  });

  it("普通用户只看到「未禁用 且 被授予播放器权限」的设备", async () => {
    currentUser = pleb;
    fns.getCachedDevices.mockReturnValue([
      dev({ id: "allowed" }), dev({ id: "denied" }), dev({ id: "off", disabled: true }),
    ]);
    fns.canUseRenderer.mockImplementation((_uid: Any, _admin: Any, key: string) => key === "dlna:allowed");
    const r = await get("/v1/dlna/devices");
    expect((await r.json() as Any).devices.map((d: Any) => d.id)).toEqual(["allowed"]);
    // 禁用设备连权限判定都不做(先短路)。
    expect(fns.canUseRenderer).not.toHaveBeenCalledWith("u-pleb", false, "dlna:off");
  });
});

// ==================== POST /v1/dlna/scan ====================

describe("POST /v1/dlna/scan", () => {
  it("强制重新发现并返回新列表", async () => {
    fns.refreshDevices.mockResolvedValue([dev({ id: "new1" })]);
    const r = await post("/v1/dlna/scan");
    expect(r.status).toBe(200);
    expect(fns.refreshDevices).toHaveBeenCalledTimes(1);
    expect((await r.json() as Any).devices[0].id).toBe("new1");
  });

  it("普通用户同样按权限过滤", async () => {
    currentUser = pleb;
    fns.refreshDevices.mockResolvedValue([dev({ id: "x" }), dev({ id: "y" })]);
    fns.canUseRenderer.mockImplementation((_u: Any, _a: Any, key: string) => key === "dlna:y");
    const r = await post("/v1/dlna/scan");
    expect((await r.json() as Any).devices.map((d: Any) => d.id)).toEqual(["y"]);
  });
});

// ==================== PUT /v1/dlna/devices/:deviceId ====================

describe("PUT /v1/dlna/devices/:deviceId(重命名)", () => {
  it("别名超长 → 400,且不落库", async () => {
    const r = await put("/v1/dlna/devices/dev1", { alias: "x".repeat(51) });
    expect(r.status).toBe(400);
    expect((await r.json() as Any).code).toBe("INVALID_PARAM");
    expect(fns.setDeviceAlias).not.toHaveBeenCalled();
  });

  it("别名恰好 50 字 → 放行(边界内)", async () => {
    fns.setDeviceAlias.mockReturnValue(dev());
    const r = await put("/v1/dlna/devices/dev1", { alias: "y".repeat(50) });
    expect(r.status).toBe(200);
    expect(fns.setDeviceAlias).toHaveBeenCalledWith("dev1", "y".repeat(50));
  });

  it("设备不存在 → 404", async () => {
    fns.setDeviceAlias.mockReturnValue(null);
    const r = await put("/v1/dlna/devices/ghost", { alias: "n" });
    expect(r.status).toBe(404);
    expect((await r.json() as Any).code).toBe("NOT_FOUND");
  });

  it("成功 → 立即 reconcile peer 并回显 displayName / hasVolumeControl", async () => {
    const reconcile = vi.fn();
    fns.getPeerManager.mockReturnValue({ reconcileDlnaPeers: reconcile, removeDlnaPeer: vi.fn() });
    fns.setDeviceAlias.mockReturnValue(dev({ alias: "主卧" }));
    const r = await put("/v1/dlna/devices/dev1", { alias: " 主卧 " });
    expect(r.status).toBe(200);
    // 前后空白被 trim 后落库
    expect(fns.setDeviceAlias).toHaveBeenCalledWith("dev1", "主卧");
    expect(reconcile).toHaveBeenCalledTimes(1);
    const b = await r.json() as Any;
    expect(b.success).toBe(true);
    expect(b.device.alias).toBe("主卧");
    expect(b.device.displayName).toBe("主卧");
    expect(b.device.hasVolumeControl).toBe(true);
  });

  it("无 renderingControlUrl → hasVolumeControl=false;alias 空串时 displayName 回落 name", async () => {
    fns.setDeviceAlias.mockReturnValue(dev({ alias: "", renderingControlUrl: "" }));
    const r = await put("/v1/dlna/devices/dev1", { alias: "" });
    const b = await r.json() as Any;
    expect(b.device.hasVolumeControl).toBe(false);
    expect(b.device.displayName).toBe("客厅音箱");
  });

  it("body 不是合法 JSON 时不炸(按空对象处理,alias 视为空串)", async () => {
    fns.setDeviceAlias.mockReturnValue(dev());
    const r = await app.request("/v1/dlna/devices/dev1", { method: "PUT", body: "{{{" });
    expect(r.status).toBe(200);
    expect(fns.setDeviceAlias).toHaveBeenCalledWith("dev1", "");
  });
});

// ==================== DELETE /v1/dlna/devices/:deviceId ====================

describe("DELETE /v1/dlna/devices/:deviceId", () => {
  it("存在 → 清群组/清队列/删 peer/删记录/广播", async () => {
    const removeFromAll = vi.fn();
    const qcClear = vi.fn();
    const removePeer = vi.fn();
    const emit = vi.fn();
    fns.getGroupManager.mockReturnValue({ removeDeviceFromAllGroups: removeFromAll });
    fns.getQueueController.mockReturnValue({ clear: qcClear });
    fns.getPeerManager.mockReturnValue({ reconcileDlnaPeers: vi.fn(), removeDlnaPeer: removePeer });
    fns.getEventManager.mockReturnValue({ getEventState: () => null, emitDeviceListChanged: emit });
    fns.deleteDeviceRecord.mockReturnValue(true);

    const r = await del("/v1/dlna/devices/dev1");
    expect(r.status).toBe(200);
    expect((await r.json() as Any).success).toBe(true);
    expect(removeFromAll).toHaveBeenCalledWith("dev1");
    expect(qcClear).toHaveBeenCalledWith("dev1");
    expect(removePeer).toHaveBeenCalledWith("dev1");
    expect(emit).toHaveBeenCalled();
  });

  it("不存在 → 404(前面的清理照做,但结果如实报)", async () => {
    fns.deleteDeviceRecord.mockReturnValue(false);
    const r = await del("/v1/dlna/devices/ghost");
    expect(r.status).toBe(404);
    expect((await r.json() as Any).code).toBe("NOT_FOUND");
  });

  it("队列 clear 抛错被吞(设备本身仍能删掉)", async () => {
    fns.getQueueController.mockReturnValue({ clear: vi.fn(() => { throw new Error("no queue"); }) });
    fns.deleteDeviceRecord.mockReturnValue(true);
    const r = await del("/v1/dlna/devices/dev1");
    expect(r.status).toBe(200);
  });
});

// ==================== PUT /v1/dlna/devices/:deviceId/disabled ====================

describe("PUT /v1/dlna/devices/:deviceId/disabled", () => {
  it("禁用 → 移出所有群组 + 停播清队列 + 删持久队列行 + reconcile + 广播", async () => {
    const removeFromAll = vi.fn();
    const qcClear = vi.fn();
    const reconcile = vi.fn();
    const emit = vi.fn();
    fns.getGroupManager.mockReturnValue({ removeDeviceFromAllGroups: removeFromAll });
    fns.getQueueController.mockReturnValue({ clear: qcClear });
    fns.getPeerManager.mockReturnValue({ reconcileDlnaPeers: reconcile, removeDlnaPeer: vi.fn() });
    fns.getEventManager.mockReturnValue({ getEventState: () => null, emitDeviceListChanged: emit });
    fns.setDeviceDisabled.mockReturnValue(dev({ disabled: true }));

    const r = await put("/v1/dlna/devices/dev1/disabled", { disabled: true });
    expect(r.status).toBe(200);
    const b = await r.json() as Any;
    expect(b.success).toBe(true);
    expect(b.disabled).toBe(true);
    expect(b.device.disabled).toBe(true);
    expect(removeFromAll).toHaveBeenCalledWith("dev1");
    expect(qcClear).toHaveBeenCalledWith("dev1");
    expect(reconcile).toHaveBeenCalled();
    expect(emit).toHaveBeenCalled();
  });

  it("启用 → 不做群组/队列清理(只写状态 + 同步 peer)", async () => {
    const removeFromAll = vi.fn();
    fns.getGroupManager.mockReturnValue({ removeDeviceFromAllGroups: removeFromAll });
    fns.setDeviceDisabled.mockReturnValue(dev({ disabled: false }));
    const r = await put("/v1/dlna/devices/dev1/disabled", { disabled: false });
    expect(r.status).toBe(200);
    expect((await r.json() as Any).disabled).toBe(false);
    expect(removeFromAll).not.toHaveBeenCalled();
    expect(fns.setDeviceDisabled).toHaveBeenCalledWith("dev1", false);
  });

  it("缺 disabled 字段 → 视为启用(!!undefined === false)", async () => {
    fns.setDeviceDisabled.mockReturnValue(dev());
    await put("/v1/dlna/devices/dev1/disabled", {});
    expect(fns.setDeviceDisabled).toHaveBeenCalledWith("dev1", false);
  });

  it("设备不存在 → 404", async () => {
    fns.setDeviceDisabled.mockReturnValue(null);
    const r = await put("/v1/dlna/devices/ghost/disabled", { disabled: true });
    expect(r.status).toBe(404);
  });

  it("禁用时队列 clear 抛错被吞(设备仍能落禁用状态)", async () => {
    fns.getQueueController.mockReturnValue({ clear: vi.fn(() => { throw new Error("队列已不存在"); }) });
    fns.setDeviceDisabled.mockReturnValue(dev({ disabled: true }));
    const r = await put("/v1/dlna/devices/dev1/disabled", { disabled: true });
    expect(r.status).toBe(200);
    expect((await r.json() as Any).disabled).toBe(true);
  });
});

// ==================== POST /v1/dlna/stream-url ====================

describe("POST /v1/dlna/stream-url(投前预检)", () => {
  it("缺 songId → 400", async () => {
    const r = await post("/v1/dlna/stream-url", {});
    expect(r.status).toBe(400);
    expect((await r.json() as Any).code).toBe("INVALID_PARAM");
  });

  it("歌不存在 → 404", async () => {
    const r = await post("/v1/dlna/stream-url", { songId: "no-such-song" });
    expect(r.status).toBe(404);
  });

  it("local 行:主源不可用且无组内备选 → 409(客户端据此跳下一首)", async () => {
    fns.probeLocalSourceOk.mockResolvedValue(false);
    const id = seedSong({ type: "local" });
    const r = await post("/v1/dlna/stream-url", { songId: id });
    expect(r.status).toBe(409);
    expect((await r.json() as Any).code).toBe("CONFLICT");
  });

  it("local 行:主源可用 → 签发 token(默认 deviceId=client-cast)", async () => {
    fns.probeLocalSourceOk.mockResolvedValue(true);
    const id = seedSong({ type: "local" });
    const r = await post("/v1/dlna/stream-url", { songId: id });
    expect(r.status).toBe(200);
    const b = await r.json() as Any;
    expect(b.token).toBe("cast-token");
    expect(b.streamUrl).toBe("/rest/dlna/stream/cast-token");
    expect(fns.createCastSession).toHaveBeenCalledWith(id, "client-cast", "http://127.0.0.1:46400");
  });

  it("local 行:主源不可用但组内有 web 备选 → 放行(流播时自行换源)", async () => {
    fns.probeLocalSourceOk.mockResolvedValue(false);
    const g = `grp-${uuidv4()}`;
    const id = seedSong({ type: "local", groupId: g });
    seedSong({ type: "web", groupId: g, url: "http://src/x.mp3" });
    const r = await post("/v1/dlna/stream-url", { songId: id });
    expect(r.status).toBe(200);
  });

  it("local 行:组内有组员但不是 web 备选 → 仍 409", async () => {
    fns.probeLocalSourceOk.mockResolvedValue(false);
    const g = `grp-${uuidv4()}`;
    const id = seedSong({ type: "local", groupId: g });
    seedSong({ type: "local", groupId: g });
    const r = await post("/v1/dlna/stream-url", { songId: id });
    expect(r.status).toBe(409);
  });

  it("web 行:本地已有缓存文件 → 直接放行(不查网络)", async () => {
    const cacheFile = path.join(tmpDir, `c-${uuidv4()}.mp3`);
    fs.writeFileSync(cacheFile, "x");
    const id = seedSong({ type: "web", cachePath: cacheFile, pluginEntry: "p:e" });
    const r = await post("/v1/dlna/stream-url", { songId: id });
    expect(r.status).toBe(200);
    expect(fns.ensurePlayableStream).not.toHaveBeenCalled();
  });

  it("web 行:有 pluginEntry 且无缓存 → 交给 ensurePlayableStream 探测换源", async () => {
    fns.ensurePlayableStream.mockResolvedValue({ url: "http://ok" });
    const id = seedSong({ type: "web", cachePath: null, pluginEntry: "p:e" });
    const r = await post("/v1/dlna/stream-url", { songId: id });
    expect(r.status).toBe(200);
    expect(fns.ensurePlayableStream).toHaveBeenCalledTimes(1);
  });

  it("web 行:有 pluginEntry 但探测失败 → 409", async () => {
    fns.ensurePlayableStream.mockResolvedValue(null);
    const id = seedSong({ type: "web", cachePath: null, pluginEntry: "p:e" });
    const r = await post("/v1/dlna/stream-url", { songId: id });
    expect(r.status).toBe(409);
  });

  it("web 行:无 pluginEntry 时按 url 判定 —— 有 url 放行 / 无 url 拒绝", async () => {
    const ok = seedSong({ type: "web", cachePath: null, pluginEntry: null, url: "http://src/a.mp3" });
    expect((await post("/v1/dlna/stream-url", { songId: ok })).status).toBe(200);
    const bad = seedSong({ type: "web", cachePath: null, pluginEntry: null, url: null });
    expect((await post("/v1/dlna/stream-url", { songId: bad })).status).toBe(409);
  });

  it("显式 deviceId 透传给 cast session", async () => {
    fns.probeLocalSourceOk.mockResolvedValue(true);
    const id = seedSong({ type: "local" });
    await post("/v1/dlna/stream-url", { songId: id, deviceId: "dev9" });
    expect(fns.createCastSession).toHaveBeenCalledWith(id, "dev9", "http://127.0.0.1:46400");
  });

  it("type 为空(历史行未写 type)→ 按 local 处理,走磁盘探测", async () => {
    fns.probeLocalSourceOk.mockResolvedValue(true);
    const id = seedSong({ type: "" });
    const r = await post("/v1/dlna/stream-url", { songId: id });
    expect(r.status).toBe(200);
    expect(fns.probeLocalSourceOk).toHaveBeenCalledTimes(1);
  });
});

// ==================== POST /v1/dlna/cast & /enqueue ====================

describe("POST /v1/dlna/cast", () => {
  it("缺 songId/deviceId → 400", async () => {
    expect((await post("/v1/dlna/cast", { songId: "s" })).status).toBe(400);
    expect((await post("/v1/dlna/cast", { deviceId: "d" })).status).toBe(400);
  });

  it("歌不存在 → 404", async () => {
    expect((await post("/v1/dlna/cast", { songId: "nope", deviceId: "dev1" })).status).toBe(404);
  });

  it("上游投屏失败 → 502 且带原因", async () => {
    fns.castToDevice.mockRejectedValue(new Error("SetAVTransportURI 超时"));
    const id = seedSong();
    const r = await post("/v1/dlna/cast", { songId: id, deviceId: "dev1" });
    expect(r.status).toBe(502);
    expect((await r.json() as Any).code).toBe("UPSTREAM_ERROR");
  });

  it("上游抛空 message → 回落到 i18n key(经 translate 渲染,不得为空)", async () => {
    fns.castToDevice.mockRejectedValue(new Error(""));
    const id = seedSong();
    const r = await post("/v1/dlna/cast", { songId: id, deviceId: "dev1" });
    expect(r.status).toBe(502);
    const b = await r.json() as Any;
    expect(b.code).toBe("UPSTREAM_ERROR");
    // 回落的是 catalog key,translate 后应是可展示文案而非空串。
    expect(typeof b.error).toBe("string");
    expect(b.error.length).toBeGreaterThan(0);
  });

  it("成功 → 传齐 meta 与 mime(baseUrl 来自请求头)", async () => {
    const id = seedSong({ suffix: "flac", title: "T", artist: "A", album: "AL", coverArt: "cv" });
    const r = await post("/v1/dlna/cast", { songId: id, deviceId: "dev1" });
    expect(r.status).toBe(200);
    const arg = fns.castToDevice.mock.calls[0][0] as Any;
    expect(arg.songId).toBe(id);
    expect(arg.deviceId).toBe("dev1");
    expect(arg.title).toBe("T");
    expect(arg.artist).toBe("A");
    expect(arg.album).toBe("AL");
    expect(arg.coverArt).toBe("cv");
    expect(arg.baseUrl).toBe("http://127.0.0.1:46400");
    expect(typeof arg.mime).toBe("string");
  });

  it("标题缺失 → 回落「未知」,artist/album/coverArt 为 undefined", async () => {
    const id = seedSong({ title: "", artist: "", album: "", coverArt: "" });
    await post("/v1/dlna/cast", { songId: id, deviceId: "dev1" });
    const arg = fns.castToDevice.mock.calls[0][0] as Any;
    expect(arg.title).toBe("未知");
    expect(arg.artist).toBeUndefined();
    expect(arg.album).toBeUndefined();
    expect(arg.coverArt).toBeUndefined();
  });
});

describe("POST /v1/dlna/enqueue(gapless 预载)", () => {
  it("缺参 → 400;歌不存在 → 404", async () => {
    expect((await post("/v1/dlna/enqueue", {})).status).toBe(400);
    expect((await post("/v1/dlna/enqueue", { songId: "nope", deviceId: "d" })).status).toBe(404);
  });

  it("设备不支持 SetNextAVTransportURI → 200 但 enqueueSupported=false", async () => {
    fns.enqueueNextTrack.mockResolvedValue(false);
    const id = seedSong();
    const r = await post("/v1/dlna/enqueue", { songId: id, deviceId: "dev1" });
    expect(r.status).toBe(200);
    expect((await r.json() as Any).enqueueSupported).toBe(false);
  });

  it("上游失败 → 502,空 message 回落 i18n key(渲染后非空)", async () => {
    const id = seedSong();
    fns.enqueueNextTrack.mockRejectedValue(new Error(""));
    const r = await post("/v1/dlna/enqueue", { songId: id, deviceId: "dev1" });
    expect(r.status).toBe(502);
    const b = await r.json() as Any;
    expect(b.code).toBe("UPSTREAM_ERROR");
    expect(typeof b.error).toBe("string");
    expect(b.error.length).toBeGreaterThan(0);
  });

  it("meta 缺失时回落(与 cast 同款:标题「未知」,其余字段不下发)", async () => {
    const id = seedSong({ title: "", artist: "", album: "", coverArt: "" });
    await post("/v1/dlna/enqueue", { songId: id, deviceId: "dev1" });
    const arg = fns.enqueueNextTrack.mock.calls[0][0] as Any;
    expect(arg.title).toBe("未知");
    expect(arg.artist).toBeUndefined();
    expect(arg.album).toBeUndefined();
    expect(arg.coverArt).toBeUndefined();
    expect(arg.baseUrl).toBe("http://127.0.0.1:46400");
  });
});

// ==================== 传输控制 ====================

describe("传输控制端点", () => {
  it("play:设备被禁用 → 403,且不下发指令", async () => {
    fns.isDeviceDisabled.mockReturnValue(true);
    const r = await post("/v1/dlna/devices/dev1/play");
    expect(r.status).toBe(403);
    expect(fns.playDevice).not.toHaveBeenCalled();
  });

  it("play:正常 → 200;上游抛错 → 500", async () => {
    expect((await post("/v1/dlna/devices/dev1/play")).status).toBe(200);
    fns.playDevice.mockRejectedValue(new Error("SOAP 500"));
    expect((await post("/v1/dlna/devices/dev1/play")).status).toBe(500);
  });

  it("pause / stop:成功 200、上游抛错 500", async () => {
    expect((await post("/v1/dlna/devices/dev1/pause")).status).toBe(200);
    fns.pauseDevice.mockRejectedValue(new Error("x"));
    expect((await post("/v1/dlna/devices/dev1/pause")).status).toBe(500);

    expect((await post("/v1/dlna/devices/dev1/stop")).status).toBe(200);
    fns.stopDevice.mockRejectedValue(new Error("x"));
    expect((await post("/v1/dlna/devices/dev1/stop")).status).toBe(500);
  });

  it("seek:两种入参都接受(前端 seconds / HA position)", async () => {
    expect((await post("/v1/dlna/devices/dev1/seek", { seconds: 12 })).status).toBe(200);
    expect(fns.seekDevice).toHaveBeenLastCalledWith("dev1", 12);
    expect((await post("/v1/dlna/devices/dev1/seek", { position: 34 })).status).toBe(200);
    expect(fns.seekDevice).toHaveBeenLastCalledWith("dev1", 34);
  });

  it("seek:非数字 → 400;上游抛错 → 500", async () => {
    expect((await post("/v1/dlna/devices/dev1/seek", { seconds: "12" })).status).toBe(400);
    expect(fns.seekDevice).not.toHaveBeenCalled();
    fns.seekDevice.mockRejectedValue(new Error("x"));
    expect((await post("/v1/dlna/devices/dev1/seek", { seconds: 1 })).status).toBe(500);
  });

  it("volume:非数字 → 400;正常 200;上游抛错 500", async () => {
    expect((await post("/v1/dlna/devices/dev1/volume", { volume: "50" })).status).toBe(400);
    expect((await post("/v1/dlna/devices/dev1/volume", { volume: 0 })).status).toBe(200);
    expect(fns.setDeviceVolume).toHaveBeenLastCalledWith("dev1", 0);
    fns.setDeviceVolume.mockRejectedValue(new Error("x"));
    expect((await post("/v1/dlna/devices/dev1/volume", { volume: 50 })).status).toBe(500);
  });

  it("mute:非布尔 → 400(false 必须通过,不能当成缺省)", async () => {
    expect((await post("/v1/dlna/devices/dev1/mute", { muted: "yes" })).status).toBe(400);
    expect((await post("/v1/dlna/devices/dev1/mute", { muted: false })).status).toBe(200);
    expect(fns.setDeviceMute).toHaveBeenLastCalledWith("dev1", false);
    fns.setDeviceMute.mockRejectedValue(new Error("x"));
    expect((await post("/v1/dlna/devices/dev1/mute", { muted: true })).status).toBe(500);
  });
});

// ==================== GET status ====================

describe("GET /v1/dlna/devices/:deviceId/status", () => {
  it("无 GENA 事件 → 原样返回 SOAP 快照", async () => {
    fns.getDeviceStatus.mockResolvedValue({ state: "paused", position: 5, duration: 100, volume: 30, muted: false });
    const r = await get("/v1/dlna/devices/dev1/status");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ state: "paused", position: 5, duration: 100, volume: 30, muted: false });
  });

  it("有 GENA 事件 → 逐字段覆盖(0/缺失的字段不覆盖,保留 SOAP 真值)", async () => {
    fns.getDeviceStatus.mockResolvedValue({ state: "playing", position: 5, duration: 100, volume: 30, muted: false });
    fns.getEventManager.mockReturnValue({
      getEventState: () => ({ state: "paused", position: 0, duration: 0, volume: 0, muted: true }),
      emitDeviceListChanged: vi.fn(),
    });
    const b = await (await get("/v1/dlna/devices/dev1/status")).json() as Any;
    expect(b.state).toBe("paused");   // state 恒覆盖
    expect(b.position).toBe(5);       // 事件给 0 → 不覆盖(0 视为无信息)
    expect(b.duration).toBe(100);     // 同上
    expect(b.volume).toBe(0);         // volume 允许 0(数字即覆盖)
    expect(b.muted).toBe(true);
  });

  it("上游 SOAP 抛错 → 500 受控响应", async () => {
    fns.getDeviceStatus.mockRejectedValue(new Error("SOAP 连接被拒"));
    const r = await get("/v1/dlna/devices/dev1/status");
    expect(r.status).toBe(500);
  });

  it("GENA 事件 position/duration 为正值时同样覆盖 SOAP", async () => {
    fns.getDeviceStatus.mockResolvedValue({ state: "playing", position: 5, duration: 100, volume: 30, muted: false });
    fns.getEventManager.mockReturnValue({
      getEventState: () => ({ position: 42, duration: 260 }),
      emitDeviceListChanged: vi.fn(),
    });
    const b = await (await get("/v1/dlna/devices/dev1/status")).json() as Any;
    expect(b.position).toBe(42);
    expect(b.duration).toBe(260);
    expect(b.volume).toBe(30); // 事件未携带 volume → 保留 SOAP 值
  });
});

// ==================== 队列管理 ====================

function fakeQueueManager(over: Any = {}) {
  const qm = {
    snapshot: vi.fn(() => ({ items: [{ songId: "s1" }], index: 0 })),
    playFrom: vi.fn(async () => undefined),
    enqueue: vi.fn(async () => undefined),
    next: vi.fn(async () => undefined),
    prev: vi.fn(async () => undefined),
    clear: vi.fn(),
    activeDevices: vi.fn(() => [{ deviceId: "d1", snapshot: { index: 0, items: [] } }]),
    setPlayMode: vi.fn(),
    removeAt: vi.fn(),
    deactivate: vi.fn(),
    ...over,
  };
  fns.getQueueManager.mockReturnValue(qm);
  return qm;
}

describe("DLNA 队列端点", () => {
  it("GET queue:补回 currentMedia 保持响应形状兼容", async () => {
    const qm = fakeQueueManager();
    fns.getCurrentMedia.mockReturnValue({ songId: "s1", title: "T" });
    const b = await (await get("/v1/dlna/devices/dev1/queue")).json() as Any;
    expect(qm.snapshot).toHaveBeenCalledWith("dev1");
    expect(b.items).toHaveLength(1);
    expect(b.currentMedia).toEqual({ songId: "s1", title: "T" });
  });

  it("POST queue/play:items 非数组 → 400;正常 → playFrom 带 startIndex 与 baseUrl", async () => {
    const qm = fakeQueueManager();
    expect((await post("/v1/dlna/devices/dev1/queue/play", { items: "nope" })).status).toBe(400);
    expect(qm.playFrom).not.toHaveBeenCalled();

    const r = await post("/v1/dlna/devices/dev1/queue/play", { items: [{ songId: "s1" }], startIndex: 3 });
    expect(r.status).toBe(200);
    expect(qm.playFrom).toHaveBeenCalledWith("dev1", [{ songId: "s1" }], 3, "http://127.0.0.1:46400");
  });

  it("POST queue/play:startIndex 缺省为 0;上游抛错 → 500", async () => {
    const qm = fakeQueueManager();
    await post("/v1/dlna/devices/dev1/queue/play", { items: [] });
    expect(qm.playFrom).toHaveBeenCalledWith("dev1", [], 0, "http://127.0.0.1:46400");
    qm.playFrom.mockRejectedValue(new Error("x"));
    expect((await post("/v1/dlna/devices/dev1/queue/play", { items: [] })).status).toBe(500);
  });

  it("POST queue/enqueue:items 非数组 → 400;正常 200;抛错 500", async () => {
    const qm = fakeQueueManager();
    expect((await post("/v1/dlna/devices/dev1/queue/enqueue", {})).status).toBe(400);
    expect((await post("/v1/dlna/devices/dev1/queue/enqueue", { items: [] })).status).toBe(200);
    expect(qm.enqueue).toHaveBeenCalledWith("dev1", [], "http://127.0.0.1:46400");
    qm.enqueue.mockRejectedValue(new Error("x"));
    expect((await post("/v1/dlna/devices/dev1/queue/enqueue", { items: [] })).status).toBe(500);
  });

  it("next / prev:成功 200,上游抛错 500", async () => {
    const qm = fakeQueueManager();
    expect((await post("/v1/dlna/devices/dev1/next")).status).toBe(200);
    expect(qm.next).toHaveBeenCalledWith("dev1", "http://127.0.0.1:46400");
    qm.next.mockRejectedValue(new Error("x"));
    expect((await post("/v1/dlna/devices/dev1/next")).status).toBe(500);

    expect((await post("/v1/dlna/devices/dev1/prev")).status).toBe(200);
    qm.prev.mockRejectedValue(new Error("x"));
    expect((await post("/v1/dlna/devices/dev1/prev")).status).toBe(500);
  });

  it("DELETE queue:清空并 200", async () => {
    const qm = fakeQueueManager();
    const r = await del("/v1/dlna/devices/dev1/queue");
    expect(r.status).toBe(200);
    expect(qm.clear).toHaveBeenCalledWith("dev1");
  });

  it("GET active:每个快照都补 currentMedia", async () => {
    fakeQueueManager();
    fns.getCurrentMedia.mockReturnValue({ songId: "s9" });
    const b = await (await get("/v1/dlna/active")).json() as Any;
    expect(b.active).toHaveLength(1);
    expect(b.active[0].deviceId).toBe("d1");
    expect(b.active[0].snapshot.currentMedia).toEqual({ songId: "s9" });
  });

  it("POST play-mode:非法模式 400;合法模式落库", async () => {
    const qm = fakeQueueManager();
    expect((await post("/v1/dlna/devices/dev1/play-mode", { mode: "chaos" })).status).toBe(400);
    expect(qm.setPlayMode).not.toHaveBeenCalled();
    for (const mode of ["order", "one", "all", "shuffle"]) {
      expect((await post("/v1/dlna/devices/dev1/play-mode", { mode })).status).toBe(200);
      expect(qm.setPlayMode).toHaveBeenLastCalledWith("dev1", mode);
    }
  });

  it("DELETE queue/:index:非数字 400;数字走 removeAt", async () => {
    const qm = fakeQueueManager();
    expect((await del("/v1/dlna/devices/dev1/queue/abc")).status).toBe(400);
    expect(qm.removeAt).not.toHaveBeenCalled();
    expect((await del("/v1/dlna/devices/dev1/queue/2")).status).toBe(200);
    expect(qm.removeAt).toHaveBeenCalledWith("dev1", 2, "http://127.0.0.1:46400");
  });

  it("POST deactivate:标记非活动但保留队列", async () => {
    const qm = fakeQueueManager();
    const r = await post("/v1/dlna/devices/dev1/deactivate");
    expect(r.status).toBe(200);
    expect(qm.deactivate).toHaveBeenCalledWith("dev1");
  });
});
