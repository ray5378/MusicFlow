// ==================== sendspin/index.ts 覆盖率补口:拨号重试状态机 + 生命周期兜底 ====================
//
// 缺口(此前全黑):
//   - 重试状态机的**慢速阶段**播报(60s 后从 2s 节拍切 10s,必须明说,否则排障时
//     会以为"重拨停了")与**第 2 次起降为 debug**(防一台离线设备 5 分钟刷 54 行);
//   - 窗口走完那一拍的**两个分叉**:仍有拨号在飞 → 先等它落地(不许把"其实刚连上"
//     的设备误判成失败);已无在飞且全程地址级不可达 → **淘汰**记忆目标(非破坏性);
//   - redialTimer 每拍的 try/catch:一拍异常不许把整个定时器打死;
//   - hooks(child)模式下 600s 空闲回收兜底确实会清掉无成员残留组;
//   - isSendspinEnabled 读库异常 → false(插件未启用语义,不抛给路由);
//   - ESPHome mute 的 fork RPC **成功**路径与 `r ?? 兜底`。
//
// 隔离:沿用一套轻量替身(mode/runtime/supervisor/server/identity/pairingStore/
// pairServer/advertise/discover/streamEngine/playerCore/group/player/peer/proxy/
// esphome/reclaim),真实保留 sqlite 与 fs(dial_targets.json 正是要验证的持久层契约)。
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
    server: null as Any,
    createSrv: null as Any,
    identity: { serverId: "srv-fake", privateKey: new Uint8Array(0) },
    pairingStore: { removeRecord: async () => true, getRecord: () => undefined, listRecords: () => [] },
    front: { clients: new Map<string, Any>() },
    rescan: true,
    rpcCalls: calls,
    rpcResult: undefined as Any,
    rpcFail: false,
    cleaner: null as Any,
    qc: { registerSendspinDevice: vi.fn(), unregisterSendspinDevices: vi.fn(), snapshot: vi.fn(() => ({ isActive: false })), clear: vi.fn() },
    pm: { registerSendspin: vi.fn(), removeSendspinPeer: vi.fn(), removeSendspinPeers: vi.fn() },
    gm: { groupsOfDevice: vi.fn(() => [] as string[]), getVolume: vi.fn(() => 50), removeDeviceFromAllGroups: vi.fn() },
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
      pollCore: vi.fn(() => ({ playing: true, positionMs: 11, durationMs: 22 })),
      pumpActiveCore: vi.fn(() => true),
      armBorrowCore: vi.fn(() => ({ armed: true, positionMs: 5 })),
    },
    supervisor: { setHooks: vi.fn(), start: vi.fn(async () => {}), stop: vi.fn(async () => {}), isRunning: vi.fn(() => false), rpc: vi.fn() },
    discover: { startPlayerDiscovery: vi.fn(), stopPlayerDiscovery: vi.fn(), refreshPlayerDiscoveryNow: vi.fn(() => true) },
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
  getSendspinFront: () => H.front,
  proxyEsphomeStatus: async () => ({ devices: [] }),
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
      return H.createSrv(opts);
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
vi.mock("../../src/services/sendspin/identity.js", () => ({ loadOrCreateIdentity: async () => H.identity }));
vi.mock("../../src/services/sendspin/pairingStore.js", () => ({ PairingStore: { open: async () => H.pairingStore } }));
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
const T0 = 1_700_000_000_000; // 固定基准时刻(配合 vi.setSystemTime 推进重试窗口)

