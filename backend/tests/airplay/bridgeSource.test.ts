import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import {
  BridgeSource,
  computeBridgeBackoffMs,
  type BridgeSocketLike,
} from "../../src/services/airplay/bridgeSource.js";

/** 测试 socket 桩:模拟 Node writable 语义 —— write() 无论返回值如何,数据都已被
 *  接收进流缓冲;false 仅表示越过 high-water(等 drain 后才能继续写)。 */
class StubSocket extends EventEmitter implements BridgeSocketLike {
  written: Buffer[] = [];
  failWrites = false;
  destroyed = false;

  write(data: Uint8Array): boolean {
    if (this.destroyed) throw new Error("write after destroy");
    this.written.push(Buffer.from(data));
    return !this.failWrites;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }

  /** 模拟内核缓冲排空。 */
  emitDrain(): void {
    this.failWrites = false;
    this.emit("drain");
  }
}

interface Harness {
  src: BridgeSource;
  sockets: StubSocket[];
  states: string[];
  backpressures: number[];
  hardCaps: number[];
  connectError: Error | null;
}

function makeHarness(opts: {
  failWrites?: boolean;
  connectError?: Error;
  highWaterMs?: number;
  hardCapMs?: number;
  schedule?: (fn: () => void, ms: number) => () => void;
} = {}): Harness {
  const h: Harness = { src: null as unknown as BridgeSource, sockets: [], states: [], backpressures: [], hardCaps: [], connectError: null };
  let connected = false;
  h.src = new BridgeSource({
    connect: async () => {
      if (opts.connectError) throw opts.connectError;
      connected = true;
      const sock = new StubSocket();
      sock.failWrites = opts.failWrites ?? false;
      h.sockets.push(sock);
      return sock;
    },
    onConnected: () => { /* CONFIG 由上层发;此处空实现 */ },
    onStateChange: (state) => h.states.push(state),
    onBackpressure: (ms) => h.backpressures.push(ms),
    onHardCap: (ms) => h.hardCaps.push(ms),
    highWaterMs: opts.highWaterMs,
    hardCapMs: opts.hardCapMs,
    schedule: opts.schedule,
  });
  void connected;
  return h;
}

function frameOf(len: number): Buffer {
  return Buffer.alloc(len, 1);
}

