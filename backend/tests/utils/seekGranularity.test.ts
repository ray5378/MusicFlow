import { describe, it, expect } from "vitest";
import { alignSeekSeconds, SEEK_GRANULARITY_SEC } from "../../src/utils/seekGranularity.js";

/** sendspin 流式引擎的帧栅格宽度(见 services/sendspin/streamEngine.ts 的 FRAME_MS)。 */
const FRAME_MS = 25;

describe("alignSeekSeconds(拖动 seek 目标的精度守卫:最小粒度 1 秒)", () => {
  it("任意精度一律向下取整到整秒(与客户端 Duration.inSeconds 同语义)", () => {
    expect(alignSeekSeconds(31.178)).toBe(31);
    expect(alignSeekSeconds(30.178)).toBe(30);
    expect(alignSeekSeconds(87.033)).toBe(87);
    // 关键:是**向下取整**而不是四舍五入 —— 客户端 inSeconds 就是截断,
    // 两端必须逐位一致,否则同一落点在客户端与网页上会落到不同的秒。
    expect(alignSeekSeconds(31.999)).toBe(31);
    expect(alignSeekSeconds(0.9)).toBe(0);
  });

  it("整秒输入是恒等变换(客户端那条「一直正常」的路径零行为变更)", () => {
    // 现场日志里客户端下发的实际值(全部整秒)——修复不得改变它们。
    for (const s of [0, 37, 49, 62, 83, 108, 111]) {
      expect(alignSeekSeconds(s)).toBe(s);
    }
  });

  it("对齐结果恒落在 25ms 帧栅格上(与 streamEngine 的硬契约)", () => {
    // 帧栅格取帧 lo = floor(pos / FRAME_MS) * frameSamples,
    // 而窗口基准 baseSample = floor(pos / 1000 * SR * CH) —— 只有 pos 是 25ms
    // 整数倍时两者严格相等;否则 slice() 判淘汰 → 游标不前进 → 纯微任务自旋
    // → 事件循环饿死 → 65s 看门狗 SIGKILL。整秒必然满足(1000 / 25 = 40)。
    for (const raw of [1, 12.345, 31.178, 87.033, 108.999, 3599.4]) {
      const aligned = alignSeekSeconds(raw);
      expect((aligned * 1000) % FRAME_MS).toBe(0);
      // 代价上界:截断误差 < 1 秒(且恒为「偏小」,与客户端同向)。
      expect(raw - aligned).toBeGreaterThanOrEqual(0);
      expect(raw - aligned).toBeLessThan(SEEK_GRANULARITY_SEC);
    }
  });

  it("负数/非有限值一律归 0(调用方无需再钳下限)", () => {
    expect(alignSeekSeconds(-1)).toBe(0);
    expect(alignSeekSeconds(-0.001)).toBe(0);
    expect(alignSeekSeconds(NaN)).toBe(0);
    expect(alignSeekSeconds(Infinity)).toBe(0);
    expect(alignSeekSeconds(-Infinity)).toBe(0);
  });

  it("粒度常量必须是 1 秒(改它即改跨端契约,守卫会拦)", () => {
    expect(SEEK_GRANULARITY_SEC).toBe(1);
  });
});
