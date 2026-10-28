// ==================== QA 独立反证：跨进程判死回传（严过关） ====================
//
// 与实现者 songUnplayableIpc.test.ts 的**关键差别**：
//   他把 `streamFallback` 全量 mock，`getCachedPlayability` 恒返回 "unknown"、断言只落在
//   「mock 的 markUnplayable 被调了一次」上。于是「主进程这份负缓存到底有没有真的变成
//   unplayable（judgePlayable 会不会因此判跳）」这条**从来没有被测到** —— 即便
//   markUnplayable 写错了 key / 动态 import 拿到另一份模块实例，他的测试照样全绿。
//
// 本文件用**真** streamFallback（不 mock），断言直接落在
// `getCachedPlayability(songId) === "unplayable"` 上 —— 这是事故修复的唯一可观测终点。
// 只 mock supervisor 的重依赖（与他的文件同款隔离，避免拉起 rendererHost）。
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../src/services/sendspin/streamEngine.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    pumpFor: () => ({ pause() {}, stop() {}, resume() {} }),
    peekPump: () => null,
    transferPumpTo: () => {},
    stopGroupPump: () => {},
    FIRST_FRAME_LEAD_US: 0,
    FRAME_MS: 10,
  };
});
vi.mock("../../src/services/sendspin/deviceState.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, saveDeviceVolumeState: () => {} };
});

import { dispatchSendspinChildEvent, markSongUnplayableInMain } from "../../src/services/sendspin/supervisor.js";
import { getCachedPlayability, clearFallbackCache } from "../../src/services/source/online/streamFallback.js";

/** fire-and-forget 的动态 import 落地（微任务 + 一次宏任务边界）。 */
async function flush(ms = 60): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

const USED: string[] = [];
afterEach(() => {
  for (const id of USED) clearFallbackCache(id);
  USED.length = 0;
});

describe("QA① 主进程负缓存：断言必须落在 getCachedPlayability（真模块）", () => {
  it("markSongUnplayableInMain ⇒ 真缓存真的变成 unplayable（judgePlayable 因此判跳）", async () => {
    const id = "qa-real-dead-1";
    USED.push(id);
    expect(getCachedPlayability(id)).not.toBe("unplayable");
    markSongUnplayableInMain(id);
    await flush();
    // ★ 这是事故修复的唯一可观测终点：主进程读视图必须是 unplayable。
    expect(getCachedPlayability(id)).toBe("unplayable");
  });

  it("dispatch(songUnplayable) → hook → markSongUnplayableInMain ⇒ 真缓存被写（整条链，非自写桩）", async () => {
    const id = "qa-real-dead-2";
    USED.push(id);
    const hooks = { onSongUnplayable: (songId: string, _r: string) => markSongUnplayableInMain(songId) };
    dispatchSendspinChildEvent({ t: "songUnplayable", clientId: "dev1", songId: id, reason: "stream-truncated" }, hooks);
    await flush();
    expect(getCachedPlayability(id)).toBe("unplayable");
  });

  it("动态 import 与静态 import 必须拿到**同一份**模块实例（否则修复等于没修）", async () => {
    const id = "qa-real-dead-3";
    USED.push(id);
    const dyn = await import("../../src/services/source/online/streamFallback.js");
    dyn.markUnplayable(id);
    // 静态入口立即读到 ⇒ 同一实例；若不是同一实例，这里会是 unknown。
    expect(getCachedPlayability(id)).toBe("unplayable");
  });

  it("空 songId 不写缓存（防御）", async () => {
    markSongUnplayableInMain("");
    await flush();
    expect(getCachedPlayability("")).not.toBe("unplayable");
  });
});
