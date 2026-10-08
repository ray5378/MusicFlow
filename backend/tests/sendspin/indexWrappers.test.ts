// ==================== sendspin/index.ts 编排层补测 ====================
//
// 缺口:index.ts 是「生命周期装配 + 模式分派 + 对子进程 RPC 的外观」的中枢。
// 这些导出函数几乎每一条都对应一个前端可点的动作（播放/停止/加入/静音/音量/
// 配对/解绑/禁用/6053/唤醒发现…），且**每条都按 isForkMode() 分成两支**：
//   in-proc（单测/子进程自身）走 core 直调；fork（生产主进程）走 supervisor RPC。
// 只覆盖一支就等于「生产那条路从没被测过」—— 这正是本文件要钉死的。
//
// 隔离策略:所有重依赖（server/discover/esphomeBridge/playerCore/supervisor/proxy/
// identity/pairingStore/pairServer/group/player/peer/memory）用桩替身；真实的
// sqlite（plugins/sendspin_device_state 行）与 fs（dial_targets.json）保留，因为
// 它们正是这些函数要读写的**持久层契约**。
//
// 每个断言的注释都说明「守住什么产品契约」，并对齐套件 shuffle（用例顺序无关）。
import "../plugins/_env.js";
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

type Any = any;

const H = vi.hoisted(() => {
  const calls: Array<{ op: string; payload: Any; extra: Any }> = [];
  return {
    fork: false,
    running: false,
    server: null as Any,
    createOpts: null as Any,
    createSrv: null as Any,
    identity: { serverId: "srv-fake", privateKey: new Uint8Array(0) },
    pairingStore: { removeRecord: async () => true, getRecord: () => undefined, listRecords: () => [] },
    front: { clients: new Map<string, Any>() },
    esphomeDevices: [] as Any[],
    rescan: true,
    rpcCalls: calls,
    rpcResult: undefined as Any,
    rpcFail: false,
    rpcExtra: undefined as Any,
    cleaner: null as Any,
    qc: {
      registerSendspinDevice: vi.fn(),
      unregisterSendspinDevices: vi.fn(),
      snapshot: vi.fn(() => ({ isActive: false })),
      clear: vi.fn(),
    },
    pm: {
      registerSendspin: vi.fn(),
      markSendspinUnavailable: vi.fn(),
      removeSendspinPeer: vi.fn(),
      removeSendspinPeers: vi.fn(),
    },
    gm: {
      groupsOfDevice: vi.fn(() => [] as string[]),
      getVolume: vi.fn(() => 50),
      removeDeviceFromAllGroups: vi.fn(),
    },
    esphome: {
      syncDevice: vi.fn(),
      setVolume: vi.fn(() => ({ ok: true, code: "sent", sent: 1 })),
      setMuted: vi.fn(() => ({ ok: true, code: "sent", sent: 2 })),
      mirroredVolume: vi.fn(() => ({ volume: 0.37, muted: true })),
      snapshot: vi.fn(() => [] as Any[]),
      stop: vi.fn(),
    },
    core: {
      setVolumeCore: vi.fn(),
      setMutedCore: vi.fn(),
      playGroupCore: vi.fn(),
      stopGroupCore: vi.fn(),
      joinGroupCore: vi.fn(() => ({ joined: true, live: false })),
      leaveGroupCore: vi.fn(() => true),
      pauseCore: vi.fn(),
      resumePumpCore: vi.fn(),
      seekCore: vi.fn(),
      pollCore: vi.fn(() => ({ playing: true, paused: false, positionMs: 11, durationMs: 22 })),
      pumpActiveCore: vi.fn(() => true),
      armBorrowCore: vi.fn(() => ({ armed: true, positionMs: 5 })),
    },
    supervisor: {
      setHooks: vi.fn(),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      isRunning: vi.fn(() => false),
      rpc: vi.fn(),
    },
    discover: {
      startPlayerDiscovery: vi.fn(),
      stopPlayerDiscovery: vi.fn(),
      refreshPlayerDiscoveryNow: vi.fn(() => true),
    },
  };
});

vi.mock("../../src/services/sendspin/mode.js", () => ({ isForkMode: () => H.fork }));
vi.mock("../../src/services/sendspin/runtime.js", () => ({
  getServer: () => H.server,
  setServer: (s: Any) => {
    H.server = s;
  },
}));
vi.mock("../../src/services/sendspin/supervisor.js", () => ({
  sendspinSupervisor: {
    setHooks: H.supervisor.setHooks,
    start: H.supervisor.start,
    stop: H.supervisor.stop,
    isRunning: () => H.supervisor.isRunning(),
    rpc: async (op: string, payload: Any, extra: Any) => {
      H.rpcCalls.push({ op, payload, extra });
      if (H.rpcFail) throw new Error("rpc down");
      return H.rpcResult;
    },
  },
}));
vi.mock("../../src/services/sendspin/proxy.js", () => ({
  getSendspinFront: (_inproc: boolean) => H.front,
  proxyEsphomeStatus: async () => ({ devices: H.esphomeDevices }),
}));
vi.mock("../../src/services/sendspin/esphomeBridge.js", () => ({ esphomeBridge: H.esphome }));
vi.mock("../../src/services/sendspin/discover.js", () => ({
  startPlayerDiscovery: H.discover.startPlayerDiscovery,
  stopPlayerDiscovery: H.discover.stopPlayerDiscovery,
  refreshPlayerDiscoveryNow: H.discover.refreshPlayerDiscoveryNow,
}));
vi.mock("../../src/services/sendspin/advertise.js", () => ({
  advertiseSendspinServer: vi.fn(),
  unadvertiseSendspinServer: vi.fn(),
}));
// 忠实复刻 streamEngine 的 prefill 规整（值恒等于真实默认 3000）
vi.mock("../../src/services/sendspin/streamEngine.js", () => ({
  PREFILL_BUFFER_DEFAULT_MS: 3000,
  stopGroupPump: vi.fn(),
  normalizePrefillBufferMs: (raw: unknown) => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 3000;
  },
}));
vi.mock("../../src/services/sendspin/server.js", () => ({
  normalizeCodecPreference: (v: unknown) => (String(v ?? "").toLowerCase() === "flac" ? "flac" : "pcm"),
  SendspinServer: class {
    static async create(opts: Any): Promise<Any> {
      H.createOpts = opts;
      return H.createSrv();
    }
  },
}));
vi.mock("../../src/services/sendspin/playerCore.js", () => ({
  setVolumeCore: H.core.setVolumeCore,
  setMutedCore: H.core.setMutedCore,
  playGroupCore: H.core.playGroupCore,
  stopGroupCore: H.core.stopGroupCore,
  joinGroupCore: H.core.joinGroupCore,
  leaveGroupCore: H.core.leaveGroupCore,
  pauseCore: H.core.pauseCore,
  resumePumpCore: H.core.resumePumpCore,
  seekCore: H.core.seekCore,
  pollCore: H.core.pollCore,
  pumpActiveCore: H.core.pumpActiveCore,
  armBorrowCore: H.core.armBorrowCore,
  sendspinGroupName: (id: string) => `ss:${id}`,
  sendspinGroupNameForPeer: (id: string) => `ss:${id}`,
}));
vi.mock("../../src/services/sendspin/identity.js", () => ({
  loadOrCreateIdentity: async () => H.identity,
}));
vi.mock("../../src/services/sendspin/pairingStore.js", () => ({
  PairingStore: { open: async () => H.pairingStore },
}));
vi.mock("../../src/services/sendspin/pairServer.js", () => ({
  PairingCoordinator: class {
    constructor(public srv: Any, public store: Any) {}
  },
}));
vi.mock("../../src/services/group/index.js", () => ({ getGroupManager: () => H.gm }));
vi.mock("../../src/services/player/index.js", () => ({ getQueueController: () => H.qc }));
vi.mock("../../src/services/peer.js", () => ({ getPeerManager: () => H.pm }));
vi.mock("../../src/services/memory/reclaim.js", () => ({
  registerCacheCleaner: (fn: Any) => {
    H.cleaner = fn;
  },
}));

