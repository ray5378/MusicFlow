// ==================== 推流侧判死 → 回传口（第六参数链路，2026-10-28 事故） ====================
//
// 根因 1 的**上游半段**：子进程怎么把「这首歌判死了」交出去。
// 修法走 playCore 的 `bridge?` 同款范式 —— 末尾可选参数 `onUnplayable?`，经
// `pumpFor(server, group, sink)` 装填到 GroupPump 实例上，判死那一拍回调。
//
// 本文件钉死：
//   ① pumpFor 装填/沿用语义（不传 = 不动泵上已有的，seek 重建路径靠它保持回传口）；
//   ② 真实 stream-truncated 判死 ⇒ 回传口收到 (songId, reason)，reason 带期望/实际秒数；
//   ③ 未装填回传口时判死不抛（既有 streamTruncate.test.ts 契约不变）；
//   ④ 回传口自己抛错不影响收尾（本地 markUnplayable 照旧）。
//
// 全部用 overridePumpSource 注入假窗口 + 最小 stub group：不碰曲库、不起 ffmpeg、不发网络。
import { describe, it, expect, vi, afterAll, beforeEach, afterEach } from "vitest";

/** 子进程本地负缓存的落地记录（判死这一拍照旧要写）。 */
const dead = vi.hoisted(() => [] as string[]);
vi.mock("../../src/services/source/online/streamFallback.js", () => ({
  markUnplayable: (songId: string) => {
    dead.push(songId);
  },
  getCachedPlayability: () => "unknown",
}));

// 插件配置在单测里读不到（与 streamEngineGaps.test.ts / streamTruncate.test.ts 同款兜底）。
vi.mock("../../src/services/sendspin/index.js", () => ({
  readSendspinPluginConfig: () => {
    throw new Error("no plugin config in unit test");
  },
}));

import {
  GroupPump,
  overridePumpSource,
  pumpFor,
  peekPump,
  stopGroupPump,
} from "../../src/services/sendspin/streamEngine.js";

const FRAME_SAMPLES = 2400; // 25ms @48k 立体声交错样本
const SPOOK = (sec: number) => Math.floor(sec * 48_000 * 2);

afterAll(() => {
  overridePumpSource(null);
});

const ENV_KEYS = ["SENDSPIN_PUSH_SPEED", "SENDSPIN_PREFILL", "AP2_TRUNCATE_MISSING_SEC"] as const;
let envSaved: Record<string, string | undefined> = {};
beforeEach(() => {
  envSaved = {};
  for (const k of ENV_KEYS) envSaved[k] = process.env[k];
  process.env.SENDSPIN_PUSH_SPEED = "200"; // 推流节奏加速，别真等 30s
  process.env.SENDSPIN_PREFILL = "0"; // 关曲末排空
  delete process.env.AP2_TRUNCATE_MISSING_SEC;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSaved[k] === undefined) delete process.env[k];
    else process.env[k] = envSaved[k];
  }
  dead.length = 0;
});

function fakeWindow(opts: { decoded: number; frames: number }) {
  let n = 0;
  return {
    baseMs: 0,
    decoded: opts.decoded,
    eof: true,
    failedReason: null,
    pid: 1,
    stderrText: () => "",
    async slice() {
      n++;
      if (n <= opts.frames) return new Float32Array(FRAME_SAMPLES).fill(0.01);
      return new Float32Array(0); // 窗口提前 EOF
    },
  } as any;
}

function makeGroup(name = "g") {
  const g: any = {
    positionMs: 0,
    timelineBaseUs: 0n,
    current: null,
    name,
    finished: 0,
    commonSendAheadUs: () => 800_000,
    pushFrame: async (_ts: bigint, pcm: Float32Array) => pcm.length / 2,
    finishPlayback: () => {
      g.finished++;
    },
  };
  return g;
}

function makeServer(logs: string[]) {
  return { log: (_level: string, msg: string) => logs.push(msg) } as any;
}

