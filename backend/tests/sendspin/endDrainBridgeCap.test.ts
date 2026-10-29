// ==================== 曲末排空 · 纯桥组投递上界钳制(B 方案,2026-11) ====================
//
// 症状(用户报告):AirPlay 群组播放中「卡顿几秒又恢复」。
// 真机抓包确证:每首歌结束,服务端 RTP **完全停止 3~7 秒**(45min 8 次,与换歌 8/8 对齐)。
//
// 机制:曲末排空(`pushLoop` 已退出,只 sleep + 刷新 group.positionMs)**停止产出 PCM**。
//   - 纯桥组:桥的投递窗口下沿是「现在 + 1.5s」(§6.2),**距此刻不足
//     `BRIDGE_END_DRAIN_MARGIN_MS` 的那段内容结构性投不出去** ⇒ 承诺排空它纯属
//     白等(实测白等 1.72s,桥侧 `bridge pacing rebase: +2987790µs`);再叠一道桥队列
//     硬上限(`BRIDGE_QUEUE_HARD_CAP_MS` = 8s,排空期间队列只出不进),两端取小。
//   - 混合组 / 纯直连组:直连 sendspin 设备的缓冲**确实需要真排空**,砍短会切掉曲尾
//     ⇒ 必须与改动前逐字节一致(不钳制、不打钳制日志)。
//
// 本文件两层验证:
//   ① 纯函数 `capEndDrainMs`(判据 + 数值 + 边界 + 非法输入);
//   ② 真 `GroupPump.pushLoop` 的曲末排空段(日志字段 + 实际等待时长),用
//      `overridePumpSource` 注入音源驱动,不碰 DB / 真 ffmpeg / 真设备。
import "../plugins/_env.js";

import { describe, it, expect, vi, afterAll } from "vitest";

// index.js 只被**动态导入**(禁环);单测里让它抛错,锁定「读配置失败一律回落」的兜底。
vi.mock("../../src/services/sendspin/index.js", () => ({
  readSendspinPluginConfig: () => {
    throw new Error("no plugin config in unit test");
  },
}));

import { GroupPump, overridePumpSource } from "../../src/services/sendspin/streamEngine.js";
import { capEndDrainMs } from "../../src/services/airplay/bridgeMath.js";
import {
  BRIDGE_END_DRAIN_MARGIN_MS,
  BRIDGE_END_DRAIN_SAFE_MAX_MS,
  BRIDGE_QUEUE_HARD_CAP_MS,
} from "../../src/services/airplay/rates.js";

const FRAME_SAMPLES = 2400; // 25ms @48k 立体声交错样本(与 streamEngine FRAME_MS 同口径)
const FRAME_MS = 25;

afterAll(() => {
  overridePumpSource(null);
});

// ---------------------------------------------------------------------------
// ① 纯函数:钳制判据与数值
// ---------------------------------------------------------------------------

