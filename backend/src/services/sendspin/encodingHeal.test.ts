// FLAC 编码器自愈(2026-10-07 240 生产实锤):libFLAC process_interleaved 中途返回
// false 后,旧实现只 warn + 静默放空 —— pushLoop 降级推进把剩余整首推成静音
// (@frame=0/638/2565 三次爆发、3.2 万行日志,切歌才恢复)。本文件锁定自愈契约:
//   1. 单次失败 → 原地重建 + 同批重编,调用方无感(无缝续流);
//   2. 实例重建失败(asm.js 堆楔死,@frame=0 形态)→ 模块级重载后重试成功;
//   3. 彻底失败 → unhealthy + 退避放空(交给 pushLoop 降级上限提前切歌)。
import { describe, it, expect } from "vitest";
import { LibFlacEncoder, type LibFlacModule } from "./encoding.js";

type FakeState = { processCalls: number; creates: number; deletes: number };

/** 可编排失败的假 libFLAC 模块:
 *  - failProcessCalls:前 N 次 process 返回 false;
 *  - failCreatesFrom:第 N 次 create 起返回 0(模拟堆楔死);
 *  - next:reloadModule 应返回的「新模块」(模块级重载后的替身)。 */
function fakeFlac(opts: {
  failProcessCalls?: number;
  failCreatesFrom?: number;
  next?: FakeFlac | null;
}): FakeFlac {
  const state: FakeState = { processCalls: 0, creates: 0, deletes: 0 };
  const mod: any = {
    isReady: () => true,
    create_libflac_encoder: () => {
      state.creates++;
      return opts.failCreatesFrom !== undefined && state.creates >= opts.failCreatesFrom ? 0 : 1;
    },
    init_encoder_stream: (_id: number, write: any) => {
      mod.__write = write;
    },
    FLAC__stream_encoder_process_interleaved: (_id: number, _pcm: Int32Array, samples: number) => {
      state.processCalls++;
      if (state.processCalls <= (opts.failProcessCalls ?? 0)) return false;
      const buf = new Uint8Array(16);
      buf[0] = 0xff; // 首字节 0xFF → 走音频帧分支
      mod.__write?.(buf, buf.length, samples, 1);
      return true;
    },
    FLAC__stream_encoder_finish: () => true,
    FLAC__stream_encoder_delete: () => {
      state.deletes++;
      return true;
    },
  };
  mod.__state = state;
  mod.__next = opts.next ?? null;
  return mod as FakeFlac;
}
type FakeFlac = LibFlacModule & { __state: FakeState; __next: FakeFlac | null; __write?: any };

function pcmBlock(): Float32Array {
  return new Float32Array(4096 * 2); // 一整块(单声道 4096 样本)
}

describe("LibFlacEncoder 自愈", () => {
  it("单次 process 失败:原地重建 + 同批重编,调用方无感拿到帧(无缝续流)", async () => {
    const mod = fakeFlac({ failProcessCalls: 1 });
    const enc = new LibFlacEncoder(mod, () => null);
    const chunks = await enc.encode(pcmBlock());
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].frameSamples).toBe(4096);
    expect(mod.__state.deletes).toBeGreaterThanOrEqual(1); // 确有重建
    expect(enc.isHealthy()).toBe(true);
    // 下一批照常产出(连续性)
    const chunks2 = await enc.encode(pcmBlock());
    expect(chunks2.length).toBeGreaterThan(0);
  });

  it("实例重建失败(堆楔死):模块级重载后重编成功", async () => {
    const good = fakeFlac({});
    const bad = fakeFlac({ failProcessCalls: 1, failCreatesFrom: 2, next: good });
    const enc = new LibFlacEncoder(bad, () => good);
    const chunks = await enc.encode(pcmBlock());
    expect(chunks.length).toBeGreaterThan(0); // 重载后的新模块编出来的
    expect(good.__state.creates).toBe(1);      // 确实用了新模块
    expect(enc.isHealthy()).toBe(true);
  });

  it("彻底失败:unhealthy + 退避放空,不抛错(pumpLoop 兜底切歌)", async () => {
    const bad = fakeFlac({ failProcessCalls: 999999, next: null });
    const enc = new LibFlacEncoder(bad, () => null);
    const chunks = await enc.encode(pcmBlock());
    expect(chunks).toEqual([]);
    expect(enc.isHealthy()).toBe(false);
    // 退避窗口内的下一次调用立即放空(不再触发重建)
    const before = bad.__state.creates;
    const chunks2 = await enc.encode(pcmBlock());
    expect(chunks2).toEqual([]);
    expect(bad.__state.creates).toBe(before);
  });
});