async function waitInactive(pump: GroupPump, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (!pump.active) return;
    if (Date.now() - t0 > ms) throw new Error(`pump 未结束: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 声明 276s、只交付 30s 的截断源。 */
function armTruncatedSource(): void {
  overridePumpSource(async () => ({
    pcm: new Float32Array(0),
    durationMs: 276_000,
    stream: fakeWindow({ decoded: SPOOK(30), frames: 3 }),
  }));
}

describe("判死回传口（pumpFor 装填 + 判死那一拍回调）", () => {
  it("① pumpFor 装填回传口；不传 = 沿用泵上已有的（seek 重建路径靠它保持）", () => {
    const g = makeGroup("g-sink-1");
    const srv = makeServer([]);
    const sink = vi.fn();
    const p1 = pumpFor(srv, g, sink);
    expect(p1.onUnplayable).toBe(sink);

    const p2 = pumpFor(srv, g); // 不传 ⇒ 不动既有回传口
    expect(p2).toBe(p1); // 组内复用同一个泵（WeakMap 池）
    expect(p2.onUnplayable).toBe(sink);

    const sink2 = vi.fn();
    pumpFor(srv, g, sink2); // 新起播 ⇒ 换成新的
    expect(pumpFor(srv, g).onUnplayable).toBe(sink2);
    expect(peekPump(g)).toBe(p1);
    stopGroupPump(g);
  });

  it("② 截断判死 ⇒ 回传口收到 (songId, reason)，reason 带期望/实际秒数", async () => {
    armTruncatedSource();
    const logs: string[] = [];
    const g = makeGroup("g-sink-2");
    const sink = vi.fn();
    const pump = pumpFor(makeServer(logs), g, sink);
    await pump.play("song-clip");
    await waitInactive(pump, 20000, "截断回传");

    expect(sink).toHaveBeenCalledTimes(1);
    const [songId, reason] = sink.mock.calls[0] as [string, string];
    expect(songId).toBe("song-clip");
    expect(reason).toContain("stream-truncated");
    expect(reason).toContain("期望276s");
    expect(reason).toContain("实际30s");
    // 子进程本地那一份照旧要写（出流换源/队列判跳在子进程内也读它）
    expect(dead).toEqual(["song-clip"]);
    stopGroupPump(g);
  }, 40_000);

  it("③ 未装填回传口 ⇒ 判死不抛，本地 markUnplayable 照旧，但**必须报警**（绝不静默吞掉判死）", async () => {
    // 🔴 最危险的失败模式：子进程判死了、回传口是空的、什么都没发生 ⇒ 主进程永远不知道，
    //    2026-10-28 事故原样复现。所以未装填时**必须**打一条 warn（每首最多一次）。
    armTruncatedSource();
    const logs: string[] = [];
    const g = makeGroup("g-sink-3");
    const pump = pumpFor(makeServer(logs), g); // 不传 sink
    expect(pump.onUnplayable).toBeNull();
    await pump.play("song-no-sink");
    await waitInactive(pump, 20000, "无回传口判死");

    expect(dead).toEqual(["song-no-sink"]);
    expect(logs.some((m) => m.includes("ev=stream-truncated"))).toBe(true);
    expect(logs.some((m) => m.includes("判死回传口未装填"))).toBe(true);
    stopGroupPump(g);
  }, 40_000);

  it("③ 同一首反复播 ⇒ 未装填告警每首最多一条（不刷屏）", async () => {
    armTruncatedSource();
    const logs: string[] = [];
    const g = makeGroup("g-sink-3b");
    pumpFor(makeServer(logs), g); // 不传 sink
    const pump = pumpFor(makeServer(logs), g);
    await pump.play("song-no-sink-2");
    await waitInactive(pump, 20000, "第一次");
    await pump.play("song-no-sink-2");
    await waitInactive(pump, 20000, "第二次");
    const warns = logs.filter((m) => m.includes("判死回传口未装填"));
    expect(warns).toHaveLength(1);
    stopGroupPump(g);
  }, 40_000);

  it("④ 回传口自己抛错 ⇒ 吞掉，收尾不受影响（本地负缓存已写 + 无未捕获异常）", async () => {
    armTruncatedSource();
    const logs: string[] = [];
    const g = makeGroup("g-sink-4");
    const pump = pumpFor(makeServer(logs), g, () => {
      throw new Error("sink boom");
    });
    await pump.play("song-sink-throws");
    await waitInactive(pump, 20000, "回传口抛错");

    expect(dead).toEqual(["song-sink-throws"]);
    expect(logs.some((m) => m.includes("ev=stream-truncated"))).toBe(true);
    expect(logs.some((m) => m.includes("判死回传失败"))).toBe(true);
    stopGroupPump(g);
  }, 40_000);
});
