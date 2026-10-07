// pushLoop 降级上限(2026-10-07 240 生产实锤):编码器死亡后旧实现无限降级推进,
// 把剩余整首推成静音(进度照走、切歌才恢复)。锁定:持续零产出超过
// MAX_SILENT_DEGRADE ⇒ 提前按自然播完收场(endedNaturally → finishPlayback →
// 自动切歌),绝不整首默剧。
import { describe, it, expect } from "vitest";
import { GroupPump, overridePumpSource } from "./streamEngine.js";

describe("GroupPump 编码器死亡兜底", () => {
  it("持续零产出:到达降级上限即提前收场并 finishPlayback(不再整首默剧)", async () => {
    // 上限取 500ms(= STALL_GRACE 下限);虚拟时间 20 帧(25ms/帧)即触顶。
    process.env.SENDSPIN_MAX_SILENT_DEGRADE_MS = "500";
    let finished = 0;
    const group: any = {
      positionMs: 0,
      timelineBaseUs: 0n,
      current: null as any,
      commonSendAheadUs: () => 800_000,
      async pushFrame() { return 0; }, // 死编码器:永远零产出
      finishPlayback() { finished++; },
    };
    // 元数据 60s ≫ 实际 PCM 3s:若降级上限失效,循环会按墙钟跑满或提前 EOF,
    // 都到不了「500ms 零产出即收场」这条路径的可观测差异 —— 断言看总耗时与收场方式。
    overridePumpSource(async () => ({ pcm: new Float32Array(48000 * 2 * 3), durationMs: 60000 }));
    const pump = new GroupPump({ log() {} } as any, group);
    await pump.play("dead");
    const t0 = Date.now();
    for (;;) {
      if (!pump.active) break;
      if (Date.now() - t0 > 8000) throw new Error("pump 未提前收场(降级上限未生效?)");
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(Date.now() - t0).toBeLessThan(6000); // 远小于 60s 元数据时长 ⇒ 提前收场
    expect(finished).toBe(1);                   // 按自然播完收场 → 自动切歌
    expect(group.current).toBeNull();
  }, 15000);
});