/** 让本模块的重试状态机在「只假造 Date」的时钟下推进(real timers 用于 flush 微任务/IO)。 */
const useDateOnlyFakeTimers = (): void => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
};
const flush = async (): Promise<void> => {
  // 两轮:一轮给 promise 回调(拨号 catch),一轮给 fs 落盘等真实 I/O。
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

/** 轮询等待某条日志出现,直到真实定时器跑满 tries 拍(默认 10ms×300≈3s)。
 *
 *  ⚠️ 刻意**不用 Date.now() 计超时**:本文件多处 toFake:["Date"],Date 被冻结,
 *  用时钟差会算出恒 0 → 死循环。用「真实 setTimeout 计数」作为进度,与伪造时钟无关。
 *
 *  为什么要轮询而不是固定 flush:淘汰路径是 `void evictStaleTarget(...)`,其 log.warn
 *  排在 `await saveDialTargets()`(真实 fs 落盘)**之后**;在整包并跑(I/O 争用)时
 *  固定的两拍 flush 可能还没等到落盘完成,日志尚未发出 → 断言假失败。轮询消除了这个
 *  对机器负载的隐式依赖(该用例本身不测落盘快慢,只测「窗口收尾确实淘汰并告警」)。 */
const waitForLog = async (spy: Any, pred: (line: string) => boolean, tries = 300): Promise<boolean> => {
  const hit = (): boolean => spy.mock.calls.map((c: Any[]) => String(c[0])).some(pred);
  for (let i = 0; i < tries; i++) {
    if (hit()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return hit();
};

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sendspin-idx2-prime-"));
  idx.setSendspinIdentityDir(dir);
  H.fork = false;
  H.server = null;
  H.createSrv = () => makeFakeSrv();
  await idx.startSendspinService(18990);
  await idx.stopSendspinService();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  initDatabase();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sendspin-idx2-"));
  idx.setSendspinIdentityDir(tmpDir);
  H.fork = false;
  H.server = null;
  H.createSrv = () => makeFakeSrv();
  H.rpcCalls.length = 0;
  H.rpcResult = undefined;
  H.rpcFail = false;
  H.front = { clients: new Map<string, Any>() };
  for (const group of [H.qc, H.pm, H.gm, H.esphome, H.core, H.supervisor, H.discover]) {
    for (const f of Object.values(group)) {
      if (typeof f === "function" && (f as Any).mockClear) (f as Any).mockClear();
    }
  }
  H.supervisor.isRunning.mockReturnValue(false);
  H.discover.refreshPlayerDiscoveryNow.mockReturnValue(true);
});

afterEach(async () => {
  try {
    await idx.stopSendspinService();
  } catch {
    /* ignore */
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ────────────────────────── 拨号重试状态机 ──────────────────────────
describe("重试状态机:慢速阶段 / 二次失败降级 / 窗口收尾", () => {
  it("进入慢速阶段必须明说一次,且第 2 次失败降为 debug(不刷屏)", async () => {
    useDateOnlyFakeTimers();
    // 全程开 debug:debug 行才输出,而「第 2 次失败」那行是异步 catch 里打的,
    // 若只在校验前后临时切级别,异步落点可能已错过窗口 → 这里整段生效,末尾还原。
    const savedLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "debug";
    try {
      const srv = makeFakeSrv({
        dialPlayer: vi.fn(async () => {
          throw new Error("connect EHOSTUNREACH");
        }),
      });
      H.server = srv;
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await idx.armDialTarget("10.71.71.1", 8928, "test");
      await flush();

      vi.setSystemTime(T0 + 61_000); // 越过 60s 快速窗口
      await idx.armDialTarget("10.71.71.2", 8928, "test"); // 触发一拍 tick

      // 契约:阶段切换必须有一条 info —— 否则排障时会误判"重拨停了"。
      expect(await waitForLog(logSpy, (l) => l.includes("重试进入慢速阶段") && l.includes("10.71.71.1"))).toBe(true);
      // 契约:第 2 次起降为 debug,避免一台离线设备 5 分钟刷几十行。
      expect(await waitForLog(logSpy, (l) => l.includes("重拨失败(第 2 次)") && l.includes("10.71.71.1"))).toBe(true);
      // 该目标确实拨过两次以上
      const dials = srv.dialPlayer.mock.calls.filter((c: Any[]) => String(c[0]).includes("10.71.71.1"));
      expect(dials.length).toBeGreaterThanOrEqual(2);
    } finally {
      if (savedLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = savedLevel;
    }
  });

  it("窗口走完但仍有拨号在飞 → 先等它落地,不淘汰目标", async () => {
    useDateOnlyFakeTimers();
    // 拨号永不落地 → retryInFlight 一直持有该 key
    const srv = makeFakeSrv({ dialPlayer: vi.fn(() => new Promise(() => {})) });
    H.server = srv;
    await idx.armDialTarget("10.72.72.1", 8928, "test");
    await flush();
    vi.setSystemTime(T0 + 301_000); // 超过 300s 窗口
    await idx.armDialTarget("10.72.72.2", 8928, "test"); // 触发 tick
    await flush();
    // 契约:有在飞时不得删状态/淘汰 —— 否则"其实刚连上"的设备会被误判失败丢掉档案。
    expect(await idx.listDialTargets()).toContainEqual(expect.objectContaining({ host: "10.72.72.1" }));
  });

  it("窗口走完、无在飞、全程地址级不可达 → 非破坏性淘汰记忆目标", async () => {
    useDateOnlyFakeTimers();
    const srv = makeFakeSrv({
      dialPlayer: vi.fn(async () => {
        throw new Error("connect ENETUNREACH");
      }),
    });
    H.server = srv;
    await idx.rememberDialTarget("10.73.73.1", 8928);
    const logSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await idx.armDialTarget("10.73.73.1", 8928, "test");
    await flush();
    vi.setSystemTime(T0 + 301_000);
    await idx.armDialTarget("10.73.73.2", 8928, "test"); // 触发 tick
    await flush();

    // 契约:淘汰只从 dial_targets 移除;设备重新被 mDNS 看到会以新地址再入册。
    expect(await idx.listDialTargets()).not.toContainEqual(expect.objectContaining({ host: "10.73.73.1" }));
    // 告警排在 await saveDialTargets()(真实落盘)之后 → 轮询等到它出现,不赌机器负载。
    expect(await waitForLog(logSpy, (l) => l.includes("拨号目标已失效") && l.includes("10.73.73.1"))).toBe(true);
  });
});

// ────────────────────────── 定时器兜底 ──────────────────────────
describe("redialTimer / 空闲回收的兜底", () => {
  it("redialTick 抛错 → 本拍被吞并打 warn,定时器不死(下一拍照跑)", async () => {
    vi.useFakeTimers();
    const srv = makeFakeSrv({ dialPlayer: vi.fn(() => new Promise(() => {})) });
    H.createSrv = () => srv;
    await idx.startSendspinInProcess(18997);
    await idx.armDialTarget("10.74.74.1", 8928, "test");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 让 tick 里的第一个判据直接抛错
    srv.isConnectedTo.mockImplementation(() => {
      throw new Error("state boom");
    });
    await vi.advanceTimersByTimeAsync(1_000);
    // 契约:一拍异常不许打死整个定时器(否则重拨永久停摆且无任何提示)。
    expect(warnSpy.mock.calls.map((c) => String(c[0])).some((l) => l.includes("redial tick failed"))).toBe(true);
    // 定时器仍在:再推一拍不抛
    await vi.advanceTimersByTimeAsync(1_000);
  });

  it("hooks(child)模式:600s 兜底回收确实清掉无成员的残留组", async () => {
    vi.useFakeTimers();
    const srv = makeFakeSrv();
    srv.groups.set("lt1-empty", { name: "lt1-empty", members: new Set(), close: () => 1 });
    H.createSrv = () => srv;
    await idx.startSendspinInProcess(18998, { onActivated: () => {}, onClosed: () => {} });
    expect(srv.groups.has("lt1-empty")).toBe(true);
    await vi.advanceTimersByTimeAsync(600_000);
    // 契约:异常残留(tab 空但仍挂在 server.groups)必须被周期回收,否则内存/CPU 双泄漏。
    expect(srv.groups.has("lt1-empty")).toBe(false);
  });
});

// ────────────────────────── 读库异常与 RPC 兜底 ──────────────────────────
describe("isSendspinEnabled / ESPHome mute RPC", () => {
  it("读 plugins 表抛错 → false(按未启用处理,不冒泡)", () => {
    const spy = vi.spyOn(sqlite, "prepare").mockImplementation(() => {
      throw new Error("db closed");
    });
    try {
      expect(idx.isSendspinEnabled()).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("fork 下 esphomeMute RPC 成功 → 原样返回;rpc 返回 undefined → 兜底 send-failed", async () => {
    H.front = { clients: new Map([["C", { clientId: "C", remoteHost: "1.1.1.1" }]]) };
    H.fork = true;
    H.rpcResult = { ok: true, code: "sent", sent: 5 };
    expect(await idx.sendspinSetEsphomeMuted("C", true)).toEqual({ ok: true, code: "sent", sent: 5 });
    expect(H.rpcCalls.at(-1)).toMatchObject({ op: "esphomeMute", payload: { host: "1.1.1.1", muted: true } });

    // 契约:RPC 返回空值(子进程异常/旧版本)时必须有兜底结构,前端不能收到 undefined。
    H.rpcResult = undefined;
    expect(await idx.sendspinSetEsphomeMuted("C", true)).toEqual({ ok: false, code: "send-failed", sent: 0 });
  });
});
