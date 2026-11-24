// ==================== P0 回归:start-seek 游标死锁 + 泵时间线同步重基准 ====================
//
// 事故(240 2026-11-24 21:14):cursor delete 后 `?? 0n` ⇒ 游标被当作内容绝对 0
// (与 uptime≈296907s 相减得 -296907s);环内当前代次内容整体在 now+15s,视界只有
// now+5.5s ⇒ 每拍 cand=0、游标不推进 = 永久静音。
//
// 本文件钉死修复的四条语义:
//   ① 游标缺失 ≠ 内容 0:缺失时给有效种子(环内最早当前代次帧前一格 / 过期或越视界则 now);
//   ② 死锁兜底:连续 2 拍 cand=0 且 tail>horizon ⇒ 环时间线整体前移回可投范围 +
//     BOUNDARY{seek} 重锚 + 独立日志 bridge-start-seek-deadlock,禁止空转;
//   ③ start-seek 不再 delete 游标(种子化),按代次记账(重播不复发);
//   ④ **泵时间线同步重基准**:重基准后真实 append 路径产出的新帧必须与平移后的环尾
//     连续(差值≈durUs),否则会「每约 15s 一次 0.5s 死窗 + 重锚」的周期性断音;
//      长跑 ≥15s 不得出现第二次兜底;稳态 20 拍兜底不得误触发。
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
vi.hoisted(() => {
  process.env.MF_PLAYER_ISOLATION = "1";
  process.env.MF_PLAYER_BROADCAST = "1";
});
import "../plugins/_env.js";
import { initDatabase } from "../../src/db/index.js";
import { SendspinGroup } from "../../src/services/sendspin/server.js";
import { nowUs } from "../../src/services/sendspin/clock.js";

const liveGroups: SendspinGroup[] = [];

/** 可控块编码器桩:每次 encode 产出 n 个样本(25ms=2400 交错样本 @48k/2ch)。 */
class PhaseEncoder {
  constructor(private readonly n = 2400) {}
  async encode(): Promise<{ frameSamples: number; data: Uint8Array }[]> {
    return this.n > 0 ? [{ frameSamples: this.n, data: new Uint8Array(Math.max(1, this.n / 2)).fill(0xab) }] : [];
  }
  async flush(): Promise<never[]> { return []; }
  close(): void {}
}

function makeServerStub() {
  const map = new Map<string, number>();
  const logs: string[] = [];
  return {
    log(level: string, msg: string) { logs.push(`${level}|${msg}`); },
    logs,
    bridgeBacklogMs: map,
    setBridgeBacklog(m: Record<string, number>) {
      map.clear();
      for (const [k, v] of Object.entries(m)) map.set(k, v);
    },
  };
}

/** 直连成员桩(最小面:codec 分组 / 清流 / 宣告 / 音频下发)。 */
function memberStub(clientId: string) {
  const sent: { type: string; payload: unknown }[] = [];
  const audio: { ts: bigint }[] = [];
  const events: string[] = [];
  return {
    clientId,
    codec: "pcm",
    legacy: false,
    appliedGain: () => 100,
    bufferCapacityBytes: 0,
    clientWantsStream: () => true,
    sendJson(type: string, payload: unknown) {
      sent.push({ type, payload });
      if (type === "stream/clear") events.push("clear");
    },
    sendAudio(ts: bigint) { audio.push({ ts }); },
    announceStream() { events.push("start"); },
    sendGroupUpdate() {},
    sent,
    audio,
    events,
  };
}

function groupWith(bridges: string[], members: ReturnType<typeof memberStub>[] = []) {
  const srv = makeServerStub();
  const g = new SendspinGroup("g-start-seek", srv as any);
  for (const m of members) g.members.add(m as any);
  const handles: Record<string, { pushed: { ts: bigint }[]; boundaries: string[] }> = {};
  for (const id of bridges) {
    const pushed: { ts: bigint }[] = [];
    const boundaries: string[] = [];
    handles[id] = { pushed, boundaries };
    g.bridges.set(id, {
      deviceId: id,
      pushed,
      pushAudio(_data: Uint8Array, ts: bigint) { pushed.push({ ts }); },
      sendBoundary(reason: string) { boundaries.push(reason); },
    } as any);
  }
  liveGroups.push(g);
  return { g, srv, handles };
}

function addRingFrame(g: SendspinGroup, tsUs: bigint, ep: number, durUs = 25_000): void {
  const key = (g as any).encoderKey("pcm", 100);
  (g as any).ringFor(key).push({ tsUs, durUs, data: new Uint8Array(2400), ep });
}

