// ==================== 流式窗口「提前 EOF」判据守卫（2026-10-27 240 生产事故） ====================
//
// 事故：插件源声明 276s，实际只吐出 ~30s（5,762,400B ÷ 192,000B/s）就 EOF。流式窗口路径
// 把 `contentEnded=true / endReason="stream-eof"` 直接当自然播完 → auto-advance →
// 单曲循环回到同一首 → 每 30s 重播一次。
//
// 本文件锁住补上的判据：
//   ① 交付 30s vs 声明 276s ⇒ 判 truncated + markUnplayable 被调 + 结构化 warn；
//   ② 交付 270s vs 276s（差 6s ≤ 80s）⇒ 不判（正常曲目一个字节都不改）；
//   ③ endReason 非 stream-eof（整包解码耗尽）⇒ 不判；
//   ④ 声明 0（时长未知）⇒ 不判；
//   ⑤ endedNaturally=false 但 contentEnded 语义不变（过渡复位照常：current 置空）。
//
// 全部用 overridePumpSource 注入假窗口 + 最小 stub group：不碰 DB 里的曲库、不起 ffmpeg、
// 不发网络。markUnplayable 用 vi.mock 抓调用。
import "../plugins/_env.js";

import { describe, it, expect, vi, afterAll, beforeEach, afterEach } from "vitest";

/** markUnplayable 的落地记录（判死是否被写进负缓存）。 */
const dead = vi.hoisted(() => [] as string[]);
vi.mock("../../src/services/source/online/streamFallback.js", () => ({
  markUnplayable: (songId: string) => {
    dead.push(songId);
  },
  getCachedPlayability: () => "unknown",
}));

// 插件配置在单测里读不到（与 streamEngineGaps.test.ts 同款兜底：全部回落默认值）。
vi.mock("../../src/services/sendspin/index.js", () => ({
  readSendspinPluginConfig: () => {
    throw new Error("no plugin config in unit test");
  },
}));

import { GroupPump, overridePumpSource } from "../../src/services/sendspin/streamEngine.js";

const FRAME_SAMPLES = 2400; // 25ms @48k 立体声交错样本
const SPOOK = (sec: number) => Math.floor(sec * 48_000 * 2); // 交错样本数

afterAll(() => {
  overridePumpSource(null);
});

/** 覆盖本文件用到的环境变量，afterEach 还原（避免污染同进程的其它文件）。 */
const ENV_KEYS = ["SENDSPIN_PUSH_SPEED", "SENDSPIN_PREFILL", "AP2_TRUNCATE_MISSING_SEC"] as const;
let envSaved: Record<string, string | undefined> = {};
beforeEach(() => {
  envSaved = {};
  for (const k of ENV_KEYS) envSaved[k] = process.env[k];
  process.env.SENDSPIN_PUSH_SPEED = "200"; // 推流节奏加速，别真等 30s
  process.env.SENDSPIN_PREFILL = "0"; // 关曲末排空，避免真等缓冲
  delete process.env.AP2_TRUNCATE_MISSING_SEC;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSaved[k] === undefined) delete process.env[k];
    else process.env[k] = envSaved[k];
  }
  dead.length = 0;
});

/** 假流式窗口：`decoded` 是本轮累计解出的交错样本数（交付时长的第一口径）。 */
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

