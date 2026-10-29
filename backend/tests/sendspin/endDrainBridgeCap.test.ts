// ==================== 曲末排空 · 桥安全钳制(B 方案,2026-11) ====================
//
// 症状(用户报告):AirPlay 群组播放中「卡顿几秒又恢复」。
// 真机抓包确证:每首歌结束,服务端 RTP **完全停止 3~7 秒**(45min 8 次,与换歌 8/8 对齐)。
//
// 机制:曲末排空(`pushLoop` 已退出,只 sleep + 刷新 group.positionMs)**停止产出 PCM**。
//   - 纯 sendspin 设备没事:音频已经在设备缓冲里,排空只是等它播完;
//   - AirPlay 桥成员的 PCM 全靠 `pushLoop` 现场产料(`bridgeMember.pushAudio`),
//     桥侧队列只出不进、硬上限 `BRIDGE_QUEUE_HARD_CAP_MS` = 8s;
//   - 实测排空需求 9784ms(几乎恒定 9781~9785)⇒ 必然提前 ~1.72s 断料
//     (桥侧记录 `bridge pacing rebase: +2987790µs`)。
//
// 修法(B 方案):组内**有桥成员**时把排空量钳制到 `BRIDGE_QUEUE_HARD_CAP_MS − 1500ms`
//   (= `BRIDGE_END_DRAIN_SAFE_MAX_MS`,6.5s);**纯 sendspin 组零变化** —— 不钳制、
//   不打钳制日志、等待时长与改动前逐字节一致。
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