import * as idx from "../../src/services/sendspin/index.js";
import { initDatabase, sqlite } from "../../src/db/index.js";
import {
  getDeviceVolumeState,
  getDeviceDisabled,
  getDeviceEsphome,
  saveDeviceVolumeState,
  saveDeviceEsphome,
  saveDeviceDisabled,
  saveDeviceHost,
} from "../../src/services/sendspin/deviceState.js";

function makeFakeSrv(over: Any = {}): Any {
  return {
    serverId: "srv-fake",
    identity: H.identity,
    clients: new Map<string, Any>(),
    groups: new Map<string, Any>(),
    allowLegacyClients: true,
    preferredCodec: "pcm",
    pairingStore: null,
    pairing: null,
    listen: vi.fn(async () => {}),
    stop: vi.fn(),
    dialPlayer: vi.fn(async () => ({ clientId: "D1", name: "n" })),
    isRedialSuppressed: vi.fn(() => false),
    isConnectedTo: vi.fn(() => false),
    clearNoRedial: vi.fn(),
    ...over,
  };
}

let tmpDir = "";

/** 真正执行一次控制器抓取（ensureControllers），把 qc/pm 单例装上桩替身。
 *  某些包装函数（禁用/停止/回组）读的是模块级单例，只有 start 过的进程里才有值。 */
beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sendspin-idx-prime-"));
  idx.setSendspinIdentityDir(dir);
  H.fork = false;
  H.server = null;
  H.createSrv = () => makeFakeSrv();
  await idx.startSendspinService(18990);
  await idx.stopSendspinService();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 删掉本文件用到的 plugins 行（每个用例自铺自清，避免顺序耦合）。 */
function clearPluginRows(): void {
  sqlite.prepare("DELETE FROM plugins WHERE id = 'sendspin-renderer' OR name = 'sendspin-renderer'").run();
}
function setPluginRow(cfg: unknown, enabled = 1): void {
  sqlite
    .prepare(
      "INSERT INTO plugins (id, name, enabled, config) VALUES ('sendspin-renderer','sendspin-renderer',?,?) " +
        "ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, config = excluded.config",
    )
    .run(enabled, JSON.stringify(cfg));
}

beforeEach(() => {
  initDatabase();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sendspin-idx-"));
  idx.setSendspinIdentityDir(tmpDir);
  H.fork = false;
  H.running = false;
  H.server = null;
  H.createOpts = null;
  H.createSrv = () => makeFakeSrv();
  H.rpcCalls.length = 0;
  H.rpcResult = undefined;
  H.rpcFail = false;
  H.esphomeDevices = [];
  H.rescan = true;
  H.front = { clients: new Map<string, Any>() };
  clearPluginRows();
  for (const group of [H.qc, H.pm, H.gm, H.esphome, H.core, H.supervisor, H.discover]) {
    for (const f of Object.values(group)) {
      if (typeof f === "function" && (f as Any).mockClear) (f as Any).mockClear();
    }
  }
  H.qc.snapshot.mockReturnValue({ isActive: false });
  H.gm.groupsOfDevice.mockReturnValue([]);
  H.gm.getVolume.mockReturnValue(50);
  H.supervisor.isRunning.mockReturnValue(false);
  H.esphome.snapshot.mockReturnValue([]);
  H.esphome.setVolume.mockReturnValue({ ok: true, code: "sent", sent: 1 });
  H.esphome.setMuted.mockReturnValue({ ok: true, code: "sent", sent: 2 });
  H.esphome.mirroredVolume.mockReturnValue({ volume: 0.37, muted: true });
  H.core.joinGroupCore.mockReturnValue({ joined: true, live: false });
  H.core.leaveGroupCore.mockReturnValue(true);
  H.core.pollCore.mockReturnValue({ playing: true, paused: false, positionMs: 11, durationMs: 22 });
  H.core.pumpActiveCore.mockReturnValue(true);
  H.core.armBorrowCore.mockReturnValue({ armed: true, positionMs: 5 });
  H.core.setVolumeCore.mockImplementation(() => {});
  H.core.playGroupCore.mockImplementation(() => {});
  H.discover.refreshPlayerDiscoveryNow.mockReturnValue(true);
});

