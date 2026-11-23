// ==================== S8 任务 3:AP2 pacing rebase 500ms 显著性阈值 ====================
//
// 旧判据 rebaseUs = BRIDGE_RESUME_REBASE_US(2s):恒定 0.5~2s 的欠账永远够不着
// rebase ⇒ 整首歌每包「迟到追发」(latePackets≈100%,bridgeSession.ts:410 事故注释)。
// 新判据:对齐 MA playback.py:90 ANCHOR_REBASE_SIGNIFICANT_US(500ms,复用
// contentDemand.CURSOR_JUMP_BEHIND_US)—— ≥500ms 持续滞后立即前移发送参考,
// <500ms 噪声不 rebase —— 注意:该区间没有累积机制,实际是逐块 late-skip
// 丢帧追赶(每块丢一拍追一拍)。
//
// 本文件用纯依赖桩驱动 runAp2OutputLoop(零 IO),钉死两个边界:700ms 跳 / 300ms 不跳。
import { describe, it, expect } from "vitest";
import { runAp2OutputLoop } from "../../src/services/airplay/bridgeSession.js";

const RATE = 48000;
const chunk = (): Float32Array => new Float32Array(352 * 2);

describe("runAp2OutputLoop — rebase 500ms 显著性(S8 任务 3)", () => {
  it("滞后 700ms(>500ms 显著、<2s 旧阈值)⇒ 立即 rebase + 首包测量回调", async () => {
    let rebaseCalls = 0;
    let firstSendUs = 0;
    let pullCalls = 0;
    const result = await runAp2OutputLoop({
      pull: async () => {
        pullCalls += 1;
        return pullCalls === 1 ? chunk() : null;
      },
      send: () => ({ sent: 1408, errors: 0, state: "open" }),
      nowUs: () => 700_000n, // 墙钟固定 0.7s;sendAt(0) = anchor(0) − 0 = 0 ⇒ lag = 700ms
      sleepUs: async () => {},
      shouldStop: () => false,
      isPaused: () => false,
      anchorUs: 0n,
      rate: RATE,
      spf: 352,
      lEffFrames: 0,
      onFirstSend: (u) => { firstSendUs = u; },
      onRebase: () => { rebaseCalls += 1; },
    });
    expect(result.stopReason).toBe("eof");
    expect(rebaseCalls).toBe(1); // 旧 2s 阈值下 = 0(判据钉死:此用例是行为变更的回归锚)
    expect(firstSendUs).toBe(700_000);
    expect(result.chunks).toBe(1);
  });

  it("滞后 300ms(<500ms 显著阈值)⇒ 不 rebase、照发(逐块 late-skip 追赶,无累积)", async () => {
    let rebaseCalls = 0;
    let pullCalls = 0;
    const result = await runAp2OutputLoop({
      pull: async () => {
        pullCalls += 1;
        return pullCalls === 1 ? chunk() : null;
      },
      send: () => ({ sent: 1408, errors: 0, state: "open" }),
      nowUs: () => 300_000n, // lag = 300ms
      sleepUs: async () => {},
      shouldStop: () => false,
      isPaused: () => false,
      anchorUs: 0n,
      rate: RATE,
      spf: 352,
      lEffFrames: 0,
      lateSkipUs: 300_000_000, // 关掉 late-skip,隔离 rebase 判据
      onRebase: () => { rebaseCalls += 1; },
    });
    expect(result.stopReason).toBe("eof");
    expect(rebaseCalls).toBe(0);
    expect(result.chunks).toBe(1); // 照发,不丢块
  });
});
