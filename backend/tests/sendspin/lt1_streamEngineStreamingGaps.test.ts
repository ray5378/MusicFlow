// streamEngine.ts 覆盖率补口:流式音源工厂(streamingSource)的**预缓冲失败收口**与时长缺省。
//
// 缺口背景:defaultSource → isStreamSource() 为真时走 streamingSource:解析行 → ffmpeg
// 输入 → new PcmWindow → `await window.ready()`。两条从未被测的收口:
//   1) ready() 失败(ffmpeg 起不来/输入 404)→ 必须 **close() 掉刚建的窗口再抛**,
//      否则进程/句柄泄漏 —— 而这里每首歌都会走一次,泄漏会线性累积;
//   2) 行的时长元数据缺失/非法 → durationMs 必须回落 **0**(=时长未知),
//      而不是 NaN/undefined —— NaN 会让进度钳制与帧栅格全线失效。
//
// 隔离:source/resolveAudio、audio/pipeline、streamSource(PcmWindow) 全部替身,
// 不碰真 ffmpeg / 网络;playerDsp 也替身(音色不是本文件要测的东西)。
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
    /** 挂起直到测试显式放行 —— 让 pushLoop 停在首帧取数前,便于观察起播瞬间的组状态。 */
    slice(): Promise<Float32Array> {
      return new Promise<Float32Array>((res) => H.sliceWaits.push(res));
    }
    stderrText(): string {
      return "";
    }
  }
  return { PcmWindow, WindowEvictedError };
});

import { GroupPump, overridePumpSource } from "../../src/services/sendspin/streamEngine.js";

function makeGroup() {
  const g: any = {
    name: "g",
    positionMs: 0,
    timelineBaseUs: 0n,
    current: null,
    finished: 0,
    commonSendAheadUs: () => 800_000,
    pushFrame: async (_ts: bigint, pcm: Float32Array) => pcm.length / 2,
    finishPlayback: () => {
      g.finished++;
    },
  };
  return g;
}
const server = { log: () => {} } as any;

const ENV = {
  SENDSPIN_STREAM_SOURCE: process.env.SENDSPIN_STREAM_SOURCE,
  SENDSPIN_PREFILL: process.env.SENDSPIN_PREFILL,
  SENDSPIN_PUSH_SPEED: process.env.SENDSPIN_PUSH_SPEED,
};

/** 放行所有挂起的 slice(返回空片 = 流提前 EOF,pushLoop 收尾退出)。 */
const releaseSlices = (): void => {
  for (const r of H.sliceWaits.splice(0)) r(new Float32Array(0));
};

beforeEach(() => {
  process.env.SENDSPIN_STREAM_SOURCE = "1";
  process.env.SENDSPIN_PREFILL = "0";
  process.env.SENDSPIN_PUSH_SPEED = "100";
  H.rows = [];
  H.instances = [];
  H.sliceWaits = [];
  H.readyImpl = () => Promise.resolve();
});

afterEach(() => {
  releaseSlices();
  overridePumpSource(null);
  for (const [k, v] of Object.entries(ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function waitInactive(pump: GroupPump, ms: number): Promise<void> {
  const t0 = Date.now();
  while (pump.active) {
    if (Date.now() - t0 > ms) throw new Error("pump 未结束");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("streamingSource:预缓冲失败必须释放窗口再抛", () => {
  it("ready() 拒绝 → play() 抛出,且刚建的 PcmWindow 已 close(不泄漏 ffmpeg)", async () => {
    H.rows = [{ id: "row-1", duration: 10 }];
    H.readyImpl = () => Promise.reject(new Error("ffmpeg spawn failed"));
    const g = makeGroup();
    const pump = new GroupPump(server, g);
    // 契约:预缓冲失败即整段起播失败;窗口必须被就地关闭,否则每首歌泄漏一个解码进程。
    await expect(pump.play("song-a")).rejects.toThrow("ffmpeg spawn failed");
    expect(H.instances).toHaveLength(1);
    expect(H.instances[0].closed).toBe(true);
    // 声源行 id 与 ffmpeg 输入都被正确透传(排障依据)
    expect(H.instances[0].opts.rowId).toBe("row-1");
    expect(H.instances[0].opts.input).toBe("https://example.invalid/a.flac");
  }, 30_000);
});

describe("streamingSource:时长缺省", () => {
  it("行带合法时长 → durationMs = round(秒×1000)", async () => {
    H.rows = [{ id: "row-2", duration: 12.5 }];
    const g = makeGroup();
    const pump = new GroupPump(server, g);
    await pump.play("song-b");
    // pushLoop 挂在首次 slice 上,此刻 current 已落位 → 可观察起播时长。
    expect(g.current?.durationMs).toBe(12500);
    releaseSlices();
    await waitInactive(pump, 5000);
  }, 30_000);

  it("行缺时长 → durationMs 回落 0(=未知),绝不是 NaN", async () => {
    H.rows = [{ id: "row-3" }];
    const g = makeGroup();
    const pump = new GroupPump(server, g);
    await pump.play("song-c");
    // 契约:未知时长必须是 0;NaN 会污染进度钳制/帧栅格,导致时间线塌陷。
    expect(g.current?.durationMs).toBe(0);
    expect(Number.isNaN(g.current?.durationMs)).toBe(false);
    releaseSlices();
    await waitInactive(pump, 5000);
  }, 30_000);

  it("负时长同样回落 0(元数据给垃圾值时不得当有效时长)", async () => {
    H.rows = [{ id: "row-4", duration: -3 }];
    const g = makeGroup();
    const pump = new GroupPump(server, g);
    await pump.play("song-d");
    expect(g.current?.durationMs).toBe(0);
    releaseSlices();
    await waitInactive(pump, 5000);
  }, 30_000);
});
