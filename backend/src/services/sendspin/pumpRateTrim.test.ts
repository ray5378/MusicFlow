// 倍速热切换的「提交基准下移」：把提交点从写前沿改为最落后桥投递游标，
// 并在提交那一拍裁掉环里未被取走的帧 + 回退 pushLoop 的 cursorUs。
//
// 背景（240 真机 2026-11-25）：泵稳态贴 30s 前瞻（PUMP_LOOKAHEAD_DEFAULT_US），
// 按写前沿提交 ⇒ 用户实测「改倍速要等 30 秒」。环里 [投递游标, 前沿] 这段桥还没取走，
// 丢掉无损 ⇒ 延迟降到 lead + RTP 队列（≈5.5s）。
//
// 判据：① 提交点确实落后于写前沿（ts 出现一次回退，且回退后继续等距）；
//      ② 泵不换代（notifyBridgeGeneration 不增）；③ 无桥时一步都不做（旧行为）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GroupPump, overridePumpSource, type GroupAudio } from "./streamEngine.js";
import { PcmWindow } from "./streamSource.js";
import { SendspinGroup, SendspinConnection } from "./server.js";
import { nowUs } from "./clock.js";

const SPEED = "4";
const FRAME_US = 25_000;

let oldSpeed: string | undefined;
const opened: PcmWindow[] = [];

function makeSource() {
  return async (songId: string, startMs = 0, opts?: { speed?: number }): Promise<GroupAudio> => {
    const speed = opts?.speed ?? 1;
    const w = new PcmWindow(
      {
        input: "sine=frequency=440:duration=600:sample_rate=48000",
        inputFormat: "lavfi",
        ...(speed !== 1 ? { speed } : {}),
      },
      0,
      { meta: { songId } },
    );
    opened.push(w);
    await w.ready();
    if (startMs > 0) {
      const respawned = await w.seekTo(startMs);
      if (respawned) await w.ready();
    }
    return { pcm: new Float32Array(0), durationMs: 600_000, stream: w };
  };
}

function stubGroup() {
  const frames: bigint[] = [];
  const notify: unknown[][] = [];
  const group: any = {
    name: "ug:test",
    positionMs: 0,
    timelineBaseUs: 0n,
    current: { songId: "s", durationMs: 0 },
    audibleStarted: false,
    displaySongId: "",
    displayLeadMs: 0,
    displayPositionMs: 0,
    displayDepthMs: null,
    commonSendAheadUs: () => 800_000,
    hasBridges: () => false,
    hasDirectMembers: () => true,
    notifyBridgeGeneration: (...a: unknown[]) => { notify.push(a); },
    async pushFrame(ts: bigint, pcm: Float32Array) {
      frames.push(ts);
      return Math.floor(pcm.length / 2);
    },
  };
  const server: any = {
    log: (level: string, msg: string) => {
      if (process.env.RATE_TEST_VERBOSE === "1") console.log(`[${level}] ${msg}`);
    },
  };
  return { group, frames, notify, server };
}