function makeGroup(over: any = {}) {
  const g: any = {
    positionMs: 0,
    timelineBaseUs: 0n,
    current: null,
    name: "g",
    finished: 0,
    commonSendAheadUs: () => 800_000,
    pushFrame: async (_ts: bigint, pcm: Float32Array) => pcm.length / 2,
    finishPlayback: () => {
      g.finished++;
    },
    ...over,
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

describe("streamEngine 提前 EOF 判据", () => {
  it("交付 30s vs 声明 276s ⇒ 判 truncated + markUnplayable + 结构化 warn", async () => {
    overridePumpSource(async () => ({
      pcm: new Float32Array(0),
      durationMs: 276_000,
      stream: fakeWindow({ decoded: SPOOK(30), frames: 3 }),
    }));
    const logs: string[] = [];
    const g = makeGroup();
    const pump = new GroupPump(makeServer(logs), g);
    await pump.play("song-truncated");
    await waitInactive(pump, 15000, "截断判死");

    expect(dead).toEqual(["song-truncated"]); // 负缓存已写（出流换源/队列判跳都读它）
    const line = logs.find((m) => m.includes("ev=stream-truncated"));
    expect(line).toBeTruthy();
    expect(line).toContain("song=song-truncated");
    expect(line).toContain("expectedSec=276");
    expect(line).toContain("deliveredSec=30");
    expect(line).toContain("missingSec=246");
    expect(line).toContain("endReason=stream-eof");
  }, 30_000);

  it("交付 270s vs 声明 276s（差 6s ≤ 80s）⇒ 不判，走原自然播完路径", async () => {
    overridePumpSource(async () => ({
      pcm: new Float32Array(0),
      durationMs: 276_000,
      stream: fakeWindow({ decoded: SPOOK(270), frames: 3 }),
    }));
    const logs: string[] = [];
    const g = makeGroup();
    const pump = new GroupPump(makeServer(logs), g);
    await pump.play("song-tail-gap");
    await waitInactive(pump, 15000, "正常曲目");

    expect(dead).toEqual([]);
    expect(logs.some((m) => m.includes("ev=stream-truncated"))).toBe(false);
    expect((pump as any).endedNaturally).toBe(true);
  }, 30_000);

  it("endReason 非 stream-eof（整包解码耗尽）⇒ 不判（判据只针对流式窗口）", async () => {
    // 整包路径：48 帧 = 1.2s，声明 276s —— 差得离谱但 endReason 是 decode-exhausted，
    // 契约上不属于本判据（注入源/PCM 长度与声明不一致是调用方的事）。
    overridePumpSource(async () => ({ pcm: new Float32Array(48 * FRAME_SAMPLES), durationMs: 276_000 }));
    const logs: string[] = [];
    const g = makeGroup();
    const pump = new GroupPump(makeServer(logs), g);
    await pump.play("song-pcm-short");
    await waitInactive(pump, 15000, "整包耗尽");

    expect(dead).toEqual([]);
    expect(logs.some((m) => m.includes("ev=stream-truncated"))).toBe(false);
  }, 30_000);

  it("声明 0（时长未知）⇒ 不判（没有参考答案）", async () => {
    overridePumpSource(async () => ({
      pcm: new Float32Array(0),
      durationMs: 0,
      stream: fakeWindow({ decoded: SPOOK(30), frames: 3 }),
    }));
    const logs: string[] = [];
    const g = makeGroup();
    const pump = new GroupPump(makeServer(logs), g);
    await pump.play("song-no-duration");
    await waitInactive(pump, 15000, "时长未知");

    expect(dead).toEqual([]);
    expect(logs.some((m) => m.includes("ev=stream-truncated"))).toBe(false);
  }, 30_000);

  it("decoded 拿不到时回落到「已推送位置」口径：1s vs 276s 仍判死", async () => {
    overridePumpSource(async () => ({
      pcm: new Float32Array(0),
      durationMs: 276_000,
      // decoded=0 ⇒ 走 lastPushedMs；40 帧 = 1s
      stream: fakeWindow({ decoded: 0, frames: 40 }),
    }));
    const logs: string[] = [];
    const g = makeGroup();
    const pump = new GroupPump(makeServer(logs), g);
    await pump.play("song-fallback-sec");
    await waitInactive(pump, 15000, "位置口径判死");

    expect(dead).toEqual(["song-fallback-sec"]);
    const line = logs.find((m) => m.includes("ev=stream-truncated"));
    expect(line).toContain("expectedSec=276");
    expect(line).toContain("deliveredSec=1");
  }, 30_000);

  it("endedNaturally=false 但 contentEnded 语义不变：过渡复位照常（current 置空、不发 finishPlayback）", async () => {
    overridePumpSource(async () => ({
      pcm: new Float32Array(0),
      durationMs: 276_000,
      stream: fakeWindow({ decoded: SPOOK(30), frames: 3 }),
    }));
    const logs: string[] = [];
    const g = makeGroup();
    const pump = new GroupPump(makeServer(logs), g);
    await pump.play("song-transition");
    await waitInactive(pump, 15000, "过渡复位");

    // 「算不算好曲」= false（截断不是自然播完）……
    expect((pump as any).endedNaturally).toBe(false);
    // ……但「该收尾了吗」不变：current 必须置空，否则 pollCore 恒报 PLAYING、队列永远不切歌。
    expect(g.current).toBeNull();
    expect(g.frozenDurationMs).toBe(276_000);
    expect(g.finished).toBe(0); // MA 对齐：过渡复位不发 stream/end（不改既有语义）
  }, 30_000);
});
