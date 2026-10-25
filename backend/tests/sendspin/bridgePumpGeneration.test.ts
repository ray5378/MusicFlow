// ==================== Phase 3:流代次混合公式 + 重锚钩子(唯一落点,BLK-02)+ 桥 lead 绕过 ====================
//
// 钉死三条(§4.3/MAJ-01):
//   ① generation = epoch * 1_000_003 + timelineReseed —— 乘法混合防撞和:
//      「epoch + reseed」在两者交替自增时会撞出同一个和(1,1 与 2,0 都得 2);
//      1_000_003 是大于 timelineReseed 实际取值范围的质数。
//   ② 重锚分支(firstFrame || timelineReseed !== consumedReseed)是桥代次钩子的
//      **唯一落点**(BLK-02:不新增 bridgeTimelineReset,g.close() 不清桥):
//      首帧 → BOUNDARY{track};reseed → BOUNDARY{rehost};3 次重锚代次严格单调推进。
//   ③ 桥在场绕过 800ms 预填充钳制:锚点 lead ≥ bridgeStartLeadUs(cold)=4.5s,
//      且 commonSendAheadUs **一字不动**(MAJ-01:桥 lead 绝不并进组公共提前量,
//      否则真实 ESP32 恒定 +3.7s 偏移)。
//
// determinism:PcmWindow.slice() 挂起直到测试显式放行(与 lt1_streamEngineStreamingGaps
// 同款夹具)—— 放一帧走一拍,重锚分支逐拍可观测,不碰真 ffmpeg / 网络 / 曲库。
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const H = vi.hoisted(() => ({
  rows: [] as any[],
  readyImpl: (() => Promise.resolve()) as () => Promise<any>,
  instances: [] as any[],
  sliceWaits: [] as Array<(v: Float32Array) => void>,
  resolveInput: { input: "https://example.invalid/a.flac" } as any,
}));

vi.mock("../../src/services/source/resolveAudio.js", () => ({
  resolvePlayableRow: async () => ({ row: H.rows.shift(), reason: "ok" }),
  fetchRowBytes: async () => null,
  resolveRowInput: () => H.resolveInput,
}));

vi.mock("../../src/services/audio/pipeline.js", () => ({
  resolvePipelineInput: async (d: any) => d,
}));

vi.mock("../../src/services/playerDsp.js", () => ({
  playerDspFilters: () => [],
}));

vi.mock("../../src/services/sendspin/streamSource.js", () => {
  class WindowEvictedError extends Error {}
  class PcmWindow {
    baseMs = 0;
    pid = 4242;
    eof = false;
    failedReason: string | null = null;
    decoded = 0;
    closed = false;
    opts: any;
    startMs: number;
    constructor(opts: any, startMs: number) {
      this.opts = opts;
      this.startMs = startMs;
      H.instances.push(this);
    }
    ready(): Promise<void> {
      return H.readyImpl();
    }
    close(): void {
      this.closed = true;
    }
    /** 挂起直到测试显式放行 —— 让 pushLoop 停在下一帧取数前,逐拍观察重锚。 */
    slice(): Promise<Float32Array> {
      return new Promise<Float32Array>((res) => H.sliceWaits.push(res));
    }
    stderrText(): string {
      return "";
    }
  }
  return { PcmWindow, WindowEvictedError, WINDOW_HIGH_SEC: 300 };
});

import { GroupPump } from "../../src/services/sendspin/streamEngine.js";
import { nowUs } from "../../src/services/sendspin/clock.js";
import { bridgeStartLeadUs } from "../../src/services/airplay/bridgeMath.js";

const server = { log: () => {} } as any;

const ENV = {
  SENDSPIN_PREFILL: process.env.SENDSPIN_PREFILL,
  SENDSPIN_PUSH_SPEED: process.env.SENDSPIN_PUSH_SPEED,
};

