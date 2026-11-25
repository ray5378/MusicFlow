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
    // 落点后移 250ms ⇒ [now, now+250ms] 无内容,允许末拍残留 1 次计数;
    // 关键判据是「不得出现第二次兜底」(上一行日志数=1)且计数未累到 2。
    expect(Math.max(0, ...(g as any).bridgeDeadTicks.values())).toBeLessThan(2);
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

  // [组A-4/原验收3 2026-11-25] 双桥场景:1 台触发死锁 + 1 台正常种子。
  // 断言口径 = **内容时间线一致**(两台游标在同一拍被同一次组级重基准对齐到同一
  // now 种子、环时间线只有一份),**不是** gen_firstTs 逐字节相等 —— gen_firstTs 含
  // 各设备首帧到达时序差(240 真机 14:45 两台差 250ms 即为正常时序差),拿它当
  // 「同源」断言会把正常现象钉成回归。
  it("⑤ 双桥:一台触发死锁兜底 ⇒ 组级单次重基准覆盖两台,游标同种子、环时间线一份,稳态不再触发", () => {
    const { g, srv, handles } = groupWith(["dev-a", "dev-b"]);
    const now = nowUs();
    const epoch = (g as any).bridgeContentEpoch;
    const key = (g as any).encoderKey("pcm", 100);
    (g as any).bcEpoch.set(key, epoch);
    // 环内容整体在视界外(now+15s 起,视界 now+8.5s ⇒ cand=0 对两台都成立)
    for (let i = 0; i < 40; i++) addRingFrame(g, now + 15_000_000n + BigInt(i) * 25_000n, epoch);
    // dev-a:模拟先起流的那台(游标已过期落在很远的历史位置);dev-b:新会话(游标缺失,走种子路径)
    (g as any).bcCursor.set("dev-a", now - 30_000_000n);

    // 第 1 拍:两台都记 dead(内容在视界外);种子路径生效(dev-b 游标=now,非 0)
    (g as any).bridgeBroadcastTick(now);
    expect((g as any).bcCursor.get("dev-b")).toBe(now);
    // 第 2 拍:dev-a 触发组级兜底重基准(冷却 1s:只前移一次)
    (g as any).bridgeBroadcastTick(now + 250_000n);
    expect(srv.logs.filter((l: string) => l.includes("bridge-start-seek-deadlock")).length).toBe(1);
    expect(handles["dev-a"].boundaries).toContain("seek");
    expect(handles["dev-b"].boundaries).toContain("seek");
    // 内容时间线一致:两台游标同拍被对齐进同一份(已重基准的)环时间线 ——
    // dev-a(先处理,触发兜底)= 种子 now;dev-b(后处理)同拍即从重基准后的环窗口
    // 继续投递,游标已前进。同源的判定 = 两台都落在同一条环时间线的窗口内
    // (≥ 重基准种子 now、≤ 环尾 now+1s),而不是逐字节相等(见本用例头注释)。
    const ca = (g as any).bcCursor.get("dev-a") as bigint;
    const cb = (g as any).bcCursor.get("dev-b") as bigint;
    expect(ca).toBeGreaterThanOrEqual(now + 250_000n);
    expect(ca).toBeLessThanOrEqual(ringTail(g) + 30_000n);
    expect(cb).toBeGreaterThanOrEqual(ca);
    expect(cb).toBeLessThanOrEqual(ringTail(g) + 30_000n);
    // 第 3 拍:两台都恢复投递(同一份环,同一时间线)
    (g as any).bridgeBroadcastTick(now + 500_000n);
    expect(handles["dev-a"].pushed.length).toBeGreaterThan(0);
    expect(handles["dev-b"].pushed.length).toBeGreaterThan(0);
    // 两台投递的是同一时间线的帧(各自游标独立推进,但内容源唯一)
    expect((g as any).bridgeDeadTicks.size).toBe(0);
    // 稳态 20 拍:冷却+重基准后不得再次触发(环时间线一份,不存在第二轮死锁)
    for (let i = 1; i <= 20; i++) {
      (g as any).bridgeBroadcastTick(now + BigInt(500_000 + i * 250_000));
    }
    expect(srv.logs.filter((l: string) => l.includes("bridge-start-seek-deadlock")).length).toBe(1);
  });

  // [组A-分级/01:05 事故标定] shift 量级门:超大 shift(40s > 8s 门)⇒ 轻重启:
  // 旧代内容作废、泵新帧接投递下沿、BOUNDARY{seek}、游标复位 —— 不整环前移
  // (整环前移在 01:05 实证会把 30s+ 的环压进窗口 ⇒ 环空 + offset 累计爆炸)。
  it("⑥ 超大 shift ⇒ mode=light-restart:旧代作废、泵新帧接下沿、游标复位", async () => {
    const { g, srv, handles } = groupWith(["dev-a"]);
    const now = nowUs();
    const epoch = (g as any).bridgeContentEpoch;
    const key = (g as any).encoderKey("pcm", 100);
    (g as any).bcEpoch.set(key, epoch);
    // 环内容整体在 now+40s(超大 shift 形态;01:05 实测 29s)
    for (let i = 0; i < 40; i++) addRingFrame(g, now + 40_000_000n + BigInt(i) * 25_000n, epoch);
    (g as any).deliveredPeak = 40 * 48_000;
    (g as any).encoders.set(key, new PhaseEncoder());

    (g as any).bridgeBroadcastTick(now);
    (g as any).bridgeBroadcastTick(now + 250_000n);
    const lines = srv.logs.filter((l: string) => l.includes("bridge-start-seek-deadlock"));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("mode=light-restart"); // 走轻重启,不是整环前移
    expect(handles["dev-a"].boundaries).toContain("seek");
    expect((g as any).bcCursor.get("dev-a")).toBe(now + 250_000n);
    // [v5] 轻重启后强制换代 ⇒ 环里旧代内容已被 ep 过滤(环空), 环尾 = 0
    expect((g as any).bridgeContentEpoch).toBe(epoch + 1);
    expect(ringTail(g)).toBe(0n);
    // 泵打戳偏移已把后续新帧拉回投递下沿附近
    expect((g as any).bridgeTimelineOffsetUs).toBeLessThan(0n);

    // 真实 append:泵按旧累计打戳(+40s 尾)⇒ 经偏移后新帧必须落在下沿附近(非 +40s)
    const pushed = await g.pushFrame(now + 41_000_000n, new Float32Array(2400));
    expect(Number(pushed)).toBeGreaterThan(0);
    const newTail = ringTail(g);
    expect(newTail).toBeGreaterThan(now); // 时间轴不倒退
    expect(newTail).toBeLessThan(now + 5_000_000n); // 不再挂在 +40s 错位时间线上
  });

  // ==================== [治本 2026-11-25] 投递侧断粮自动补静音 ====================
  // 真机(v4.15.2, 03:23/03:27):切歌后环内 ~6.5s 真空,`bridge-gap-fill` 全程 0 次
  // ⇒ 连环死锁 5 次 + offset 累到 -31.1s。修法:投递 tick 按「内容尾 < 投递下沿」
  // 自动启动续静音(对齐 MA _align_chunk 按 ts 填洞,不依赖上游 endedNaturally 语义)。
  it("⑦ 断粮(tail<下沿)+在播 ⇒ 自动启动续静音", () => {
    const { g, srv } = groupWith(["dev-a"]);
    const now = nowUs();
    const epoch = (g as any).bridgeContentEpoch;
    (g as any).bcEpoch.set((g as any).encoderKey("pcm", 100), epoch);
    g.current = { songId: "s1", durationMs: 200000 };
    g.paused = false;
    addRingFrame(g, now + 1_000_000n, epoch); // 仅 1s 存量,低于 2.5s 下沿

    g.bridgePushTick();
    expect((g as any).bridgeGapFillTailUs).not.toBeNull();
    expect(srv.logs.some((l) => l.includes("bridge-gap-fill-autostart"))).toBe(true);
  });

  it("⑧ 内容充足(tail=now+30s) ⇒ 不启动(正常播放零干扰)", () => {
    const { g, srv } = groupWith(["dev-a"]);
    const now = nowUs();
    const epoch = (g as any).bridgeContentEpoch;
    (g as any).bcEpoch.set((g as any).encoderKey("pcm", 100), epoch);
    g.current = { songId: "s1", durationMs: 200000 };
    g.paused = false;
    addRingFrame(g, now + 30_000_000n, epoch);

    g.bridgePushTick();
    expect((g as any).bridgeGapFillTailUs).toBeNull();
    expect(srv.logs.some((l) => l.includes("bridge-gap-fill-autostart"))).toBe(false);
  });

  it("⑨ 无曲目 / 暂停 ⇒ 不启动(停止后不得灌静音)", () => {
    const { g } = groupWith(["dev-a"]);
    const now = nowUs();
    const epoch = (g as any).bridgeContentEpoch;
    (g as any).bcEpoch.set((g as any).encoderKey("pcm", 100), epoch);
    addRingFrame(g, now + 1_000_000n, epoch);

    g.current = null;
    g.paused = false;
    g.bridgePushTick();
    expect((g as any).bridgeGapFillTailUs).toBeNull();

    g.current = { songId: "s1", durationMs: 200000 };
    g.paused = true;
    g.bridgePushTick();
    expect((g as any).bridgeGapFillTailUs).toBeNull();
  });

  it("⑩ 真内容到达 ⇒ 自动收工(不持续灌静音)", async () => {
    const { g } = groupWith(["dev-a"]);
    const now = nowUs();
    const epoch = (g as any).bridgeContentEpoch;
    (g as any).bcEpoch.set((g as any).encoderKey("pcm", 100), epoch);
    g.current = { songId: "s1", durationMs: 200000 };
    g.paused = false;
    addRingFrame(g, now + 1_000_000n, epoch);
    g.bridgePushTick();
    expect((g as any).bridgeGapFillTailUs).not.toBeNull();

    await g.pushFrame(now + 32_000_000n, new Float32Array(2400));
    expect((g as any).bridgeGapFillTailUs).toBeNull();
  });

  // ==================== [治本 v3 2026-11-25] 投递洞填充 ====================
  // 真机 v4.15.3(05:04)实证: cursorVsNow=-681ms / backlogMs=0 / deliveredMs=0
  // 连续三拍投不出, 而 tailVsNow=34524(环里 34.5s 内容充足) ⇒ cursor 与环头之间
  // 有真空; 旧路径被判定死锁后整环前移, offset 每次 -5.5M、4 连累到 -34M。
  // 加余量(shiftMs 5549 vs headVsNowMs 5799 差额恒 250)无效。
  // 填洞后应直接推静音跨过真空, 不触发死锁。
  it("⑬ cursor 与环头之间有真空 ⇒ 填静音跨过, 不触发死锁", () => {
    const { g, srv, handles } = groupWith(["dev-a"]);
    const now = nowUs();
    const epoch = (g as any).bridgeContentEpoch;
    const key = (g as any).encoderKey("pcm", 100);
    (g as any).bcEpoch.set(key, epoch);
    (g as any).frozenSendAheadUs = 500_000; // 固定 ahead ⇒ 视界 = now+5s+0.5s = 5.5s
    (g as any).bcCursor.set("dev-a", now + 4_000_000n); // 游标已推到 4s
    // 环从 now+5.8s 起 1400 帧 ⇒ 4s~5.8s 之间是真空(超视界 0.3s, 填洞应在 3 拍内跨过)
    for (let i = 0; i < 1400; i++) addRingFrame(g, now + 5_800_000n + BigInt(i) * 25_000n, epoch);
    (g as any).deliveredPeak = 1400 * 48_000;
    (g as any).encoders.set(key, new PhaseEncoder());

    for (let k = 0; k < 8; k++) {
      (g as any).bridgeBroadcastTick(now + BigInt(k) * 250_000n);
    }
    expect(srv.logs.some((l) => l.includes("bridge-hole-fill"))).toBe(true);
    expect(srv.logs.filter((l) => l.includes("bridge-start-seek-deadlock")).length).toBe(0);
    expect(handles["dev-a"].pushed.length).toBeGreaterThan(0);
    expect((g as any).bridgeTimelineOffsetUs).toBe(0n); // 填洞不记账, 不累加 offset
  });

  it("⑭ 环头在视界内 ⇒ 正常投递, 不触发填洞(零误伤)", () => {
    const { g, srv } = groupWith(["dev-a"]);
    const now = nowUs();
    const epoch = (g as any).bridgeContentEpoch;
    const key = (g as any).encoderKey("pcm", 100);
    (g as any).bcEpoch.set(key, epoch);
    for (let i = 0; i < 200; i++) addRingFrame(g, now + 1_000_000n + BigInt(i) * 25_000n, epoch);
    (g as any).deliveredPeak = 200 * 48_000;
    (g as any).encoders.set(key, new PhaseEncoder());

    (g as any).bridgeBroadcastTick(now);
    expect(srv.logs.some((l) => l.includes("bridge-hole-fill"))).toBe(false);
  });

  // ==================== [治本 v4] continuity=1 的时间线洁净门 ====================
  // 真机 05:04: offset=-6.7s 时 continuity=1 不换代不清偏移 ⇒ 坏偏移传新曲 ⇒
  // 真空 ⇒ 5 连死锁累到 -34M。offset 越 ±1s 时必须降级 REBUILD。
  it("⑮ continuity=1 且 offset 病态 ⇒ 降级 REBUILD(换代,不传播坏偏移)", () => {
    const { g, srv } = groupWith(["dev-a"]);
    const epoch0 = (g as any).bridgeContentEpoch;
    (g as any).bridgeTimelineOffsetUs = -6_700_000n;
    (g as any).notifyBridgeGeneration(101, "track", undefined, true);
    expect(srv.logs.some((l) => l.includes("bridge-continuity-degraded"))).toBe(true);
    expect((g as any).bridgeContentEpoch).toBe(epoch0 + 1); // 走了完整换代
  });

  it("⑯ continuity=1 且 offset 干净 ⇒ 仍接续(零误伤,不换代)", () => {
    const { g, srv } = groupWith(["dev-a"]);
    const epoch0 = (g as any).bridgeContentEpoch;
    (g as any).bridgeTimelineOffsetUs = 0n;
    (g as any).notifyBridgeGeneration(102, "track", undefined, true);
    expect(srv.logs.some((l) => l.includes("continuity=1 keep"))).toBe(true);
    expect(srv.logs.some((l) => l.includes("bridge-continuity-degraded"))).toBe(false);
    expect((g as any).bridgeContentEpoch).toBe(epoch0); // 不换代
  });

  // ==================== [治本 v5] LR 后强制换代 ====================
  // 真机 06:01:01→07: LR(shift 34.7s) 后 droppedFrames 一次性暴涨 291,723(≈6.6s),
  // 用户听到「跳了一段」而进度条照走。换代让环重建, 把「丢 6.6s 且位置不确定」
  // 变成「从明确位置短跳」。
  it("⑰ LR(shift>16s) 后强制换代: epoch+1、环空、不连环死锁", () => {
    const { g, srv, handles } = groupWith(["dev-a"]);
    const now = nowUs();
    const epoch0 = (g as any).bridgeContentEpoch;
    const key = (g as any).encoderKey("pcm", 100);
    (g as any).bcEpoch.set(key, epoch0);
    for (let i = 0; i < 40; i++) addRingFrame(g, now + 40_000_000n + BigInt(i) * 25_000n, epoch0);
    (g as any).deliveredPeak = 40 * 48_000;
    (g as any).encoders.set(key, new PhaseEncoder());

    (g as any).bridgeBroadcastTick(now);
    (g as any).bridgeBroadcastTick(now + 250_000n);
    expect(srv.logs.some((l) => l.includes("mode=light-restart"))).toBe(true);
    expect((g as any).bridgeContentEpoch).toBe(epoch0 + 1);
    expect(ringTail(g)).toBe(0n); // 旧代被过滤 ⇒ 环空

    // 环空后继续走:不得再触发死锁(tail=0 ⇒ 判据不成立)
    for (let k = 3; k <= 10; k++) {
      (g as any).bridgeBroadcastTick(now + BigInt(k) * 250_000n);
    }
    expect(srv.logs.filter((l) => l.includes("bridge-start-seek-deadlock")).length).toBe(1);
    expect(handles["dev-a"].boundaries).toContain("seek");
  });
});
