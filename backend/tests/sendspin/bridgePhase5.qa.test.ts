// ==================== Phase 5 QA:sendspin 侧生命周期(§5.2/§5.4/§4.4) ====================
//
// 出口判据:
//   ① bridgeSyncCore:播中加入(ring 回填)/ 热复用幂等 / 摘除(设备回到可 cast 状态);
//   ② SendspinGroup.setBridgesPaused → 每座桥 setPaused(pauseCore/resumePumpCore 接线);
//   ③ BridgeMember.setPaused → HEARTBEAT flags bit1 经真 socket 到 airplay 侧(§5.4);
//   ④ BridgeSource 状态机迁移日志:live→stalled→connecting→live 可 grep + hardCap 断连
//      + 低水位恢复(§4.4)。
import "../plugins/_env.js";

import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BridgeMember } from "../../src/services/sendspin/bridgeMember.js";
import { bridgeSyncCore } from "../../src/services/sendspin/playerCore.js";
import { SendspinGroup } from "../../src/services/sendspin/server.js";
import { nowUs } from "../../src/utils/hostClock.js";
import { BridgeSource, computeBridgeBackoffMs, type BridgeSocketLike } from "../../src/services/airplay/bridgeSource.js";
import { bridgeSocketPath } from "../../src/services/airplay/bridgeChannel.js";
import { BridgeServer } from "../../src/services/airplay/bridgeServer.js";
import type { BridgeSocketSpec } from "../../src/services/sendspin/bridgeAttach.js";

// ---------------------------------------------------------------------------

function spec(id: string): BridgeSocketSpec {
  return { deviceId: id, socketPath: bridgeSocketPath(id, id), token: id, protocol: "raop" };
}

interface FakeHandle {
  deviceId: string;
  started: number;
  stopped: number;
  pushed: Array<{ bytes: number; tsUs: bigint }>;
  paused: boolean | null;
  pushAudio(pcm: Uint8Array, tsUs: bigint): void;
  notifyGeneration(g: number, r: string): void;
  sendBoundary(r: string): void;
  setPaused(p: boolean): void;
  start(): void;
  stop(): void;
}

function mkFakeHandle(deviceId: string): FakeHandle {
  return {
    deviceId, started: 0, stopped: 0, pushed: [], paused: null,
    pushAudio(pcm, tsUs) { this.pushed.push({ bytes: pcm.byteLength, tsUs }); },
    notifyGeneration() { /* noop */ },
    sendBoundary() { /* noop */ },
    setPaused(p) { this.paused = p; },
    start() { this.started++; },
    stop() { this.stopped++; },
  };
}

