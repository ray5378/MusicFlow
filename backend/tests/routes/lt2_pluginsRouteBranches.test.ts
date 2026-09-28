// MUST be the first import:隔离 DATA_DIR 后再加载后端模块。
import "../plugins/_env.js";

// `routes/api/plugins.ts` 残余未覆盖行补测(全部是**服务编排 / 外部依赖失败**分支):
//   113-118 sendspin 端口热更新(仅当新端口合法且与现值不同 → 停旧起新)
//   146-148 / 150-152 toggle airplay/sendspin 内置插件时的服务生命周期联动
//   164-167 删除外置插件:处置沙箱
//   188     renderer 设备发现失败 → 502
//   212-213 / 217-218 插件市场:已安装态合并 + 拉市场失败 → 502
//   236-241 市场安装:成功回执 + 安装失败 → 502
//
// 手法:mock `routes/api/shared.js`(以真实模块为底),只把**服务层入口**换成受控假体;
// 业务真源(DB 行、apiError 契约、adminMiddleware 真鉴权)全部保真。
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import md5 from "md5";

const leaf = vi.hoisted(() => ({
  getPluginManifest: vi.fn(() => null as any),
  homePositionConflictForSave: vi.fn(() => null as any),
  isBatchCapable: vi.fn(() => false),
  registerBatchWorker: vi.fn(),
  unregisterBatchWorker: vi.fn(),
  startAirPlayService: vi.fn(),
  stopAirPlayService: vi.fn(),
  startSendspinService: vi.fn(async () => undefined),
  stopSendspinService: vi.fn(async () => undefined),
  discoverRenderers: vi.fn(async () => [] as any[]),
  listMarketplace: vi.fn(async () => [] as any[]),
  listRegistries: vi.fn(() => [] as any[]),
  collectRegistryGroups: vi.fn(async () => [] as any[]),
  addRegistry: vi.fn(() => "reg-1"),
  removeRegistry: vi.fn(),
  installPlugin: vi.fn(async () => ({ id: "installed-1" })),
  unregisterPlugin: vi.fn(),
  // sendspin 服务叶子(plugins.ts 里是动态 import)
  applySendspinConfigHotUpdate: vi.fn(async () => undefined),
  getSendspinFront: vi.fn(() => null as any),
}));

vi.mock("../../src/routes/api/shared.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  getPluginManifest: leaf.getPluginManifest,
  homePositionConflictForSave: leaf.homePositionConflictForSave,
  isBatchCapable: leaf.isBatchCapable,
  registerBatchWorker: leaf.registerBatchWorker,
  unregisterBatchWorker: leaf.unregisterBatchWorker,
  startAirPlayService: leaf.startAirPlayService,
  stopAirPlayService: leaf.stopAirPlayService,
  startSendspinService: leaf.startSendspinService,
  stopSendspinService: leaf.stopSendspinService,
  discoverRenderers: leaf.discoverRenderers,
  listMarketplace: leaf.listMarketplace,
  listRegistries: leaf.listRegistries,
  collectRegistryGroups: leaf.collectRegistryGroups,
  addRegistry: leaf.addRegistry,
  removeRegistry: leaf.removeRegistry,
  installPlugin: leaf.installPlugin,
  unregisterPlugin: leaf.unregisterPlugin,
}));

vi.mock("../../src/services/sendspin/index.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  applySendspinConfigHotUpdate: leaf.applySendspinConfigHotUpdate,
  getSendspinFront: leaf.getSendspinFront,
  stopSendspinService: leaf.stopSendspinService,
  startSendspinService: leaf.startSendspinService,
}));

import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, plugins } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { registerPlugins } from "../../src/routes/api/plugins.js";
import { pluginSandboxes } from "../../src/routes/api/shared.js";

const api = new Hono();
registerPlugins(api);
const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", api);

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

function putPlugin(id: string, name: string, enabled: number, config = "{}") {
  db.delete(plugins).where(eq(plugins.id, id)).run();
  db.insert(plugins).values({ id, name, enabled, config }).run();
}

