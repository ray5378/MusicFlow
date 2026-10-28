// E3 settle 标记单测:TTL 过期、容量淘汰、env 开关语义。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  BRIDGE_SETTLE_MARK_TTL_MS,
  clearBridgeSettleMarks,
  isRecentlyBridgeSettledDlnaPeer,
  markBridgeSettledDlnaPeer,
  raopSuppressDlnaResetAfterBridge,
} from "../../src/services/airplay/bridgeSettleMarks.js";

beforeEach(() => clearBridgeSettleMarks());
afterEach(() => {
  clearBridgeSettleMarks();
  delete process.env.MF_BRIDGE_RAOP_SUPPRESS_DLNA_RESET_AFTER_BRIDGE;
});

describe("bridgeSettleMarks(exp4 E3)", () => {
  it("标记后即命中;未标记不命中", () => {
    expect(isRecentlyBridgeSettledDlnaPeer("d1")).toBe(false);
    markBridgeSettledDlnaPeer("d1", "ap1");
    expect(isRecentlyBridgeSettledDlnaPeer("d1")).toBe(true);
    expect(isRecentlyBridgeSettledDlnaPeer("d2")).toBe(false);
  });

  it("TTL 边界:≤20s 命中,>20s 过期(过期即删)", () => {
    markBridgeSettledDlnaPeer("d1", "ap1", 1_000_000);
    expect(isRecentlyBridgeSettledDlnaPeer("d1", 1_000_000 + BRIDGE_SETTLE_MARK_TTL_MS)).toBe(true);
    expect(isRecentlyBridgeSettledDlnaPeer("d1", 1_000_000 + BRIDGE_SETTLE_MARK_TTL_MS + 1)).toBe(false);
    // 已删:再以「未过期时刻」查也不命中。
    expect(isRecentlyBridgeSettledDlnaPeer("d1", 1_000_001)).toBe(false);
  });

  it("容量上限:超过 64 条淘汰最旧", () => {
    for (let i = 0; i < 65; i++) markBridgeSettledDlnaPeer(`d${i}`, "ap1", 1_000_000 + i);
    expect(isRecentlyBridgeSettledDlnaPeer("d0", 1_000_100)).toBe(false); // 最旧被淘汰
    expect(isRecentlyBridgeSettledDlnaPeer("d64", 1_000_100)).toBe(true); // 最新在
  });

  it("env 开关:缺省关;1/true 开;其余关", () => {
    expect(raopSuppressDlnaResetAfterBridge()).toBe(false);
    process.env.MF_BRIDGE_RAOP_SUPPRESS_DLNA_RESET_AFTER_BRIDGE = "1";
    expect(raopSuppressDlnaResetAfterBridge()).toBe(true);
    process.env.MF_BRIDGE_RAOP_SUPPRESS_DLNA_RESET_AFTER_BRIDGE = "true";
    expect(raopSuppressDlnaResetAfterBridge()).toBe(true);
    process.env.MF_BRIDGE_RAOP_SUPPRESS_DLNA_RESET_AFTER_BRIDGE = "0";
    expect(raopSuppressDlnaResetAfterBridge()).toBe(false);
  });
});
