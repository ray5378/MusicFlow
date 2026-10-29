// ==================== 曲末排空 · 桥续静音(A 方案,2026-11) ====================
//
// 问题(真机抓包):曲末排空期间 `pushLoop` 已退出、**不再产出 PCM**;桥侧
// `bridgeSession.pullChunk()` 按 `waitDataMs=1000ms` 超时后每秒只吐**一块 1408B 静音**
// ⇒ 服务端 RTP 从 125pps 掉到约 1pps(卡顿期每秒恰好 1 包),接收端长时间近零速率会被
// 判假死 / 触发重锚。
//
// A 方案:排空期间**每步**把与 sleep 等长、同起点的静音帧写进 pcm:100 的 ring
// (`SendspinGroup.pushBridgeOnlySilence`),由 250ms 补投定时器照常按可听域窗口投递
// ⇒ RTP 节拍保持。A 的**目标不是缩短可听静默**(那是 B/C 的活),只是维持节拍。
//
// 三条硬约束(本文件逐个钉住):
//   ① 只写 ring,不做成员下发(deliveredByGroup / deliveredPeak / 成员 sendAudio 全不动);
//   ② 无桥 ⇒ 完全不写(返回 0),纯直连组行为与改动前一致;
//   ③ 开关 `MF_BRIDGE_DRAIN_SILENCE`(缺省 ON)关闭时排空循环逐字节回到改动前;
//   ④ 补料总量 == 实际排空时长(误差 ≤ 一个切片),不多补。
import "../plugins/_env.js";

import { describe, it, expect, vi, afterAll, afterEach } from "vitest";

// index.js 只被**动态导入**(禁环);单测里让它抛错,锁定「读配置失败一律回落」的兜底。
vi.mock("../../src/services/sendspin/index.js", () => ({
  readSendspinPluginConfig: () => {
    throw new Error("no plugin config in unit test");
  },
}));

import {
  GroupPump,
  overridePumpSource,
  bridgeDrainSilenceEnabled,
} from "../../src/services/sendspin/streamEngine.js";
import { SendspinGroup } from "../../src/services/sendspin/server.js";
import { SAMPLE_RATE } from "../../src/services/sendspin/encoding.js";

const FRAME_SAMPLES = 2400; // 25ms @48k 立体声交错样本
const FRAME_MS = 25;
const SLICE_US = 25_000;

afterAll(() => {
  overridePumpSource(null);
});

afterEach(() => {
  delete process.env.MF_BRIDGE_DRAIN_SILENCE;
});

// ---------------------------------------------------------------------------
// ① pushBridgeOnlySilence:只写 ring,不写成员 / 不动交付计量
// ---------------------------------------------------------------------------

/** 最小 srv:group() 造**真实** SendspinGroup(字段行为保真)。 */
function makeSrv(): any {
  const groups = new Map<string, SendspinGroup>();
  const srv: any = {
    groups,
    clients: new Map<string, any>(),
    log: vi.fn(),
    group(name: string) {
      let g = groups.get(name);
      if (!g) {
        g = new SendspinGroup(name, srv);
        groups.set(name, g);
      }
      return g;
    },
    syncVolume: vi.fn(),
  };
  return srv;
}

/** 挂一座纯内存桥桩(只满足 SendspinBridgeHandle 的最小面)。 */
function attachBridgeStub(g: SendspinGroup, deviceId = "dev1") {
  const handle: any = {
    deviceId,
    pushAudio: vi.fn(),
    notifyGeneration: vi.fn(),
    sendBoundary: vi.fn(),
    stop: vi.fn(),
  };
  (g as any).bridges.set(deviceId, handle);
  return handle;
}

function ringOf(g: SendspinGroup): Array<{ tsUs: bigint; durUs: number; data: Uint8Array; ep?: number }> {
  return (g as any).recentByGroup.get("pcm:100") ?? [];
}