/** 组桩:桥相关的三个观测面(hasBridges / notifyBridgeGeneration / bridgeSpecs)+ 泵要读的面。 */
function makeGroup(overrides: Record<string, unknown> = {}) {
  const genCalls: Array<[number, string]> = [];
  const g: any = {
    name: "g",
    id: "g",
    positionMs: 0,
    timelineBaseUs: 0n,
    current: null,
    finished: 0,
    members: new Set<any>(),
    bridgeSpecs: [],
    hasBridges: () => false,
    notifyBridgeGeneration: (gen: number, reason: string) => {
      genCalls.push([gen, reason]);
    },
    commonSendAheadUs: () => 800_000,
    capacityLimitedPrefillMs: () => 3_000,
    resetPushMeter: () => {},
    pushFrame: async () => 480,
    finishPlayback: () => {
      g.finished++;
    },
    close: () => {},
    ...overrides,
  };
  return { g, genCalls };
}


/** 放行一拍 slice(非空数据帧 —— 空片 = EOF,pushLoop 会直接收尾)。 */
const FRAME_DATA = new Float32Array(4800);
const releaseOne = (): void => {
  const r = H.sliceWaits.shift();
  if (r) r(FRAME_DATA);
};

/** 放行所有挂起的 slice(返回空片 = 流提前 EOF,pushLoop 收尾退出)。 */
const releaseSlices = (): void => {
  for (const r of H.sliceWaits.splice(0)) r(new Float32Array(0));
};

