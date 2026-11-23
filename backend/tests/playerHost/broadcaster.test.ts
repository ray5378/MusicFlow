import { describe, expect, it } from "vitest";
import { GroupBroadcaster, type BroadcastFrame } from "../../src/services/playerHost/broadcaster.js";

const f = (ts: number): BroadcastFrame => ({ tsUs: ts, nFrames: 480, data: new Uint8Array(8) });

describe("GroupBroadcaster — 一次解码、N 路独立投递", () => {
  it("同一帧广播到所有 sink，各 sink 投递计数独立", () => {
    const bc = new GroupBroadcaster();
    const a: number[] = [];
    const b: number[] = [];
    bc.addSink("A", { push: (fr) => (a.push(fr.tsUs), true) });
    bc.addSink("B", { push: (fr) => (b.push(fr.tsUs), true) });
    bc.broadcast(f(1_000));
    bc.broadcast(f(2_000));
    bc.flush();
    expect(a).toEqual([1_000, 2_000]);
    expect(b).toEqual([1_000, 2_000]);
    expect(bc.stats().A.delivered).toBe(2);
    expect(bc.stats().B.delivered).toBe(2);
  });

  it("慢 sink 只阻塞自己：快 sink 照常推进，慢的积压不丢", () => {
    const bc = new GroupBroadcaster();
    const fast: number[] = [];
    let slowAllowed = false;
    bc.addSink("fast", { push: (fr) => (fast.push(fr.tsUs), true) });
    bc.addSink("slow", { push: () => slowAllowed });
    for (let i = 0; i < 10; i++) bc.broadcast(f(i * 1_000));
    bc.flush();
    expect(fast).toHaveLength(10);
    expect(bc.stats().slow.delivered).toBe(0);
    expect(bc.stats().slow.queued).toBe(10);

    slowAllowed = true;
    bc.flush();
    expect(bc.stats().slow.delivered).toBe(10);
  });

  it("队列超上限丢最旧（保实时，不追历史）", () => {
    const bc = new GroupBroadcaster();
    bc.addSink("cap", { push: () => false, maxQueue: 3 });
    for (let i = 0; i < 6; i++) bc.broadcast(f(i * 1_000));
    const st = bc.stats().cap;
    expect(st.queued).toBe(3);
    expect(st.dropped).toBe(3);
  });

  it("sink.push 抛异常不影响其他 sink", () => {
    const bc = new GroupBroadcaster();
    const got: number[] = [];
    bc.addSink("bad", { push: () => { throw new Error("boom"); } });
    bc.addSink("ok", { push: (fr) => (got.push(fr.tsUs), true) });
    bc.broadcast(f(5_000));
    bc.flush();
    expect(got).toEqual([5_000]);
    expect(bc.stats().bad.delivered).toBe(0);
  });

  it("resetAll 清空所有队列（换代重锚）", () => {
    const bc = new GroupBroadcaster();
    bc.addSink("A", { push: () => false });
    bc.broadcast(f(1));
    bc.broadcast(f(2));
    expect(bc.stats().A.queued).toBe(2);
    bc.resetAll();
    expect(bc.stats().A.queued).toBe(0);
  });
});