beforeEach(() => {
  // 清掉本文件用到的插件行:否则"已安装态合并"用例留下的 ext-1 会让
  // "未安装"断言随执行顺序漂移(shuffle 下必现)。
  for (const id of ["ext-1", "sendspin-renderer", "airplay-renderer", "ext-del-1"]) {
    db.delete(plugins).where(eq(plugins.id, id)).run();
  }
  for (const f of Object.values(leaf)) (f as any).mockReset();
  leaf.getPluginManifest.mockReturnValue(null);
  leaf.homePositionConflictForSave.mockReturnValue(null);
  leaf.isBatchCapable.mockReturnValue(false);
  leaf.startSendspinService.mockResolvedValue(undefined);
  leaf.stopSendspinService.mockResolvedValue(undefined);
  leaf.discoverRenderers.mockResolvedValue([]);
  leaf.listMarketplace.mockResolvedValue([]);
  leaf.listRegistries.mockReturnValue([]);
  leaf.collectRegistryGroups.mockResolvedValue([]);
  leaf.addRegistry.mockReturnValue("reg-1");
  leaf.installPlugin.mockResolvedValue({ id: "installed-1" });
  leaf.getSendspinFront.mockReturnValue(null);
  leaf.applySendspinConfigHotUpdate.mockResolvedValue(undefined);
  pluginSandboxes.clear();
});

describe("PUT /v1/plugins/:id (sendspin 端口热更新)", () => {
  it("端口变更且合法 → 停旧服务再按新端口起服务", async () => {
    putPlugin("sendspin-renderer", "sendspin-renderer", 1, "{}");
    leaf.getSendspinFront.mockReturnValue({ port: 8000 });

    const r = await call("PUT", "/v1/plugins/sendspin-renderer", { config: { port: 9000 } });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);

    // 热更新配置总是先下发一次(与端口是否变无关)
    expect(leaf.applySendspinConfigHotUpdate).toHaveBeenCalledTimes(1);
    expect(leaf.stopSendspinService).toHaveBeenCalledTimes(1);
    expect(leaf.startSendspinService).toHaveBeenCalledWith(9000);
  });

  it("端口非法(越界/非整数)或与现值相同 → 不重启服务", async () => {
    putPlugin("sendspin-renderer", "sendspin-renderer", 1, "{}");
    leaf.getSendspinFront.mockReturnValue({ port: 8000 });

    await call("PUT", "/v1/plugins/sendspin-renderer", { config: { port: 70000 } });
    await call("PUT", "/v1/plugins/sendspin-renderer", { config: { port: 8000 } });
    expect(leaf.stopSendspinService).not.toHaveBeenCalled();
    expect(leaf.startSendspinService).not.toHaveBeenCalled();
  });
});

describe("PUT /v1/plugins/:id/toggle (内置服务联动)", () => {
  it("airplay-renderer:关 → 停在播会话;开 → 起监听", async () => {
    putPlugin("airplay-renderer", "airplay-renderer", 1, "{}");
    const off = await call("PUT", "/v1/plugins/airplay-renderer/toggle");
    expect(off.body.success).toBe(true);
    expect(leaf.stopAirPlayService).toHaveBeenCalledTimes(1);
    expect(leaf.startAirPlayService).not.toHaveBeenCalled();

    // 置为已关闭后再切一次 → 起服务
    db.update(plugins).set({ enabled: 0 }).where(eq(plugins.id, "airplay-renderer")).run();
    const on = await call("PUT", "/v1/plugins/airplay-renderer/toggle");
    expect(on.body.success).toBe(true);
    expect(leaf.startAirPlayService).toHaveBeenCalledTimes(1);
  });

  it("sendspin-renderer:关 → 停服务;开 → 起服务", async () => {
    putPlugin("sendspin-renderer", "sendspin-renderer", 1, "{}");
    await call("PUT", "/v1/plugins/sendspin-renderer/toggle");
    expect(leaf.stopSendspinService).toHaveBeenCalledTimes(1);

    db.update(plugins).set({ enabled: 0 }).where(eq(plugins.id, "sendspin-renderer")).run();
    await call("PUT", "/v1/plugins/sendspin-renderer/toggle");
    expect(leaf.startSendspinService).toHaveBeenCalled();
  });
});