async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - t0 > ms) throw new Error(`等待超时(${what})`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------------- server 侧
function fakeServer(epoch = 7): any {
  const srv: any = Object.create(SendspinGroup.prototype);
  srv.recentByGroup = new Map();
  srv.bcCursor = new Map();
  srv.bridges = new Map();
  srv.bridgeContentEpoch = epoch;
  return srv;
}

describe("SendspinGroup.trimRingAfter 环裁剪", () => {
  const KEY = "pcm:100";
  const mk = (ts: bigint, ep: number) => ({ tsUs: ts, durUs: FRAME_US, data: new Uint8Array(0), ep });

  it("裁掉 ts > cut 的当前代次帧,保留历史代次,并把游标钳回 cut", () => {
    const srv = fakeServer(7);
    srv.recentByGroup.set(KEY, [mk(1000n, 6), mk(2000n, 7), mk(3000n, 7), mk(4000n, 7)]);
    srv.bcCursor.set("d1", 2500n);
    srv.bcCursor.set("d2", 9000n);
    srv.bridges.set("d1", {});
    srv.bridges.set("d2", {});

    expect(srv.trimRingAfter(2000n)).toBe(2);
    expect(srv.recentByGroup.get(KEY).map((e: any) => Number(e.tsUs))).toEqual([1000, 2000]);
    // 游标只钳不删：d2 从 9000 回退到 2000（那段内容已删，必须重投新内容）
    expect(srv.bcCursor.get("d1")).toBe(2000n);
    expect(srv.bcCursor.get("d2")).toBe(2000n);
  });

  it("cut 小于全部 ts ⇒ 全裁空并删 key(与 pruneRecent 同构);cut 落在末尾 ⇒ 零删除", () => {
    const srv = fakeServer(7);
    srv.recentByGroup.set(KEY, [mk(1000n, 7), mk(2000n, 7)]);
    expect(srv.trimRingAfter(500n)).toBe(2);
    expect(srv.recentByGroup.has(KEY)).toBe(false);

    srv.recentByGroup.set(KEY, [mk(1000n, 7), mk(2000n, 7)]);
    expect(srv.trimRingAfter(2000n)).toBe(0);
    expect(srv.recentByGroup.get(KEY).length).toBe(2);
  });
});

describe("SendspinGroup.bridgeTrimCursorUs 可裁上界", () => {
  it("无桥 ⇒ null(纯 sendspin 组不走共享环背压)", () => {
    expect(fakeServer().bridgeTrimCursorUs()).toBeNull();
  });

  it("取最落后、忽略 0n 与已摘桥残留游标", () => {
    const srv = fakeServer();
    srv.bridges.set("d1", {});
    srv.bridges.set("d2", {});
    srv.bridges.set("d3", {});
    srv.bcCursor.set("d1", 5000n);
    srv.bcCursor.set("d2", 0n); // 起播豁免期，恒 0 ⇒ 不计入 min
    srv.bcCursor.set("d3", 3000n);
    srv.bcCursor.set("dh", 1000n); // 已摘桥，不在 bridges ⇒ 必须忽略（否则延迟白降）
    expect(srv.bridgeTrimCursorUs()).toBe(3000n);
  });
});

// ---------------------------------------------------------------- engine 侧
describe("GroupPump.resolveTrimPoint 投递游标 → 输出轴换算", () => {
  beforeEach(() => {
    oldSpeed = process.env.SENDSPIN_PUSH_SPEED;
    process.env.SENDSPIN_PUSH_SPEED = SPEED;
  });
  afterEach(() => {
    if (oldSpeed === undefined) delete process.env.SENDSPIN_PUSH_SPEED;
    else process.env.SENDSPIN_PUSH_SPEED = oldSpeed;
    overridePumpSource(null);
    for (const w of opened.splice(0)) { try { w.close(); } catch { /* ignore */ } }
  });

  it("用固定偏移把环 ts 折回输出轴;游标落在写指针之后 24.5s ⇒ outMs 同步落后", () => {
    const { group, server } = stubGroup();
    group.hasDirectMembers = () => false; // 纯桥组
    group.pumpTailUs = () => 1_000_000_000n;
    group.bridgeTrimCursorUs = () => 1_000_000_000n - 24_500_000n;
    const pump = new GroupPump(server, group);
    (pump as any).playCursorMs = 120_000; // offset = 1e9 − 120e6 = 880e6
    const r = (pump as any).resolveTrimPoint();
    expect(r).not.toBeNull();
    expect(r.outMs).toBeCloseTo(95_500, 3);
    expect(r.tsUs).toBe(975_500_000n);
  });

  it("五种不可用情形一律 null(调用方据此回落写前沿)", () => {
    const { group, server } = stubGroup();
    group.hasDirectMembers = () => false; // 先排除混合组闸门，逐项验其余四种
    const pump = new GroupPump(server, group);
    (pump as any).playCursorMs = 10_000;

    group.pumpTailUs = () => 0n; // 环空
    group.bridgeTrimCursorUs = () => 5_000_000n;
    expect((pump as any).resolveTrimPoint()).toBeNull();

    group.pumpTailUs = () => 1_000_000_000n;
    group.bridgeTrimCursorUs = () => null; // 无桥
    expect((pump as any).resolveTrimPoint()).toBeNull();

    group.bridgeTrimCursorUs = () => 0n; // 游标全 0
    expect((pump as any).resolveTrimPoint()).toBeNull();

    // 游标跑到了写指针之后（防御：不可能超前于已产出内容）⇒ outMs > playMs ⇒ 钳到 playMs
    group.pumpTailUs = () => 1_000_000_000n;
    group.bridgeTrimCursorUs = () => 1_000_000_000n + 5_000_000n;
    const r = (pump as any).resolveTrimPoint();
    expect(r.outMs).toBe(10_000);
  });

  it("混合组:直连实收前沿 D 参与取小;D 缺失/越界时退回桥游标", () => {
    const { group, server } = stubGroup(); // hasDirectMembers = () => true
    group.pumpTailUs = () => 1_000_000_000n;
    group.bridgeTrimCursorUs = () => 975_500_000n; // B
    const pump = new GroupPump(server, group);
    (pump as any).playCursorMs = 120_000; // offset = 1e9 - 120e6 = 880e6

    // ① 桩没有 slowestDirectMemberFrontUs ⇒ D 未知 ⇒ 用 B(与旧版等价)
    expect((pump as any).resolveTrimPoint().tsUs).toBe(975_500_000n);

    // ② D 比 B 更落后 3s ⇒ 裁到 D(设备已收内容一点不重发)
    group.slowestDirectMemberFrontUs = () => 972_500_000n;
    const r2 = (pump as any).resolveTrimPoint();
    expect(r2.tsUs).toBe(972_500_000n);
    expect(r2.outMs).toBeCloseTo(92_500, 3);

    // ③ D 比 B 更靠前(投递闸失效) ⇒ 仍取 B,绝不越过桥游标
    group.slowestDirectMemberFrontUs = () => 978_000_000n;
    expect((pump as any).resolveTrimPoint().tsUs).toBe(975_500_000n);

    // ④ D = 0n(成员刚连上还没出队) ⇒ 忽略,用 B
    group.slowestDirectMemberFrontUs = () => 0n;
    expect((pump as any).resolveTrimPoint().tsUs).toBe(975_500_000n);
  });
});

describe("GroupPump 有桥时提交点下移(裁环 + ts 回退)", () => {
  beforeEach(() => {
    oldSpeed = process.env.SENDSPIN_PUSH_SPEED;
    process.env.SENDSPIN_PUSH_SPEED = SPEED;
  });
  afterEach(() => {
    if (oldSpeed === undefined) delete process.env.SENDSPIN_PUSH_SPEED;
    else process.env.SENDSPIN_PUSH_SPEED = oldSpeed;
    overridePumpSource(null);
    for (const w of opened.splice(0)) { try { w.close(); } catch { /* ignore */ } }
  });

  it("提交基准落后 2s:环被裁一次、ts 回退后继续等距、泵不换代", async () => {
    overridePumpSource(makeSource());
    const { group, frames, notify, server } = stubGroup();
    const trimCalls: bigint[] = [];
    // 模拟桥：投递游标恒落后写前沿 2s（真机是 24.5s，缩短以适配 4x 推流节奏）
    group.pumpTailUs = () => (frames.length ? frames[frames.length - 1] : 0n);
    group.bridgeTrimCursorUs = () =>
      frames.length ? frames[frames.length - 1] - 2_000_000n : null;
    group.trimRingAfter = (cut: bigint) => { trimCalls.push(cut); return 80; };
    group.hasDirectMembers = () => false; // 纯桥组才允许裁环

    const pump = new GroupPump(server, group);
    await pump.play("song-trim");
    // 推进到 3s 内容：保证「游标 − 2s」仍为正（否则 resolveTrimPoint 判非法回落）
    await waitFor(() => (pump as any).playCursorMs >= 3_000, 30_000, "推进 3s 内容");
    const notify0 = notify.length;

    expect(await pump.switchRate(1.5)).toBe(true);
    await waitFor(
      () => pump.playbackRate === 1.5 && (pump as any).pendingSwap === null,
      30_000,
      "换源提交",
    );
    await waitFor(() => frames.length >= 12, 30_000, "换源后继续推帧");

    // ① 裁环只发生一次，且裁点就是当时的投递游标
    expect(trimCalls.length).toBe(1);
    // ② 绝不换代：换代 = 桥 reason=track = 断点，整个优化就白做了
    expect(notify.length).toBe(notify0);
    expect(pump.active).toBe(true);

    // ③ ts 必须出现一次回退（= 提交点从写前沿下移到游标）；没有回退说明裁环没生效
    let backIdx = -1;
    for (let k = 1; k < frames.length; k++) {
      if (frames[k] < frames[k - 1]) { backIdx = k; break; }
    }
    expect(backIdx, "未观察到 ts 回退 ⇒ 提交点仍取写前沿(延迟会退回 30s)").toBeGreaterThan(0);
    // 回退量 ≈ 2s（游标落后量），不是若干帧的抖动
    const backUs = Number(frames[backIdx - 1] - frames[backIdx]);
    expect(backUs).toBeGreaterThan(1_500_000);
    expect(backUs).toBeLessThan(2_500_000);

    // ④ 回退之后时间戳继续逐帧等距（新窗口按新基准线性接续）
    const bad: number[] = [];
    for (let k = backIdx + 1; k < frames.length; k++) {
      const d = Number(frames[k] - frames[k - 1]);
      if (d !== FRAME_US) bad.push(d);
    }
    expect(bad.length, `回退后时间戳出现非等距跳变: ${JSON.stringify(bad.slice(0, 5))}`).toBe(0);

    pump.stop();
  });

  it("无桥(桩无新方法):一步都不做,ts 全程等距、不裁环 —— 旧行为零变化", async () => {
    overridePumpSource(makeSource());
    const { group, frames, notify, server } = stubGroup();
    const pump = new GroupPump(server, group);
    await pump.play("song-nobridge");
    await waitFor(() => frames.length >= 10, 30_000, "起播推帧");
    const notify0 = notify.length;

    expect(await pump.switchRate(1.5)).toBe(true);
    await waitFor(() => pump.playbackRate === 1.5 && (pump as any).pendingSwap === null, 30_000, "提交");
    await waitFor(() => frames.length >= 18, 30_000, "继续推帧");

    expect(notify.length).toBe(notify0);
    const bad: number[] = [];
    for (let k = 1; k < frames.length; k++) {
      const d = Number(frames[k] - frames[k - 1]);
      if (d !== FRAME_US) bad.push(d);
    }
    expect(bad.length, `无桥路径不该有 ts 跳变: ${JSON.stringify(bad.slice(0, 5))}`).toBe(0);

    pump.stop();
  });

  it("混合组:裁环点取 min(B, D),ts 只回退一次后继续等距、泵不换代", async () => {
    overridePumpSource(makeSource());
    const { group, frames, notify, server } = stubGroup(); // hasDirectMembers = true
    const trimCalls: bigint[] = [];
    group.pumpTailUs = () => (frames.length ? frames[frames.length - 1] : 0n);
    group.bridgeTrimCursorUs = () =>
      frames.length ? frames[frames.length - 1] - 2_000_000n : null;
    // 直连成员比桥再落后 1s ⇒ 裁环点必须取它(否则设备会重收)
    group.slowestDirectMemberFrontUs = () =>
      frames.length ? frames[frames.length - 1] - 3_000_000n : null;
    group.trimRingAfter = (cut: bigint) => { trimCalls.push(cut); return 80; };

    const pump = new GroupPump(server, group);
    await pump.play("song-mixed-d");
    await waitFor(() => (pump as any).playCursorMs >= 3_000, 30_000, "推进 3s 内容");
    const notify0 = notify.length;

    expect(await pump.switchRate(1.5)).toBe(true);
    await waitFor(
      () => pump.playbackRate === 1.5 && (pump as any).pendingSwap === null,
      30_000,
      "换源提交",
    );
    await waitFor(() => frames.length >= 14, 30_000, "继续推帧");

    expect(trimCalls.length, "混合组的 D 已被投递闸压住 ⇒ 应当裁环").toBe(1);
    expect(notify.length).toBe(notify0);
    let backs = 0;
    const bad: number[] = [];
    for (let k = 1; k < frames.length; k++) {
      const d = Number(frames[k] - frames[k - 1]);
      if (d < 0) backs++;
      else if (d !== FRAME_US) bad.push(d);
    }
    expect(backs, "应恰好一次 ts 回退(裁环点)").toBe(1);
    expect(bad.length, `回退后应继续等距: ${JSON.stringify(bad.slice(0, 5))}`).toBe(0);

    pump.stop();
  });
});


// ---------------------------------------------------------------- 投递闸(P1)
// 目的:把「直连成员实收前沿 D」的真正来源钉死 —— D 由三道闸共同限制：
//   ① 设备容量 ② 桥投递游标 ③ 用户配置的 prefill 档位。
// 其中 ③ 是「混合组改速延迟」的旋钮：设 5 秒 ⇒ 混合组约 5 秒生效。
function fakeConn(group: any, cap = 1_000_000): any {
  const conn: any = Object.create(SendspinConnection.prototype);
  conn.clientId = "c1";
  conn.legacy = false;
  conn.ws = { readyState: 1, send: () => {} };
  conn.bufferCapacityBytes = cap;
  conn.issuedBytes = 0;
  conn.issuedFrames = [];
  conn.issuedFrontUs = 0n;
  conn.audioQueue = [];
  conn.audioQueueBytes = 0;
  conn.audioQueueTimer = null;
  conn.droppedByQueueCap = 0;
  conn.audioGateLogAt = 0;
  conn.group = group;
  conn.server = { log: () => {} };
  conn.__sent = [] as bigint[];
  conn._sendAudioNow = (ts: bigint) => { conn.__sent.push(ts); };
  return conn;
}

function bridgeGroup(over: any = {}): any {
  return {
    bridges: new Map([["b1", {}]]),
    bridgeTrimCursorUs: () => null,
    prefillWantedMsCache: 0,
    ...over,
  };
}

describe("SendspinConnection 逐成员投递闸(P1)", () => {
  const DATA = new Uint8Array(1000);
  const DUR = 25_000;

  it("① 容量闸:已发未播 + 本帧 > buffer_capacity ⇒ 拒收", () => {
    const conn = fakeConn(bridgeGroup(), 10_000);
    conn.issuedBytes = 9_500;
    expect(conn.canAccept(1000, 0n, DUR)).toBe(false);
    expect(conn.canAccept(400, 0n, DUR)).toBe(true);
  });

  it("② 桥游标闸:本帧末尾 > B ⇒ 拒收(D 不得超过桥游标)", () => {
    const t0 = nowUs();
    const conn = fakeConn(bridgeGroup({ bridgeTrimCursorUs: () => t0 + 5_000_000n }));
    expect(conn.canAccept(1000, t0 + 5_000_000n - 25_000n, DUR)).toBe(true);
    expect(conn.canAccept(1000, t0 + 5_000_000n, DUR)).toBe(false);
  });

  it("③ prefill 闸:档位即旋钮 —— 5 秒档只放到 now+5s", () => {
    const t0 = nowUs();
    const conn = fakeConn(bridgeGroup({ prefillWantedMsCache: 5000 }));
    expect(conn.canAccept(1000, t0 + 4_900_000n, DUR)).toBe(true);
    expect(conn.canAccept(1000, t0 + 5_000_000n, DUR)).toBe(false);
  });

  it("设备未宣告容量 ⇒ 容量闸关(大字节也放行),但桥闸仍生效", () => {
    const t0 = nowUs();
    const g = bridgeGroup({ bridgeTrimCursorUs: () => t0 + 5_000_000n });
    const conn = fakeConn(g, 0);
    conn.issuedBytes = 10_000_000;
    expect(conn.canAccept(1000, t0 + 1_000_000n, DUR)).toBe(true);
    expect(conn.canAccept(1000, t0 + 6_000_000n, DUR)).toBe(false);
  });

  it("无桥 / 无容量 ⇒ 投递闸不启用(纯 sendspin 组旧行为零变化)", () => {
    expect(fakeConn(bridgeGroup({ bridges: new Map() })).audioGateOn()).toBe(false);
    expect(fakeConn(bridgeGroup(), 0).audioGateOn()).toBe(false);
    expect(fakeConn(bridgeGroup()).audioGateOn()).toBe(true);
  });

  it("prunePlayed 只回收已播字节,未播的仍计入占用", () => {
    const t0 = nowUs();
    const conn = fakeConn(bridgeGroup());
    conn.issuedFrames.push({ endUs: t0 - 1n, bytes: 100 }, { endUs: t0 + 1_000_000n, bytes: 300 });
    conn.issuedBytes = 400;
    conn.prunePlayed(t0);
    expect(conn.issuedBytes).toBe(300);
    expect(conn.issuedFrames.length).toBe(1);
  });

  it("队列:装不下的留在队列(不丢帧),腾出空间后自动续发且顺序不乱", () => {
    const t0 = nowUs();
    let bLimit = t0 + 100_000n;
    const conn = fakeConn(bridgeGroup({ bridgeTrimCursorUs: () => bLimit }));
    for (let k = 0; k < 8; k++) {
      const ts = t0 + BigInt(k * 25_000);
      conn.sendAudio(ts, DATA, ts, DUR);
    }
    expect(conn.__sent.length).toBe(4);
    expect(conn.audioQueue.length).toBe(4);
    expect(conn.droppedByQueueCap).toBe(0);

    bLimit = t0 + 1_000_000n;
    conn.pumpMemberQueue();
    expect(conn.__sent.length).toBe(8);
    expect(conn.audioQueue.length).toBe(0);
    const sent = conn.__sent as bigint[];
    for (let k = 1; k < sent.length; k++) expect(sent[k] > sent[k - 1]).toBe(true);
  });

  it("issuedFrontUs 记的是内容轴(未补偿)ts:补偿值不会把 D 抬高", () => {
    const t0 = nowUs();
    const conn = fakeConn(bridgeGroup());
    conn.sendAudio(t0 + 500_000n, DATA, t0, DUR); // 下发带 500ms 补偿
    expect(conn.issuedFrontUs).toBe(t0 + 25_000n);
  });
});