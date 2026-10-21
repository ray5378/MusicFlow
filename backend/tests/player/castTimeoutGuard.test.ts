// cast 超时回归守卫(2026-10-21 HiVi 流转现场):
//
// 现场链路 = `playMedia` 挂 30s → withTimeout 的兜底回调里 **throw** → 异常发生在
// setTimeout 定时器里 = 未捕获异常 → **整个 Node 进程退出**(容器重启,API 报
// connection refused,所有设备的播放同时中断)。本文件钉死两件事:
//   ① 超时只判失败,绝不把异常抛到定时器里(进程必须活着);
//   ② 超时必须回收设备侧半开会话(`player.stop`)—— 否则下一次 cast 与幽灵会话
//      并存,HiVi/Linkplay 这类单会话设备会一直停在旧通道(表现「流转后无声」)。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { QueueController } from "../../src/services/player/QueueController.js";
import { PlaybackState } from "../../src/services/player/types.js";

function setup(opts: { hang: boolean }) {
  const stopped: string[] = [];
  const starts: Array<number | undefined> = [];
  const player = {
    playerId: "airplay:casttimeout",
    async playMedia(_item: any, _baseUrl: string, startMs?: number) {
      starts.push(startMs);
      if (opts.hang) {
        // 永不返回:模拟 RTSP 握手挂死(不可取消,正是现场形态)
        return await new Promise<never>(() => { /* never settle */ });
      }
      return { mediaUri: "u" };
    },
    async stop() { stopped.push("stop"); },
    async pollState() {
      return {
        playerId: "airplay:casttimeout",
        playbackState: PlaybackState.IDLE,
        position: 0,
        duration: 0,
        updatedAt: Date.now(),
      };
    },
  } as any;
  const ctrl = {
    beginOptimistic: () => {},
    armOptimisticTimeout: () => {},
    endOptimistic: () => {},
    reportState: () => {},
    resetTracker: () => {},
    setExpectedDuration: () => {},
  };
  const qc = new QueueController();
  qc.registerPlayer("casttimeout", player, ctrl);
  qc.setQueue(
    "casttimeout",
    [{ songId: "s1", title: "t1", mime: "audio/mpeg", duration: 180 }] as any,
    0,
    "http://base",
  );
  return { qc, stopped, starts };
}

const ITEMS = [{ songId: "s1", title: "t1", mime: "audio/mpeg", duration: 180 }] as any;

describe("cast 超时:判失败而不是杀进程", () => {
  beforeAll(() => {
    if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
    // 测试接缝:把 30s 压到 80ms(生产不设该变量)。
    process.env.MF_CAST_TIMEOUT_MS = "80";
  });
  afterAll(() => {
    delete process.env.MF_CAST_TIMEOUT_MS;
  });

  it("playMedia 永不返回 → 兜底不抛未捕获异常,并回收设备侧会话", async () => {
    const { qc, stopped } = setup({ hang: true });
    // 修复前:兜底回调在 setTimeout 里 throw → 本用例会以未捕获异常直接炸掉测试进程。
    const idx = await qc.playFrom("airplay:casttimeout", ITEMS, 0, "http://base");
    expect(idx).toBe(0);
    expect(stopped.length, "超时后必须 best-effort 回收半开 RAOP 会话").toBeGreaterThan(0);
    // 队列仍在(失败走的是重投/切歌通道,而不是把队列清空)
    expect(qc.snapshot("casttimeout").items.length).toBe(1);
  }, 5000);

  it("不挂死的 cast 不受影响(同一接缝下仍能正常返回)", async () => {
    const { qc, stopped } = setup({ hang: false });
    const idx = await qc.playFrom("airplay:casttimeout", ITEMS, 0, "http://base");
    expect(idx).toBe(0);
    expect(stopped.length).toBe(0);
  }, 5000);

  it("playFrom 把起播落点透传给 playMedia(流转不再「先起播、再 seek」)", async () => {
    const { qc, starts } = setup({ hang: false });
    await qc.playFrom("airplay:casttimeout", ITEMS, 0, "http://base", undefined, 12_500);
    // 落点必须进**这一次** cast;否则流转会在同一设备上再建一次会话。
    expect(starts.at(-1)).toBe(12_500);
  }, 5000);
});