describe("DELETE /v1/plugins/:id", () => {
  it("外置插件:处置沙箱 + 反注册 + 删行", async () => {
    putPlugin("ext-del-1", "ext-del-1", 1, "{}");
    const dispose = vi.fn();
    pluginSandboxes.set("ext-del-1", { dispose } as any);

    const r = await call("DELETE", "/v1/plugins/ext-del-1");
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    // 沙箱必须显式释放(否则插件 worker/socket 会常驻)
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(pluginSandboxes.has("ext-del-1")).toBe(false);
    // id 与 name 两个键都要反注册(id 与 name 相同时两条调用都合法)
    expect(leaf.unregisterPlugin).toHaveBeenCalledWith("ext-del-1");
    expect(db.select().from(plugins).where(eq(plugins.id, "ext-del-1")).get()).toBeUndefined();
  });

  it("内置插件不可删除 → 400(不处置沙箱、不删行)", async () => {
    putPlugin("airplay-renderer", "airplay-renderer", 1, "{}");
    const dispose = vi.fn();
    pluginSandboxes.set("airplay-renderer", { dispose } as any);
    const r = await call("DELETE", "/v1/plugins/airplay-renderer");
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ success: false, code: "INVALID_PARAM" });
    expect(dispose).not.toHaveBeenCalled();
    expect(db.select().from(plugins).where(eq(plugins.id, "airplay-renderer")).get()).toBeTruthy();
  });
});

describe("GET /v1/plugins/renderers/devices", () => {
  it("设备发现失败 → 502 + UPSTREAM_ERROR,并原样带回原因", async () => {
    leaf.discoverRenderers.mockRejectedValue(new Error("mDNS 超时"));
    const r = await call("GET", "/v1/plugins/renderers/devices");
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ success: false, code: "UPSTREAM_ERROR", error: "mDNS 超时" });
  });

  it("成功 → 返回 devices 列表", async () => {
    leaf.discoverRenderers.mockResolvedValue([{ id: "r1", name: "Renderer" }]);
    const r = await call("GET", "/v1/plugins/renderers/devices");
    expect(r.status).toBe(200);
    expect(r.body.devices).toEqual([{ id: "r1", name: "Renderer" }]);
  });
});

describe("GET /v1/plugins/registry", () => {
  it("市场拉取失败 → 502;注册表来源的错误状态回传前端", async () => {
    leaf.listMarketplace.mockRejectedValue(new Error("network down"));
    const bad = await call("GET", "/v1/plugins/registry");
    expect(bad.status).toBe(502);
    expect(bad.body).toMatchObject({ success: false, code: "UPSTREAM_ERROR", error: "network down" });

    leaf.listMarketplace.mockResolvedValue([{ id: "ext-1", name: "外部插件" }]);
    leaf.listRegistries.mockReturnValue([{ url: "https://reg.example" }]);
    leaf.collectRegistryGroups.mockResolvedValue([{ registryUrl: "https://reg.example", error: "拉取超时" }]);
    const ok = await call("GET", "/v1/plugins/registry");
    expect(ok.status).toBe(200);
    // 注册表本次拉取失败必须显式可见(不是整组静默消失)
    expect(ok.body.registries[0]).toMatchObject({ url: "https://reg.example", error: "拉取超时" });
    // 未安装 → installed=false
    expect(ok.body.plugins[0]).toMatchObject({ id: "ext-1", installed: false, enabled: 0 });
  });

  it("已安装的插件合并 installed/version/enabled 状态", async () => {
    leaf.listMarketplace.mockResolvedValue([{ id: "ext-1", name: "外部插件", version: "1.0.0" }]);
    putPlugin("ext-1", "ext-1", 1, "{}");
    db.update(plugins).set({ version: "2.3.4" }).where(eq(plugins.id, "ext-1")).run();

    const r = await call("GET", "/v1/plugins/registry");
    expect(r.status).toBe(200);
    expect(r.body.plugins[0]).toMatchObject({ id: "ext-1", installed: true, installedVersion: "2.3.4", enabled: 1 });
  });
});

describe("POST /v1/plugins/registry/install", () => {
  it("缺 downloadUrl → 400(不触发安装)", async () => {
    const r = await call("POST", "/v1/plugins/registry/install", {});
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ success: false, code: "INVALID_PARAM" });
    expect(leaf.installPlugin).not.toHaveBeenCalled();
  });

  it("安装成功 → success + 安装结果", async () => {
    leaf.installPlugin.mockResolvedValue({ id: "pkg-9", version: "3.0.0" });
    const r = await call("POST", "/v1/plugins/registry/install", { downloadUrl: "https://x/pkg.tgz" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, id: "pkg-9", version: "3.0.0" });
    expect(leaf.installPlugin).toHaveBeenCalledWith("https://x/pkg.tgz");
  });

  it("安装失败 → 502 + UPSTREAM_ERROR", async () => {
    leaf.installPlugin.mockRejectedValue(new Error("下载失败"));
    const r = await call("POST", "/v1/plugins/registry/install", { downloadUrl: "https://x/pkg.tgz" });
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ success: false, code: "UPSTREAM_ERROR", error: "下载失败" });
  });
});
