// ==================== 【QA 对抗性用例】Phase 5 生命周期/背压/热复用 ====================
//
// ① 播中 join→leave→join 循环 3 次:airplay 侧 session 计数与设备数一致、
//    泵侧 bridges.size 同步、ring 回填原序且内容贴近泵当前位置(±KEEP_PAST 容差);
// ② 暂停中注入 BOUNDARY{seek} → 恢复后从新代次起播:旧帧门控丢弃(无泄漏)、
//    锚点重立、resume 不重锚(≤45s「继续」语义);
// ③ 活 listener + 同路径 cleanupStaleBridgeSockets → listener 存活、死链删除、
//    清理后 bridgePrepare(CONFIG 握手)仍可用;
// ④ rehost/seek 交错 5 次:staleFramesDropped 单调不回退、generation 无回跳、
//    scheduledAnchorUs 严格递增;
// ⑤ rebase 丢包缺陷修后语义独立验证:lag>2s → 恰一次 rebase、同迭代发本包
//    (producer 调用数 = 包数+1,无重取料)、latePackets=0、RTP ts 连续。
import "../plugins/_env.js";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BridgeSession, BridgeSessionManager } from "../../src/services/airplay/bridgeSession.js";
import { BridgeServer } from "../../src/services/airplay/bridgeServer.js";
import {
  bridgeSocketPath,
  cleanupStaleBridgeSockets,
} from "../../src/services/airplay/bridgeChannel.js";
import { BridgeMember } from "../../src/services/sendspin/bridgeMember.js";
import { SendspinGroup } from "../../src/services/sendspin/server.js";
import { bridgeSyncCore } from "../../src/services/sendspin/playerCore.js";
import { CHUNK_LEN, RaopPlayer, type RaopSession } from "../../src/services/airplay/raop.js";
import { computeBridgeAnchors } from "../../src/services/airplay/bridgeMath.js";
import { nowUs, setNowUsOverride } from "../../src/utils/hostClock.js";
import type { BridgeSocketSpec } from "../../src/services/sendspin/bridgeAttach.js";
import { EventEmitter } from "node:events";

const cleanupFns: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanupFns.length) {
    const f = cleanupFns.pop()!;
    await f();
  }
  setNowUsOverride(null);
  vi.restoreAllMocks();
});

// ---- 夹具(与工程师 bridgePhase5.qa.test.ts 同款注入式生命周期会话)----

function mkLifecycleSession(): BridgeSession {
  const n = Math.floor(Math.random() * 1e9);
  const s = new BridgeSession({
    deviceId: `qa5-${n}`,
    token: `qa5-${n}`,
    protocol: "raop",
    socketPath: bridgeSocketPath(`qa5-${n}`, `qa5-${n}`),
    waitDataMs: 30,
  });
  cleanupFns.push(() => s.stop().catch(() => {}));
  return s;
}

function fakePlayer() {
  return {
    negotiatedLatencyFrames: 44100,
    streamBridge: vi.fn(() => new Promise<void>(() => {})),
    pause: vi.fn(),
    resume: vi.fn(),
    flush: vi.fn(),
    forceClose: vi.fn(),
    stop: vi.fn(async () => {}),
    isStreaming: true,
    bridgeLateCount: 0,
  };
}

function injectConnected(s: BridgeSession, player: ReturnType<typeof fakePlayer>): void {
  (s as any).connected = true;
  (s as any).player = player;
  (s as any).raopSession = { session: "t", audioPort: 7000, controlPort: 7001, timingPort: 7002 } as RaopSession;
}

function feed(s: BridgeSession, tsUs: bigint, generation: number, frames = 960): void {
  (s as any).ingestAudio({ tsUs, generation, sequence: 1, payload: new Uint8Array(frames * 4) });
}

function bridgeEvents(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const call of spy.mock.calls) {
    const line = call.map(String).join(" ");
    const i = line.indexOf("[airplay-bridge] ");
    if (i < 0) continue;
    const json = line.slice(i + "[airplay-bridge] ".length);
    if (json.startsWith("{")) out.push(JSON.parse(json) as Record<string, unknown>);
  }
  return out;
}

