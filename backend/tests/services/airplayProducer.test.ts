// AirPlay producer 有界 PCM 缓冲(背压)回归测试:
//   - makeProducer 让 ffmpeg 满速解码,但缓冲超过 MAX_BUFFER_BYTES(10s)
//     必须 pause ffmpeg stdout;低于低水位(RESUME_BUFFER_BYTES)必须 resume。
//   - 防止"整首歌进内存"回归(长曲目无上限时最坏缓冲 ~1.2GB)。
// 不依赖 DB/网络:用 MockStdout(event emitter + pause/resume)驱动 producer。
import { describe, it, expect } from "vitest";
import { EventEmitter } from "events";
import { makeProducer } from "../../src/services/airplay/control.js";
import { PCM_BYTES_PER_CHUNK, SAMPLE_RATE } from "../../src/services/airplay/raop.js";

const BYTES_PER_SEC = SAMPLE_RATE * 2 * 2; // 176400 s16le stereo
const MAX_BUFFER_BYTES = Math.round((10_000 / 1000) * BYTES_PER_SEC);
const RESUME_BUFFER_BYTES = Math.round(MAX_BUFFER_BYTES / 2);
const chunkBytes = PCM_BYTES_PER_CHUNK; // 1408
const capChunks = Math.ceil(MAX_BUFFER_BYTES / chunkBytes);

class MockStdout extends EventEmitter {
  paused = false;
  pauseCalls = 0;
  resumeCalls = 0;
  pause(): void { this.paused = true; this.pauseCalls++; }
  resume(): void { this.paused = false; this.resumeCalls++; }
  isPaused(): boolean { return this.paused; }
}

class MockFf {
  stdout = new MockStdout();
  on(): this { return this; } // swallow 'exit' registration
}

describe("airplay producer bounded PCM buffer", () => {
  it("pauses ffmpeg stdout at the cap and resumes below low-water", async () => {
    const ff = new MockFf();
    const producer = makeProducer(ff as any);

    for (let i = 0; i < capChunks + 2; i++) {
      ff.stdout.emit("data", Buffer.alloc(chunkBytes));
    }
    expect(ff.stdout.pauseCalls).toBeGreaterThan(0);
    expect(ff.stdout.isPaused()).toBe(true);

    let iters = 0;
    while (ff.stdout.isPaused() && iters < 10000) {
      await producer();
      iters++;
    }
    expect(ff.stdout.resumeCalls).toBeGreaterThan(0);
    expect(ff.stdout.isPaused()).toBe(false);
    // Low-water is half the cap — only ~capChunks/2 pulls were needed, not the
    // whole track's worth of buffered chunks.
    expect(iters).toBeLessThan(capChunks);
  });

  it("returns PCM chunks in order then EOF null", async () => {
    const ff = new MockFf();
    const producer = makeProducer(ff as any);

    const payloads = [1, 2, 3].map((n) => Buffer.alloc(chunkBytes, n));
    for (const p of payloads) ff.stdout.emit("data", p);
    ff.stdout.emit("end");

    for (let i = 0; i < 3; i++) {
      const c = await producer();
      expect(c).not.toBeNull();
      expect(c![0]).toBe(payloads[i][0]);
    }
    expect(await producer()).toBeNull();
  });

  it("keeps streaming while feeding continues (no backpressure deadlock)", async () => {
    const ff = new MockFf();
    const producer = makeProducer(ff as any);

    for (let i = 0; i < capChunks + 5; i++) {
      ff.stdout.emit("data", Buffer.alloc(chunkBytes, i % 256));
    }
    expect(ff.stdout.isPaused()).toBe(true);

    let pulls = 0;
    let refeeds = 0;
    while (ff.stdout.isPaused() && pulls < 100000) {
      for (let k = 0; k < 200; k++) {
        const c = await producer();
        expect(c).not.toBeNull();
      }
      pulls += 200;
      // ffmpeg is still blocked on the pipe: as long as we're paused, keep
      // "decoding" more data in the background (real stdout events).
      for (let k = 0; k < 100; k++) ff.stdout.emit("data", Buffer.alloc(chunkBytes, k));
      refeeds++;
    }

    expect(ff.stdout.isPaused()).toBe(false);
    expect(ff.stdout.resumeCalls).toBeGreaterThan(0);

    // Post-resume the pipeline still delivers chunks (deadlock-free).
    ff.stdout.emit("data", Buffer.alloc(chunkBytes, 9));
    const c = await producer();
    expect(c).not.toBeNull();
    expect(pulls).toBeGreaterThan(0);
    expect(refeeds).toBeGreaterThan(0);
  });
});