const waitSlices = async (n: number, timeoutMs = 5000): Promise<void> => {
  const t0 = Date.now();
  while (H.sliceWaits.length < n) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`slice 未挂起(等 ${n} 个)`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

const waitGen = async (genCalls: Array<[number, string]>, n: number, timeoutMs = 5000): Promise<void> => {
  const t0 = Date.now();
  while (genCalls.length < n) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`重锚未发生(等第 ${n} 拍,现有 ${genCalls.length})`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

async function waitInactive(pump: GroupPump, ms: number): Promise<void> {
  const t0 = Date.now();
  while (pump.active) {
    if (Date.now() - t0 > ms) throw new Error("pump 未结束");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeEach(() => {
  process.env.SENDSPIN_PREFILL = "0"; // 非 prefill 路径:lead = commonSendAheadUs = 800ms
  process.env.SENDSPIN_PUSH_SPEED = "100"; // pacing 延迟归零,纯确定性
  H.rows = [];
  H.instances = [];
  H.sliceWaits = [];
  H.readyImpl = () => Promise.resolve();
});

afterEach(async () => {
  releaseSlices();
  for (const [k, v] of Object.entries(ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("① generation 乘法混合公式", () => {
  it("generation = epoch * 1_000_003 + timelineReseed", () => {
    const { g } = makeGroup();
    const pump = new GroupPump(server, g);
    const p = pump as any;
    p.epoch = 0; p.timelineReseed = 0;
    expect(pump.generation).toBe(0);
    p.epoch = 1; p.timelineReseed = 0;
    expect(pump.generation).toBe(1_000_003);
    p.epoch = 1; p.timelineReseed = 7;
    expect(pump.generation).toBe(1_000_010);
    p.epoch = 2; p.timelineReseed = 0;
    expect(pump.generation).toBe(2_000_006);
  });

  it("防撞和:epoch 间隔(1_000_003)覆盖 reseed 实际取值范围,不同 (epoch,reseed) 不撞值", () => {
    const { g } = makeGroup();
    const pump = new GroupPump(server, g);
    const p = pump as any;
    const seen = new Set<number>();
    for (let e = 0; e < 3; e++) {
      for (let r = 0; r <= 999_999; r += 111_111) {
        p.epoch = e;
        p.timelineReseed = r;
        seen.add(pump.generation);
      }
    }
    // 3 epoch × 10 reseed = 30 个全不相同的值(加法混合在这里会撞出重复)
    expect(seen.size).toBe(30);
  });
});

describe("② 重锚钩子:唯一落点(BLK-02)", () => {
  it("首帧 → notifyBridgeGeneration(gen, 'track'),非 prefill 路径 lead = 800ms(行为零变化)", async () => {
    H.rows = [{ id: "row-1", duration: 10 }];
    const { g, genCalls } = makeGroup();
    const pump = new GroupPump(server, g);
    await pump.play("song-a");
    await waitSlices(1); // pushLoop 停在首帧取数前
    releaseOne(); // 放一帧 → firstFrame 重锚
    await waitGen(genCalls, 1);

    // play() 起播先把 epoch 自增到 1(新流 = 新代次)→ 首帧 gen = 1*1_000_003 + 0
    expect(genCalls[0]).toEqual([1_000_003, "track"]);
    const leadUs = Number(g.timelineBaseUs - nowUs()); // 与锚点同源的单调钟
    expect(leadUs).toBeGreaterThan(500_000); // ≥800ms(扣观测时刻噪声)
    expect(leadUs).toBeLessThan(3_000_000); // <3s:不是 reseed lead,更不是桥 cold lead
    releaseSlices(); // EOF 收尾
    await waitInactive(pump, 5000);
  }, 30_000);

  it("timelineReseed 自增 → 下一拍 notifyBridgeGeneration(gen+1, 'rehost'),代次严格单调", async () => {
    H.rows = [{ id: "row-2", duration: 10 }];
    const { g, genCalls } = makeGroup();
    const pump = new GroupPump(server, g);
    await pump.play("song-b");
    await waitSlices(1);
    releaseOne();
    await waitGen(genCalls, 1); // 首帧 track

    (pump as any).timelineReseed += 1; // 泵移交(rehost)写入的状态变化
    releaseOne(); // 下一帧 → 重锚(reseed 路径)
    await waitGen(genCalls, 2);
    expect(genCalls[1]).toEqual([1_000_004, "rehost"]); // reseed 0→1
    expect(genCalls[1]![0]).toBeGreaterThan(genCalls[0]![0]);
    releaseSlices(); // EOF 收尾
    await waitInactive(pump, 5000);
  }, 30_000);

  it("机械判据:连续 3 次重锚 → 代次逐拍 +1、reason 全为 rehost", async () => {
    H.rows = [{ id: "row-3", duration: 10 }];
    const { g, genCalls } = makeGroup();
    const pump = new GroupPump(server, g);
    await pump.play("song-c");
    await waitSlices(1);
    releaseOne();
    await waitGen(genCalls, 1);

    for (let i = 0; i < 3; i++) {
      (pump as any).timelineReseed += 1;
      releaseOne();
      await waitGen(genCalls, 2 + i);
    }
    expect(genCalls).toHaveLength(4); // track + 3 × rehost
    for (let i = 1; i < genCalls.length; i++) {
      expect(genCalls[i]![0]).toBe(genCalls[i - 1]![0] + 1);
      expect(genCalls[i]![1]).toBe("rehost");
    }
    releaseSlices(); // EOF 收尾
    await waitInactive(pump, 5000);
  }, 30_000);
});

describe("③ 桥在场绕过 800ms 钳制(MAJ-01)", () => {
  it("hasBridges()=true → 首帧 lead ≥ bridgeStartLeadUs(cold)=4.5s,commonSendAheadUs 一字不动", async () => {
    H.rows = [{ id: "row-4", duration: 10 }];
    const csa = () => 800_000;
    const { g, genCalls } = makeGroup({ hasBridges: () => true, commonSendAheadUs: csa });
    const pump = new GroupPump(server, g);
    await pump.play("song-d");
    await waitSlices(1);
    releaseOne();
    await waitGen(genCalls, 1);

    expect(genCalls[0]).toEqual([1_000_003, "track"]);
    const leadUs = Number(g.timelineBaseUs - nowUs()); // 与锚点同源的单调钟
    // 桥 cold lead = 4.5s:既压过 800ms 的 prefill 钳制,也压过 3s 的 reseed lead
    expect(leadUs).toBeGreaterThanOrEqual(bridgeStartLeadUs([{ warm: false }]) - 1_000_000);
    expect(leadUs).toBeGreaterThan(3_500_000);
    // MAJ-01 回归断言:组公共提前量没有被污染 —— 同一个函数、同一个返回值
    expect(g.commonSendAheadUs).toBe(csa);
    expect(g.commonSendAheadUs()).toBe(800_000);
    releaseSlices(); // EOF 收尾
    await waitInactive(pump, 5000);
  }, 30_000);
});
