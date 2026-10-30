// airplay/raopProbe.ts + raop.ts raopTeardownProbe 定向单测(S1/S3,2026-10-30 全屋
// HiVi 无声事故:容器重建后 MUZO 固件保留半开会话,新握手 ECONNRESET)。
// 全部离线:探测用本进程假 RTSP server(真实 net socket);重试梯注入 sleep;
// boot 探测 mock discovery/supervisor。不碰真实设备与子进程。
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as net from "net";
import { raopTeardownProbe } from "../../src/services/airplay/raop.js";
import {
  isBridgeHandshakeDeviceError,
  retryBridgePrepareWithProbe,
  BRIDGE_PREPARE_RETRY_BACKOFF_MS,
  runBootClearProbes,
  raopProbeDevice,
  resetBootProbeStateForTest,
  setBridgePrepareRetrySleepForTest,
  type RaopProbeResult,
} from "../../src/services/airplay/raopProbe.js";

const h = vi.hoisted(() => {
  const devices: Array<{ id: string; host: string; port: number }> = [];
  const byId = new Map<string, { id: string; host: string; port: number }>();
  const rpcCalls: Array<{ op: string; payload: any }> = [];
  const rpcReply: { value: RaopProbeResult | Error } = {
    value: { reachable: true, optionsStatus: 200, teardownStatus: 454, detail: "ok" },
  };
  const supervisorRunning = { value: true };
  const bridgeOwned = new Set<string>();
  return { devices, byId, rpcCalls, rpcReply, supervisorRunning, bridgeOwned };
});

vi.mock("../../src/services/airplay/discovery.js", () => ({
  getAirPlayDevice: (id: string) => h.byId.get(id),
  getAirPlayDevices: () => h.devices,
}));
// raopProbe 依赖 control.js 的 isBridgeOwned(S3 防杀合法会话),mock 掉避免加载重模块。
vi.mock("../../src/services/airplay/control.js", () => ({
  isBridgeOwned: (id: string) => h.bridgeOwned.has(id),
}));
vi.mock("../../src/services/airplay/supervisor.js", () => ({
  airplaySupervisor: {
    isRunning: () => h.supervisorRunning.value,
    rpc: async (op: string, payload: any) => {
      h.rpcCalls.push({ op, payload });
      if (h.rpcReply.value instanceof Error) throw h.rpcReply.value;
      return h.rpcReply.value;
    },
  },
}));

/** 假 RTSP server:按请求方法回预置响应;method→reply(null=不答直断)。 */
function startFakeRtsp(replies: { OPTIONS?: string | null; TEARDOWN?: string | null }): Promise<{ port: number; counts: { OPTIONS: number; TEARDOWN: number }; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const counts = { OPTIONS: 0, TEARDOWN: 0 };
    const srv = net.createServer((sock) => {
      let buf = "";
      sock.on("data", (c: Buffer) => {
        buf += c.toString("latin1");
        let idx: number;
        while ((idx = buf.indexOf("\r\n\r\n")) >= 0) {
          const req = buf.slice(0, idx);
          buf = buf.slice(idx + 4);
          const method = (req.match(/^([A-Z]+) /) || [])[1] || "";
          if (method in counts) counts[method as keyof typeof counts]++;
          const reply = (replies as Record<string, string | null | undefined>)[method];
          if (reply !== null && reply !== undefined) sock.write(reply);
          if (reply === null) sock.destroy();
        }
      });
    });
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo;
      resolve({
        port: addr.port,
        counts,
        close: () => new Promise((r) => srv.close(() => r())),
      });
    });
  });
}

beforeEach(() => {
  h.devices.length = 0;
  h.byId.clear();
  h.rpcCalls.length = 0;
  h.rpcReply.value = { reachable: true, optionsStatus: 200, teardownStatus: 454, detail: "ok" };
  h.supervisorRunning.value = true;
  h.bridgeOwned.clear();
  resetBootProbeStateForTest();
  setBridgePrepareRetrySleepForTest(null);
});

