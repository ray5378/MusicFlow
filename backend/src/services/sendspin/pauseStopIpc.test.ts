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

import { armPauseWatchdog, setPauseStopSink } from "./playerCore.js";
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
    } finally {
      setPauseStopSink(null);
      vi.useRealTimers();
    }
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
