// ==================== audio/offlineMeasure 执行层长尾 ====================
// 既有 offlineMeasure.test.ts 走真实 ffmpeg 的 happy path。这里补「ffmpeg 异常」三分支:
//   - 子进程挂起 → 超时强杀并收尾(不能让一个卡死的 ffmpeg 堵死串行队列);
//   - 子进程 error(ENOENT/EACCES)→ 立即收尾,不抛未捕获异常;
//   - spawn 同步抛错 → measureOne reject → 整批只计 failed,不中断;
//   - isMeasuring() 空闲返回 false。
// 用假 spawn 注入,不依赖真实 ffmpeg。
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({ mode: "hang" as "hang" | "error" | "throw" }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual: any = await importOriginal();
  // 在工厂内部动态取 EventEmitter:避免 vi.mock 提升后顶层 import 绑定尚未初始化。
  const { EventEmitter } = await import("node:events");
  return {
    ...actual,
    spawn: (..._args: any[]) => {
      if (h.mode === "throw") throw new Error("EACCES: spawn 被拒");
      const child: any = new EventEmitter();
      child.stderr = new EventEmitter();
      child.killed = false;
      child.kill = () => { child.killed = true; return true; };
      if (h.mode === "error") {
        setImmediate(() => child.emit("error", new Error("ENOENT ffmpeg")));
      }
      // mode === "hang":不发任何事件 → 只能靠超时收尾
      return child;
    },
  };
});

import { sqlite, db } from "../../src/db/index.js";
import { songs } from "../../src/db/schema.js";
import {
  runOfflineMeasure,
  isMeasuring,
  resetOfflineMeasureStateForTests,
  MEASURE_TIMEOUT_MS,
} from "../../src/services/audio/offlineMeasure.js";

beforeEach(() => {
  sqlite.prepare("DELETE FROM audio_analysis").run();
  db.delete(songs).run();
  h.mode = "hang";
  resetOfflineMeasureStateForTests();
});

afterEach(() => {
  vi.useRealTimers();
  resetOfflineMeasureStateForTests();
});

function insertSongLocal(id: string): void {
  db.insert(songs).values({ id, title: id, path: `l:s1:/tmp/${id}.flac`, type: "local" }).run();
}

describe("offlineMeasure 执行层异常收口", () => {
  it("ffmpeg 挂起 → 超时强杀并按 failed 收敛(不悬挂)", async () => {
    // 为什么:串行队列被一个卡死的 ffmpeg 堵住 = 后续所有歌永远测不到。
    vi.useFakeTimers();
    insertSongLocal("lt4-measure-hang");
    const p = runOfflineMeasure({ limit: 5 });
    await vi.advanceTimersByTimeAsync(MEASURE_TIMEOUT_MS + 1000);
    const summary = await p;
    expect(summary.considered).toBe(1);
    expect(summary.measured).toBe(0);
    expect(summary.failed).toBe(1);
  });

  it("spawn 触发 error 事件 → 立即收尾计 failed(不抛未捕获异常)", async () => {
    // 为什么:没有 'error' 监听时 spawn 失败会抛成进程级未捕获异常。
    h.mode = "error";
    insertSongLocal("lt4-measure-err");
    const summary = await runOfflineMeasure({ limit: 5 });
    expect(summary.failed).toBe(1);
    expect(summary.measured).toBe(0);
  });

  it("spawn 同步抛错 → measureOne reject,整批只计 failed 不中断", async () => {
    // 为什么:单曲失败绝不能中断整批(用户点「测量」不希望因一首坏文件全军覆没)。
    h.mode = "throw";
    insertSongLocal("lt4-measure-throw");
    const summary = await runOfflineMeasure({ limit: 5 });
    expect(summary.considered).toBe(1);
    expect(summary.failed).toBe(1);
  });

  it("isMeasuring():空闲时为 false", () => {
    expect(isMeasuring()).toBe(false);
  });
});
