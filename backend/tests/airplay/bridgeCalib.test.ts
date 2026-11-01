// AirPlay 桥 A/V 标定位移:解析钳制 + planBridgeAnchor 平移精确性。
// 真机背景:HiVi(MUZO)不回报 Audio-Latency ⇒ L_true 未知 ⇒ 桥整体差一个常量,
// 由 bridge.avShiftMs 标定;本文件钉住「只平移落点、不动保持深度」的语义。
import { describe, it, expect } from "vitest";
import {
  parseBridgeAvShiftMs,
  BRIDGE_AV_SHIFT_MAX_MS,
  BRIDGE_AV_SHIFT_MIN_MS,
} from "../../src/services/airplay/bridgeCalib.js";
import { planBridgeAnchor } from "../../src/services/airplay/bridgeSession.js";

describe("bridge.avShiftMs 解析", () => {
  it("空/非法 → 0(= 不标定,历史行为)", () => {
    expect(parseBridgeAvShiftMs("")).toBe(0);
    expect(parseBridgeAvShiftMs("   ")).toBe(0);
    expect(parseBridgeAvShiftMs("abc")).toBe(0);
    expect(parseBridgeAvShiftMs("NaN")).toBe(0);
  });

  it("正负都保留(正=桥延后,负=桥提前),小数取整", () => {
    expect(parseBridgeAvShiftMs("180")).toBe(180);
    expect(parseBridgeAvShiftMs("-120")).toBe(-120);
    expect(parseBridgeAvShiftMs("12.6")).toBe(13);
  });

  it("越界钳到 ±2000ms", () => {
    expect(parseBridgeAvShiftMs("99999")).toBe(BRIDGE_AV_SHIFT_MAX_MS);
    expect(parseBridgeAvShiftMs("-99999")).toBe(BRIDGE_AV_SHIFT_MIN_MS);
  });
});

describe("planBridgeAnchor.anchorShiftUs", () => {
  const NOW = 1_000_000_000n;
  const LAT = 44_100; // 1s @44.1k
  const RATE = 44_100;

  function plan(shiftUs: number | undefined, firstTs = NOW + 3_000_000n) {
    return planBridgeAnchor({
      firstFrameTsUs: firstTs,
      latencyFrames: LAT,
      rate: RATE,
      resampled: false,
      nowUs: NOW,
      anchorShiftUs: shiftUs,
    });
  }

  it("缺省(undefined)= 0,与历史行为逐字节一致", () => {
    const a = plan(undefined);
    const b = plan(0);
    expect(a.anchorUs).toBe(b.anchorUs);
    expect(a.anchors.startNtp).toBe(b.anchors.startNtp);
    expect(a.anchors.headTs).toBe(b.anchors.headTs);
    expect(a.commandedLeadUs).toBe(b.commandedLeadUs);
  });

  // 2026-11-01(D1/D2,MA `_anchor_stream`):补偿**只进出声锚点**,不进组锚点/送包节拍 ——
  // 否则同组各成员的投递窗口不同 ⇒ 同刻投出的内容不同(进度差 ⇒ 一台无料可投 ⇒ 静音)。
  it("正值只平移出声锚点(playAnchorUs),组锚点与送包节拍不动", () => {
    const base = plan(0);
    const shifted = plan(250_000);
    expect(shifted.anchorUs).toBe(base.anchorUs);
    expect(shifted.commandedLeadUs).toBe(base.commandedLeadUs);
    expect(shifted.beatAnchorUs).toBe(base.beatAnchorUs);
    expect(shifted.playAnchorUs).toBe(base.playAnchorUs + 250_000n);
    // 保持深度不参与平移:映射(NTP/RTP)跟着出声锚点走,L 的部分不变
    const lUs = BigInt(Math.round((LAT / RATE) * 1e6));
    const baseMap = base.anchors.anchorUsShifted - lUs;
    const shiftedMap = shifted.anchors.anchorUsShifted - lUs;
    expect(shiftedMap - baseMap).toBe(250_000n);
  });

  it("负值只把出声锚点提前;送包基准仍是内容锚点 ⇒ 不需要可达性重锚", () => {
    const base = plan(0);
    const early = plan(-250_000);
    expect(early.anchorUs).toBe(base.anchorUs);
    expect(early.beatAnchorUs).toBe(base.beatAnchorUs);
    expect(early.playAnchorUs).toBe(base.playAnchorUs - 250_000n);
    // 旧实现把 shift 折进 A ⇒ sendAt(0) 落到过去 ⇒ 必须重锚(代价是内容跳段)。
    // 新模型 A 不含 shift,首帧恒可达 ⇒ 不再重锚(负补偿只吃掉设备侧到达余量)。
    const near = plan(-500_000, NOW + 1_100_000n);
    expect(near.reAnchored).toBe(false);
    expect(near.playAnchorUs).toBe(NOW + 1_100_000n - 500_000n);
  });
});
