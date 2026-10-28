// ==================== 子进程判死 → 主进程负缓存（2026-10-28 240 生产事故） ====================
//
// 事故：Sendspin **子进程** 在 `stream-truncated` 分支里写 `markUnplayable(songId)`，而
// streamFallback 的负缓存是 **module-local Map** —— 子进程只改自己进程里那一份，主进程
// `QueueController.judgePlayable` 读的是主进程那一份，两边互不可见。后果：子进程
// 18:28:22 已判死，主进程 18:28:46 重播时仍读到 `unknown` ⇒ 又把 60s 试听片段播了一遍
// （要等 18:29:06 主进程自己的预取跑完才判死）。
//
// 本文件钉死修复后的三段链：
//   ① supervisor 分发：songUnplayable 事件 → hooks.onSongUnplayable(songId, reason)；
//   ② 主进程落地：markSongUnplayableInMain(songId) ⇒ **主进程这份** markUnplayable 被调；
//   ③ 兜底：无 hook 不抛、hook 抛错不拖垮事件桥、既有事件（closed/pauseStopIssued）不受影响。
//
// 参照 src/services/sendspin/pauseStopIpc.test.ts（同一类跨进程打标洞的先例）。
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  dispatchSendspinChildEvent,
  markSongUnplayableInMain,
} from "../../src/services/sendspin/supervisor.js";
import type { SupervisorHooks } from "../../src/services/sendspin/supervisor.js";

/** 主进程这份负缓存的落地记录。 */
const dead = vi.hoisted(() => [] as string[]);
// ⚠ 必须是**全量替换式** mock（不带 importOriginal）：supervisor 里对它是
// `await import()` 动态引入，带 importOriginal 的工厂对这条动态路径不生效
// （实测：静态 import 命中桩、动态 import 拿到真模块；与 streamTruncate.test.ts 同款写法）。
vi.mock("../../src/services/source/online/streamFallback.js", () => ({
  markUnplayable: (songId: string) => {
    dead.push(songId);
  },
  getCachedPlayability: () => "unknown",
}));

// supervisor 经 rendererHost 拉进来的重依赖用桩替身（与 pauseStopIpc.test.ts 同款）：
// 本文件只测事件分发与负缓存落地，不测推流。
vi.mock("../../src/services/sendspin/streamEngine.js", () => ({
  pumpFor: () => ({ pause() {}, stop() {}, resume() {} }),
  peekPump: () => null,
  transferPumpTo: () => {},
  stopGroupPump: () => {},
  FIRST_FRAME_LEAD_US: 0,
  FRAME_MS: 10,
}));
vi.mock("../../src/services/sendspin/deviceState.js", () => ({ saveDeviceVolumeState: () => {} }));

afterEach(() => {
  dead.length = 0;
});

/** 让 fire-and-forget 的动态 import 落地（微任务 + 一次宏任务边界足够）。 */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

describe("songUnplayable 跨进程负缓存链", () => {
  it("① supervisor 分发：songUnplayable → hooks.onSongUnplayable(songId, reason)", () => {
    const seen: Array<[string, string]> = [];
    const hooks: SupervisorHooks = { onSongUnplayable: (songId, reason) => seen.push([songId, reason]) };
    dispatchSendspinChildEvent(
      { t: "songUnplayable", clientId: "dev1", songId: "song-clip", reason: "stream-truncated 期望276s 实际30s" },
      hooks,
    );
    expect(seen).toEqual([["song-clip", "stream-truncated 期望276s 实际30s"]]);
  });

  it("② 主进程落地：markSongUnplayableInMain ⇒ 主进程这份 markUnplayable 被调（子进程那份主进程读不到）", async () => {
    const hooks: SupervisorHooks = {
      onSongUnplayable: (songId, _reason) => markSongUnplayableInMain(songId),
    };
    dispatchSendspinChildEvent(
      { t: "songUnplayable", clientId: "dev1", songId: "song-clip", reason: "stream-truncated" },
      hooks,
    );
    await flush();
    expect(dead).toEqual(["song-clip"]);
  });

  it("② 空 songId ⇒ 不记（防御：子进程异常快照不该写空键）", async () => {
    markSongUnplayableInMain("");
    await flush();
    expect(dead).toEqual([]);
  });

  it("③ 无 hook 不抛；hook 抛错只吞自身", () => {
    expect(() =>
      dispatchSendspinChildEvent({ t: "songUnplayable", clientId: "x", songId: "s", reason: "r" }, {}),
    ).not.toThrow();
    expect(() =>
      dispatchSendspinChildEvent(
        { t: "songUnplayable", clientId: "x", songId: "s", reason: "r" },
        { onSongUnplayable: () => { throw new Error("boom"); } },
      ),
    ).not.toThrow();
  });

  it("③ 既有事件不受影响：closed / pauseStopIssued 照旧分发", () => {
    const closed: string[] = [];
    dispatchSendspinChildEvent({ t: "closed", clientId: "c1" }, { onClosed: (cid) => closed.push(cid) });
    expect(closed).toEqual(["c1"]);
    const paused: string[] = [];
    dispatchSendspinChildEvent(
      { t: "pauseStopIssued", clientId: "ug:g1" },
      { onPauseStopIssued: (cid) => paused.push(cid) },
    );
    expect(paused).toEqual(["ug:g1"]);
    // 互不串台：songUnplayable 不会误触发 onClosed / onPauseStopIssued
    dispatchSendspinChildEvent(
      { t: "songUnplayable", clientId: "c9", songId: "s9", reason: "r" },
      { onClosed: (cid) => closed.push(cid), onPauseStopIssued: (cid) => paused.push(cid) },
    );
    expect(closed).toEqual(["c1"]);
    expect(paused).toEqual(["ug:g1"]);
  });
});
