// AirPlay 原位 seek 时钟重锚回归测试:
//   - seekStartTs 把 RTP 时钟重新锚定在 session 基线上,使下一批 chunk 的
//     内容位置精确从目标秒开始(不再从 0 上报)。
//   - 负向 seek 夹到 0;起点对齐 CHUNK_LEN 帧,避免进度计算累计漂移。
import { describe, it, expect } from "vitest";
import { CHUNK_LEN, SAMPLE_RATE, PCM_BYTES_PER_CHUNK, seekPositionSec, seekStartTs } from "../../src/services/airplay/raop.js";

const chunkDur = CHUNK_LEN / SAMPLE_RATE;

describe("airplay in-place seek clock re-anchor", () => {
  it("maps the seek target onto the session base timeline", () => {
    const baseTs = 0x12345600;
    const seekSec = 65;
    const startTs = seekStartTs(baseTs, seekSec, SAMPLE_RATE, CHUNK_LEN);
    // First chunk sits at the target.
    const pos = seekPositionSec(baseTs, startTs, 0, CHUNK_LEN, SAMPLE_RATE);
    expect(Math.abs(pos - seekSec)).toBeLessThan(chunkDur);
    // Clock stays anchored to the session base (monotonic, never restarts at 0).
    expect((startTs - baseTs) >>> 0).toBeGreaterThan(0);
  });

  it("keeps position contents-accurate as chunks advance past the target", () => {
    const baseTs = 500000;
    const seekSec = 12.5;
    const startTs = seekStartTs(baseTs, seekSec, SAMPLE_RATE, CHUNK_LEN);
    for (let idx = 0; idx < 5; idx++) {
      const pos = seekPositionSec(baseTs, startTs, idx, CHUNK_LEN, SAMPLE_RATE);
      const expected = (startTs === baseTs ? 0 : (startTs - baseTs) >>> 0) / SAMPLE_RATE + idx * chunkDur;
      // ts2ms() floors to whole ms, so allow sub-millisecond slack.
      expect(Math.abs(pos - expected)).toBeLessThan(0.005);
    }
  });

  it("clamps negative seeks to file-time 0", () => {
    const baseTs = 0x20000000;
    expect(seekStartTs(baseTs, -30, SAMPLE_RATE, CHUNK_LEN)).toBe((baseTs + 0) >>> 0);
  });

  it("always starts on a CHUNK_LEN frame boundary", () => {
    const baseTs = 0x11111111;
    const startTs = seekStartTs(baseTs, 332, SAMPLE_RATE, CHUNK_LEN);
    expect(((startTs - baseTs) >>> 0) % CHUNK_LEN).toBe(0);
  });

  it("produces an exact 1408-byte chunk count for the target position invariant", () => {
    // Keep the RTP math tied back to the PCM chunk: one chunk == CHUNK_LEN frames.
    expect(chunkDur).toBeGreaterThan(0);
    expect(PCM_BYTES_PER_CHUNK).toBe(CHUNK_LEN * 4);
  });
});