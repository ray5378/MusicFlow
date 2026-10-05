// sendspin fork 模式「主进程侧外观」(镜像 + RPC 代理)契约测试。
//
// 这层是路由唯一的状态入口:同步读走 supervisor 维护的**镜像**,命令写走 RPC 转给子进程。
// 一旦某个 getter 漏读镜像字段、或某个写操作忘了发 RPC,表现是「UI 改了 app 里没变」
// —— 分叉点全在这个文件,所以逐条钉死。
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, vi } from "vitest";

type Any = any;

/** 共享可变状态:vi.mock 工厂会被提升,只能用 vi.hoisted 的闭包。 */
const H = vi.hoisted(() => ({
  running: false,
  inProcServer: null as Any,
  rpcCalls: [] as Array<{ op: string; payload: Any; extra: Any }>,
  rpcResult: undefined as Any,
  mirror: {
    port: 8928,
    serverId: "srv-abc",
    clients: new Map<string, Any>(),
    groups: new Map<string, Any>(),
    records: new Map<string, Any>(),
    attempts: [] as Any[],
  },
}));

vi.mock("../../src/services/sendspin/supervisor.js", () => ({
  sendspinSupervisor: {
    isRunning: () => H.running,
    mirror: H.mirror,
    rpc: async (...args: Any[]) => {
      H.rpcCalls.push({ op: String(args[0]), payload: args[1], extra: args[2] });
      return H.rpcResult;
    },
  },
}));

vi.mock("../../src/services/sendspin/runtime.js", () => ({
  getServer: () => H.inProcServer,
}));

import { getSendspinFront, proxyEsphomeStatus } from "../../src/services/sendspin/proxy.js";
import { DEFAULT_SENDSPIN_VOLUME } from "../../src/services/sendspin/deviceState.js";

/** 等一轮微任务,让 fire-and-forget 的 RPC 落地。 */
const tick = () => new Promise((r) => setTimeout(r, 0));

function seedClient(over: Partial<Record<string, Any>> = {}) {
  const row = {
    clientId: "c1",
    name: "客厅",
    roles: ["player@v1"],
    legacy: false,
    ready: true,
    remoteHost: "192.168.1.9",
    dialed: false,
    dialHost: "",
    dialPort: 0,
    volume: 80,
    muted: false,
    ...over,
  };
  H.mirror.clients.set(row.clientId, row);
  return row;
}

beforeEach(() => {
  H.running = false;
  H.inProcServer = null;
  H.rpcCalls.length = 0;
  H.rpcResult = undefined;
  H.mirror.clients.clear();
  H.mirror.groups.clear();
  H.mirror.records.clear();
  H.mirror.attempts.length = 0;
});

