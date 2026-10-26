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

  it("正值精确平移落点 A(桥延后),保持深度 latencyFrames 不变", () => {
    const base = plan(0);
    const shifted = plan(250_000);
    expect(shifted.anchorUs).toBe(base.anchorUs + 250_000n);
    expect(shifted.commandedLeadUs).toBe(base.commandedLeadUs + 250_000n);
    // 保持深度不参与平移:startNtp 只跟 A 走,受 L 影响的部分不变
    const baseStartNtpOffset = base.anchorUs - BigInt(Math.round((LAT / RATE) * 1e6));
    const shiftedStartNtpOffset = shifted.anchorUs - BigInt(Math.round((LAT / RATE) * 1e6));
    expect(shiftedStartNtpOffset - baseStartNtpOffset).toBe(250_000n);
  });

  it("负值精确提前;极端负值仍走可达性重锚(不硬塞过去的内容)", () => {
    const base = plan(0);
    const early = plan(-250_000);
    expect(early.anchorUs).toBe(base.anchorUs - 250_000n);
    // 首帧刚好在可达线上,再提前 500ms 就不可达 → 重锚到 now + warmLead
    const near = plan(-500_000, NOW + 1_100_000n);
    expect(near.reAnchored).toBe(true);
    expect(near.anchorUs > NOW).toBe(true);
  });
});
