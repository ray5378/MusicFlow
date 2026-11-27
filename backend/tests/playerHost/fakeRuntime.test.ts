import { describe, it, expect, afterEach } from "vitest";
import { FakeRuntime } from "../../src/services/playerHost/fakeRuntime.js";

// P0 假播放器运行时：无真实设备验证「每播放器一进程」宿主能力。
// 注意：status() 的 stall 判定依赖真实时间（idleMs > 2000），这里用短 sleep 或直接构造状态验证。
describe("FakeRuntime（假播放器运行时）", () => {
  afterEach(() => { delete process.env.MF_FAKE_STALL_MS; });

  function prepare(r: FakeRuntime, rate = 48000, shiftUs = 0) {
    r.prepare({ t: "prepare", playerId: "p1", rate, shiftUs, codec: "pcm", anchorUs: 0, gen: 1 } as any);
  }

  it("prepare 后进入 live、gen 递增", () => {
    const r = new FakeRuntime();
    expect(r.status().state).toBe("idle");
    prepare(r);
    const s = r.status();
    expect(s.state).toBe("live");
    expect(s.gen).toBe(1);
    prepare(r, 44100, 123);
    expect(r.status().gen).toBe(2);
  });

  it("pcm 收帧推进 watermarkUs、framesOut、inQueueMs", () => {
    const r = new FakeRuntime();
    prepare(r, 48000);
    r.pcm({ t: "pcm", tsUs: 1_000_000, nFrames: 4800, data: Buffer.alloc(0) } as any); // 0.1s 帧
    const s = r.status();
    expect(s.framesOut).toBe(1);
    expect(s.watermarkUs).toBe(1_000_000 + 100_000);
  });

  it("anchor/shift 更新水位与 shift", () => {
    const r = new FakeRuntime();
    prepare(r);
    r.anchor(5_000_000, 9);
    expect(r.status().gen).toBe(9);
    expect(r.status().watermarkUs).toBe(5_000_000);
    r.shift(1000);
    expect(r.status().gen).toBe(9);
  });

  it("flush 重置 inQueue，stop 进入 closing", () => {
    const r = new FakeRuntime();
    prepare(r);
    r.pcm({ t: "pcm", tsUs: 0, nFrames: 4800, data: Buffer.alloc(0) } as any);
    r.flush(3);
    expect(r.status().gen).toBe(3);
    expect(r.status().inQueueMs).toBe(0);
    r.stop();
    expect(r.status().state).toBe("closing");
  });

  it("volume/mute 是 no-op，不影响状态", () => {
    const r = new FakeRuntime();
    prepare(r);
    expect(() => { r.volume(-6); r.mute(false); }).not.toThrow();
    expect(r.status().state).toBe("live");
  });

  it("status 返回的字段齐全（父进程据此判活）", () => {
    const r = new FakeRuntime();
    prepare(r);
    const s = r.status();
    expect(s).toMatchObject({
      t: "status", gen: 1, state: "live", queueMs: 0,
      inQueueMs: 0, underruns: 0, lastUnderrunMs: 0, watermarkUs: 0, framesOut: 0,
    });
  });
});
