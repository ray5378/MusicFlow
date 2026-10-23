// 群组 × AirPlay 桥接编排的契约测试(2026-10-24)。
//
// 为什么需要这组用例:
//   1) **并行握手**是硬契约。历史实现按设备串行 await,实测 3832ms + 2772ms,
//      两台接收端的 RECORD 延迟测量与 `START_UNIX_MS` 锚点落在不同时刻,
//      于是同一组内两个成员出现约 0.8s 的真实音频错位(230/231 双机 PCM 包络
//      互相关:峰 corr=0.779 @ +0.80s,lag=0 时仅 0.464)。串行一旦回归,错位就回来,
//      而且起播还会被拖到 7~16s。这里用「同时在飞的 bridgeCast 最大并发数」判定,
//      不依赖墙钟,不会 flaky。
//   2) **失败重试**:实测存在 FIFO 被并发拆除导致握手 ENOENT 的偶发失败,
//      单台失败会让该成员整场静音,必须重试一次;重试只针对失败设备,不能把
//      已经握手成功的设备再 cast 一遍(会白白重建会话)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const devices: Record<string, any> = {
    d1: { id: "d1", name: "Dev1", alias: "客厅", available: true, pk: "pk1", et: "et1" },
    d2: { id: "d2", name: "Dev2", alias: "书房", available: true, pk: "pk2", et: "et2" },
  };
  const memberIds = ["airplay:d1", "airplay:d2"];
  const rpcCalls: Array<{ op: string; deviceId: string }> = [];
  const state = {
    inFlight: 0,
    maxInFlight: 0,
    /** deviceId → 每次 bridgeCast 的结果队列(true=成功, false=抛错);缺省全部成功。 */
    plan: {} as Record<string, boolean[]>,
    delayMs: 15,
    bridgePort: 41234,
  };
  return { devices, memberIds, rpcCalls, state };
});

vi.mock("../../src/services/group/index.js", () => ({
  getGroupManager: () => ({
    get: (id: string) => ({ id, name: "TEST", memberIds: h.memberIds }),
  }),
  splitMemberId: (m: string) => {
    const i = m.indexOf(":");
    if (i < 0) return null;
    return { kind: m.slice(0, i), id: m.slice(i + 1) };
  },
}));

vi.mock("../../src/services/airplay/discovery.js", () => ({
  getAirPlayDevice: (id: string) => h.devices[id] ?? null,
}));

vi.mock("../../src/services/airplay/cliParams.js", () => ({
  planCliRoute: (dev: any) => ({
    host: "10.0.0.9",
    port: 7000,
    route: "cli",
    cli: "cliairplay",
    pk: dev.pk,
  }),
}));

vi.mock("../../src/services/airplay/control.js", () => ({
  getAirPlayCredentials: () => undefined,
}));

vi.mock("../../src/services/airplay/supervisor.js", () => ({
  airplaySupervisor: {
    isRunning: () => true,
    mirror: { bridgePort: h.state.bridgePort },
    rpc: async (op: string, args: any) => {
      const deviceId = String(args?.deviceId ?? "");
      h.rpcCalls.push({ op, deviceId });
      if (op !== "bridgeCast") return null;
      h.state.inFlight++;
      h.state.maxInFlight = Math.max(h.state.maxInFlight, h.state.inFlight);
      try {
        await new Promise((r) => setTimeout(r, h.state.delayMs));
        const q = h.state.plan[deviceId];
        const ok = q && q.length > 0 ? q.shift()! : true;
        if (!ok) throw new Error(`AP2 命令管道无读端(/tmp/x-${deviceId}.fifo): ENOENT`);
        return { latencyFrames: 48000, sampleRate: 44100 };
      } finally {
        h.state.inFlight--;
      }
    },
  },
}));

import { startGroupAirPlayBridge } from "../../src/services/group/airplayBridge.js";

beforeEach(() => {
  h.rpcCalls.length = 0;
  h.state.inFlight = 0;
  h.state.maxInFlight = 0;
  h.state.plan = {};
  h.state.delayMs = 15;
  h.devices.d1.available = true;
  h.devices.d2.available = true;
});

describe("群组 × AirPlay 桥接编排", () => {
  it("多台成员**并行**握手(串行会让成员开播锚点差 0.8s 以上)", async () => {
    const info = await startGroupAirPlayBridge("g1");
    expect(info).not.toBeNull();
    expect((info!.devices || []).sort()).toEqual(["d1", "d2"]);
    // 并行 ⇒ 两台 bridgeCast 同时在飞;串行时这里恒为 1。
    expect(h.state.maxInFlight).toBe(2);
    expect(h.rpcCalls.filter((c) => c.op === "bridgeCast").length).toBe(2);
  });

  it("单台首轮握手失败 → 只重试失败的那台,成功后仍进 devices", async () => {
    h.state.plan = { d2: [false, true] };
    const info = await startGroupAirPlayBridge("g1");
    expect(info).not.toBeNull();
    expect((info!.devices || []).sort()).toEqual(["d1", "d2"]);
    expect(h.rpcCalls.filter((c) => c.op === "bridgeCast" && c.deviceId === "d1").length).toBe(1);
    expect(h.rpcCalls.filter((c) => c.op === "bridgeCast" && c.deviceId === "d2").length).toBe(2);
  });

  it("全部握手失败 → 返回 null(组仍可只靠 sendspin 成员播)", async () => {
    h.state.plan = { d1: [false, false], d2: [false, false] };
    const info = await startGroupAirPlayBridge("g1");
    expect(info).toBeNull();
  });

  it("离线成员不参与握手,也不触发重试", async () => {
    h.devices.d2.available = false;
    const info = await startGroupAirPlayBridge("g1");
    expect(info).not.toBeNull();
    expect(info!.devices).toEqual(["d1"]);
    expect(h.rpcCalls.filter((c) => c.deviceId === "d2").length).toBe(0);
  });

  it("send_ahead 下限 = 设备最大延迟 + 200ms 余量", async () => {
    const info = await startGroupAirPlayBridge("g1");
    const expectUs = Math.round((48000 / 44100) * 1_000_000) + 200_000;
    expect(info!.minSendAheadUs).toBe(expectUs);
    expect(info!.host).toBe("127.0.0.1");
    expect(info!.port).toBe(h.state.bridgePort);
  });

  it("组内没有 airplay 成员 → 不建桥接", async () => {
    h.memberIds.length = 0;
    h.memberIds.push("sendspin:c1");
    const info = await startGroupAirPlayBridge("g1");
    expect(info).toBeNull();
    expect(h.rpcCalls.length).toBe(0);
    h.memberIds.length = 0;
    h.memberIds.push("airplay:d1", "airplay:d2");
  });
});