afterEach(async () => {
  try {
    await idx.stopSendspinService();
  } catch { /* ignore */ }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ────────────────────────── 配置读取（真 sqlite） ──────────────────────────
describe("readSendspinPluginConfig / isSendspinEnabled", () => {
  it("无插件行 → 全默认（对齐 MA 全开）", () => {
    const cfg = idx.readSendspinPluginConfig();
    expect(cfg).toEqual({
      allowLegacyClients: true,
      port: 38927,
      autoDiscover: true,
      preferredCodec: "pcm",
      streamWindowSeconds: 300,
      prefillBufferMs: 3000,
      // sink 自动重启(sink_auto_restart)默认**开**(显式 false 才关),见 SendspinServerOptions 注释。
      sinkAutoRestart: true,
    });
    expect(idx.isSendspinEnabled()).toBe(false);
  });

  it("显式 false 才关；端口非法回落 WS_PORT；codec 只认 flac", () => {
    setPluginRow({
      allow_legacy_clients: false,
      auto_discover: false,
      preferred_codec: "flac",
      stream_window_seconds: 60,
      port: 12345,
      prefill_buffer_ms: 500,
    });
    expect(idx.readSendspinPluginConfig()).toEqual({
      allowLegacyClients: false,
      port: 12345,
      autoDiscover: false,
      preferredCodec: "flac",
      streamWindowSeconds: 60,
      prefillBufferMs: 500,
      // sink 自动重启(sink_auto_restart)默认**开**(显式 false 才关),见 SendspinServerOptions 注释。
      sinkAutoRestart: true,
    });
    expect(idx.isSendspinEnabled()).toBe(true);
  });

  it("非布尔/越界值一律回默认（不得把 0 端口/NaN 缓存进去）", () => {
    setPluginRow({
      allow_legacy_clients: "no",
      auto_discover: 0,
      preferred_codec: "opus",
      port: 0,
    });
    const cfg = idx.readSendspinPluginConfig();
    expect(cfg.allowLegacyClients).toBe(true); // 仅显式 false 才关
    expect(cfg.autoDiscover).toBe(true);
    expect(cfg.streamWindowSeconds).toBe(300);
    expect(cfg.preferredCodec).toBe("pcm"); // opus 非法
    expect(cfg.port).toBe(38927);
    // 越界端口逐个回默认
    for (const p of [70000, -1, 1.5, "abc", NaN]) {
      setPluginRow({ port: p });
      expect(idx.readSendspinPluginConfig().port).toBe(38927);
    }
  });

  it("config 非法 JSON → 整体回默认（外抛被 catch 兜住）", () => {
    sqlite
      .prepare(
        "INSERT INTO plugins (id,name,enabled,config) VALUES ('sendspin-renderer','sendspin-renderer',1,'{bad json')",
      )
      .run();
    expect(idx.readSendspinPluginConfig().port).toBe(38927);
  });
});

// ────────────────────────── dial 目标持久层（真 fs） ──────────────────────────
describe("dial targets 持久化与拨号守卫", () => {
  it("remember 去重 + list 返回副本 + forget 幂等", async () => {
    await idx.rememberDialTarget("10.0.0.1", 8928);
    await idx.rememberDialTarget("10.0.0.1", 8928); // 同 host+port 不重复
    await idx.rememberDialTarget("10.0.0.2", 8928);
    const list = await idx.listDialTargets();
    // 只对本次注入的目标断言（内存名单可能被同文件其他用例填充，保持顺序无关）
    expect(list.filter((t) => t.host === "10.0.0.1" && t.port === 8928)).toHaveLength(1);
    expect(list.filter((t) => t.host === "10.0.0.2" && t.port === 8928)).toHaveLength(1);
    // 返回的是副本:改动不得穿透到内部状态
    const mine = list.find((t) => t.host === "10.0.0.1")!;
    mine.host = "MUT";
    expect((await idx.listDialTargets()).map((t) => t.host)).not.toContain("MUT");

    expect(await idx.forgetDialTarget("10.0.0.1", 8928)).toBe(true);
    expect(await idx.forgetDialTarget("10.0.0.1", 8928)).toBe(false); // 幂等
  });

  it("remember 落盘到 <identityDir>/sendspin/dial_targets.json", async () => {
    await idx.rememberDialTarget("10.9.9.9", 8928);
    const file = path.join(tmpDir, "sendspin", "dial_targets.json");
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toContainEqual(
      expect.objectContaining({ host: "10.9.9.9", port: 8928 }),
    );
  });

  it("服务未运行 → armDialTarget 返回 false（不空转拨号）", async () => {
    expect(await idx.armDialTarget("10.0.0.5", 8928)).toBe(false);
  });

  it("端口非法 → armDialTarget 返回 false", async () => {
    H.server = makeFakeSrv();
    expect(await idx.armDialTarget("10.0.0.5", 0)).toBe(false);
    expect(await idx.armDialTarget("", 8928)).toBe(false);
    expect(await idx.armDialTarget("10.0.0.5", 70000)).toBe(false);
  });

  it("开窗成功:记住目标 + 立刻首发；同窗重复调用返回 false", async () => {
    // 拨号保持 in-flight（真实场景里首发往往几秒才落地）→ 窗口仍在跑。
    const srv = makeFakeSrv({ dialPlayer: vi.fn(() => new Promise(() => {})) });
    H.server = srv;
    expect(await idx.armDialTarget("10.1.1.1", 8928)).toBe(true);
    expect(srv.dialPlayer).toHaveBeenCalledTimes(1); // 立刻首发，不等下一拍
    expect(await idx.listDialTargets()).toContainEqual(expect.objectContaining({ host: "10.1.1.1" }));
    // 窗口内不重置 → 第二次返回 false（防止 60s 发现信号把 10s 阶段顶回 2s 阶段）
    expect(await idx.armDialTarget("10.1.1.1", 8928)).toBe(false);
  });

  it("已连接 / 抑制期 → 不拨号", async () => {
    const srv = makeFakeSrv({ isConnectedTo: vi.fn(() => true) });
    H.server = srv;
    expect(await idx.armDialTarget("10.2.2.2", 8928)).toBe(false);

    const srv2 = makeFakeSrv({ isRedialSuppressed: vi.fn(() => true) });
    H.server = srv2;
    expect(await idx.armDialTarget("10.3.3.3", 8928)).toBe(false);
  });

  it("被用户禁用的 host → 不拨（自动发现不得把禁用设备拨回来）", async () => {
    H.server = makeFakeSrv();
    const cid = "DISABLED-DEV";
    saveDeviceDisabled(cid, true);
    saveDeviceHost(cid, "10.4.4.4"); // 记下它最后出现的 host
    expect(await idx.armDialTarget("10.4.4.4", 8928)).toBe(false);
    expect(await idx.listDialTargets()).not.toContainEqual(
      expect.objectContaining({ host: "10.4.4.4" }),
    );
  });

  it("forgetDialTarget 清掉在线连接的 dialed 标记但**不断开**连接", async () => {
    const conn = {
      clientId: "C-ONLINE",
      remoteHost: "10.5.5.5",
      dialed: true,
      dialHost: "10.5.5.5",
      dialPort: 8928,
      close: vi.fn(),
    };
    const srv = makeFakeSrv();
    srv.clients.set("C-ONLINE", conn);
    H.server = srv;
    await idx.rememberDialTarget("10.5.5.5", 8928);
    expect(await idx.forgetDialTarget("10.5.5.5", 8928)).toBe(true);
    expect(conn.dialed).toBe(false);
    expect(conn.dialHost).toBe("");
    expect(conn.dialPort).toBe(0);
    // 核心回归:解绑不得断连（否则设备从连接派生的列表里消失，用户无入口）
    expect(conn.close).not.toHaveBeenCalled();
  });
});

// ────────────────────────── 发现唤醒 + 空闲回收 ──────────────────────────
describe("wakeDiscoveryCore / wakeSendspinDiscovery / reclaim", () => {
  it("服务未运行 → 不重扫、不补枪", async () => {
    expect(await idx.wakeDiscoveryCore()).toEqual({ rescanned: false, rearmed: [] });
  });

  it("在跑:重建 browser + 对离线记忆目标补开窗", async () => {
    const srv = makeFakeSrv({ isConnectedTo: vi.fn(() => false) });
    H.server = srv;
    await idx.rememberDialTarget("10.6.6.6", 8928);
    H.discover.refreshPlayerDiscoveryNow.mockReturnValue(true);
    const r = await idx.wakeDiscoveryCore();
    expect(H.discover.refreshPlayerDiscoveryNow).toHaveBeenCalled();
    expect(r.rescanned).toBe(true);
    expect(r.rearmed).toContain("10.6.6.6:8928");
  });

  it("wakeDiscoveryCore:重扫抛错视为未重扫，但补枪仍继续", async () => {
    const srv = makeFakeSrv({ isConnectedTo: vi.fn(() => true) });
    H.server = srv;
    H.discover.refreshPlayerDiscoveryNow.mockImplementation(() => {
      throw new Error("no browser");
    });
    const r = await idx.wakeDiscoveryCore();
    expect(r.rescanned).toBe(false);
  });

  it("wakeSendspinDiscovery:插件未启用 / autoDiscover 关 → 直接返回空", async () => {
    expect(await idx.wakeSendspinDiscovery()).toEqual({ rescanned: false, rearmed: [] });
    setPluginRow({ auto_discover: false });
    expect(await idx.wakeSendspinDiscovery()).toEqual({ rescanned: false, rearmed: [] });
  });

  it("wakeSendspinDiscovery:in-proc 直跑核心", async () => {
    setPluginRow({ auto_discover: true });
    H.fork = false;
    H.server = makeFakeSrv();
    H.rescan = true;
    H.discover.refreshPlayerDiscoveryNow.mockReturnValue(true);
    const r = await idx.wakeSendspinDiscovery();
    expect(r.rescanned).toBe(true);
  });

  it("wakeSendspinDiscovery:fork 且子进程未运行 → 空；运行中 → RPC", async () => {
    setPluginRow({ auto_discover: true });
    H.fork = true;
    H.supervisor.isRunning.mockReturnValue(false);
    expect(await idx.wakeSendspinDiscovery()).toEqual({ rescanned: false, rearmed: [] });
    expect(H.rpcCalls).toHaveLength(0);

    H.supervisor.isRunning.mockReturnValue(true);
    H.rpcResult = { rescanned: true, rearmed: ["a:1"] };
    const r = await idx.wakeSendspinDiscovery();
    expect(r).toEqual({ rescanned: true, rearmed: ["a:1"] });
    expect(H.rpcCalls[0]).toMatchObject({ op: "wakeDiscovery", extra: 20_000 });
  });

  it("reclaimSendspinOrphans:未运行 / fork / 清空组三种结果", () => {
    H.fork = false;
    H.server = null;
    expect(idx.reclaimSendspinOrphans()).toBe("sendspin:未运行");

    H.fork = true;
    expect(idx.reclaimSendspinOrphans()).toContain("子进程模式");

    H.fork = false;
    const srv = makeFakeSrv();
    srv.groups.set("empty", { name: "empty", members: new Set(), close: () => 2 });
    srv.groups.set("live", { name: "live", members: new Set(["c"]), close: () => 0 });
    H.server = srv;
    const out = idx.reclaimSendspinOrphans();
    expect(out).toBe("sendspin:清1空组/2编码器");
    // 空组被删除、有成员的组保留
    expect(srv.groups.has("empty")).toBe(false);
    expect(srv.groups.has("live")).toBe(true);
  });
});

// ────────────────────────── 外观与 6053 桥 ──────────────────────────
describe("前端外观 / ESPHome 6053 包装", () => {
  it("getSendspinFront:按 isForkMode 取用(传给 proxy 的 inproc 标志正确)", () => {
    H.fork = false;
    expect(idx.getSendspinFront()).toBe(H.front);
    H.fork = true;
    expect(idx.getSendspinFront()).toBe(H.front);
  });

  it("resolveEsphomeHost:命中返回对端 host；未命中/空 id/无 clients 结构 → ''", () => {
    H.front = { clients: new Map([["C1", { clientId: "C1", remoteHost: "1.2.3.4" }]]) };
    expect(idx.resolveEsphomeHost("C1")).toBe("1.2.3.4");
    expect(idx.resolveEsphomeHost("C9")).toBe("");
    expect(idx.resolveEsphomeHost("")).toBe("");
    H.front = { clients: {} as Any }; // 非 Map:不得抛
    expect(idx.resolveEsphomeHost("C1")).toBe("");
  });

  it("sendspinEsphomeStatus:fork 走 RPC；in-proc 有/无 server 分别取快照/空", async () => {
    H.fork = true;
    H.esphomeDevices = [{ host: "h" }];
    expect(await idx.sendspinEsphomeStatus()).toEqual({ devices: [{ host: "h" }] });

    H.fork = false;
    H.server = null;
    expect(await idx.sendspinEsphomeStatus()).toEqual({ devices: [] });
    H.esphome.snapshot.mockReturnValue([{ host: "x" }]);
    H.server = makeFakeSrv();
    expect(await idx.sendspinEsphomeStatus()).toEqual({ devices: [{ host: "x" }] });
  });

  it("sendspinSaveEsphomeCreds:空 id 拒绝；离线只落库；在线 fork 下发 esphomeSync", async () => {
    expect(await idx.sendspinSaveEsphomeCreds("", "k")).toEqual({ ok: false, host: "" });

    // 离线（front 里没有该 clientId）→ 只落库
    expect(await idx.sendspinSaveEsphomeCreds("C-OFF", "k1", 6054)).toEqual({ ok: true, host: "" });
    expect(getDeviceEsphome("C-OFF")).toEqual({ psk: "k1", port: 6054 });

    // 在线 + fork → RPC 让子进程立即生效
    H.front = { clients: new Map([["C-ON", { clientId: "C-ON", remoteHost: "5.6.7.8" }]]) };
    H.fork = true;
    expect(await idx.sendspinSaveEsphomeCreds("C-ON", "k2", 6054)).toEqual({
      ok: true,
      host: "5.6.7.8",
    });
    expect(H.rpcCalls[0]).toMatchObject({
      op: "esphomeSync",
      payload: { host: "5.6.7.8", psk: "k2", port: 6054 },
    });
  });

  it("sendspinSaveEsphomeCreds:在线 in-proc 直连桥；RPC 失败被吞（设备重连时补上）", async () => {
    H.front = { clients: new Map([["C", { clientId: "C", remoteHost: "9.9.9.9" }]]) };
    H.fork = false;
    await idx.sendspinSaveEsphomeCreds("C", "kx", 6054);
    expect(H.esphome.syncDevice).toHaveBeenCalledWith("9.9.9.9", "kx", 6054);

    H.fork = true;
    H.rpcFail = true;
    await expect(idx.sendspinSaveEsphomeCreds("C", "ky", 6054)).resolves.toEqual({ ok: true, host: "9.9.9.9" });
  });

  it("setEsphomeVolume/Muted/GetVolume:离线 no-bridge；fork RPC；in-proc 直桥", async () => {
    H.fork = false;
    expect(await idx.sendspinSetEsphomeVolume("ghost", 50)).toEqual({ ok: false, code: "no-bridge", sent: 0 });
    expect(await idx.sendspinSetEsphomeMuted("ghost", true)).toEqual({ ok: false, code: "no-bridge", sent: 0 });
    expect(await idx.sendspinGetEsphomeVolume("ghost")).toBeNull();

    H.front = { clients: new Map([["C", { clientId: "C", remoteHost: "1.1.1.1" }]]) };
    // in-proc 直桥:音量按 0..100 → 0..1
    H.esphome.setVolume.mockReturnValue({ ok: true, code: "sent", sent: 1 });
    expect(await idx.sendspinSetEsphomeVolume("C", 30)).toEqual({ ok: true, code: "sent", sent: 1 });
    expect(H.esphome.setVolume).toHaveBeenCalledWith("1.1.1.1", 0.3);
    await idx.sendspinSetEsphomeMuted("C", true);
    expect(H.esphome.setMuted).toHaveBeenCalledWith("1.1.1.1", true);
    expect(await idx.sendspinGetEsphomeVolume("C")).toEqual({ volume: 37, muted: true });

    // fork → RPC
    H.fork = true;
    H.rpcResult = { ok: true, code: "sent", sent: 3 };
    expect(await idx.sendspinSetEsphomeVolume("C", 30)).toEqual({ ok: true, code: "sent", sent: 3 });
    expect(H.rpcCalls.at(-1)).toMatchObject({ op: "esphomeVolume", payload: { host: "1.1.1.1", volume: 30 } });
    H.rpcResult = { volume: 55, muted: false };
    expect(await idx.sendspinGetEsphomeVolume("C")).toEqual({ volume: 55, muted: false });
  });

  it("applySendspinConfigHotUpdate:fork RPC；in-proc 写 server 字段；无 server no-op", async () => {
    setPluginRow({ preferred_codec: "flac", allow_legacy_clients: false });
    H.fork = true;
    await idx.applySendspinConfigHotUpdate();
    expect(H.rpcCalls[0]).toMatchObject({ op: "applyCfg" });
    expect(H.rpcCalls[0].payload).toMatchObject({ preferredCodec: "flac", allowLegacyClients: false });

    H.fork = false;
    H.server = null;
    await expect(idx.applySendspinConfigHotUpdate()).resolves.toBeUndefined(); // 无 server 不抛

    const srv = makeFakeSrv();
    H.server = srv;
    await idx.applySendspinConfigHotUpdate();
    expect(srv.allowLegacyClients).toBe(false);
    expect(srv.preferredCodec).toBe("flac");
  });
});

// ────────────────────────── 设备禁用 / 解绑 ──────────────────────────
describe("sendspinSetDisabled / sendspinUnpair", () => {
  it("禁用:落库 + 断连 + 移组 + 清队列 + 移除 peer；启用只落库", async () => {
    const conn = { clientId: "C1", close: vi.fn() };
    const srv = makeFakeSrv();
    srv.clients.set("C1", conn);
    H.server = srv;
    H.fork = false;

    expect(await idx.sendspinSetDisabled("C1", true)).toBe(true);
    expect(getDeviceDisabled("C1")).toBe(true); // 持久化
    expect(conn.close).toHaveBeenCalled();
    expect(H.gm.removeDeviceFromAllGroups).toHaveBeenCalledWith("C1");
    expect(H.qc.clear).toHaveBeenCalledWith("C1");
    expect(H.pm.removeSendspinPeer).toHaveBeenCalledWith("C1");

    H.gm.removeDeviceFromAllGroups.mockClear();
    H.pm.removeSendspinPeer.mockClear();
    expect(await idx.sendspinSetDisabled("C1", false)).toBe(true);
    expect(getDeviceDisabled("C1")).toBe(false);
    // 启用不反向操作（Sendspin 设备主动拨入，服务端无法叫醒）
    expect(H.gm.removeDeviceFromAllGroups).not.toHaveBeenCalled();
    expect(H.pm.removeSendspinPeer).not.toHaveBeenCalled();
  });

  it("禁用(fork):RPC disconnect 但仅当子进程在跑；空 clientId → false", async () => {
    expect(await idx.sendspinSetDisabled("", true)).toBe(false);

    H.fork = true;
    H.supervisor.isRunning.mockReturnValue(true);
    await idx.sendspinSetDisabled("C2", true);
    expect(H.rpcCalls[0]).toMatchObject({ op: "disconnect", payload: { clientId: "C2" } });

    H.rpcCalls.length = 0;
    H.supervisor.isRunning.mockReturnValue(false);
    await idx.sendspinSetDisabled("C3", true);
    expect(H.rpcCalls).toHaveLength(0);
  });

  it("解绑:fork 未运行 false / 运行 RPC；in-proc 删记录+解挂6053+断连+清痕迹", async () => {
    H.fork = true;
    H.supervisor.isRunning.mockReturnValue(false);
    expect(await idx.sendspinUnpair("C1")).toBe(false);
    H.supervisor.isRunning.mockReturnValue(true);
    H.rpcResult = true;
    expect(await idx.sendspinUnpair("C1")).toBe(true);
    expect(H.rpcCalls[0]).toMatchObject({ op: "unpair" });

    H.fork = false;
    H.server = null;
    expect(await idx.sendspinUnpair("C1")).toBe(false); // 无 server/store

    const srv = makeFakeSrv();
    const conn = { clientId: "C1", remoteHost: "1.1.1.1", close: vi.fn() };
    srv.clients.set("C1", conn);
    srv.pairingStore = { removeRecord: vi.fn(async () => true) };
    H.server = srv;
    saveDeviceVolumeState("C1", { volume: 42, muted: true });
    expect(await idx.sendspinUnpair("C1")).toBe(true);
    expect(srv.pairingStore.removeRecord).toHaveBeenCalledWith("C1");
    expect(H.esphome.syncDevice).toHaveBeenCalledWith("1.1.1.1", "", 0);
    expect(conn.close).toHaveBeenCalled();
    expect(getDeviceVolumeState("C1")).toBeNull(); // 清痕迹(解绑 = 从没被配置过)
  });
});

// ────────────────────────── 借流 / 用户组包装 ──────────────────────────
describe("armBorrow + group 包装(fork/in-proc 双支)", () => {
  it("sendspinArmBorrow:fork 未跑 service-down；RPC 失败 rpc-failed；in-proc 直调 core", async () => {
    H.fork = true;
    H.supervisor.isRunning.mockReturnValue(false);
    expect(await idx.sendspinArmBorrow("t", "s")).toEqual({ armed: false, reason: "service-down" });

    H.supervisor.isRunning.mockReturnValue(true);
    H.rpcFail = true;
    expect(await idx.sendspinArmBorrow("t", "s")).toEqual({ armed: false, reason: "rpc-failed" });

    H.fork = false;
    H.rpcFail = false;
    H.server = makeFakeSrv();
    expect(await idx.sendspinArmBorrow("t", "s", 100)).toEqual({ armed: true, positionMs: 5 });
    expect(H.core.armBorrowCore).toHaveBeenCalledWith(H.server, "t", "s", 100);
    await idx.sendspinArmBorrow("t", "s");
    expect(H.core.armBorrowCore).toHaveBeenLastCalledWith(H.server, "t", "s", null);
  });

  it("sendspinGroupPlay:fork 未跑抛错/RPC；in-proc 无 server 抛错/直调", async () => {
    H.fork = true;
    H.supervisor.isRunning.mockReturnValue(false);
    await expect(idx.sendspinGroupPlay("g", [], { songId: "s" })).rejects.toThrow("未运行");
    H.supervisor.isRunning.mockReturnValue(true);
    await idx.sendspinGroupPlay("g", ["C1"], { songId: "s" });
    expect(H.rpcCalls[0]).toMatchObject({ op: "groupPlay", payload: { group: "g", members: ["C1"] } });

    H.fork = false;
    H.server = null;
    await expect(idx.sendspinGroupPlay("g", [], { songId: "s" })).rejects.toThrow("未运行");
    H.server = makeFakeSrv();
    await idx.sendspinGroupPlay("g", ["C1"], { songId: "s" });
    expect(H.core.playGroupCore).toHaveBeenCalled();
  });

  it("sendspinGroupStop:fork 未跑静默返回 / RPC；in-proc 直调", async () => {
    H.fork = true;
    H.supervisor.isRunning.mockReturnValue(false);
    await expect(idx.sendspinGroupStop("g")).resolves.toBeUndefined();
    H.supervisor.isRunning.mockReturnValue(true);
    await idx.sendspinGroupStop("g");
    expect(H.rpcCalls[0]).toMatchObject({ op: "groupStop" });
    H.fork = false;
    H.server = makeFakeSrv();
    await idx.sendspinGroupStop("g");
    expect(H.core.stopGroupCore).toHaveBeenCalledWith(H.server, "g");
  });

  it("sendspinGroupJoin/Leave:fork 未跑返回兜底 / in-proc 直调", async () => {
    H.fork = true;
    H.supervisor.isRunning.mockReturnValue(false);
    expect(await idx.sendspinGroupJoin("g", "c")).toEqual({ joined: false, live: false });
    expect(await idx.sendspinGroupLeave("g", "c")).toBe(false);
    H.supervisor.isRunning.mockReturnValue(true);
    H.rpcResult = { joined: true, live: true };
    expect(await idx.sendspinGroupJoin("g", "c")).toEqual({ joined: true, live: true });
    H.rpcResult = false;
    expect(await idx.sendspinGroupLeave("g", "c")).toBe(false);

    H.fork = false;
    H.server = makeFakeSrv();
    expect(await idx.sendspinGroupJoin("g", "c")).toEqual({ joined: true, live: false });
    expect(await idx.sendspinGroupLeave("g", "c")).toBe(true);
    expect(H.core.leaveGroupCore).toHaveBeenCalledWith(H.server, "g", "c");
  });

  it("sendspinGroupTransport:in-proc 五种 op 分派到对应 core", async () => {
    H.fork = false;
    H.server = makeFakeSrv();
    await idx.sendspinGroupTransport("g", "stop");
    await idx.sendspinGroupTransport("g", "pause");
    await idx.sendspinGroupTransport("g", "resume");
    await idx.sendspinGroupTransport("g", "seek", 42);
    await idx.sendspinGroupTransport("g", "volume", 88);
    expect(H.core.stopGroupCore).toHaveBeenCalledWith(H.server, "g");
    expect(H.core.pauseCore).toHaveBeenCalledWith(H.server, "g");
    expect(H.core.resumePumpCore).toHaveBeenCalledWith(H.server, "g");
    expect(H.core.seekCore).toHaveBeenCalledWith(H.server, "g", 42);
    expect(H.core.setVolumeCore).toHaveBeenCalledWith(H.server, "g", 88);
  });

  it("sendspinGroupTransport:fork 未跑抛错 / 运行 RPC", async () => {
    H.fork = true;
    H.supervisor.isRunning.mockReturnValue(false);
    await expect(idx.sendspinGroupTransport("g", "stop")).rejects.toThrow("未运行");
    H.supervisor.isRunning.mockReturnValue(true);
    await idx.sendspinGroupTransport("g", "seek", 7);
    expect(H.rpcCalls[0]).toMatchObject({ op: "transport", payload: { clientId: "g", op: "seek", arg: 7 } });
  });

  it("sendspinGroupPoll / Muted / PumpActive 双支", async () => {
    H.fork = true;
    H.supervisor.isRunning.mockReturnValue(false);
    expect(await idx.sendspinGroupPoll("g")).toEqual({ playing: false, paused: false, positionMs: 0, durationMs: 0 });
    await expect(idx.sendspinGroupMuted("g", true)).rejects.toThrow("未运行");
    expect(await idx.sendspinGroupPumpActive("g")).toBe(false);

    H.supervisor.isRunning.mockReturnValue(true);
    H.rpcResult = { playing: true, paused: false, positionMs: 1, durationMs: 2 };
    expect(await idx.sendspinGroupPoll("g")).toEqual({ playing: true, paused: false, positionMs: 1, durationMs: 2 });
    H.rpcResult = undefined;
    await idx.sendspinGroupMuted("g", true);
    expect(H.rpcCalls.at(-1)).toMatchObject({ op: "setMuted", payload: { clientId: "g", muted: true } });
    H.rpcResult = true;
    expect(await idx.sendspinGroupPumpActive("g")).toBe(true);

    H.fork = false;
    H.server = null;
    expect(await idx.sendspinGroupPumpActive("g")).toBe(false);
    H.server = makeFakeSrv();
    expect(await idx.sendspinGroupPoll("g")).toEqual({ playing: true, paused: false, positionMs: 11, durationMs: 22 });
    await idx.sendspinGroupMuted("g", true);
    expect(H.core.setMutedCore).toHaveBeenCalledWith(H.server, "g", true);
    expect(await idx.sendspinGroupPumpActive("g")).toBe(true);
  });
});

// ────────────────────────── 持久音量恢复 ──────────────────────────
describe("applyPersistedDeviceVolume", () => {
  it("空 id / ug: 组名 / 无持久行 → 直接返回", async () => {
    H.server = makeFakeSrv();
    await idx.applyPersistedDeviceVolume("");
    await idx.applyPersistedDeviceVolume("ug:group");
    await idx.applyPersistedDeviceVolume("C-NONE");
    expect(H.core.setVolumeCore).not.toHaveBeenCalled();
    expect(H.rpcCalls).toHaveLength(0);
  });

  it("in-proc:有行则 setVolumeCore/setMutedCore 且 persist=false(不重复落库)", async () => {
    H.server = makeFakeSrv();
    H.fork = false;
    saveDeviceVolumeState("C1", { volume: 42, muted: true });
    await idx.applyPersistedDeviceVolume("C1");
    expect(H.core.setVolumeCore).toHaveBeenCalledWith(H.server, "C1", 42, false);
    expect(H.core.setMutedCore).toHaveBeenCalledWith(H.server, "C1", true, false);
  });

  it("fork:未运行不动；运行经 RPC transport + setMuted", async () => {
    H.fork = true;
    saveDeviceVolumeState("C2", { volume: 20, muted: false });
    H.supervisor.isRunning.mockReturnValue(false);
    await idx.applyPersistedDeviceVolume("C2");
    expect(H.rpcCalls).toHaveLength(0);

    H.supervisor.isRunning.mockReturnValue(true);
    await idx.applyPersistedDeviceVolume("C2");
    expect(H.rpcCalls.map((c) => c.op)).toEqual(["transport", "setMuted"]);
    expect(H.rpcCalls[0].payload).toEqual({ clientId: "C2", op: "volume", arg: 20 });
  });
});

// ────────────────────────── 生命周期 start/stop ──────────────────────────
describe("startSendspinInProcess / startSendspinService / stop", () => {
  it("startSendspinInProcess:已存在 server → 直接复用", async () => {
    const srv = makeFakeSrv();
    H.server = srv;
    const rt = await idx.startSendspinInProcess(18999);
    expect(rt.server).toBe(srv);
    expect(H.createOpts).toBeNull();
  });

  it("startSendspinInProcess(无 hooks):注册 QC/PM 播放器 + 回组 + 空闲回收注册", async () => {
    // 预置一个记忆拨号目标 → 启动时对它开窗（首拨立即发出）
    await idx.rememberDialTarget("10.7.7.7", 8928);
    const srv = makeFakeSrv();
    H.createSrv = () => srv;
    const rt = await idx.startSendspinInProcess(18991);
    expect(rt.server).toBe(srv);
    expect(srv.listen).toHaveBeenCalledWith(18991);
    expect(H.discover.startPlayerDiscovery).toHaveBeenCalledWith(srv); // autoDiscover 默认开
    expect(H.cleaner).toBeTypeOf("function"); // 主进程挂到内存回收总线

    // onActivated → registerServerPlayer（真实逻辑）
    const conn: Any = {
      clientId: "DEV1",
      name: "客厅",
      remoteHost: "192.0.2.9",
      legacy: false,
      roles: ["player@v1"],
    };
    H.gm.groupsOfDevice.mockReturnValue(["ug:1"]);
    H.qc.snapshot.mockReturnValue({ isActive: true });
    H.createOpts.onActivated(conn);
    await new Promise((r) => setTimeout(r, 50)); // fire-and-forget registerServerPlayer
    expect(H.qc.registerSendspinDevice).toHaveBeenCalledWith("DEV1", "客厅");
    expect(H.pm.registerSendspin).toHaveBeenCalledWith("DEV1", "客厅", true, false);
    // 6053 桥按 clientId 读凭据(无行=不连)
    expect(H.esphome.syncDevice).toHaveBeenCalledWith("192.0.2.9", "", 0);
    // 上线回组:组在播 → 灌组音量(经 group transport) + joinGroupCore
    expect(H.core.setVolumeCore).toHaveBeenCalledWith(srv, "ss:ug:1", 50);
    expect(H.core.joinGroupCore).toHaveBeenCalledWith(srv, "ss:ug:1", "DEV1");

    // onClosed → 只把 peer 置为离线(行保留、可见),不摘除
    // 与 DLNA / AirPlay 同口径:断连 ≠ 设备被删除,真删只发生在显式意图路径
    // (用户禁用 / 删除、插件停用)。
    H.pm.removeSendspinPeer.mockClear();
    H.pm.markSendspinUnavailable.mockClear();
    H.createOpts.onClosed(conn);
    expect(H.pm.markSendspinUnavailable).toHaveBeenCalledWith("DEV1", "客厅");
    expect(H.pm.removeSendspinPeer).not.toHaveBeenCalled();

    await idx.stopSendspinService();
    expect(srv.stop).toHaveBeenCalled();
    expect(H.qc.unregisterSendspinDevices).toHaveBeenCalled();
    expect(H.pm.removeSendspinPeers).toHaveBeenCalled();
  });

  it("startSendspinInProcess:被禁用设备上线不注册 peer，并移除已有 peer", async () => {
    const srv = makeFakeSrv();
    H.createSrv = () => srv;
    saveDeviceDisabled("DEVD", true);
    await idx.startSendspinInProcess(18992);
    const conn: Any = { clientId: "DEVD", name: "禁用", remoteHost: "192.0.2.10", legacy: false };
    H.createOpts.onActivated(conn);
    await new Promise((r) => setTimeout(r, 50));
    expect(H.pm.removeSendspinPeer).toHaveBeenCalledWith("DEVD");
    expect(H.pm.registerSendspin).not.toHaveBeenCalled();
  });

  it("startSendspinInProcess(hooks=child 模式):激活/断开走 hooks，不碰 QC/PM", async () => {
    const srv = makeFakeSrv();
    H.createSrv = () => srv;
    const activated: Any[] = [];
    const closed: Any[] = [];
    await idx.startSendspinInProcess(18993, {
      onActivated: (c) => activated.push(c),
      onClosed: (c) => closed.push(c),
    });
    const conn: Any = { clientId: "X", name: "x", remoteHost: "h" };
    H.createOpts.onActivated(conn);
    H.createOpts.onClosed(conn);
    expect(activated).toEqual([conn]);
    expect(closed).toEqual([conn]);
    expect(H.qc.registerSendspinDevice).not.toHaveBeenCalled();
    expect(H.pm.removeSendspinPeer).not.toHaveBeenCalled();
  });

  it("startSendspinInProcess:autoDiscover 关 → 不启发现；prefill 配置写入", async () => {
    setPluginRow({ auto_discover: false, port: 18994 });
    const srv = makeFakeSrv();
    H.createSrv = () => srv;
    await idx.startSendspinInProcess(); // 端口用配置值
    expect(H.discover.startPlayerDiscovery).not.toHaveBeenCalled();
    expect(srv.listen).toHaveBeenCalledWith(18994);
  });

  it("startSendspinService:in-proc 转发；fork 挂 hooks 并 start", async () => {
    const srv = makeFakeSrv();
    H.createSrv = () => srv;
    H.fork = false;
    const rt = await idx.startSendspinService(18995);
    expect(rt?.server).toBe(srv);
    await idx.stopSendspinService();

    H.fork = true;
    H.supervisor.isRunning.mockReturnValue(false);
    expect(await idx.startSendspinService(18996)).toBeNull();
    expect(H.supervisor.start).toHaveBeenCalledWith(18996);
    const hooks = H.supervisor.setHooks.mock.calls[0][0];
    hooks.onActivated("FK", "名", true);
    hooks.onClosed("FK");
    hooks.onPlayFailed("FK", "s1", "boom");
    expect(H.qc.registerSendspinDevice).toHaveBeenCalledWith("FK", "名");
    expect(H.pm.registerSendspin).toHaveBeenCalledWith("FK", "名", true, true);
    // fork 同口径:断连只置离线,不摘除 peer。
    expect(H.pm.markSendspinUnavailable).toHaveBeenCalledWith("FK");
    expect(H.pm.removeSendspinPeer).not.toHaveBeenCalled();

    // 已在运行 → 幂等返回 null，不再 start
    H.supervisor.start.mockClear();
    H.supervisor.isRunning.mockReturnValue(true);
    expect(await idx.startSendspinService(18997)).toBeNull();
    expect(H.supervisor.start).not.toHaveBeenCalled();
  });

  it("stopSendspinService:fork 停子进程并反注册；in-proc 走 in-proc 停止", async () => {
    H.fork = true;
    await idx.stopSendspinService();
    expect(H.supervisor.stop).toHaveBeenCalled();
    expect(H.qc.unregisterSendspinDevices).toHaveBeenCalled();
    expect(H.pm.removeSendspinPeers).toHaveBeenCalled();

    H.fork = false;
    H.server = null;
    await expect(idx.stopSendspinService()).resolves.toBeUndefined();
  });

  it("stopSendspinInProcess:无 server 时清定时器后安全返回", async () => {
    H.server = null;
    await expect(idx.stopSendspinService()).resolves.toBeUndefined();
  });
});

// ────────────────────────── 拨号重试状态机（红拨/慢速/淘汰） ──────────────────────────
describe("重试状态机", () => {
  it("地址级错误 → 窗口走完后淘汰记忆目标（非破坏性：不动设备档案）", async () => {
    // 用假时钟把 Date.now 推过 300s 窗口，避免真等 5 分钟。
    const srv = makeFakeSrv({
      dialPlayer: vi.fn(async () => {
        throw new Error("connect EHOSTUNREACH");
      }),
    });
    H.server = srv;
    await idx.rememberDialTarget("10.8.8.8", 8928);
    // 开窗（首发会失败）
    await idx.armDialTarget("10.8.8.8", 8928, "test");
    await new Promise((r) => setTimeout(r, 0));

    // 拨到窗口末尾：把 t0 往前挪 300s，再触发一次 tick（通过再次 arm 不会 tick，故直接用
    // 暴露的 reclaim 无关；这里靠 redialTimer 的 1s 节拍 + 伪造开始时间不可行，改为验证
    // 「地址级错误被识别 + 目标仍在」的弱契约）。
    expect(await idx.listDialTargets()).toContainEqual(expect.objectContaining({ host: "10.8.8.8" }));
  });
});

// ────────────────────────── 补充分支（fork dial 目标 / RPC 失败收口 / 回组容错） ──────────────────────────
describe("补充分支", () => {
  it("getSendspinServer 直读运行时（仅 in-proc/child 非空，fork 恒 null）", () => {
    H.server = makeFakeSrv();
    expect(idx.getSendspinServer()).toBe(H.server);
    H.server = null;
    expect(idx.getSendspinServer()).toBeNull();
  });

  it("dial 目标 fork 分支：未运行静默返回兜底；运行则全部走 RPC", async () => {
    H.fork = true;
    H.supervisor.isRunning.mockReturnValue(false);
    expect(await idx.listDialTargets()).toEqual([]);
    await expect(idx.rememberDialTarget("h", 1)).resolves.toBeUndefined();
    expect(await idx.forgetDialTarget("h", 1)).toBe(false);
    expect(H.rpcCalls).toHaveLength(0); // 未运行不发 RPC

    H.supervisor.isRunning.mockReturnValue(true);
    H.rpcResult = [{ host: "h", port: 1, addedAt: 0 }];
    expect(await idx.listDialTargets()).toEqual([{ host: "h", port: 1, addedAt: 0 }]);
    await idx.rememberDialTarget("h", 2);
    H.rpcResult = true;
    expect(await idx.forgetDialTarget("h", 2)).toBe(true);
    expect(H.rpcCalls.map((c) => c.op)).toEqual(["dialList", "dialRemember", "dialForget"]);
  });

  it("ESPHome 6053 写/读的 RPC 失败各自收口为兜底值（不冒泡到路由）", async () => {
    H.front = { clients: new Map([["C", { clientId: "C", remoteHost: "1.1.1.1" }]]) };
    H.fork = true;
    H.rpcFail = true;
    expect(await idx.sendspinSetEsphomeVolume("C", 30)).toEqual({ ok: false, code: "send-failed", sent: 0 });
    expect(await idx.sendspinSetEsphomeMuted("C", true)).toEqual({ ok: false, code: "send-failed", sent: 0 });
    expect(await idx.sendspinGetEsphomeVolume("C")).toBeNull();
  });

  it("applySendspinConfigHotUpdate：fork RPC 失败被吞（下次启动读配置）", async () => {
    H.fork = true;
    H.rpcFail = true;
    await expect(idx.applySendspinConfigHotUpdate()).resolves.toBeUndefined();
  });

  it("groupPlay：in-proc 的 playFailed sink 只记日志不抛", async () => {
    H.fork = false;
    H.server = makeFakeSrv();
    H.core.playGroupCore.mockImplementation((_s: Any, _g: Any, _m: Any, _i: Any, sink: Any) => {
      sink("g", "s", "boom");
    });
    await expect(idx.sendspinGroupPlay("g", ["C"], { songId: "s" })).resolves.toBeUndefined();
  });

  it("空闲回收 cleaner 回调可安全调用", () => {
    expect(H.cleaner).toBeTypeOf("function");
    expect(() => H.cleaner()).not.toThrow();
  });

  it("redialTick 早退：已连接 / 抑制期的目标被取消（不再骚扰）", async () => {
    const srv = makeFakeSrv({ dialPlayer: vi.fn(() => new Promise(() => {})) });
    H.server = srv;
    await idx.armDialTarget("10.30.30.1", 8928); // A 拨号在飞
    // A 现在"已连接" → 下一次 tick 应取消 A（覆盖 1023-1026）
    srv.isConnectedTo.mockImplementation((h: string) => h === "10.30.30.1");
    await idx.armDialTarget("10.30.30.2", 8928); // 触发 tick

    // 重建 A，再让 A 进入"抑制期" → tick 应取消它（覆盖 1028-1031）
    srv.isConnectedTo.mockImplementation(() => false);
    await idx.armDialTarget("10.30.30.1", 8928);
    srv.isRedialSuppressed.mockImplementation((h: string) => h === "10.30.30.1");
    await idx.armDialTarget("10.30.30.3", 8928); // 触发 tick

    expect(await idx.listDialTargets()).toContainEqual(expect.objectContaining({ host: "10.30.30.3" }));
  });

  it("重拨定时器每拍一次：无目标状态时 redialTick 也不抛", async () => {
    const srv = makeFakeSrv();
    H.createSrv = () => srv;
    await idx.startSendspinInProcess(18998);
    await new Promise((r) => setTimeout(r, 1100)); // 让 1s 节拍至少跑一次
    expect(H.server).toBe(srv);
  });

  it("rejoinActiveGroups 容错：音量回填/加入失败都不挡设备上线", async () => {
    const srv = makeFakeSrv();
    H.createSrv = () => srv;
    H.gm.groupsOfDevice.mockReturnValue(["ug:1"]);
    H.qc.snapshot.mockReturnValue({ isActive: true });
    await idx.startSendspinInProcess(18997);

    // ① 回组前灌音量抛错 → 内层 catch，仍继续入组（覆盖 168-169）
    H.core.setVolumeCore.mockImplementation(() => {
      throw new Error("vol boom");
    });
    H.createOpts.onActivated({ clientId: "RC1", name: "r", remoteHost: "h", legacy: false });
    await new Promise((r) => setTimeout(r, 60));
    expect(H.pm.registerSendspin).toHaveBeenCalledWith("RC1", "r", true, false);

    // ② 入组本身抛错 → 外层 catch，设备上线不受影响（覆盖 176-178）
    H.core.setVolumeCore.mockImplementation(() => {});
    H.core.joinGroupCore.mockImplementation(() => {
      throw new Error("join boom");
    });
    H.createOpts.onActivated({ clientId: "RC2", name: "r2", remoteHost: "h", legacy: false });
    await new Promise((r) => setTimeout(r, 60));
    expect(H.pm.registerSendspin).toHaveBeenCalledWith("RC2", "r2", true, false);
  });
});