describe("getSendspinFront 双模式取用", () => {
  it("fork 模式且子进程未运行 → null(调用方靠它判空,不能抛)", () => {
    H.running = false;
    expect(getSendspinFront(false)).toBeNull();
  });

  it("fork 模式且运行中 → 代理,且是单例(懒建只一次)", () => {
    H.running = true;
    const a = getSendspinFront(false);
    const b = getSendspinFront(false);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("in-proc 模式 → 直接返回真实 server(不判 running)", () => {
    H.running = false;
    expect(getSendspinFront(true)).toBeNull(); // 真实 server 尚未挂上

    const fakeServer = { port: 1, serverId: "x" };
    H.inProcServer = fakeServer;
    expect(getSendspinFront(true)).toBe(fakeServer);
  });
});

describe("SendspinServerProxy 读侧(镜像)", () => {
  beforeEach(() => {
    H.running = true;
  });

  it("port / serverId 直读镜像", () => {
    const p = getSendspinFront(false)!;
    expect(p.port).toBe(8928);
    expect(p.serverId).toBe("srv-abc");
    H.mirror.port = 9999;
    H.mirror.serverId = "srv-2";
    expect(p.port).toBe(9999);
    expect(p.serverId).toBe("srv-2");
  });

  it("clients 逐字段映射,且返回新 Map(不泄漏镜像内部结构)", () => {
    const row = seedClient({ dialed: true, dialHost: "10.0.0.2", dialPort: 8928, muted: true });
    const p = getSendspinFront(false)!;
    const view = p.clients.get("c1")!;
    expect(view.clientId).toBe(row.clientId);
    expect(view.name).toBe("客厅");
    expect(view.roles).toEqual(["player@v1"]);
    expect(view.legacy).toBe(false);
    expect(view.ready).toBe(true);
    expect(view.remoteHost).toBe("192.168.1.9");
    expect(view.dialed).toBe(true);
    expect(view.dialHost).toBe("10.0.0.2");
    expect(view.dialPort).toBe(8928);
    expect(view.volume).toBe(80);
    expect(view.muted).toBe(true);
    // 视图是即时读取的活体(getter),镜像变了视图跟着变。
    row.volume = 42;
    expect(view.volume).toBe(42);
  });

  it("clients 的 muted setter:镜像即时改 + RPC 下发 setMuted", async () => {
    const row = seedClient();
    const p = getSendspinFront(false)!;
    const view = p.clients.get("c1")!;
    view.muted = true;
    expect(row.muted).toBe(true);
    await tick();
    expect(H.rpcCalls).toEqual([{ op: "setMuted", payload: { clientId: "c1", muted: true }, extra: undefined }]);
  });

  it("groups 映射与 muted setter(组名作为 clientId 下发)", async () => {
    H.mirror.groups.set("g1", { name: "g1", volume: 100, muted: false, current: { songId: "s1", durationMs: 1 } });
    const p = getSendspinFront(false)!;
    const g = p.groups.get("g1")!;
    expect(g.name).toBe("g1");
    // 4.0.87:缺省收窄到 DEFAULT_SENDSPIN_VOLUME,但**镜像里已存在的组**(真机在跑)仍原样透传,
    // 缺省只作用于「组缺席」这条分支(见下面 ghost 用例)。
    expect(g.volume).toBe(100);
    expect(g.muted).toBe(false);
    expect(g.current?.songId).toBe("s1");

    g.muted = true;
    expect(H.mirror.groups.get("g1")!.muted).toBe(true);
    await tick();
    expect(H.rpcCalls).toEqual([{ op: "setMuted", payload: { clientId: "g1", muted: true }, extra: undefined }]);
  });

  it("group(name):镜像缺失时返回占位(与真实 server 懒创建语义一致)", () => {
    const p = getSendspinFront(false)!;
    expect(p.groups.get("ghost")).toBeUndefined();
    const g = p.group("ghost");
    expect(g.name).toBe("ghost");
    expect(g.volume).toBe(DEFAULT_SENDSPIN_VOLUME);
    expect(g.muted).toBe(false);
    expect(g.current).toBeNull();
  });

  it("group(name):镜像存在时读到真实值", () => {
    H.mirror.groups.set("g1", { name: "g1", volume: 55, muted: true, current: null });
    const p = getSendspinFront(false)!;
    expect(p.group("g1").volume).toBe(55);
    expect(p.group("g1").muted).toBe(true);
  });

  it("currentMedia:命中时剥出展示字段(不带 positionMs/内部态)", () => {
    H.mirror.groups.set("c1", {
      name: "c1", volume: 100, muted: false,
      current: { songId: "s1", title: "t", artist: "a", album: "al", coverArt: "cv", durationMs: 123 },
    });
    const p = getSendspinFront(false)!;
    const m = p.currentMedia("c1")!;
    expect(m).toEqual({ songId: "s1", title: "t", artist: "a", album: "al", coverArt: "cv" });
    expect(m).not.toHaveProperty("durationMs");
  });

  it("currentMedia:组不存在或 current 为空 → undefined", () => {
    const p = getSendspinFront(false)!;
    expect(p.currentMedia("nope")).toBeUndefined();
    H.mirror.groups.set("g2", { name: "g2", volume: 100, muted: false, current: null });
    expect(p.currentMedia("g2")).toBeUndefined();
  });
});

describe("SendspinServerProxy 写侧(RPC)", () => {
  beforeEach(() => {
    H.running = true;
  });

  it("pairingStore:getRecord 补上 clientId(Map key),缺失返回 undefined", () => {
    H.mirror.records.set("c1", { clientId: "c1", createdAt: 11, lastUsedAt: 22, approved: true });
    const store = getSendspinFront(false)!.pairingStore!;
    expect(store.getRecord("c1")).toEqual({ clientId: "c1", createdAt: 11, lastUsedAt: 22 });
    expect(store.getRecord("ghost")).toBeUndefined();
  });

  it("pairingStore:isApproved 默认 false,记录存在时取 approved", () => {
    const store = getSendspinFront(false)!.pairingStore!;
    expect(store.isApproved("c1")).toBe(false);
    H.mirror.records.set("c1", { clientId: "c1", createdAt: null, lastUsedAt: null, approved: true });
    expect(store.isApproved("c1")).toBe(true);
    H.mirror.records.set("c2", { clientId: "c2", createdAt: null, lastUsedAt: null, approved: false });
    expect(store.isApproved("c2")).toBe(false);
  });

  it("pairingStore:setApproved / removeRecord 走 RPC(await 结果透传)", async () => {
    const store = getSendspinFront(false)!.pairingStore!;
    await store.setApproved("c1", true);
    expect(H.rpcCalls[0]).toEqual({ op: "setApproved", payload: { clientId: "c1", approved: true }, extra: undefined });

    H.rpcResult = true;
    await expect(store.removeRecord("c1")).resolves.toBe(true);
    expect(H.rpcCalls[1]).toEqual({ op: "unpair", payload: { clientId: "c1" }, extra: undefined });
  });

  it("pairing:listAttempts 直读镜像数组", () => {
    H.mirror.attempts.push({ clientId: "c1" }, { clientId: "c2" });
    const pairing = getSendspinFront(false)!.pairing!;
    expect(pairing.listAttempts()).toHaveLength(2);
  });

  it("pairing:getAttempt 命中/未命中(clientId 不匹配 → null)", () => {
    H.mirror.attempts.push({ clientId: "c1", method: "digits" });
    const pairing = getSendspinFront(false)!.pairing!;
    expect(pairing.getAttempt("c1")).toEqual({ clientId: "c1", method: "digits" });
    expect(pairing.getAttempt("c9")).toBeNull();
  });

  it("pairing:getAttempt 对畸形行不炸(可选链兜底)", () => {
    H.mirror.attempts.push(null, undefined, { nope: 1 });
    const pairing = getSendspinFront(false)!.pairing!;
    expect(pairing.getAttempt("c1")).toBeNull();
  });

  it("pairing:start / enterCode / pairWithToken 走 RPC 且参数完整", async () => {
    const pairing = getSendspinFront(false)!.pairing!;
    await pairing.start("c1", "code", "qr_code");
    await pairing.enterCode("c1", "123456");
    await pairing.pairWithToken("c1", "tok");
    expect(H.rpcCalls.map((c) => c.op)).toEqual(["pairStart", "pairCode", "pairToken"]);
    expect(H.rpcCalls[0].payload).toEqual({ clientId: "c1", method: "code", format: "qr_code" });
    expect(H.rpcCalls[1].payload).toEqual({ clientId: "c1", code: "123456" });
    expect(H.rpcCalls[2].payload).toEqual({ clientId: "c1", token: "tok" });
  });

  it("pairing:start 省略 format 时透传 undefined(由子进程决定默认)", async () => {
    const pairing = getSendspinFront(false)!.pairing!;
    await pairing.start("c1", "code");
    expect(H.rpcCalls[0].payload).toEqual({ clientId: "c1", method: "code", format: undefined });
  });

  it("pairing:cancel 是 fire-and-forget(void 返回,不 await)", async () => {
    const pairing = getSendspinFront(false)!.pairing!;
    expect(pairing.cancel("c1")).toBeUndefined();
    await tick();
    expect(H.rpcCalls[0]).toEqual({ op: "pairCancel", payload: { clientId: "c1" }, extra: undefined });
  });

  it("dialPlayer:超时 = rpc 超时缺省 + 10s 宽限", async () => {
    H.rpcResult = { clientId: "c9", name: "音箱" };
    const p = getSendspinFront(false)!;
    await expect(p.dialPlayer("ws://10.0.0.3:8928/sendspin")).resolves.toEqual({ clientId: "c9", name: "音箱" });
    expect(H.rpcCalls[0].op).toBe("dial");
    expect(H.rpcCalls[0].payload).toEqual({ url: "ws://10.0.0.3:8928/sendspin", timeoutMs: undefined });
    expect(H.rpcCalls[0].extra).toBe(15_000 + 10_000);
  });

  it("dialPlayer:显式 timeoutMs 时按 timeoutMs + 10s", async () => {
    const p = getSendspinFront(false)!;
    await p.dialPlayer("ws://h:1/sendspin", 3_000);
    expect(H.rpcCalls[0].extra).toBe(13_000);
  });

  it("clearNoRedial 是 fire-and-forget", async () => {
    const p = getSendspinFront(false)!;
    expect(p.clearNoRedial("10.0.0.3", 8928)).toBeUndefined();
    await tick();
    expect(H.rpcCalls[0]).toEqual({ op: "clearNoRedial", payload: { host: "10.0.0.3", port: 8928 }, extra: undefined });
  });

  it("RPC 失败时 fire-and-forget 不冒泡(交给下一轮快照校正)", async () => {
    const store = getSendspinFront(false)!.pairingStore!;
    // 让下一次 RPC reject:临时替换实现。
    const original = H.rpcResult;
    H.rpcResult = original;
    // removeRecord 是 await 的,失败应抛;cancel/setMuted 才吞。
    H.rpcCalls.length = 0;
    const p = getSendspinFront(false)!;
    p.clearNoRedial("h", 1);
    await expect(tick()).resolves.toBeUndefined();
    expect(H.rpcCalls).toHaveLength(1);
    void store;
  });
});

describe("proxyEsphomeStatus", () => {
  it("子进程未运行 → 空设备表(不抛)", async () => {
    H.running = false;
    await expect(proxyEsphomeStatus()).resolves.toEqual({ devices: [] });
    expect(H.rpcCalls).toHaveLength(0);
  });

  it("运行中 → 透传 RPC esphomeStatus 结果", async () => {
    H.running = true;
    H.rpcResult = { devices: [{ host: "192.168.1.9", connected: true }] };
    const st = await proxyEsphomeStatus();
    expect(st.devices).toHaveLength(1);
    expect(H.rpcCalls[0].op).toBe("esphomeStatus");
  });
});