describe("capEndDrainMs:曲末排空量的桥安全钳制(纯函数)", () => {
  it("常量口径:上限 = 队列硬上限 − 周转余量 = 8000 − 1500 = 6500ms", () => {
    expect(BRIDGE_QUEUE_HARD_CAP_MS).toBe(8_000);
    expect(BRIDGE_END_DRAIN_MARGIN_MS).toBe(1_500);
    expect(BRIDGE_END_DRAIN_SAFE_MAX_MS).toBe(6_500);
  });

  it("有桥成员 + 真机实测排空需求 9784ms ⇒ 钳制到 6500ms", () => {
    const r = capEndDrainMs(9784, true);
    expect(r.contentMs).toBe(9784);
    expect(r.drainMs).toBe(BRIDGE_END_DRAIN_SAFE_MAX_MS);
    expect(r.drainMs).toBe(6_500);
    expect(r.clamped).toBe(true);
  });

  it("无桥(纯 sendspin 组)+ 同样 9784ms ⇒ 原值返回,不钳制", () => {
    const r = capEndDrainMs(9784, false);
    expect(r.contentMs).toBe(9784);
    expect(r.drainMs).toBe(9784);
    expect(r.clamped).toBe(false);
  });

  it("有桥但排空需求未超上限(2200ms)⇒ 不钳制", () => {
    const r = capEndDrainMs(2200, true);
    expect(r.drainMs).toBe(2200);
    expect(r.clamped).toBe(false);
  });

  it("边界:恰好等于上限不钳制,超 1ms 才钳制(日志只在真钳制时打)", () => {
    expect(capEndDrainMs(BRIDGE_END_DRAIN_SAFE_MAX_MS, true).clamped).toBe(false);
    const over = capEndDrainMs(BRIDGE_END_DRAIN_SAFE_MAX_MS + 1, true);
    expect(over.clamped).toBe(true);
    expect(over.drainMs).toBe(BRIDGE_END_DRAIN_SAFE_MAX_MS);
  });

  it("非法输入(NaN / 负数 / 0)⇒ 归 0,不产出负等待", () => {
    for (const bad of [Number.NaN, -1, 0, Number.NEGATIVE_INFINITY]) {
      const r = capEndDrainMs(bad, true);
      expect(r.contentMs).toBe(0);
      expect(r.drainMs).toBe(0);
      expect(r.clamped).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// ② pushLoop 集成:曲末排空段的日志与真实等待时长
// ---------------------------------------------------------------------------

/** 最小 stub group:只提供 pushLoop 真正会调的接口(其余走可选调用的兜底)。 */
function makeGroup(over: Record<string, unknown> = {}) {
  const frames: bigint[] = [];
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
const DRAIN_CLAMP_RE = /桥成员在场,排空量按桥队列上限钳制 (\d+)ms → (\d+)ms/;

interface RunOpts {
  /** 注入音源的时长(ms);0 帧长未知口径统一走整包路径。 */
  sourceMs: number;
  /** 组内有无桥成员;`null` = 旧桩(根本没有 hasBridges 属性)。 */
  hasBridges: boolean | null;
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
  const over: Record<string, unknown> = {};
  if (opts.hasBridges !== null) over.hasBridges = () => opts.hasBridges === true;
  const { g, frames } = makeGroup(over);
  const pump = new GroupPump(makeServer(recs), g);
  try {
    // ⚠️ play() 只**启动** pushLoop(推进循环 fire-and-forget),必须 waitInactive 等它收尾,
    //    否则曲末排空日志还没打出来就断言了。
    await pump.play(`song-drain-${opts.hasBridges}-${opts.prefillMs}`);
    await waitInactive(pump, 25_000, "曲末排空收尾");
    const inactiveAt = Date.now();
    const stdLog = recs.find((r) => DRAIN_STD_RE.test(r.msg));
    return { recs, frames, g, totalFrames, stdLog, inactiveAt };
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

function stdWaitMs(rec: LogRec | undefined, recs?: LogRec[]): number {
  const m = rec ? DRAIN_STD_RE.exec(rec.msg) : null;
  if (!m) {
    const dump = (recs ?? []).map((r) => `${r.level}:${r.msg}`).join(" | ");
    throw new Error(`未找到曲末排空日志;实收:${rec ? rec.msg : "(无)"} 全部日志:${dump}`);
  }
  return Number(m[1]);
}

describe("pushLoop 曲末排空:组内有桥成员 ⇒ 排空量被钳制(日志 + 真实等待)", () => {
  it("排空需求 9.4s+ / 桥上限 6.5s ⇒ 打钳制日志 6500ms,真实等待 ≈ 6500/speed(而非原值)", async () => {
    const speed = 8;
    const prefillMs = 10_000; // 深档位:排空需求必然超过 6.5s 的桥安全上限
    const out = await runPump({ sourceMs: 12_000, hasBridges: true, prefillMs, speed });

    // 整首内容确实推完了(排除「提前退出」造成的假象)
    expect(out.frames).toHaveLength(out.totalFrames);

    const clampRec = clampLogOf(out.recs);
    expect(clampRec, "有桥且超上限时必须打钳制日志").toBeTruthy();
    const m = DRAIN_CLAMP_RE.exec(clampRec!.msg)!;
    const origMs = Number(m[1]);
    const clampedMs = Number(m[2]);
    expect(origMs).toBeGreaterThan(BRIDGE_END_DRAIN_SAFE_MAX_MS); // 真的超了上限
    expect(clampedMs).toBe(BRIDGE_END_DRAIN_SAFE_MAX_MS); // 钳到 6500
    expect(clampedMs).toBe(6_500);
    // 日志字段固定,便于 grep:带 song=
    expect(clampRec!.msg).toContain("sendspin 曲末排空:");

    // 钳制后实际等待 = clamped / speed(倍速折算),且标准排空日志报的是钳制后的值
    expect(stdWaitMs(out.stdLog, out.recs)).toBe(Math.round(clampedMs / speed));

    // 真实耗时也必须是钳制后的量级:未钳制时 ≈ origMs/speed(≈1.9s),钳制后 ≈0.81s
    const waited = out.inactiveAt - out.stdLog!.at;
    expect(waited).toBeGreaterThan(Math.round((clampedMs / speed) * 0.5));
    expect(waited).toBeLessThan(Math.round((clampedMs / speed) * 0.5) + 700);
    expect(waited).toBeLessThan(Math.round(origMs / speed) - 300);
  }, 30_000);

  it("有桥但排空需求未超上限 ⇒ 不钳制、不打钳制日志(不刷噪声)", async () => {
    const speed = 8;
    const prefillMs = 3_000;
    // 短源(2s):即使按纯桥组的深锚点(4.5s)起算,排空需求也在 6.5s 以内
    const out = await runPump({ sourceMs: 2_000, hasBridges: true, prefillMs, speed });

    expect(out.frames).toHaveLength(out.totalFrames);
    expect(clampLogOf(out.recs), "未超上限时不得打钳制日志").toBeUndefined();
    const waitMs = stdWaitMs(out.stdLog, out.recs);
    expect(waitMs).toBeGreaterThan(0);
    expect(waitMs * speed).toBeLessThanOrEqual(BRIDGE_END_DRAIN_SAFE_MAX_MS);
    // 与纯函数判定一致:未超上限 ⇒ 不钳制
    expect(capEndDrainMs(waitMs * speed, true).clamped).toBe(false);
  }, 30_000);
});

describe("pushLoop 曲末排空:纯 sendspin 组行为零变化", () => {
  it("hasBridges=false ⇒ 不打钳制日志,排空量取原值(即使原值已超 6.5s),与旧桩逐项一致", async () => {
    const speed = 8;
    const prefillMs = 10_000;
    const withJudge = await runPump({ sourceMs: 12_000, hasBridges: false, prefillMs, speed });
    const legacyStub = await runPump({ sourceMs: 12_000, hasBridges: null, prefillMs, speed });

    for (const out of [withJudge, legacyStub]) {
      expect(out.frames).toHaveLength(out.totalFrames);
      // 纯 sendspin 组:无论排空需求多大都**不钳制、不打钳制日志**
      expect(clampLogOf(out.recs), "纯 sendspin 组不得出现钳制日志").toBeUndefined();
      const waitMs = stdWaitMs(out.stdLog, out.recs);
      expect(waitMs).toBeGreaterThan(0);
      // 关键:内容域排空量已超过桥安全上限,却仍按原值等待
      // ⇒ 证明「钳制只在有桥成员时生效」,纯 sendspin 行为与改动前一致。
      expect(waitMs * speed).toBeGreaterThan(BRIDGE_END_DRAIN_SAFE_MAX_MS);
    }

    // 有判据(false)与旧桩(无该属性)的等待量必须一致(±120ms 计时抖动)
    const a = stdWaitMs(withJudge.stdLog, withJudge.recs);
    const b = stdWaitMs(legacyStub.stdLog, legacyStub.recs);
    expect(Math.abs(a - b)).toBeLessThanOrEqual(120);
  }, 60_000);
});