// ---------------------------------------------------------------------------
describe("raopTeardownProbe(假 RTSP server,真实 net socket)", () => {
  it("正常路径:OPTIONS 200 + TEARDOWN 454(无 session,无害)⇒ reachable=true", async () => {
    const srv = await startFakeRtsp({
      OPTIONS: "RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n",
      TEARDOWN: "RTSP/1.0 454 Session Not Found\r\nCSeq: 2\r\n\r\n",
    });
    try {
      const r = await raopTeardownProbe("127.0.0.1", srv.port, 2_000);
      expect(r.reachable).toBe(true);
      expect(r.optionsStatus).toBe(200);
      expect(r.teardownStatus).toBe(454);
      expect(srv.counts.TEARDOWN).toBe(1);
    } finally { await srv.close(); }
  });

  it("TEARDOWN 不答(设备直断)⇒ reachable 仍 true(通道本身活着)", async () => {
    const srv = await startFakeRtsp({
      OPTIONS: "RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n",
      TEARDOWN: null,
    });
    try {
      const r = await raopTeardownProbe("127.0.0.1", srv.port, 400);
      expect(r.reachable).toBe(true);
      expect(r.optionsStatus).toBe(200);
      expect(r.teardownStatus).toBeNull();
    } finally { await srv.close(); }
  });

  it("端口无人听 ⇒ reachable=false(ECONNREFUSED),探测永不抛", async () => {
    const r = await raopTeardownProbe("127.0.0.1", 1, 500);
    expect(r.reachable).toBe(false);
    expect(r.optionsStatus).toBeNull();
    expect(r.detail).toContain("TCP connect");
  });

  it("TCP 活但 RTSP 层哑 ⇒ reachable=false(OPTIONS 无响应,重试握手只会空耗预算)", async () => {
    const srv = await startFakeRtsp({ OPTIONS: null });
    try {
      const r = await raopTeardownProbe("127.0.0.1", srv.port, 300);
      expect(r.reachable).toBe(false);
      expect(r.detail).toContain("OPTIONS");
    } finally { await srv.close(); }
  });
});