function fakeHandleFactory(handles: FakeHandle[]) {
  return (s: BridgeSocketSpec): FakeHandle => {
    const h = mkFakeHandle(s.deviceId);
    handles.push(h);
    return h;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// ① bridgeSyncCore(§5.2 加入/摘除/热复用)
// ---------------------------------------------------------------------------

describe("bridgeSyncCore(§5.2 流内成员变化)", () => {
  function mkStubGroup() {
    const backfilled: string[] = [];
    const g = {
      bridges: new Map(),
      bridgeSpecs: [] as BridgeSocketSpec[],
      backfillBridge(deviceId: string): number {
        backfilled.push(deviceId);
        return 7;
      },
    };
    const srv = { group: (_n: string) => g };
    return { g, srv, backfilled };
  }

  it("★ 播中加入 → 建句柄 + ring 回填;重复 sync 热复用(不重建、不重复回填)", () => {
    const { srv, backfilled } = mkStubGroup();
    const handles: FakeHandle[] = [];
    const factory = fakeHandleFactory(handles);

    const n1 = bridgeSyncCore(srv as any, "ug:t", [spec("d1")], factory as any);
    expect(handles.length).toBe(1);
    expect(handles[0].started).toBe(1);
    expect(backfilled).toEqual(["d1"]); // ★ 新加入者从 ring 回填
    expect(n1).toBe(7);

    // 同规格重同步(seek 重建路径):热复用,零副作用
    const n2 = bridgeSyncCore(srv as any, "ug:t", [spec("d1")], factory as any);
    expect(handles.length).toBe(1);
    expect(handles[0].started).toBe(1);
    expect(backfilled).toEqual(["d1"]); // ★ 不重复回填
    expect(n2).toBe(0);
  });

  it("★ 摘除 → 句柄 stop + 移出(设备回到可 cast 状态);新成员只回填新者", () => {
    const { srv, backfilled } = mkStubGroup();
    const handles: FakeHandle[] = [];
    const factory = fakeHandleFactory(handles);
    bridgeSyncCore(srv as any, "ug:t", [spec("d1"), spec("d2")], factory as any);
    expect(handles.length).toBe(2);
    backfilled.length = 0;

    bridgeSyncCore(srv as any, "ug:t", [spec("d2")], factory as any);
    expect(handles[0].stopped).toBe(1); // d1 摘除
    expect(handles[1].stopped).toBe(0);
    expect(backfilled).toEqual([]); // 热复用者不回填
    bridgeSyncCore(srv as any, "ug:t", [spec("d2"), spec("d3")], factory as any);
    expect(backfilled).toEqual(["d3"]); // ★ 只有新加入者回填
  });
});

// ---------------------------------------------------------------------------
// ② setBridgesPaused(§5.4,pauseCore/resumePumpCore 接线)
// ---------------------------------------------------------------------------

describe("SendspinGroup.setBridgesPaused(§5.4)", () => {
  it("★ 组级暂停指示下发到每座桥(真 SendspinGroup 实例)", () => {
    const fakeSrv = { log: () => {}, clients: new Map(), groups: new Map() };
    const g = new SendspinGroup("ug:p5", fakeSrv as any);
    const h1 = mkFakeHandle("d1");
    const h2 = mkFakeHandle("d2");
    (g.bridges as Map<string, unknown>).set("d1", h1);
    (g.bridges as Map<string, unknown>).set("d2", h2);
    g.setBridgesPaused(true);
    expect(h1.paused).toBe(true);
    expect(h2.paused).toBe(true);
    g.setBridgesPaused(false);
    expect(h1.paused).toBe(false);
    expect(h2.paused).toBe(false);
  });

  it("★ backfillBridge:只回填可听域窗口内当前代次帧(原序 + ts' 转换),空包/窗外不回填", () => {
    const fakeSrv = { log: () => {}, clients: new Map(), groups: new Map() };
    const g = new SendspinGroup("ug:p5b", fakeSrv as any);
    const h = mkFakeHandle("d1");
    (g.bridges as Map<string, unknown>).set("d1", h);
    const anyG = g as any;
    const now = nowUs();
    const ahead = BigInt(g.commonSendAheadUs()); // 无成员 → 回落 800ms
    anyG.recentByGroup.set(anyG.encoderKey("pcm", 100), [
      { tsUs: now + 500_000n, durUs: 1000, data: new Uint8Array(10), ep: 0 }, // floor 下:不回填
      { tsUs: now + 2_000_000n, durUs: 1000, data: new Uint8Array(10), ep: 0 }, // 窗口内
      { tsUs: now + 2_400_000n, durUs: 1000, data: new Uint8Array(0), ep: 0 }, // 空包跳过(2026-09-17 ESPHome)
      { tsUs: now + 2_300_000n, durUs: 1000, data: new Uint8Array(12), ep: 0 }, // 窗口内
      { tsUs: now + 3_000_000n, durUs: 1000, data: new Uint8Array(10), ep: 0 }, // horizon 上:不回填
    ]); // 生产 ring 帧恒由 pushFrame 打 ep 戳(S2:ep 缺失=未打戳=不可信,严格相等才投)
    expect(g.backfillBridge("d1")).toBe(2); // 空包不计、窗外两帧不回填
    expect(h.pushed.map((p) => p.tsUs)).toEqual([
      now + 2_000_000n - ahead,
      now + 2_300_000n - ahead,
    ]); // 原序 + 可听域转换 ts' = ts − sendAhead
    expect(g.backfillBridge("missing")).toBe(0);
    g.stopBridgePushTimer(); // backfill 会起补投定时器,收尾停表
  });
});

// ---------------------------------------------------------------------------
// ③ BridgeMember.setPaused → HEARTBEAT flags(真 socket 到 airplay 侧)
// ---------------------------------------------------------------------------

describe("BridgeMember 暂停指示(§5.4 线格式,e2e mini)", () => {
  it("★ setPaused(true) → airplay 侧 onHeartbeat 收到 paused=true;恢复后 false", async () => {
    const deviceId = `bp5m-${Math.floor(Math.random() * 1e9)}`;
    const socketPath = bridgeSocketPath(deviceId, deviceId);
    const heartbeats: Array<{ gen: number; seq: number; paused: boolean }> = [];
    let sessionConnected: (() => void) | null = null;
    const connected = new Promise<void>((r) => { sessionConnected = r; });
    const srv = new BridgeServer(
      { deviceId, token: deviceId, protocol: "raop" },
      {
        onSession: (ev) => { if (ev.connected) sessionConnected?.(); },
        onHeartbeat: (gen, seq, paused) => heartbeats.push({ gen, seq, paused: paused === true }),
      },
    );
    await srv.listen(socketPath);
    try {
      const m = new BridgeMember({
        deviceId,
        socketPath,
        token: deviceId,
        protocol: "raop",
        heartbeatMs: 50,
      });
      m.start();
      await connected;
      m.setPaused(true);
      m.setPaused(false);
      await new Promise((r) => setTimeout(r, 150));
      m.stop();
      // ★ 立即直发的两条暂停心跳 + 周期心跳,标志位正确
      expect(heartbeats.some((h) => h.paused === true)).toBe(true);
      expect(heartbeats.some((h) => h.paused === false)).toBe(true);
      expect(heartbeats.every((h) => typeof h.gen === "number")).toBe(true);
    } finally {
      await srv.close().catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// ④ BridgeSource 状态机(§4.4,序列可 grep)
// ---------------------------------------------------------------------------

class StubSocket extends EventEmitter implements BridgeSocketLike {
  written: Uint8Array[] = [];
  destroyed = false;
  write(data: Uint8Array): boolean { this.written.push(data); return true; }
  destroy(): void { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } }
  on(event: "drain" | "close" | "error", cb: (...args: never[]) => void): unknown {
    return super.on(event, cb as never);
  }
}

describe("BridgeSource 状态机迁移日志(§4.4)", () => {
  function mkSource(opts?: Partial<ConstructorParameters<typeof BridgeSource>[0]>) {
    const lines: string[] = [];
    const sockets: StubSocket[] = [];
    const scheduled: number[] = [];
    let connectCalls = 0;
    const src = new BridgeSource({
      connect: async () => { connectCalls++; const s = new StubSocket(); sockets.push(s); return s; },
      onConnected: () => {},
      schedule: (fn: () => void, ms: number) => { scheduled.push(ms); pendingFns.push(fn); return () => {}; },
      log: (...args: unknown[]) => lines.push(args.map(String).join(" ")),
      ...opts,
    });
    const pendingFns: Array<() => void> = [];
    return { src, lines, sockets, scheduled, pendingFns, getConnectCalls: () => connectCalls };
  }

  it("★ 完整序列:connecting→live→stalled→connecting→live(可 grep)", async () => {
    const { src, lines, sockets, pendingFns } = mkSource();
    src.start();
    await new Promise((r) => setImmediate(r));
    expect(lines).toContain("bridge link state: idle→connecting");
    expect(lines).toContain("bridge link state: connecting→live");
    // 断连 → stalled(退避排程,未到点仍是 stalled)
    sockets[0].destroy();
    expect(lines.some((l) => l.includes("bridge link state: live→stalled"))).toBe(true);
    expect(pendingFns.length).toBe(1); // 一次退避重连排程(5s/30s ±20%)
    // 退避到点 → connecting → live
    pendingFns[0]();
    await new Promise((r) => setImmediate(r));
    expect(lines.some((l) => l.includes("bridge link state: stalled→connecting"))).toBe(true);
    expect(lines.some((l) => l.includes("bridge link state: connecting→live"))).toBe(true);
    expect(lines.filter((l) => l.includes("→live")).length).toBeGreaterThanOrEqual(2);
  });

  it("★ hardCap 断连:超硬上限 → 关 socket → stalled(宁断不错位)", async () => {
    const { src, lines, sockets } = mkSource({ highWaterMs: 1, hardCapMs: 1 });
    src.start();
    await new Promise((r) => setImmediate(r));
    expect(src.state).toBe("live");
    src.enqueue(new Uint8Array(400)); // 400B ≈ 2.08ms > 1ms ⇒ hardCap
    expect(sockets[0].destroyed).toBe(true);
    expect(lines.some((l) => l.includes("hardCap"))).toBe(true);
    expect(src.state).toBe("stalled");
    // 禁止丢最旧帧:队列原样保留(重连后重新判定)
    expect(src.stats().queuedFrames).toBe(1);
  });

  it("★ 低水位恢复:背压跨过高水位后回落 → recovered 日志(可 grep)", async () => {
    const { src, lines } = mkSource({ highWaterMs: 1, hardCapMs: 100_000 });
    src.start();
    await new Promise((r) => setImmediate(r));
    src.enqueue(new Uint8Array(400)); // >1ms ⇒ backpressure
    expect(lines.some((l) => l.includes("bridge backpressure ") && !l.includes("recovered"))).toBe(true);
    src.enqueue(new Uint8Array(28)); // 0.15ms < 1ms ⇒ 恢复
    expect(lines.some((l) => l.includes("bridge backpressure recovered"))).toBe(true);
  });

  it("退避参数:5s 起 ×2 封顶 30s,±20% 抖动(Phase 2 既有语义不回退)", () => {
    expect(computeBridgeBackoffMs(1, 0.5)).toBeGreaterThanOrEqual(4000);
    expect(computeBridgeBackoffMs(1, 0.5)).toBeLessThanOrEqual(6000);
    expect(computeBridgeBackoffMs(9, 0.5)).toBeLessThanOrEqual(30_000);
    for (let i = 0; i < 20; i++) {
      const d = computeBridgeBackoffMs(1, Math.random());
      expect(d).toBeGreaterThanOrEqual(5_000 * 0.8);
      expect(d).toBeLessThanOrEqual(5_000 * 1.2);
    }
  });
});