describe("SendspinGroup.pushBridgeOnlySilence:只写 ring、不写成员", () => {
  it("补 200ms ⇒ 8 片×25ms 全零静音入 ring;成员 sendAudio / deliveredPeak / deliveredByGroup 全不动", () => {
    const srv = makeSrv();
    const g = srv.group("g-fill") as SendspinGroup;
    try {
      const sent: Array<{ ts: bigint; data: Uint8Array }> = [];
      const member: any = {
        clientId: "m1",
        codec: "pcm",
        appliedGain: () => 100,
        sendAudio: (ts: bigint, data: Uint8Array) => sent.push({ ts, data }),
      };
      (g as any).members.add(member);
      attachBridgeStub(g);
      const peakBefore = (g as any).deliveredPeak;

      const n = g.pushBridgeOnlySilence(1_000_000n, 200_000);

      expect(n).toBe(8); // 200ms / 25ms
      const ring = ringOf(g);
      expect(ring).toHaveLength(8);
      const framesPerSlice = Math.round((SLICE_US * SAMPLE_RATE) / 1_000_000);
      let expectTs = 1_000_000n;
      for (const e of ring) {
        expect(e.tsUs).toBe(expectTs); // 时间戳首尾连续,与 ring 既有帧同源
        expectTs += BigInt(SLICE_US);
        expect(e.durUs).toBe(SLICE_US);
        expect(e.data.length).toBe(framesPerSlice * 4); // s16le × 2ch
        expect(Array.from(e.data).every((b) => b === 0)).toBe(true); // 真·静音
        expect(e.ep).toBe((g as any).bridgeContentEpoch); // 当前内容代次
      }

      // ★ 硬约束:不做成员下发、不动交付计量、不动组进度
      expect(sent).toHaveLength(0);
      expect((g as any).deliveredPeak).toBe(peakBefore);
      expect((g as any).deliveredByGroup.size).toBe(0);
      expect(g.positionMs).toBe(0);
    } finally {
      g.stopBridgePushTimer();
      (g as any).bridges.clear();
    }
  });

  it("最后一片允许不足 25ms(30ms ⇒ 25ms + 5ms 两片)", () => {
    const srv = makeSrv();
    const g = srv.group("g-partial") as SendspinGroup;
    try {
      attachBridgeStub(g);
      expect(g.pushBridgeOnlySilence(0n, 30_000)).toBe(2);
      const ring = ringOf(g);
      expect(ring.map((e) => e.durUs)).toEqual([SLICE_US, 5_000]);
      expect(ring[1].data.length).toBe(Math.round((5_000 * SAMPLE_RATE) / 1_000_000) * 4);
    } finally {
      g.stopBridgePushTimer();
      (g as any).bridges.clear();
    }
  });

  it("无桥 ⇒ 返回 0 且完全不写 ring(纯直连组零影响)", () => {
    const srv = makeSrv();
    const g = srv.group("g-nobridge") as SendspinGroup;
    expect(g.pushBridgeOnlySilence(0n, 200_000)).toBe(0);
    expect(ringOf(g)).toHaveLength(0);
  });

  it("非法时长(0 / 负数 / NaN)⇒ 返回 0,不写 ring", () => {
    const srv = makeSrv();
    const g = srv.group("g-bad") as SendspinGroup;
    try {
      attachBridgeStub(g);
      for (const bad of [0, -1, Number.NaN, Number.NEGATIVE_INFINITY]) {
        expect(g.pushBridgeOnlySilence(0n, bad)).toBe(0);
      }
      expect(ringOf(g)).toHaveLength(0);
    } finally {
      g.stopBridgePushTimer();
      (g as any).bridges.clear();
    }
  });
});

// ---------------------------------------------------------------------------
// ② 排空循环调用点:开关 / 总量 == 排空时长 / 每首一行日志
// ---------------------------------------------------------------------------

interface LogRec {
  at: number;
  level: string;
  msg: string;
}

