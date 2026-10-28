// E2/E3 实验:planBridgeAnchor forceNow(now 锚)+ env 开关 + 对齐器零点语义。
// 背景(2026-10-28 240 实证):MUZO 类固件只支持「到包即播/now 锚」语义;
// 桥的未来锚 2.3s + 首包延迟 1.25s 会话永不渲染(solo/旧墙钟路径 now 锚均出声)。
// forceNow 语义:anchorUs = now(+anchorShiftUs),首包立即发;对齐器零点取
// 首帧 tsUs(见 maybeBeginStream)—— 否则泵 lead 段触发 skip 跳段时间线,
// startTs 前移把 RTP 重新标回未来,now 锚失效。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BridgeTimelineAligner,
  planBridgeAnchor,
  raopNowAnchorEnabled,
  raopNowAnchorOffsetUs,
} from "../../src/services/airplay/bridgeSession.js";
import { ntpToHostUs } from "../../src/utils/hostClock.js";

const NOW = 1_000_000_000_000n; // host µs(任意单调基准)
const FIRST_FRAME = NOW + 2_300_000n; // 泵首帧:组时间线上 2.3s 后可听
const RATE = 44100;

describe("raopNowAnchorEnabled(env 开关)", () => {
  const KEY = "MF_BRIDGE_RAOP_NOW_ANCHOR";
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[KEY];
    delete process.env[KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it("缺省(未设置)= ON(实验构建默认开)", () => {
    expect(raopNowAnchorEnabled()).toBe(true);
  });
  it("显式 0 / false = 关闭回旧路径", () => {
    process.env[KEY] = "0";
    expect(raopNowAnchorEnabled()).toBe(false);
    process.env[KEY] = "false";
    expect(raopNowAnchorEnabled()).toBe(false);
  });
  it("显式 1 = ON", () => {
    process.env[KEY] = "1";
    expect(raopNowAnchorEnabled()).toBe(true);
  });
});

describe("planBridgeAnchor.forceNow(now 锚)", () => {
  it("anchorUs = now+缺省偏移 400ms,首包可达(commandedLeadUs = 400000;offset<L+SAFETY ⇒ sendAt(0) 仍在过去)", () => {
    const plan = planBridgeAnchor({
      firstFrameTsUs: FIRST_FRAME,
      latencyFrames: 44100,
      rate: RATE,
      resampled: true,
      nowUs: NOW,
      forceNow: true,
    });
    expect(plan.forceNow).toBe(true);
    expect(plan.anchorUs).toBe(NOW + 400_000n);
    expect(plan.commandedLeadUs).toBe(400_000n);
    // forceNow 不是可达性重锚:reAnchored 保持 false
    expect(plan.reAnchored).toBe(false);
  });

  it("anchorShiftUs 平移在 now 锚下保留(A/V 标定不丢)", () => {
    const plan = planBridgeAnchor({
      firstFrameTsUs: FIRST_FRAME,
      latencyFrames: 44100,
      rate: RATE,
      resampled: true,
      nowUs: NOW,
      anchorShiftUs: 150_000,
      forceNow: true,
    });
    expect(plan.anchorUs).toBe(NOW + 150_000n + 400_000n);
  });

  it("now 锚的 SYNC 映射 = 「音频 now+偏移 开始」:startNtp = ntp(now+offset+群延迟 − L)", () => {
    const plan = planBridgeAnchor({
      firstFrameTsUs: FIRST_FRAME,
      latencyFrames: 44100,
      rate: RATE,
      resampled: true,
      nowUs: NOW,
      forceNow: true,
    });
    // A′ = anchorUs + 0.3627ms(重采样群延迟,44100 下取整 363µs);
    // ntpToHostUs 往返截断误差 ≤1µs(hostClock.ts 文档口径),容差 1。
    const gdUs = Math.round((16 / RATE) * 1e6);
    const expectUs = NOW + 400_000n + BigInt(gdUs) - 1_000_000n;
    const gotUs = ntpToHostUs(plan.anchors.startNtp);
    expect(Number(expectUs - gotUs)).toBeLessThanOrEqual(1);
    expect(Number(expectUs - gotUs)).toBeGreaterThanOrEqual(0);
  });

  it("forceNow 缺省/false 走旧路径:可达时 anchorUs = 首帧 tsUs", () => {
    const plan = planBridgeAnchor({
      firstFrameTsUs: FIRST_FRAME,
      latencyFrames: 44100,
      rate: RATE,
      resampled: true,
      nowUs: NOW,
    });
    expect(plan.forceNow).toBe(false);
    expect(plan.anchorUs).toBe(FIRST_FRAME);
    expect(plan.commandedLeadUs).toBe(2_300_000n);
  });
});

describe("forceNow 对齐器零点语义(为何取首帧 tsUs 而非 plan.anchorUs)", () => {
  const FRAME_US = 10_000n; // 480 帧 @48k = 10ms(重采样后 441 帧 @44.1k)

  function feed(aligner: BridgeTimelineAligner, n: number): { insert: number; drop: number; skip: number } {
    let insert = 0, drop = 0, skip = 0;
    for (let i = 0; i < n; i++) {
      const act = aligner.onFrame(FIRST_FRAME + BigInt(i) * FRAME_US);
      insert += act.insertFrames;
      drop += act.dropFrames;
      skip += act.skipFrames;
      aligner.produced(441);
    }
    return { insert, drop, skip };
  }

  it("零点 = 首帧 tsUs ⇒ 泵 lead 段零漂移、不触发 insert/drop/skip(内容连续)", () => {
    const aligner = new BridgeTimelineAligner(FIRST_FRAME, RATE);
    const r = feed(aligner, 300);
    expect(r).toEqual({ insert: 0, drop: 0, skip: 0 });
    expect(aligner.lastDriftUs).toBeLessThanOrEqual(1000);
  });

  it("零点 = plan.anchorUs(=now)⇒ 首帧 target ≈ +2.3s > 2s 补静音上限 ⇒ skip 跳段(此路会把 RTP 标回未来,必须避开)", () => {
    const aligner = new BridgeTimelineAligner(NOW, RATE);
    const act = aligner.onFrame(FIRST_FRAME);
    expect(act.skipFrames).toBeGreaterThan(0);
  });
});

describe("raopNowAnchorOffsetUs(exp2 偏移)", () => {
  const KEY = "MF_BRIDGE_RAOP_NOW_ANCHOR_OFFSET_MS";
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[KEY];
    delete process.env[KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it("缺省(未设置)= 400ms", () => {
    expect(raopNowAnchorOffsetUs()).toBe(400_000n);
  });
  it("显式数值生效(800 → 800ms)", () => {
    process.env[KEY] = "800";
    const plan = planBridgeAnchor({
      firstFrameTsUs: FIRST_FRAME,
      latencyFrames: 44100,
      rate: RATE,
      resampled: true,
      nowUs: NOW,
      forceNow: true,
    });
    expect(plan.anchorUs).toBe(NOW + 800_000n);
  });
  it("非法值(abc / 负数)回退默认 400", () => {
    process.env[KEY] = "abc";
    expect(raopNowAnchorOffsetUs()).toBe(400_000n);
    process.env[KEY] = "-5";
    expect(raopNowAnchorOffsetUs()).toBe(400_000n);
  });
  it("显式 0 = 回到无偏移的到包即播", () => {
    process.env[KEY] = "0";
    expect(raopNowAnchorOffsetUs()).toBe(0n);
    const plan = planBridgeAnchor({
      firstFrameTsUs: FIRST_FRAME,
      latencyFrames: 44100,
      rate: RATE,
      resampled: true,
      nowUs: NOW,
      forceNow: true,
    });
    expect(plan.anchorUs).toBe(NOW);
  });
});