/** 环内当前代次最后一帧 ts(不存在 ⇒ 0)。 */
function ringTail(g: SendspinGroup): bigint {
  const key = (g as any).encoderKey("pcm", 100);
  const ring = (g as any).recentByGroup.get(key) ?? [];
  for (let i = ring.length - 1; i >= 0; i--) if (ring[i].ep === (g as any).bridgeContentEpoch) return ring[i].tsUs;
  return 0n;
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

afterEach(() => {
  for (const g of liveGroups.splice(0)) g.stopBridgePushTimer();
});

describe("start-seek 死锁修复(P0)", () => {
  it("① 环内容整体 now+15s 且 bcCursor 缺失 ⇒ 种子非 0,2 拍后显式重锚,第 3 拍恢复投递", () => {
    const { g, srv, handles } = groupWith(["dev-a", "dev-b"]);
    const now = nowUs();
    const epoch = (g as any).bridgeContentEpoch;
    (g as any).bcEpoch.set((g as any).encoderKey("pcm", 100), epoch);
    for (let i = 0; i < 40; i++) addRingFrame(g, now + 15_000_000n + BigInt(i) * 25_000n, epoch);

    (g as any).bridgeBroadcastTick(now);
    expect((g as any).bcCursor.get("dev-a")).toBe(now); // 缺失语义修复:不是 0n
    expect(handles["dev-a"].pushed.length).toBe(0);

    (g as any).bridgeBroadcastTick(now + 250_000n);
    expect(handles["dev-a"].boundaries).toContain("seek");
    expect(handles["dev-b"].boundaries).toContain("seek");
    expect(srv.logs.some((l) => l.includes("bridge-start-seek-deadlock"))).toBe(true);

    (g as any).bridgeBroadcastTick(now + 500_000n);
    expect(handles["dev-a"].pushed.length).toBeGreaterThan(0);
    expect((g as any).bcCursor.get("dev-a")).toBeGreaterThan(now);
    expect((g as any).bridgeDeadTicks.size).toBe(0);
  });

  it("② 环内最早帧在视界内 ⇒ 种子=该帧前一格,首拍即投出", () => {
    const { g, handles } = groupWith(["dev-a"]);
    const now = nowUs();
    const epoch = (g as any).bridgeContentEpoch;
    (g as any).bcEpoch.set((g as any).encoderKey("pcm", 100), epoch);
    const head = now + 2_000_000n;
    for (let i = 0; i < 10; i++) addRingFrame(g, head + BigInt(i) * 25_000n, epoch);

    (g as any).bridgeBroadcastTick(now);
    expect((g as any).bcCursor.get("dev-a")).not.toBe(0n);
    expect(handles["dev-a"].pushed.length).toBeGreaterThan(0);
    expect((g as any).bridgeDeadTicks.size).toBe(0);
  });

  it("④ 重基准后走**真实 append 路径**产一帧 ⇒ 新帧 ts 与平移后环尾连续(≈durUs,无 15s 洞)", async () => {
    const { g, handles } = groupWith(["dev-a"]);
    const now = nowUs();
    const epoch = (g as any).bridgeContentEpoch;
    const key = (g as any).encoderKey("pcm", 100);
    (g as any).bcEpoch.set(key, epoch);
    // 复刻事故环:1400 帧 × 25ms 从 now+15s 到 now+50s(泵累计已产到 +50s)
    for (let i = 0; i < 1400; i++) addRingFrame(g, now + 15_000_000n + BigInt(i) * 25_000n, epoch);
    // 泵记账峰值 ≈ +50s(与环尾同源)
    (g as any).deliveredPeak = 50 * 48_000;
    (g as any).encoders.set(key, new PhaseEncoder());

    // 两拍触发兜底重基准(第 1 拍记数,第 2 拍重基准)
    (g as any).bridgeBroadcastTick(now);
    (g as any).bridgeBroadcastTick(now + 250_000n);
    expect(handles["dev-a"].boundaries).toContain("seek");
    // 环已平移到「头帧落 now(第 2 拍 = now+250ms)」..尾部 ≈ +35.2s
    const rebasedTail = ringTail(g);
    expect(rebasedTail).toBeLessThanOrEqual(now + 35_500_000n);
    expect(rebasedTail).toBeGreaterThan(now + 34_500_000n);

    // 真实 append:泵下一批 tsUs = 累计 +50s(旧时间线)
    const pushed = await g.pushFrame(now + 50_000_000n, new Float32Array(2400));
    expect(Number(pushed)).toBeGreaterThan(0);
    const newTail = ringTail(g);
    const delta = newTail - rebasedTail;
    // 连续:差值 ≈ 一帧时长(25ms);若泵时间线未同步重基准,这里会是 ≈15s 的洞
    expect(delta).toBeLessThanOrEqual(30_000n);
    expect(delta).toBeGreaterThan(0n);
  });

  it("④b 重基准后继续播放 ≥15s(60 拍)+ 泵持续产帧 ⇒ 不再第二次 deadlock,投递持续增长", async () => {
    const { g, srv, handles } = groupWith(["dev-a"]);
    const now = nowUs();
    const epoch = (g as any).bridgeContentEpoch;
    const key = (g as any).encoderKey("pcm", 100);
    (g as any).bcEpoch.set(key, epoch);
    for (let i = 0; i < 1400; i++) addRingFrame(g, now + 15_000_000n + BigInt(i) * 25_000n, epoch);
    (g as any).deliveredPeak = 50 * 48_000;
    (g as any).encoders.set(key, new PhaseEncoder());

    (g as any).bridgeBroadcastTick(now);
    (g as any).bridgeBroadcastTick(now + 250_000n);
    const deadAfterRebase = srv.logs.filter((l) => l.includes("bridge-start-seek-deadlock")).length;
    expect(deadAfterRebase).toBe(1);

    // 60 拍 × 250ms = 15s;每拍泵真实产 250ms 内容(10 × 25ms)。
    // 泵的 tsUs 沿**旧时间线**推进(从 +50s 起):经偏移 −15s 后落在 +35s 起的
    // 平移后时间线上 —— 与平移后的环尾连续(这正是 ④ 修复点)。
    let pumpRegUs = now + 50_000_000n;
    let t = now + 500_000n;
    const pushedAtStart = handles["dev-a"].pushed.length;
    for (let tick = 0; tick < 60; tick++) {
      for (let k = 0; k < 10; k++) {
        await g.pushFrame(pumpRegUs, new Float32Array(2400));
        pumpRegUs += 25_000n;
      }
      t += 250_000n;
      (g as any).bridgeBroadcastTick(t);
    }
    // 观测:只允许首轮那一次兜底;不得出现第二次
    expect(srv.logs.filter((l) => l.includes("bridge-start-seek-deadlock")).length).toBe(1);
    expect(handles["dev-a"].pushed.length).toBeGreaterThan(pushedAtStart);
    expect((g as any).bridgeDeadTicks.size).toBe(0);
  });

  it("④c 稳态 20 拍正常投递 ⇒ 兜底不误触发(无 BOUNDARY seek、deadTicks 恒空)", () => {
    const { g, handles } = groupWith(["dev-a"]);
    const now = nowUs();
    const epoch = (g as any).bridgeContentEpoch;
    (g as any).bcEpoch.set((g as any).encoderKey("pcm", 100), epoch);
    // 稳态:内容超前 2s(视界内)
    for (let i = 0; i < 160; i++) addRingFrame(g, now + 2_000_000n + BigInt(i) * 25_000n, epoch);
    let t = now;
    for (let tick = 0; tick < 20; tick++) {
      (g as any).bridgeBroadcastTick(t);
      t += 250_000n;
    }
    expect(handles["dev-a"].pushed.length).toBeGreaterThan(0);
    expect(handles["dev-a"].boundaries.filter((b) => b === "seek").length).toBe(0);
    expect((g as any).bridgeDeadTicks.size).toBe(0);
  });

  it("⑤ 混合组:重基准对直连成员 stream/clear→重宣告,后续 sendAudio ts 与环连续(无 15s 倒跳)", async () => {
    const mb = memberStub("esp32-player2");
    const { g, handles } = groupWith(["dev-a"], [mb]);
    const now = nowUs();
    const epoch = (g as any).bridgeContentEpoch;
    const key = (g as any).encoderKey("pcm", 100);
    (g as any).bcEpoch.set(key, epoch);
    for (let i = 0; i < 1400; i++) addRingFrame(g, now + 15_000_000n + BigInt(i) * 25_000n, epoch);
    (g as any).deliveredPeak = 50 * 48_000;
    (g as any).encoders.set(key, new PhaseEncoder());

    // 两拍触发兜底重基准
    (g as any).bridgeBroadcastTick(now);
    (g as any).bridgeBroadcastTick(now + 250_000n);
    // 直连成员:清流 + 入 pendingAnnounces(下一帧重宣告);桥仍 seek
    expect(mb.events).toContain("clear");
    expect((g as any).pendingAnnounces).toContain(mb);
    expect(handles["dev-a"].boundaries).toContain("seek");

    // 下一帧走真实 pushFrame ⇒ stream/start + sendAudio 的 ts 与平移后环连续
    const rebasedTail = ringTail(g);
    await g.pushFrame(now + 50_000_000n, new Float32Array(2400));
    expect(mb.events).toContain("start");
    expect((g as any).pendingAnnounces.length).toBe(0);
    expect(mb.audio.length).toBeGreaterThan(0);
    const memberTs = mb.audio[0].ts;
    const newTail = ringTail(g);
    // 成员与环同源:同一帧 ts(成员 sendAudio 不额外偏移,client 延迟补偿=0)
    expect(memberTs).toBe(newTail);
    // 连续性:新帧接在平移后环尾之后(≈一帧时长),不是 15s 倒跳/空洞
    expect(newTail - rebasedTail).toBeLessThanOrEqual(30_000n);
    expect(newTail - rebasedTail).toBeGreaterThan(0n);
  });
});
