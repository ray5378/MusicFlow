// ==================== audio/flow 空会话契约 ====================
// startFlowSession([]) 必须「起得来、立刻收敛、不启动任何解码器」——这是
// 「单曲/空列表走同一实现」的最小保证(关闭交叉淡入不是绕过管道,空列表也不是特例分支爆炸)。
// 真实 ffmpeg 不参与:只桩掉 spawn 出的编码器进程。
import "../plugins/_env.js";

import { describe, it, expect, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual: any = await importOriginal();
  const { PassThrough } = await import("node:stream");
  const { EventEmitter } = await import("node:events");
  return {
    ...actual,
    spawn: () => {
      const enc: any = new EventEmitter();
      enc.stdout = new PassThrough();
      enc.stderr = new PassThrough();
      enc.stdin = new PassThrough();
      enc.killed = false;
      enc.kill = () => { enc.killed = true; return true; };
      // 会话内部同步挂上 'close' 监听后再发,模拟编码器 stdin 收尾后自然退出
      setImmediate(() => enc.emit("close"));
      return enc;
    },
  };
});

import { startFlowSession } from "../../src/services/audio/flow.js";

describe("startFlowSession 空列表", () => {
  it("空列表:不启动解码器、stats 全零、done 收敛", async () => {
    const session = await startFlowSession([]);
    expect(session.currentIndex()).toBe(0);
    expect(session.stats()).toEqual({ emittedFrames: 0, crossfades: 0, skipped: 0, decoders: 0 });
    await session.done;
    // abort 幂等:收敛后再次调用不抛
    expect(() => session.abort()).not.toThrow();
    expect(() => session.abort()).not.toThrow();
  });
});