async function until(cond: () => boolean, what: string): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > 2000) throw new Error(`until timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("bridgeSource:队列与 drain(§4.4)", () => {
  it("逐帧写出;write()=false 停住等 drain,drain 后续传且不丢帧", async () => {
    const h = makeHarness();
    h.src.start();
    await until(() => h.src.state === "live", "live");

    const a = frameOf(10);
    const b = frameOf(20);
    h.src.enqueue(a);
    h.src.enqueue(b);
    expect(h.sockets[0]!.written.length).toBe(2);
    expect(h.src.stats().queuedBytes).toBe(0);
    expect(h.src.stats().sentFrames).toBe(2);

    // socket 背压:write 返回 false → 该帧已被接收,但暂停后续帧,等 drain
    const sock = h.sockets[0]!;
    sock.failWrites = true;
    const c = frameOf(30);
    const d = frameOf(40);
    h.src.enqueue(c);
    expect(sock.written.length).toBe(3); // c 已交给 socket(被接收)
    expect(h.src.stats().queuedBytes).toBe(0);
    h.src.enqueue(d);
    expect(sock.written.length).toBe(3); // d 滞留队列,等 drain
    expect(h.src.stats().queuedBytes).toBe(40);
    sock.emitDrain();
    expect(sock.written.length).toBe(4);
    expect(h.src.stats().queuedBytes).toBe(0);
    // 字节序保持 FIFO
    expect(Buffer.compare(sock.written[2]!, c)).toBe(0);
    expect(Buffer.compare(sock.written[3]!, d)).toBe(0);
  });
});

describe("bridgeSource:水位判定(MIN-05,按秒计量)", () => {
  it("超高水位只告警不断连(状态保持 live),上行跨越只回调一次", async () => {
    // 192000B/s:highWater 2s = 384000B;首帧 write=false 后续帧滞留队列
    const h = makeHarness({ failWrites: true, highWaterMs: 2000, hardCapMs: 8000 });
    h.src.start();
    await until(() => h.src.state === "live", "live");

    h.src.enqueue(frameOf(192_000)); // 首帧已交付 socket:排队 0s
    expect(h.backpressures.length).toBe(0);
    h.src.enqueue(frameOf(192_000)); // 滞留 1s:未越线
    expect(h.backpressures.length).toBe(0);
    h.src.enqueue(frameOf(192_000)); // 滞留 2s:未越(严格大于)
    expect(h.backpressures.length).toBe(0);
    h.src.enqueue(frameOf(192_000)); // 滞留 3s:越线,告警一次
    expect(h.backpressures.length).toBe(1);
    expect(h.backpressures[0]).toBeCloseTo(3000, 0);
    h.src.enqueue(frameOf(192_000)); // 滞留 4s:仍在水位上,不重复告警
    expect(h.backpressures.length).toBe(1);
    expect(h.src.state).toBe("live");
    expect(h.sockets[0]!.destroyed).toBe(false);
    expect(h.src.stats().maxQueueMs).toBeGreaterThanOrEqual(4000);
  });

  it("超硬上限断连不丢帧:socket destroy → stalled,滞留帧原样保留", async () => {
    // hardCap 8s = 1536000B;每帧 480000B(2.5s);首帧交付后其余滞留
    const scheduled: number[] = [];
    const h = makeHarness({
      failWrites: true,
      highWaterMs: 2000,
      hardCapMs: 8000,
      schedule: (fn, ms) => {
        scheduled.push(ms);
        return () => {}; // 手动触发,不自动重连
      },
    });
    h.src.start();
    await until(() => h.src.state === "live", "live");

    h.src.enqueue(frameOf(480_000)); // 交付,排队 0
    h.src.enqueue(frameOf(480_000)); // 滞留 2.5s
    h.src.enqueue(frameOf(480_000)); // 滞留 5s
    h.src.enqueue(frameOf(480_000)); // 滞留 7.5s:未越
    expect(h.hardCaps.length).toBe(0);
    h.src.enqueue(frameOf(480_000)); // 滞留 10s:越线
    expect(h.hardCaps.length).toBe(1);
    expect(h.sockets[0]!.destroyed).toBe(true);
    expect(h.src.state).toBe("stalled");
    // 不丢帧:滞留帧原样保留(交付过的 1 帧已由 socket 缓冲接收)
    expect(h.src.stats().queuedFrames).toBe(4);
    expect(h.src.stats().queuedBytes).toBe(480_000 * 4);
    expect(h.src.stats().sentFrames).toBe(1);
    // 重连已按注入退避调度
    expect(scheduled.length).toBe(1);
  });
});

describe("bridgeSource:状态机与退避重连", () => {
  it("live → stalled → connecting → live,重连后队列续传", async () => {
    let fire: (() => void) | null = null;
    const states: string[] = [];
    const sockets: StubSocket[] = [];
    let attempts = 0;
    const src = new BridgeSource({
      connect: async () => {
        attempts++;
        const sock = new StubSocket();
        sock.failWrites = attempts === 1; // 第一次带背压,便于触发硬上限
        sockets.push(sock);
        return sock;
      },
      onConnected: () => undefined,
      onStateChange: (s) => states.push(s),
      backoffDelayMs: () => 123,
      schedule: (fn, ms) => {
        expect(ms).toBe(123);
        fire = fn;
        return () => { fire = null; };
      },
      hardCapMs: 8000,
    });
    src.start();
    await until(() => src.state === "live", "live#1");
    // 硬上限断连(首帧交付,后 5 帧滞留:5×2.5s=12.5s > 8s)
    for (let i = 0; i < 6; i++) src.enqueue(frameOf(480_000));
    expect(src.state).toBe("stalled");
    expect(fire).not.toBeNull();
    // 退避到期 → connecting → live
    (fire as () => void)();
    await until(() => src.state === "live", "live#2");
    expect(attempts).toBe(2);
    expect(states).toEqual(["connecting", "live", "stalled", "connecting", "live"]);
    // 断连前的滞留帧不丢:换新 socket 后续传(1 帧已交付旧 socket,5 帧滞留)
    expect(src.stats().sentFrames).toBe(6);
    expect(src.stats().reconnects).toBe(1);
    expect(src.stats().queuedBytes).toBe(0);
    expect(sockets[1]!.written.length).toBe(5);
    src.stop();
  });

  it("connect 失败同样进退避调度,成功后 attempt 归零", async () => {
    let fire: (() => void) | null = null;
    const delays: number[] = [];
    const sockets: StubSocket[] = [];
    let failNext = true;
    const src = new BridgeSource({
      connect: async () => {
        if (failNext) throw new Error("ECONNREFUSED");
        const sock = new StubSocket();
        sockets.push(sock);
        return sock;
      },
      onConnected: () => undefined,
      backoffDelayMs: () => 5,
      schedule: (fn, ms) => {
        delays.push(ms);
        fire = fn;
        return () => { fire = null; };
      },
    });
    src.start();
    await until(() => src.state === "stalled", "stalled#1");
    (fire as () => void)();
    await until(() => src.state === "stalled", "stalled#2");
    expect(delays).toEqual([5, 5]);
    failNext = false;
    (fire as () => void)();
    await until(() => src.state === "live", "live");
    // 成功后重试序号归零:再断连,退避重新从注入的小值开始
    sockets[0]!.destroy();
    await until(() => src.state === "stalled", "stalled#3");
    expect(delays).toEqual([5, 5, 5]);
    src.stop();
  });
});

describe("bridgeSource:stop 与默认退避", () => {
  it("stop 后不再重连,状态 idle,可重新 start", async () => {
    const h = makeHarness({ failWrites: true });
    h.src.start();
    await until(() => h.src.state === "live", "live");
    h.src.stop();
    expect(h.src.state).toBe("idle");
    // 断连不触发重连(stopping)
    h.sockets[0]!.destroy();
    expect(h.src.state).toBe("idle");
    h.src.start();
    await until(() => h.src.state === "live", "live#2");
    h.src.stop();
  });

  it("computeBridgeBackoffMs:指数 + ±20% 抖动 + 30s 封顶(含封顶后抖动仍不超上限)", () => {
    expect(computeBridgeBackoffMs(1, 0)).toBe(4000);      // 5s × 0.8
    expect(computeBridgeBackoffMs(1, 1)).toBe(6000);      // 5s × 1.2
    expect(computeBridgeBackoffMs(2, 0.5)).toBe(10000);   // 10s × 1.0
    expect(computeBridgeBackoffMs(3, 0.5)).toBe(20000);
    expect(computeBridgeBackoffMs(5, 0.5)).toBe(30000);   // 封顶
    expect(computeBridgeBackoffMs(9, 1)).toBe(30000);     // 封顶后抖动不越上限
    expect(computeBridgeBackoffMs(0, 0.5)).toBe(5000);    // attempt<1 归一为 1
  });
});

describe("bridgeSource:泵未在跑的过渡期 closed 即时重连(修法②a)", () => {
  it("closed 时泵空闲 → 0ms 即时重连(不进退避);connect 失败照常退避;播中 closed 恢复退避", async () => {
    const delays: number[] = [];
    let fire: (() => void) | null = null;
    let failNext = false;
    let idle = true;
    const sockets: StubSocket[] = [];
    const src = new BridgeSource({
      connect: async () => {
        if (failNext) throw new Error("ECONNREFUSED");
        const sock = new StubSocket();
        sockets.push(sock);
        return sock;
      },
      onConnected: () => undefined,
      backoffDelayMs: () => 123,
      immediateReconnectOnClosed: () => idle,
      schedule: (fn, ms) => {
        delays.push(ms);
        fire = fn;
        return () => { fire = null; };
      },
    });
    src.start();
    await until(() => src.state === "live", "live");
    // ① 过渡期 closed(泵未在跑)→ 0ms 即时重连
    failNext = true;
    sockets[0]!.destroy();
    await until(() => src.state === "stalled", "stalled#1");
    expect(delays).toEqual([0]);
    // ② 对端监听未就绪 → connect 失败照常退避(不热循环)
    (fire as () => void)();
    await until(() => src.state === "stalled", "stalled#2");
    expect(delays).toEqual([0, 123]);
    // ③ 重连成功 → 播中 closed(泵在跑)→ 正常退避
    failNext = false;
    (fire as () => void)();
    await until(() => src.state === "live", "live#2");
    idle = false;
    sockets[1]!.destroy();
    await until(() => src.state === "stalled", "stalled#3");
    expect(delays).toEqual([0, 123, 123]);
    src.stop();
  });
});
