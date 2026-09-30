import { describe, it, expect, vi } from "vitest";
import { dispatchSendspinChildEvent } from "./supervisor.js";
import type { SupervisorHooks } from "./supervisor.js";

vi.mock("./streamEngine.js", () => ({
  pumpFor: () => ({ pause() {}, stop() {}, resume() {} }),
  peekPump: () => null,
  transferPumpTo: () => {},
  stopGroupPump: () => {},
  FIRST_FRAME_LEAD_US: 0,
  FRAME_MS: 10,
}));
vi.mock("./deviceState.js", () => ({ saveDeviceVolumeState: () => {} }));

import { armPauseWatchdog, setPauseStopSink, stopCore } from "./playerCore.js";
import { withinPauseStopSettle, clearPauseStop } from "../player/pauseStopSettle.js";

// 背景(2026-09-30 真机两次复现):看门狗「暂停转 stop」跑在 sendspin 子进程,
// markPauseStopIssued 的 Map 在进程内存里 —— 子进程原地打标,主进程 QueueController
// 的 idle_early 复查永远查不到 → 暂停后照样自动切歌(v1 限时窗口 / v2 持久标记
// 两次修复都因此失效)。v3:子进程经 IPC pauseStopIssued 上报,主进程打标。

describe("pauseStopIssued 跨进程打标链", () => {
  it("supervisor 分发:pauseStopIssued 事件 → hooks.onPauseStopIssued(clientId)", () => {
    const seen: string[] = [];
    const hooks: SupervisorHooks = { onPauseStopIssued: (cid) => seen.push(cid) };
    dispatchSendspinChildEvent({ t: "pauseStopIssued", clientId: "ug:g1" }, hooks);
    expect(seen).toEqual(["ug:g1"]);
  });

  it("supervisor 分发:无 hook 不抛;其余事件不受影响", () => {
    expect(() => dispatchSendspinChildEvent({ t: "pauseStopIssued", clientId: "x" }, {})).not.toThrow();
    const closed: string[] = [];
    dispatchSendspinChildEvent({ t: "closed", clientId: "c1" }, { onClosed: (cid) => closed.push(cid) });
    expect(closed).toEqual(["c1"]);
  });

  it("看门狗触发 → sink 上报(fork 模式主进程打标路径)", () => {
    vi.useFakeTimers();
    try {
      const seen: string[] = [];
      setPauseStopSink((cid) => seen.push(cid));
      const g = {
        name: "ug:g1", paused: true,
        current: { songId: "s1", durationMs: 100 },
        members: [] as unknown[], positionMs: 0, volume: 100, muted: false,
        finishPlayback() {},
      };
      const srv = {
        clients: { get: (id: string) => ({ clientId: id, sendGroupUpdate() {} }) },
        group: (_id: string) => g,
      };
      armPauseWatchdog(srv as any, "ug:g1");
      vi.advanceTimersByTime(30_000);
      expect(seen).toEqual(["ug:g1"]);
      // keepCurrent:看门狗 stop 保留曲目与 paused(播放帧锁定,可续播)
      expect(g.current).toEqual({ songId: "s1", durationMs: 100 });
      expect(g.paused).toBe(true);
    } finally {
      setPauseStopSink(null);
      vi.useRealTimers();
    }
  });

  it("stopCore 默认(显式 stop)仍全清;keepCurrent=true 保留曲目", () => {
    const mkG = () => ({
      name: "dev1", paused: false,
      current: { songId: "s1", durationMs: 100 } as any,
      members: [] as unknown[], positionMs: 42, volume: 100, muted: false,
      finishPlayback() {},
    });
    const g1 = mkG();
    const srv1 = { clients: { get: () => ({ sendGroupUpdate() {} }) }, group: () => g1 };
    stopCore(srv1 as any, "dev1");
    expect(g1.current).toBeNull();
    expect(g1.positionMs).toBe(0);
    expect(g1.paused).toBe(false);
    const g2 = mkG();
    const srv2 = { clients: { get: () => ({ sendGroupUpdate() {} }) }, group: () => g2 };
    stopCore(srv2 as any, "dev1", true);
    expect(g2.current).toEqual({ songId: "s1", durationMs: 100 });
    expect(g2.positionMs).toBe(42);
  });

  it("sink 未接线 → 兜底原地打标(in-proc 直标路径)", () => {
    vi.useFakeTimers();
    try {
      const g = {
        name: "dev1", paused: true,
        current: { songId: "s1", durationMs: 100 },
        members: [] as unknown[], positionMs: 0, volume: 100, muted: false,
        finishPlayback() {},
      };
      const srv = {
        clients: { get: () => ({ sendGroupUpdate() {} }) },
        group: (_id: string) => g,
      };
      clearPauseStop("dev1");
      armPauseWatchdog(srv as any, "dev1");
      vi.advanceTimersByTime(30_000);
      expect(withinPauseStopSettle("dev1")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