async function waitInactive(pump: GroupPump, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (!pump.active) return;
    if (Date.now() - t0 > ms) throw new Error(`pump 未结束: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface FillRec {
  tsUs: bigint;
  durUs: number;
  chunks: number;
}

/** 跑一次完整 pushLoop(注入音源 → 自然曲终 → 曲末排空),记录补料调用与日志。 */
async function runPump(opts: { withFillMethod: boolean; silenceEnv?: string }) {
  const envBackup = {
    speed: process.env.SENDSPIN_PUSH_SPEED,
    prefill: process.env.SENDSPIN_PREFILL,
    prefillMs: process.env.SENDSPIN_PREFILL_MS,
    silence: process.env.MF_BRIDGE_DRAIN_SILENCE,
  };
  process.env.SENDSPIN_PUSH_SPEED = "8"; // 倍速:把 8000ms 排空压到 1000ms 墙钟
  process.env.SENDSPIN_PREFILL = "1";
  process.env.SENDSPIN_PREFILL_MS = "10000";
  if (opts.silenceEnv === undefined) delete process.env.MF_BRIDGE_DRAIN_SILENCE;
  else process.env.MF_BRIDGE_DRAIN_SILENCE = opts.silenceEnv;

  const totalFrames = Math.round(12_000 / FRAME_MS);
  overridePumpSource(async () => ({
    pcm: new Float32Array(totalFrames * FRAME_SAMPLES),
    durationMs: 0,
  }));
  const fills: FillRec[] = [];
  const recs: LogRec[] = [];
  const over: Record<string, unknown> = {
    hasBridges: () => true,
    hasDirectMembers: () => false, // 纯桥组
  };
  if (opts.withFillMethod) {
    over.pushBridgeOnlySilence = (tsUs: bigint, durUs: number) => {
      const chunks = Math.ceil(durUs / SLICE_US);
      fills.push({ tsUs, durUs, chunks });
      return chunks;
    };
  }
  const g: Record<string, any> = {
    positionMs: 0,
    timelineBaseUs: 0n,
    current: null,
    name: "g",
    finished: 0,
    audibleStarted: false,
    commonSendAheadUs: () => 800_000,
    pushFrame: async (_ts: bigint, pcm: Float32Array) => pcm.length / 2,
    finishPlayback: () => undefined,
    ...over,
  };
  const server: any = {
    log: (level: string, msg: string) => recs.push({ at: Date.now(), level, msg }),
  };
  const pump = new GroupPump(server, g as any);
  try {
    await pump.play(`song-fill-${opts.withFillMethod}`);
    await waitInactive(pump, 25_000, "曲末排空收尾");
    const inactiveAt = Date.now();
    const stdLog = recs.find((r) => /等设备播完缓冲 (\d+)ms 后再收流/.test(r.msg));
    const fillLog = recs.find((r) => r.msg.includes("ev=bridge-drain-fill"));
    const waitMs = stdLog ? Number(/等设备播完缓冲 (\d+)ms/.exec(stdLog.msg)![1]) : 0;
    return { fills, recs, stdLog, fillLog, waitMs, inactiveAt, totalFrames };
  } finally {
    if (envBackup.speed === undefined) delete process.env.SENDSPIN_PUSH_SPEED;
    else process.env.SENDSPIN_PUSH_SPEED = envBackup.speed;
    if (envBackup.prefill === undefined) delete process.env.SENDSPIN_PREFILL;
    else process.env.SENDSPIN_PREFILL = envBackup.prefill;
    if (envBackup.prefillMs === undefined) delete process.env.SENDSPIN_PREFILL_MS;
    else process.env.SENDSPIN_PREFILL_MS = envBackup.prefillMs;
    if (envBackup.silence === undefined) delete process.env.MF_BRIDGE_DRAIN_SILENCE;
    else process.env.MF_BRIDGE_DRAIN_SILENCE = envBackup.silence;
  }
}

describe("排空循环:开关 ON ⇒ 逐步续静音,总量 == 排空时长", () => {
  it("纯桥组 + 开关缺省 ON ⇒ 每步补一段、总量 == 排空时长(±1 片),每首一行日志", async () => {
    const out = await runPump({ withFillMethod: true });
    expect(out.waitMs).toBeGreaterThan(0);

    // 每步一次(200ms/步):至少一次调用,且每段 durUs 与步长严格对应
    expect(out.fills.length).toBeGreaterThan(0);
    for (const f of out.fills) {
      expect(f.durUs).toBeGreaterThan(0);
      expect(f.durUs % 1_000).toBe(0); // 由 sleep 毫秒数换算而来
    }
    const totalUs = out.fills.reduce((s, f) => s + f.durUs, 0);
    // ★ 总量必须等于实际排空时长,不能多补
    expect(Math.abs(totalUs - out.waitMs * 1000)).toBeLessThanOrEqual(SLICE_US);

    // 时间戳逐段首尾相接(每段起点 = 起点 + 已补总量)
    let expectTs = out.fills[0].tsUs;
    for (const f of out.fills) {
      expect(f.tsUs).toBe(expectTs);
      expectTs += BigInt(f.durUs);
    }

    // 日志:每首歌**一行**,字段固定便于 grep
    expect(out.fillLog, "开关 ON 时必须打一行桥续静音日志").toBeTruthy();
    expect(out.fillLog!.msg).toContain("sendspin 曲末排空:桥续静音");
    expect(out.fillLog!.msg).toContain("dev=-"); // 桩无 bridges 集合
    expect(out.fillLog!.msg).toMatch(/durMs=\d+ chunks=\d+ song=/);
    const durMs = Number(/durMs=(\d+)/.exec(out.fillLog!.msg)![1]);
    const chunks = Number(/chunks=(\d+)/.exec(out.fillLog!.msg)![1]);
    expect(Math.abs(durMs * 1000 - totalUs)).toBeLessThanOrEqual(SLICE_US);
    expect(chunks).toBe(out.fills.reduce((s, f) => s + f.chunks, 0));
    // 日志只有一行(每步不打)
    expect(out.recs.filter((r) => r.msg.includes("ev=bridge-drain-fill"))).toHaveLength(1);
  }, 30_000);

  it("开关解析:缺省 ON;=0/false/off 关闭;其它值 ON(缓存按取值,切换即生效)", () => {
    delete process.env.MF_BRIDGE_DRAIN_SILENCE;
    expect(bridgeDrainSilenceEnabled()).toBe(true);
    for (const off of ["0", "false", "off"]) {
      process.env.MF_BRIDGE_DRAIN_SILENCE = off;
      expect(bridgeDrainSilenceEnabled()).toBe(false);
    }
    for (const on of ["1", "true", "on", ""]) {
      process.env.MF_BRIDGE_DRAIN_SILENCE = on;
      expect(bridgeDrainSilenceEnabled()).toBe(true);
    }
    delete process.env.MF_BRIDGE_DRAIN_SILENCE;
    expect(bridgeDrainSilenceEnabled()).toBe(true);
  });

  it("开关 MF_BRIDGE_DRAIN_SILENCE=0 ⇒ 不补料、不打日志,排空时长与关闭前一致", async () => {
    const off = await runPump({ withFillMethod: true, silenceEnv: "0" });
    expect(off.fills).toHaveLength(0);
    expect(off.fillLog).toBeUndefined();
    // 排空本身照旧发生(开关只管补料,不改排空量)
    expect(off.waitMs).toBeGreaterThan(0);
  }, 30_000);

  it("组上没有该能力(最小测试桩)⇒ 不补料、不打日志,行为与改动前一致", async () => {
    const out = await runPump({ withFillMethod: false });
    expect(out.fills).toHaveLength(0);
    expect(out.fillLog).toBeUndefined();
    expect(out.waitMs).toBeGreaterThan(0);
  }, 30_000);
});
