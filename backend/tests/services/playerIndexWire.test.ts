// ==================== services/player/index 接线 ====================
// wirePlayerQueueControllers 是 PlayerController(决策) → QueueController(切歌)的唯一接线点。
// 既有测试都在测两个控制器内部,这条「转发 + 失败只告警不冒泡」的接线是空的。
import "../plugins/_env.js";

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  handleDecision: vi.fn(async () => {}),
}));

// 只替换两个控制器为可观测假体,验证 index.ts 的接线逻辑本身。
vi.mock("../../src/services/player/PlayerController.js", () => ({
  PlayerController: class { onDecision: ((d: string, p: string) => void) | null = null; },
}));
vi.mock("../../src/services/player/QueueController.js", () => ({
  QueueController: class { handleDecision = h.handleDecision; },
}));

import {
  getPlayerController,
  getQueueController,
  wirePlayerQueueControllers,
} from "../../src/services/player/index.js";

beforeEach(() => {
  h.handleDecision.mockClear();
  h.handleDecision.mockImplementation(async () => {});
});

describe("wirePlayerQueueControllers", () => {
  it("懒建单例:两次 get 返回同一实例", () => {
    expect(getPlayerController()).toBe(getPlayerController());
    expect(getQueueController()).toBe(getQueueController());
  });

  it("PlayerController 决策 → 转发给 QueueController.handleDecision(决策名 + playerId)", () => {
    // 为什么:接错参数会让「下一首/暂停」打到错误的播放器,是最隐蔽的一类 bug。
    wirePlayerQueueControllers();
    const pc = getPlayerController() as any;
    pc.onDecision("next", "player-1");
    expect(h.handleDecision).toHaveBeenCalledWith("next", "player-1");
  });

  it("handleDecision 拒绝 → 只 console.warn,不冒泡到调用方", async () => {
    // 为什么:切歌失败不应把异常抛回 WS/HTTP 事件回调(会被当成未捕获异常)。
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.handleDecision.mockRejectedValueOnce(new Error("boom"));
    try {
      wirePlayerQueueControllers();
      const pc = getPlayerController() as any;
      expect(() => pc.onDecision("stop", "p2")).not.toThrow();
      await new Promise((r) => setTimeout(r, 10));
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