// ---------------------------------------------------------------------------
describe("isBridgeHandshakeDeviceError(只认设备类连接失败,不碰语义错误)", () => {
  it("连接类失败 ⇒ true", () => {
    for (const m of [
      "read ECONNRESET",
      "connect ECONNREFUSED 192.168.10.30:4515",
      "RAOP connect 总超时(12000ms)",
      "RTSP connect timeout",
      "RTSP ANNOUNCE failed: socket closed",
      "socket hang up",
      "read ETIMEDOUT",
    ]) expect(isBridgeHandshakeDeviceError(m)).toBe(true);
  });

  it("语义性/非设备错误 ⇒ false(AP2 凭据缺失、设备不存在、prepare 断言等重试必复现)", () => {
    for (const m of [
      "ap2-setup: AP2 载荷缺失",
      "AirPlay 设备不存在: xxx",
      "prepare failed",
      "bridgePrepare: deviceId/socketPath/token 必填",
      "",
    ]) expect(isBridgeHandshakeDeviceError(m)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("retryBridgePrepareWithProbe(S1 重试梯)", () => {
  it("probe 不可达 ⇒ 不重试直接放弃,attempt 0 次,sleep 0 次", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const ok = await retryBridgePrepareWithProbe({
      reason: "read ECONNRESET",
      probe: async () => ({ reachable: false, optionsStatus: null, teardownStatus: null, detail: "TCP connect: ECONNREFUSED" }),
      attempt: async () => { attempts++; },
      onGiveUp: () => {},
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(ok).toBe(false);
    expect(attempts).toBe(0);
    expect(sleeps).toEqual([]);
  });

  it("握手第 2 次成功 ⇒ 每次重试前都 probe,sleep 走 5s/15s 两档,返回 true", async () => {
    let attempts = 0;
    let probes = 0;
    const sleeps: number[] = [];
    const retried: number[] = [];
    const ok = await retryBridgePrepareWithProbe({
      reason: "read ECONNRESET",
      probe: async () => { probes++; return { reachable: true, optionsStatus: 200, teardownStatus: 454, detail: "ok" }; },
      attempt: async () => {
        attempts++;
        if (attempts < 2) throw new Error("read ECONNRESET");
      },
      onRetry: (n) => retried.push(n),
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(ok).toBe(true);
    expect(attempts).toBe(2);
    expect(probes).toBe(2);
    expect(sleeps).toEqual([5_000, 15_000]);
    expect(retried).toEqual([1, 2]);
  });

  it("两档全败 ⇒ 返回 false(调用方回落 solo cast)", async () => {
    let attempts = 0;
    const ok = await retryBridgePrepareWithProbe({
      reason: "read ECONNRESET",
      probe: async () => ({ reachable: true, optionsStatus: 200, teardownStatus: 200, detail: "ok" }),
      attempt: async () => { attempts++; throw new Error("read ECONNRESET"); },
      sleep: async () => {},
    });
    expect(ok).toBe(false);
    expect(attempts).toBe(2);
  });

  it("非设备类失败(reason 不匹配)⇒ 恒 false,probe 一次都不发", async () => {
    let probes = 0;
    const ok = await retryBridgePrepareWithProbe({
      reason: "ap2-setup: AP2 载荷缺失",
      probe: async () => { probes++; return { reachable: true, optionsStatus: 200, teardownStatus: 454, detail: "ok" }; },
      attempt: async () => {},
      sleep: async () => {},
    });
    expect(ok).toBe(false);
    expect(probes).toBe(0);
  });

  it("默认退避梯 = [5000, 15000](值被钉,防无意改参)", () => {
    expect([...BRIDGE_PREPARE_RETRY_BACKOFF_MS]).toEqual([5_000, 15_000]);
  });
});

// ---------------------------------------------------------------------------
describe("raopProbeDevice / runBootClearProbes(S3)", () => {
  it("raopProbeDevice:host/port 主进程查好随载荷下发(子进程注册表恒空,不能反查)", async () => {
    h.byId.set("a1", { id: "a1", host: "192.168.10.30", port: 4515 });
    const r = await raopProbeDevice("a1");
    expect(r.reachable).toBe(true);
    expect(h.rpcCalls).toEqual([{ op: "raopProbe", payload: { host: "192.168.10.30", port: 4515, timeoutMs: 6_000 } }]);
  });

  it("设备不在注册表 ⇒ 不可达回落,不发 rpc", async () => {
    const r = await raopProbeDevice("ghost");
    expect(r.reachable).toBe(false);
    expect(r.detail).toContain("设备不存在");
    expect(h.rpcCalls).toHaveLength(0);
  });

  it("rpc 抛错 ⇒ 不可达回落,不抛", async () => {
    h.byId.set("a1", { id: "a1", host: "10.0.0.1", port: 5000 });
    h.rpcReply.value = new Error("子进程忙");
    const r = await raopProbeDevice("a1");
    expect(r.reachable).toBe(false);
    expect(r.detail).toContain("probe rpc 失败");
  });

  it("runBootClearProbes:清单非空 ⇒ 逐台 blind probe(幂等清理)", async () => {
    h.devices.push({ id: "a1", host: "10.0.0.1", port: 5000 }, { id: "a2", host: "10.0.0.2", port: 5000 });
    h.byId.set("a1", h.devices[0]!);
    h.byId.set("a2", h.devices[1]!);
    await runBootClearProbes();
    expect(h.rpcCalls.map((c) => c.payload.host)).toEqual(["10.0.0.1", "10.0.0.2"]);
  });

  it("runBootClearProbes:清单为空(mDNS 未完成)⇒ 不 probe,留给 120s 补轮", async () => {
    await runBootClearProbes();
    expect(h.rpcCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("S3 防误杀:boot probe 绝不碰合法桥会话(用户 12s 内起播的场景)", () => {
  it("isBridgeOwned 的设备两轮都跳过(blind TEARDOWN 会真杀会话,HiVi 实测回 200)", async () => {
    h.devices.push({ id: "a1", host: "10.0.0.1", port: 5000 }, { id: "a2", host: "10.0.0.2", port: 5000 });
    h.byId.set("a1", h.devices[0]!);
    h.byId.set("a2", h.devices[1]!);
    h.bridgeOwned.add("a1"); // 用户已起播,a1 有合法会话
    await runBootClearProbes(false); // 首轮:a1 跳过(记入确认),a2 probe
    h.rpcCalls.length = 0;
    await runBootClearProbes(true); // 兜底轮:a1、a2 都已确认 → 一次都不发
    expect(h.rpcCalls).toHaveLength(0);
  });

  it("兜底轮只补首轮未确认的设备:12s 首轮成功的,45s 兜底不再碰", async () => {
    h.devices.push({ id: "a1", host: "10.0.0.1", port: 5000 }, { id: "a2", host: "10.0.0.2", port: 5000 });
    h.byId.set("a1", h.devices[0]!);
    h.byId.set("a2", h.devices[1]!);
    await runBootClearProbes(false); // 首轮:a1 + a2 都 probe
    h.rpcCalls.length = 0;
    h.devices.push({ id: "a3", host: "10.0.0.3", port: 5000 }); // mDNS 迟到的新设备
    h.byId.set("a3", h.devices[2]!);
    await runBootClearProbes(true); // 兜底轮:只 probe a3
    expect(h.rpcCalls.map((c) => c.payload.host)).toEqual(["10.0.0.3"]);
  });

  it("用户 12s 前起播 ⇒ 首轮被 owner 检查跳过且记入已确认 ⇒ 兜底轮也不碰", async () => {
    h.devices.push({ id: "a1", host: "10.0.0.1", port: 5000 });
    h.byId.set("a1", h.devices[0]!);
    h.bridgeOwned.add("a1");
    await runBootClearProbes(false); // a1 被 owner 检查跳过
    h.bridgeOwned.delete("a1"); // 之后会话停了也不影响:已记入确认集合
    h.rpcCalls.length = 0;
    await runBootClearProbes(true);
    expect(h.rpcCalls).toHaveLength(0);
  });
});