// ---------------------------------------------------------------------------
// ① join→leave→join ×3:session 计数 + ring 回填原序/贴当前位置
// ---------------------------------------------------------------------------

class PhaseEncoder {
  calls = 0;
  constructor(private readonly fill = 0xcd) {}
  async encode(): Promise<Array<{ frameSamples: number; data: Uint8Array }>> {
    const n = 960;
    return [{ frameSamples: n, data: new Uint8Array(Math.max(1, n / 100)).fill(this.fill) }];
  }
  async flush(): Promise<never[]> {
    return [];
  }
  close(): void {}
}

describe("QA① join→leave→join 循环 3 次:session 计数==设备数 + ring 回填一致", () => {
  it("每轮恰 1 会话/1 句柄;回填原序、单调、全部落在 [now−KEEP_PAST, now+future] 窗口", async () => {
    const mgr = new BridgeSessionManager();
    cleanupFns.push(() => mgr.stopAll());
    const g = new SendspinGroup("ug:g-qa5", { log() {} } as any);
    (g as any).encoders.set("pcm:100", new PhaseEncoder());
    // ring 灌注需要 pcm:100 组参与 pushFrame(无桥时虚拟组不建)→ 挂一个真实成员桩
    const memberStub = {
      clientId: "c1",
      codec: "pcm",
      sent: [] as unknown[],
      appliedGain: () => 100,
      bufferCapacityBytes: 0,
      clientWantsStream: () => true,
      announceStream: () => {},
      sendAudio: (ts: bigint, data: Uint8Array) => memberStub.sent.push({ ts, data: Uint8Array.from(data) }),
    };
    g.add(memberStub as any);
    const srv = { group: () => g } as any; // bridgeSyncCore 第一参数是 SendspinServer
    const made: any[] = [];
    const factory = (spec: BridgeSocketSpec) => {
      const h: any = {
        deviceId: spec.deviceId,
        pushAudio: vi.fn(),
        notifyGeneration: vi.fn(),
        sendBoundary: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      made.push(h);
      return h;
    };

    // 预置 ring:用真实 pushFrame 灌 6 个 chunk(−0.5s … +2.0s)。
    // 冻结墙钟让投递窗口/水位判定全确定(afterEach 统一 setNowUsOverride(null))。
    const NOW = 1_000_000_000n;
    setNowUsOverride(() => NOW);
    for (let k = 0; k < 6; k++) {
      const ts = NOW + BigInt(k * 500_000 - 500_000); // −0.5s … +2.0s
      await g.pushFrame(ts, new Float32Array(1200));
    }
    const ring = (g as any).recentByGroup.get("pcm:100") as Array<{ tsUs: bigint; durUs: number; data: Uint8Array }>;
    expect(ring.length).toBe(6);

    for (let cycle = 1; cycle <= 3; cycle++) {
      const token = `tok-cycle${cycle}`;
      // join(airplay 侧 prepare + 泵侧 sync)
      await mgr.prepare({ deviceId: "dev-qa5", token, protocol: "raop", socketPath: path.join(os.tmpdir(), "mfab-qa5", `c${cycle}-${process.pid}.sock`), dry: true });
      expect(mgr.list()).toHaveLength(1); // ★ session 数 == 桥设备数(1 台)
      const spec: BridgeSocketSpec = { deviceId: "dev-qa5", socketPath: `/tmp/qa5-${cycle}.sock`, token, protocol: "raop" };
      const backfilled = bridgeSyncCore(srv, "ug:g-qa5", [spec], factory);
      expect(g.bridges.size).toBe(1);
      const handle = made[made.length - 1]!;
      // ★ 窗口化回填(§6.2):只投 [now+FLOOR 1.5s, now+HORIZON 2.5s] 内的当前代次帧,
      //    原序 + 贴组时间线:X = 组 ts(与真实设备可听时刻同值);floor 下/horizon 上/空包一律不投。
      const win = ring.filter((e) => e.data.length > 0 && e.tsUs >= NOW + 1_500_000n && e.tsUs <= NOW + 2_500_000n);
      expect(win.length).toBe(2); // +1.5s(恰在 floor 上沿)与 +2.0s 两帧
      expect(backfilled).toBe(win.length);
      const pushedTs = (handle.pushAudio as any).mock.calls.map((c: unknown[]) => c[1] as bigint);
      expect(pushedTs).toEqual(win.map((e) => e.tsUs));
      for (let i = 1; i < pushedTs.length; i++) expect(pushedTs[i]! > pushedTs[i - 1]!).toBe(true);
      // leave
      await mgr.stop(token);
      expect(mgr.list()).toHaveLength(0);
      bridgeSyncCore(srv, "ug:g-qa5", [], factory);
      expect(g.bridges.size).toBe(0);
      expect(handle.stop).toHaveBeenCalledTimes(1);
    }
    // 3 轮共 3 个句柄,无累积;每轮都用新 token 的新句柄(不热复用旧 token)
    expect(made).toHaveLength(3);
    expect(new Set(made.map((h) => h.deviceId)).size).toBe(1);
  }, 20000);
});

// ---------------------------------------------------------------------------
// ② 暂停中 BOUNDARY{seek} → 恢复后无旧帧泄漏
// ---------------------------------------------------------------------------

describe("QA② 暂停中 seek:恢复从新代次起播,旧帧门控丢弃", () => {
  it("pause→boundary(seek)→stale 丢弃→新代次重立锚→resume 不重立锚(≤45s)", async () => {
    const s = mkLifecycleSession();
    const player = fakePlayer();
    injectConnected(s, player);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    const now0 = nowUs();
    feed(s, now0 + 3_000_000n, 11); // gen11 首帧(3s 后,可达)→ 立锚
    expect((s as any).aligner).not.toBeNull();
    const anchorsBefore = bridgeEvents(spy).filter((e) => e.ev === "anchor");
    expect(anchorsBefore).toHaveLength(1);

    // 暂停
    (s as any).onBridgeHeartbeat(true);
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect((s as any).snapshot().paused).toBe(true);
    // 暂停中重复 pause 幂等
    (s as any).onBridgeHeartbeat(true);
    expect(player.pause).toHaveBeenCalledTimes(1);

    // 暂停中注入 seek:BOUNDARY{seek} → 清队 + abort + flush
    (s as any).onBoundary(12, "seek");
    expect(player.flush).toHaveBeenCalledTimes(1);
    expect((s as any).aligner).toBeNull();
    // 旧代次在途帧(Boundary 后到达)→ 门控丢弃,绝不入队/绝不立锚
    const staleBefore = s.stats.staleFramesDropped;
    feed(s, now0 + 3_500_000n, 11);
    expect(s.stats.staleFramesDropped).toBe(staleBefore + 960); // payload 3840B >> 2 = 960 帧
    expect(((s as any).inQueue as unknown[]).length).toBe(0);
    expect(bridgeEvents(spy).filter((e) => e.ev === "anchor")).toHaveLength(1); // 旧帧不触发新锚

    // 新代次首帧(未来时间线)→ 暂停期间也重立锚(新流待发)
    feed(s, now0 + 8_000_000n, 12);
    const anchors = bridgeEvents(spy).filter((e) => e.ev === "anchor");
    expect(anchors).toHaveLength(2);
    expect(Number(anchors[1]!.gen)).toBe(12);
    expect(Number(anchors[1]!.scheduledAnchorUs)).toBeGreaterThan(Number(anchors[0]!.scheduledAnchorUs));

    // 恢复(暂停远小于 45s)→ 按「继续」:不再重立第 3 次锚
    (s as any).onBridgeHeartbeat(false);
    expect(player.resume).toHaveBeenCalledTimes(1);
    expect(bridgeEvents(spy).filter((e) => e.ev === "anchor")).toHaveLength(2);
    // 新代次后续帧正常入队(无 gen11 泄漏)
    feed(s, now0 + 8_020_000n, 12);
    expect(((s as any).inQueue as Array<{ generation: number }>).every((e) => e.generation === 12)).toBe(true);
  }, 15000);
});

// ---------------------------------------------------------------------------
// ③ 活 listener + cleanupStaleBridgeSockets → 存活 + bridgePrepare 仍可用
// ---------------------------------------------------------------------------

describe("QA③ cleanupStaleBridgeSockets 不误删活 listener,清理后仍可 prepare", () => {
  it("同目录死链删除、活 listener 原样,清理后 CONFIG 握手照常入会", async () => {
    const dir = path.join(os.tmpdir(), `mfab-qa5-clean-${process.pid}`);
    fs.mkdirSync(dir, { recursive: true });
    cleanupFns.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const livePath = path.join(dir, "live.sock");
    const server = new BridgeServer({ deviceId: "qa5-live", token: "qa5-live", protocol: "raop" }, {});
    cleanupFns.push(() => server.close().catch(() => {}));
    await server.listen(livePath);
    fs.writeFileSync(path.join(dir, "dead.sock"), ""); // 死链(无 listener)

    const removed = await cleanupStaleBridgeSockets({ dir, probeTimeoutMs: 300 });
    expect(removed).toBe(1); // 恰删死链
    expect(fs.existsSync(path.join(dir, "dead.sock"))).toBe(false);
    expect(fs.existsSync(livePath)).toBe(true); // ★ 活 listener 文件未被误删
    expect(server.listeningOn).toBe(livePath);

    // 清理后 bridgePrepare 语义仍可用:真 BridgeMember 走 CONFIG 握手入会
    const member = new BridgeMember({ deviceId: "qa5-live", socketPath: livePath, token: "qa5-live", protocol: "raop" });
    cleanupFns.push(() => member.stop());
    member.start();
    const t0 = Date.now();
    while (server.stats().sessionsAccepted < 1 && Date.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(server.stats().sessionsAccepted).toBe(1);
    expect(server.stats().rejected).toBe(0); // 探针对活 listener 的连接不留残留拒绝
    member.stop();
  }, 15000);
});

// ---------------------------------------------------------------------------
// ④ rehost/seek 交错 5 次:stale 单调、代次无回跳、锚点严格递增
// ---------------------------------------------------------------------------

describe("QA④ rehost/seek 交错 5 次:计数单调不回退 + 代次无回跳", () => {
  it("每代次:boundary→旧帧丢弃→新首帧重锚;scheduledAnchorUs 严格递增", async () => {
    const s = mkLifecycleSession();
    const player = fakePlayer();
    injectConnected(s, player);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    const reasons: Array<"seek" | "rehost"> = ["seek", "rehost", "seek", "rehost", "seek"];
    const staleTrace: number[] = [];
    const anchorUsTrace: number[] = [];

    feed(s, nowUs() + 3_000_000n, 20); // gen20 立锚
    anchorUsTrace.push(Number(bridgeEvents(spy).filter((e) => e.ev === "anchor").at(-1)!.scheduledAnchorUs));

    for (let k = 1; k <= 5; k++) {
      const gen = 20 + k;
      (s as any).onBoundary(gen, reasons[k - 1]);
      feed(s, nowUs() + 3_000_000n + BigInt(k) * 1_000_000n, gen - 1); // 旧代次在途帧 → 门控丢弃
      staleTrace.push(s.stats.staleFramesDropped);
      feed(s, nowUs() + 3_000_000n + BigInt(k + 1) * 1_000_000n, gen); // 新代次首帧 → 重锚
      const anchors = bridgeEvents(spy).filter((e) => e.ev === "anchor");
      expect(anchors.length).toBe(1 + k);
      anchorUsTrace.push(Number(anchors.at(-1)!.scheduledAnchorUs));
      expect((s as any).generation >>> 0).toBe(gen); // ★ 代次无回跳(喂旧帧后仍为新值)
    }
    // ★ staleFramesDropped 单调不回退
    for (let i = 1; i < staleTrace.length; i++) {
      expect(staleTrace[i]!).toBeGreaterThanOrEqual(staleTrace[i - 1]!);
    }
    expect(staleTrace.at(-1)!).toBeGreaterThan(0);
    // ★ scheduledAnchorUs 严格递增
    for (let i = 1; i < anchorUsTrace.length; i++) {
      expect(anchorUsTrace[i]!).toBeGreaterThan(anchorUsTrace[i - 1]!);
    }
    // 5 次 boundary 都有 flush(热复用同一假 player 重启流)
    expect(player.flush).toHaveBeenCalledTimes(5);
    expect(player.streamBridge).toHaveBeenCalledTimes(6);
  }, 15000);
});

// ---------------------------------------------------------------------------
// ⑤ rebase 丢包缺陷修后语义
// ---------------------------------------------------------------------------

class FakeUdp extends EventEmitter {
  sent: Buffer[] = [];
  constructor(public port: number) {
    super();
  }
  send(buf: Buffer, ...rest: unknown[]): void {
    this.sent.push(Buffer.isBuffer(rest[0]) ? Buffer.from(buf.subarray(rest[0] as number, rest[1] as number)) : Buffer.from(buf));
  }
  address() {
    return { address: "192.0.2.9", port: this.port, family: "IPv4" };
  }
  close() {}
}

describe("QA⑤ rebase 修复:同迭代发本包、无重取料、latePackets=0、RTP 连续", () => {
  it("A 在 3s 前 → 恰一次 rebase 日志;producer 调用数=包数+1;5 包 RTP 连续", async () => {
    setNowUsOverride(() => BigInt(Date.now()) * 1000n);
    const p = new RaopPlayer({ host: "192.0.2.9" });
    const audio = new FakeUdp(6001);
    const anyP = p as any;
    anyP.audioSocket = audio;
    anyP.ctrlSocket = new FakeUdp(6002);
    anyP.timeSocket = new FakeUdp(6003);
    anyP.url = "rtsp://192.0.2.9:5000/1234567890";
    cleanupFns.push(() => {
      if (anyP.syncTimer) clearInterval(anyP.syncTimer);
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const anchorUs = BigInt(Date.now() - 3000) * 1000n; // sendAt 已过期 ~4s
    const anchors = computeBridgeAnchors({ anchorUs, latencyFrames: 44100, rate: 44100, chunkLen: CHUNK_LEN });
    let producerCalls = 0;
    const producer = async (): Promise<Buffer | null> => (++producerCalls <= 5 ? Buffer.alloc(CHUNK_LEN * 4, 1) : null);
    await p.streamBridge(producer, { session: "t", audioPort: 7000, controlPort: 7001, timingPort: 7002 }, {
      baseTs: anchors.baseTs, startTs: anchors.startTs, headTs: anchors.headTs,
      startNtp: anchors.startNtp, anchorUsShifted: anchors.anchorUsShifted, anchorUs,
      latencyFrames: 44100, rate: 44100,
    });
    const logText = logSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(logText).toContain("bridge pacing rebase"); // rebase 生效(而非逐包计 late)
    expect((logText.match(/bridge pacing rebase/g) ?? []).length).toBe(1); // ★ 恰一次(此后节拍正常)
    expect(producerCalls).toBe(6); // 5 包 + 1 个 null:rebase 不重取料、不丢本包
    expect(audio.sent.length).toBe(5);
    expect(p.bridgeLateCount).toBe(0); // rebase 段不计 late
    for (let i = 0; i < 5; i++) {
      expect(audio.sent[i]!.readUInt32BE(4)).toBe((anchors.baseTs + i * CHUNK_LEN) >>> 0); // RTP 连续无缺口
    }
  }, 20000);
});
