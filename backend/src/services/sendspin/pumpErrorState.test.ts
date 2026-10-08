// pushLoop 异常终止必须清组状态(2026-10-08 240「月满西楼」群组永久卡死回归守卫)。
//
// 线上事故:群组流中途死亡(上游源断/ffmpeg 死)→ pushLoop 进 catch 只置 running,
// group.current 残留 → pollCore `playing: !!g.current` 永远 true → 主进程 pollState
// 永远 PLAYING pos=0 dur=311 uri=- → PlaybackTracker/QueueController 被假在播骗住
// (stalled 复查见 PLAYING 误判「确在播放」清计数)→ 不重投不切歌,群组永久卡死。
// 契约:异常终止与自然结束同口径 —— 清 current + finishPlayback 宣告结束 ⇒
// poll 上报 IDLE ⇒ auto-advance 走既有跳歌自愈(失败矩阵:显式失败 ⇒ 跳下一首)。
import { describe, it, expect, afterEach } from "vitest";
import { GroupPump, overridePumpSource } from "./streamEngine.js";

function stubGroup() {
  let finished = 0;
  const group: any = {
    positionMs: 0,
    timelineBaseUs: 0n,
    current: { songId: "s", durationMs: 311_000 } as any,
    commonSendAheadUs: () => 800_000,
    finishPlayback() {
      finished++;
    },
    async pushFrame(_ts: bigint, pcm: Float32Array) {
      return Math.floor(pcm.length / 2);
    },
  };
  return { group, finishedAt: () => finished };
}

async function waitInactive(pump: GroupPump, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (!pump.active) return;
    if (Date.now() - t0 > ms) throw new Error(`pump 未结束: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

afterEach(() => overridePumpSource(null));

describe("GroupPump 异常终止(假在播根源修复守卫)", () => {
  it("推帧中途异常:清 current + finishPlayback,poll 不再报 playing", async () => {
    overridePumpSource(async () => ({ pcm: new Float32Array(48000 * 2 * 2), durationMs: 2000 }));
    const { group, finishedAt } = stubGroup();
    let pushes = 0;
    group.pushFrame = async (_ts: bigint, pcm: Float32Array) => {
      pushes++;
      if (pushes >= 3) throw new Error("upstream died mid-stream"); // 模拟流中途死亡
      return Math.floor(pcm.length / 2);
    };
    const pump = new GroupPump({ log() {} } as any, group);
    await pump.play("s3").catch(() => { /* play 可能向上传播,pushLoop 收尾已兜 */ });
    await waitInactive(pump, 8000, "推帧异常");
    // 旧代码此处 group.current 残留 → pollCore playing 恒 true → 群组永久假在播
    expect(group.current).toBeNull();
    expect(finishedAt()).toBe(1);
  }, 15000);

  it("异常终止后 pollCore 视角:playing=false(可被 auto-advance 正常切歌)", async () => {
    overridePumpSource(async () => ({ pcm: new Float32Array(48000 * 2 * 2), durationMs: 2000 }));
    const { group } = stubGroup();
    let pushes = 0;
    group.pushFrame = async (_ts: bigint, pcm: Float32Array) => {
      pushes++;
      if (pushes >= 2) throw new Error("source unreachable");
      return Math.floor(pcm.length / 2);
    };
    const pump = new GroupPump({ log() {} } as any, group);
    await pump.play("s4").catch(() => {});
    await waitInactive(pump, 8000, "异常终止");
    // pollCore 的判定式:`playing: !!g.current` —— 此处必须为 false
    expect(!!group.current).toBe(false);
  }, 15000);
});