describe("capEndDrainMs:曲末排空量的纯桥组投递上界(纯函数)", () => {
  it("常量口径:余量 1500ms(从需求里减)、安全上限 = 队列硬上限 8000ms(不再双重扣减)", () => {
    expect(BRIDGE_END_DRAIN_MARGIN_MS).toBe(1_500);
    expect(BRIDGE_QUEUE_HARD_CAP_MS).toBe(8_000);
    // 🔴 上限就是队列硬上限本身:1500 已从「需求」里减过,这里再减一次就会每首歌砍掉
    //    约 1.5s 真实音频(推导见 rates.ts 的 BRIDGE_END_DRAIN_MARGIN_MS 注释)。
    expect(BRIDGE_END_DRAIN_SAFE_MAX_MS).toBe(BRIDGE_QUEUE_HARD_CAP_MS);
    expect(BRIDGE_END_DRAIN_SAFE_MAX_MS).toBe(8_000);
  });

  it("纯桥组 + 真机实测排空需求 9784ms ⇒ min(9784−1500, 8000) = 8000ms", () => {
    const r = capEndDrainMs(9784, true);
    expect(r.contentMs).toBe(9784);
    expect(r.drainMs).toBe(8_000);
    expect(r.drainMs).toBe(
      Math.min(9784 - BRIDGE_END_DRAIN_MARGIN_MS, BRIDGE_QUEUE_HARD_CAP_MS),
    );
    expect(r.clamped).toBe(true);
  });

  it("纯桥组 + 需求 6000ms ⇒ 只扣不可达段 = 4500ms(队列上限未触发)", () => {
    const r = capEndDrainMs(6_000, true);
    expect(r.drainMs).toBe(4_500);
    expect(r.drainMs).toBeLessThan(BRIDGE_QUEUE_HARD_CAP_MS);
    expect(r.clamped).toBe(true);
  });

  it("纯桥组 + 需求 12000ms ⇒ 被队列硬上限兜住 = 8000ms", () => {
    const r = capEndDrainMs(12_000, true);
    expect(r.drainMs).toBe(BRIDGE_END_DRAIN_SAFE_MAX_MS);
    expect(r.drainMs).toBe(8_000);
    expect(r.clamped).toBe(true);
  });

  it("边界:需求 9500ms ⇒ 钳到上限 8000ms(需求−1500 仍高于上限时以 8000 收口)", () => {
    const r = capEndDrainMs(9_500, true);
    expect(r.drainMs).toBe(8_000);
    expect(r.clamped).toBe(true);
  });

  it("边界:需求恰好 8000ms ⇒ 8000−1500 = 6500ms(尾段结构性不可达,与上限无关)", () => {
    // ⚠️ 注意这里**不是**「8000−1500 双重扣减」那一版:那一版是把 6500 当成固定上限,
    //    9784ms 的需求也被压到 6500 ⇒ 砍掉 1.5s 真实音频。本式是「需求 − 不可达尾段」,
    //    需求 8000 ⇒ 设备侧本来就只有 8000ms 可播,其中末尾 1500ms 桥拿不到 ⇒ 6500 正确;
    //    而需求 9784 ⇒ 8000(见上面的用例),真实音频不受损。
    const r = capEndDrainMs(8_000, true);
    expect(r.drainMs).toBe(6_500);
    expect(r.clamped).toBe(true);
  });

  it("纯桥组只要需求 > 0 就必然发生钳制(尾段结构性不可达)⇒ 日志判据天然成立", () => {
    for (const raw of [1_600, 8_000, 9_784, 20_000]) {
      expect(capEndDrainMs(raw, true).clamped).toBe(true);
    }
    // 只有「无需排空」(≤0)时才不钳制、不打日志
    expect(capEndDrainMs(0, true).clamped).toBe(false);
  });

  it("需求小于不可达段(1500ms)⇒ 结果为 0,绝不出现负数", () => {
    for (const raw of [1_500, 1_200, 800, 1]) {
      const r = capEndDrainMs(raw, true);
      expect(r.drainMs).toBe(0);
      expect(r.drainMs).toBeGreaterThanOrEqual(0);
      expect(r.clamped).toBe(true);
    }
  });

  it("非纯桥组(混合组 / 纯直连组)⇒ 原值返回,不钳制(与改动前逐字节一致)", () => {
    for (const raw of [9784, 6_000, 1_200]) {
      const r = capEndDrainMs(raw, false);
      expect(r.drainMs).toBe(raw);
      expect(r.clamped).toBe(false);
    }
  });

  it("非法输入(NaN / 负数 / 0)⇒ 归 0,不产出负等待", () => {
    for (const bad of [Number.NaN, -1, 0, Number.NEGATIVE_INFINITY]) {
      for (const pure of [true, false]) {
        const r = capEndDrainMs(bad, pure);
        expect(r.contentMs).toBe(0);
        expect(r.drainMs).toBe(0);
        expect(r.clamped).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// ② pushLoop 集成:曲末排空段的日志与真实等待时长
// ---------------------------------------------------------------------------

/** 组形态:纯桥组 / 混合组 / 纯直连组 / 旧桩(两个判据都没有)。 */
type GroupShape = "pureBridge" | "mixed" | "direct" | "legacyStub";

/** 最小 stub group:只提供 pushLoop 真正会调的接口(其余走可选调用的兜底)。 */
function makeGroup(shape: GroupShape) {
  const frames: bigint[] = [];
  const over: Record<string, unknown> = {};
  if (shape === "pureBridge") {
    over.hasBridges = () => true;
    over.hasDirectMembers = () => false;
  } else if (shape === "mixed") {
    over.hasBridges = () => true;
    over.hasDirectMembers = () => true;
  } else if (shape === "direct") {
    over.hasBridges = () => false;
    over.hasDirectMembers = () => false;
  } // legacyStub:两个方法都不提供(旧桩,可选链自动退化成「无桥」)
  const g: Record<string, any> = {
    positionMs: 0,
    timelineBaseUs: 0n,
    current: null,
    name: "g",
    finished: 0,
    audibleStarted: false,
    commonSendAheadUs: () => 800_000,
    pushFrame: async (_ts: bigint, pcm: Float32Array) => {
      frames.push(_ts);
      return pcm.length / 2; // 产出样本数(单声道口径)
    },
    finishPlayback: () => {
      g.finished++;
    },
    ...over,
  };
  return { g: g as any, frames };
}

interface LogRec {
  at: number;
  level: string;
  msg: string;
}

function makeServer(recs: LogRec[]) {
  return {
    log: (level: string, msg: string) => {
      recs.push({ at: Date.now(), level, msg });
    },
  } as any;
}

async function waitInactive(pump: GroupPump, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (!pump.active) return;
    if (Date.now() - t0 > ms) throw new Error(`pump 未结束: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const DRAIN_STD_RE = /等设备播完缓冲 (\d+)ms 后再收流/;
const DRAIN_CLAMP_RE = /纯桥组,排空量按桥投递上界钳制 (\d+)ms → (\d+)ms/;

interface RunOpts {
  /** 注入音源时长(ms)。 */
  sourceMs: number;
  shape: GroupShape;
  /** 预填充档位(经 SENDSPIN_PREFILL_MS 生效)。 */
  prefillMs: number;
  /** 推流倍速(SENDSPIN_PUSH_SPEED),用于把真实等待压到测试可接受量级。 */
  speed: number;
}

/** 跑一次完整 pushLoop(注入音源 → 自然曲终 → 曲末排空 → 退出),返回日志与测量值。 */
async function runPump(opts: RunOpts) {
  const envBackup = {
    speed: process.env.SENDSPIN_PUSH_SPEED,
    prefill: process.env.SENDSPIN_PREFILL,
    prefillMs: process.env.SENDSPIN_PREFILL_MS,
  };
  process.env.SENDSPIN_PUSH_SPEED = String(opts.speed);
  process.env.SENDSPIN_PREFILL = "1";
  process.env.SENDSPIN_PREFILL_MS = String(opts.prefillMs);
  const totalFrames = Math.round(opts.sourceMs / FRAME_MS);
  overridePumpSource(async () => ({
    pcm: new Float32Array(totalFrames * FRAME_SAMPLES),
    durationMs: 0, // 时长未知口径:按 EOF 收尾(不触发提前 EOF 判死)
  }));
  const recs: LogRec[] = [];
  const { g, frames } = makeGroup(opts.shape);
  const pump = new GroupPump(makeServer(recs), g);
  try {
    // ⚠️ play() 只**启动** pushLoop(推进循环 fire-and-forget),必须 waitInactive 等它收尾,
    //    否则曲末排空日志还没打出来就断言了。
    await pump.play(`song-drain-${opts.shape}-${opts.prefillMs}`);
    await waitInactive(pump, 25_000, "曲末排空收尾");
    const inactiveAt = Date.now();
    const stdLog = recs.find((r) => DRAIN_STD_RE.test(r.msg));
    return { recs, frames, totalFrames, stdLog, inactiveAt };
  } finally {
    if (envBackup.speed === undefined) delete process.env.SENDSPIN_PUSH_SPEED;
    else process.env.SENDSPIN_PUSH_SPEED = envBackup.speed;
    if (envBackup.prefill === undefined) delete process.env.SENDSPIN_PREFILL;
    else process.env.SENDSPIN_PREFILL = envBackup.prefill;
    if (envBackup.prefillMs === undefined) delete process.env.SENDSPIN_PREFILL_MS;
    else process.env.SENDSPIN_PREFILL_MS = envBackup.prefillMs;
  }
}

function clampLogOf(recs: LogRec[]): LogRec | undefined {
  return recs.find((r) => DRAIN_CLAMP_RE.test(r.msg));
}

function stdWaitMs(rec: LogRec | undefined, recs: LogRec[]): number {
  const m = rec ? DRAIN_STD_RE.exec(rec.msg) : null;
  if (!m) {
    const dump = recs.map((x) => `${x.level}:${x.msg}`).join(" | ");
    throw new Error(`未找到曲末排空日志;全部日志:${dump}`);
  }
  return Number(m[1]);
}

describe("pushLoop 曲末排空:纯桥组 ⇒ 按投递上界钳制(日志 + 真实等待)", () => {
  it("排空需求远超上界(≈14.8s)⇒ 日志钳制到 8000ms,真实等待 ≈ 8000/speed", async () => {
    const speed = 8;
    const out = await runPump({
      sourceMs: 12_000,
      shape: "pureBridge",
      prefillMs: 10_000,
      speed,
    });

    // 整首内容确实推完了(排除「提前退出」造成的假象)
    expect(out.frames).toHaveLength(out.totalFrames);

    const clampRec = clampLogOf(out.recs);
    expect(clampRec, "纯桥组且被钳制时必须打钳制日志").toBeTruthy();
    const m = DRAIN_CLAMP_RE.exec(clampRec!.msg)!;
    const origMs = Number(m[1]);
    const clampedMs = Number(m[2]);
    expect(origMs).toBeGreaterThan(BRIDGE_QUEUE_HARD_CAP_MS); // 真的超了队列硬上限
    expect(clampedMs).toBe(
      Math.min(origMs - BRIDGE_END_DRAIN_MARGIN_MS, BRIDGE_QUEUE_HARD_CAP_MS),
    );
    expect(clampedMs).toBe(BRIDGE_QUEUE_HARD_CAP_MS); // = 8000
    expect(clampRec!.msg).toContain("sendspin 曲末排空:");

    // 钳制后实际等待 = clamped / speed(倍速折算),标准排空行报的也是钳制后的值
    expect(stdWaitMs(out.stdLog, out.recs)).toBe(Math.round(clampedMs / speed));

    // 真实耗时也必须是钳制后的量级:未钳制时 ≈ origMs/speed(≈1.9s),钳制后 ≈1.0s
    const waited = out.inactiveAt - out.stdLog!.at;
    expect(waited).toBeGreaterThan(Math.round((clampedMs / speed) * 0.5));
    expect(waited).toBeLessThan(Math.round((clampedMs / speed) * 0.5) + 800);
    expect(waited).toBeLessThan(Math.round(origMs / speed) - 300);
  }, 30_000);

  it("排空需求一般(≈5.4s,未触队列上限)⇒ 只扣不可达段 1500ms", async () => {
    const speed = 8;
    const out = await runPump({
      sourceMs: 2_000,
      shape: "pureBridge",
      prefillMs: 3_000,
      speed,
    });

    expect(out.frames).toHaveLength(out.totalFrames);
    const clampRec = clampLogOf(out.recs);
    expect(clampRec).toBeTruthy();
    const m = DRAIN_CLAMP_RE.exec(clampRec!.msg)!;
    const origMs = Number(m[1]);
    const clampedMs = Number(m[2]);
    expect(clampedMs).toBeLessThan(BRIDGE_QUEUE_HARD_CAP_MS); // 队列上限未触发
    expect(Math.abs(clampedMs - (origMs - BRIDGE_END_DRAIN_MARGIN_MS))).toBeLessThanOrEqual(1);
    expect(clampedMs).toBeGreaterThan(0);
    expect(stdWaitMs(out.stdLog, out.recs)).toBe(Math.round(clampedMs / speed));
  }, 30_000);
});

describe("pushLoop 曲末排空:混合组 / 纯直连组行为零变化", () => {
  const speed = 8;
  const prefillMs = 10_000;

  it("混合组(有桥且有直连成员)⇒ 不钳制、不打钳制日志,排空量取原值", async () => {
    const out = await runPump({ sourceMs: 12_000, shape: "mixed", prefillMs, speed });
    expect(out.frames).toHaveLength(out.totalFrames);
    expect(clampLogOf(out.recs), "混合组不得出现钳制日志").toBeUndefined();
    const waitMs = stdWaitMs(out.stdLog, out.recs);
    // 原值口径:内容域排空需求 > 队列硬上限也照旧等待(证明没被钳制)
    expect(waitMs * speed).toBeGreaterThan(BRIDGE_QUEUE_HARD_CAP_MS);
    expect(capEndDrainMs(waitMs * speed, false).drainMs).toBe(waitMs * speed);
  }, 40_000);

  it("纯直连组(hasBridges=false)⇒ 不钳制,且与旧桩(无判据)等待量一致", async () => {
    const direct = await runPump({ sourceMs: 12_000, shape: "direct", prefillMs, speed });
    const legacyStub = await runPump({ sourceMs: 12_000, shape: "legacyStub", prefillMs, speed });

    for (const out of [direct, legacyStub]) {
      expect(out.frames).toHaveLength(out.totalFrames);
      expect(clampLogOf(out.recs), "纯直连组不得出现钳制日志").toBeUndefined();
      const waitMs = stdWaitMs(out.stdLog, out.recs);
      expect(waitMs * speed).toBeGreaterThan(BRIDGE_QUEUE_HARD_CAP_MS);
    }

    // 有判据(false) 与 旧桩(无该属性) 的等待量必须一致(±120ms 计时抖动)
    const a = stdWaitMs(direct.stdLog, direct.recs);
    const b = stdWaitMs(legacyStub.stdLog, legacyStub.recs);
    expect(Math.abs(a - b)).toBeLessThanOrEqual(120);
  }, 60_000);
});
