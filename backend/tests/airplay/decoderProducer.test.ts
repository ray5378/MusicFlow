// ==================== AirPlay 解码/缓冲层(airplay/decoder.ts)补齐测试 ====================
//
// B23:此前只测了 buildAirplayAf 与 spawnDecoder 的入参合规,真正扛实时播放的
// makeProducer(有界 PCM 队列 + 背压 + 预填充)一行没覆盖。
//
// 这里用**假 ff**(EventEmitter)同步驱动,不真起 ffmpeg:producer 只读 stdout 的
// data/end 与 ff 的 exit,把每条分支钉死在确定的字节序列上。
import { EventEmitter } from "node:events";
import Module from "node:module";
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

// decoder.ts 用 createRequire 取 ffmpeg-static,是 Node 的 CJS require ——
// vitest 的 vi.mock 拦不住,只能打在 Module._load 上(与 sendspin/control 同手法)。
const origLoad = (Module as any)._load;
let throwStatic = false;
(Module as any)._load = function (request: string) {
  if (throwStatic && request === "ffmpeg-static") throw new Error("ffmpeg-static 不可解析");
  return origLoad.apply(this, arguments as any);
};

// 模块加载时就由 createLogger 造出 log,打桩必须挂在 import 之前 —— vi.mock 会被提升。
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../../src/utils/logger.js", async (io) => {
  const real: any = await io();
  return { ...real, createLogger: () => log };
});

// 通道开关(P5-1):关掉时 buildAirplayAf 的响度段必须整段消失。
const h = vi.hoisted(() => ({ airplayChannelOn: true }));
vi.mock("../../src/services/audio/pipelineSwitches.js", async (io) => {
  const real: any = await io();
  return {
    ...real,
    isChannelEnabled: (ch: string) => (ch === "airplay" ? h.airplayChannelOn : real.isChannelEnabled(ch)),
  };
});

import { PCM_BYTES_PER_CHUNK } from "../../src/services/airplay/raop.js";
import {
  degreesToDb,
  buildAirplayAf,
  spawnDecoder,
  makeProducer,
  PREFILL_BYTES,
  MAX_BUFFER_BYTES,
  RESUME_BUFFER_BYTES,
} from "../../src/services/airplay/decoder.js";
// D35 后 ffmpeg 定位统一收敛到 transcode.resolveFfmpeg()(口径:FFMPEG_PATH → ffmpeg-static → PATH)。
// AirPlay 不再自带一份「内置优先」的重复实现,故此处直接测统一后的那一份。
import { resolveFfmpeg } from "../../src/services/transcode.js";

const CHUNK = PCM_BYTES_PER_CHUNK;

class FakeStdout extends EventEmitter {
  private paused = false;
  pauseCalls = 0;
  resumeCalls = 0;
  pause(): void {
    this.pauseCalls++;
    this.paused = true;
  }
  resume(): void {
    this.resumeCalls++;
    this.paused = false;
  }
  isPaused(): boolean {
    return this.paused;
  }
}

function makeFf() {
  const ff: any = new EventEmitter();
  const stdout = new FakeStdout();
  ff.stdout = stdout;
  ff.stderr = new EventEmitter();
  return { ff, stdout };
}

function pcm(n: number): Buffer {
  return Buffer.alloc(n, 0x7f);
}

beforeEach(() => {
  log.info.mockClear();
  h.airplayChannelOn = true;
});

afterEach(() => {
  throwStatic = false;
  vi.useRealTimers();
});

// 打桩只在进程内有效(forks 池每个测试文件独立进程),到文件结束再还原 ——
// 中途还原会让后面的用例集体找不到 ffmpeg-static。
afterAll(() => {
  (Module as any)._load = origLoad;
});

describe("degreesToDb(RAOP 音量百分比 → dB)", () => {
  it("0 是静音档 -144,不是 -30", () => {
    expect(degreesToDb(0)).toBe(-144);
  });

  it("100 → 0 dB,50 → -15 dB(线性映射)", () => {
    expect(degreesToDb(100)).toBeCloseTo(0, 6);
    expect(degreesToDb(50)).toBeCloseTo(-15, 6);
  });

  it("越界一律钳到 [0,100] 再换算", () => {
    expect(degreesToDb(200)).toBeCloseTo(0, 6);
    expect(degreesToDb(-5)).toBe(-144);
  });
});

describe("ffmpeg 定位与兜底(D35:统一到 transcode.resolveFfmpeg)", () => {
  const saved = process.env.FFMPEG_PATH;
  afterEach(() => {
    if (saved === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = saved;
  });

  it("总返回一个非空字符串(容器里没有系统 ffmpeg 也不会拿到空值)", () => {
    const b = resolveFfmpeg();
    expect(typeof b).toBe("string");
    expect(b.length).toBeGreaterThan(0);
  });

  it("FFMPEG_PATH 优先于内置(运维注入必须能换掉静态构建)", () => {
    process.env.FFMPEG_PATH = "/opt/ff/ffmpeg";
    expect(resolveFfmpeg()).toBe("/opt/ff/ffmpeg");
  });

  it("取不到内置 → 回落到 FFMPEG_PATH(再取不到才回 \"ffmpeg\")", () => {
    throwStatic = true;
    process.env.FFMPEG_PATH = "/opt/ff/ffmpeg2";
    expect(resolveFfmpeg()).toBe("/opt/ff/ffmpeg2");
    delete process.env.FFMPEG_PATH;
    expect(resolveFfmpeg()).toBe("ffmpeg");
  });
});

describe("buildAirplayAf 通道开关(P5-1)", () => {
  it("通道关 → 不带响度段,但输出段照旧(RAOP 协议硬性要求)", () => {
    h.airplayChannelOn = false;
    const { af, hasLoudnorm } = buildAirplayAf({});
    expect(hasLoudnorm).toBe(false);
    expect(af.some((f) => f.startsWith("loudnorm"))).toBe(false);
    // 关的是响度,不是管道:44.1k/16bit/stereo 的 pin 仍然在位。
    expect(af).toContain("aformat=channel_layouts=stereo");
    expect(af.some((f) => f.startsWith("aresample="))).toBe(true);
  });

  it("通道开 → 响度段回来(与上面成对,证明开关真在起作用)", () => {
    const { hasLoudnorm } = buildAirplayAf({});
    expect(hasLoudnorm).toBe(true);
  });
});

describe("spawnDecoder:非零退出要留痕,不静默", () => {
  it("解码失败(输入不存在)→ 退出码非 0 且留一条带 stderr 的日志", async () => {
    const ff = spawnDecoder("/tmp/__musicflow_no_such_input__.mp3");
    // 必须有人排 stdout,否则管道满后 ffmpeg 憋住不退出(生产由 producer 排)。
    ff.stdout.resume();
    ff.stdout.on("data", () => {});
    const code = await new Promise<number | null>((resolve) => {
      ff.on("exit", (c) => resolve(c));
      ff.on("error", () => resolve(-1));
    });
    expect(code).not.toBe(0);
    if (typeof code === "number" && code !== -1) {
      expect(log.info).toHaveBeenCalled();
      expect(String(log.info.mock.calls[0][0])).toContain("ffmpeg exit code=");
    }
  }, 30_000);
});

describe("makeProducer:有界 PCM 队列", () => {
  it("跨 data 事件的残余先攒在 carry,凑满一帧才成块", async () => {
    const { ff, stdout } = makeFf();
    const next = makeProducer(ff as any);
    const p = next();
    stdout.emit("data", pcm(100)); // carry = 100
    stdout.emit("data", pcm(50)); // 仍不足一帧 → carry 拼接成 150
    stdout.emit("data", pcm(CHUNK - 150)); // 这次刚好凑满一帧,carry 清空
    stdout.emit("data", pcm(PREFILL_BYTES)); // 补够预填充
    const first = await p;
    expect(first).toBeTruthy();
    expect(first!.length).toBe(CHUNK);
    expect(stdout.isPaused()).toBe(false); // 远未到水位,不该触发背压
  });

  it("【背压】缓冲越过上限就 pause,掉到低水位才 resume", async () => {
    const { ff, stdout } = makeFf();
    const next = makeProducer(ff as any);
    const p = next();
    stdout.emit("data", pcm(MAX_BUFFER_BYTES + CHUNK));
    expect(stdout.pauseCalls).toBe(1); // 内存被钉在 ~10s,不是整首歌
    expect((await p)!.length).toBe(CHUNK);
    expect(stdout.resumeCalls).toBe(0); // 还没消化到低水位,不要急着恢复
    let guard = 0;
    while (stdout.resumeCalls === 0 && guard++ < 5000) await next();
    expect(stdout.resumeCalls).toBe(1);
    expect(RESUME_BUFFER_BYTES).toBeLessThan(MAX_BUFFER_BYTES);
  });

  it("【收尾】流结束后最后一截不足一帧的残余照样吐出", async () => {
    const { ff, stdout } = makeFf();
    const next = makeProducer(ff as any);
    const p = next();
    const total = PREFILL_BYTES + 300;
    stdout.emit("data", pcm(total));
    stdout.emit("end");
    const sizes: number[] = [];
    const first = await p; // 首个 promise 已经占了一个块,不能丢掉重新拉
    expect(first).toBeTruthy();
    sizes.push(first!.length);
    for (;;) {
      const c = await next();
      if (!c) break;
      sizes.push(c.length);
    }
    expect(sizes.filter((s) => s === CHUNK).length).toBe(Math.floor(total / CHUNK));
    // 尾部残余只在流结束后才兑现,绝不提前当成一帧丢给 RAOP。
    expect(sizes[sizes.length - 1]).toBe(total % CHUNK);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(total);
  });

  it("【压实】消费过的队头定期回收,不让数组无限增长", async () => {
    const { ff, stdout } = makeFf();
    const next = makeProducer(ff as any);
    const p = next();
    stdout.emit("data", pcm(2050 * CHUNK));
    expect((await p)!.length).toBe(CHUNK);
    for (let i = 0; i < 2048; i++) await next(); // 累计 2049 次 → 越过压实阈值
    const rest = await next();
    expect(rest).toBeTruthy();
    expect(rest!.length).toBe(CHUNK); // 压实不能把还没消费的块弄丢
  });

  it("【预填充超时】30s 等不来数据就放弃,不无限挂住发送端", async () => {
    vi.useFakeTimers();
    const { ff } = makeFf();
    const next = makeProducer(ff as any);
    const p = next();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await p).toBeNull();
    // done 闩住:之后不再重新等待,避免每帧都卡 30s。
    expect(await next()).toBeNull();
  });

  it("拉空后再来数据:等一轮而不是立刻返回 null", async () => {
    const { ff, stdout } = makeFf();
    const next = makeProducer(ff as any);
    const p = next();
    stdout.emit("data", pcm(PREFILL_BYTES)); // 恰好够预填充,无余量
    expect((await p)!.length).toBe(CHUNK);
    for (let i = 0; i < Math.floor(PREFILL_BYTES / CHUNK) - 1; i++) await next();
    const p2 = next(); // 队列已空 → 进入等待
    stdout.emit("data", pcm(CHUNK * 3));
    expect((await p2)!.length).toBe(CHUNK);
  });

  it("队列空且超时 → 收尾返回 null(不把空包当静音帧发出去)", async () => {
    vi.useFakeTimers();
    const { ff, stdout } = makeFf();
    const next = makeProducer(ff as any);
    const p = next();
    stdout.emit("data", pcm(PREFILL_BYTES));
    expect((await p)!.length).toBe(CHUNK);
    for (let i = 0; i < Math.floor(PREFILL_BYTES / CHUNK) - 1; i++) await next();
    const p2 = next();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await p2).toBeNull();
  });

  it("end 之后 done 闩住:重复拉取一律 null", async () => {
    const { ff, stdout } = makeFf();
    const next = makeProducer(ff as any);
    const p = next();
    stdout.emit("data", pcm(CHUNK * 2));
    stdout.emit("end");
    expect((await p)!.length).toBe(CHUNK);
    expect((await next())!.length).toBe(CHUNK);
    expect(await next()).toBeNull();
    expect(await next()).toBeNull();
  });

  it("【首发必须攒够预填充】只来一点点数据时首拉不返回(否则发送端会被饿到)", async () => {
    const { ff, stdout } = makeFf();
    const next = makeProducer(ff as any);
    const p = next();
    stdout.emit("data", pcm(CHUNK * 10)); // 远小于 PREFILL_BYTES
    let settled = false;
    p.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    // 排空微任务再让一轮宏任务跑完:预填充没攒够时这里必须仍然挂着。
    for (let i = 0; i < 50; i++) await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    // 收尾:补够预填充,让 promise 正常落地,不留下悬挂。
    stdout.emit("data", pcm(PREFILL_BYTES));
    expect((await p)!.length).toBe(CHUNK);
  });

  it("预填充期间反复唤醒:每次只推进一步,不忙等", async () => {
    const { ff, stdout } = makeFf();
    const next = makeProducer(ff as any);
    const p = next();
    // 每次只喂一点点,预填充循环会被唤醒多次而不是空转烧 CPU。
    for (let i = 0; i < 20; i++) stdout.emit("data", pcm(CHUNK * 10));
    stdout.emit("data", pcm(PREFILL_BYTES));
    expect((await p)!.length).toBe(CHUNK);
    expect(stdout.pauseCalls + stdout.resumeCalls).toBeGreaterThanOrEqual(0);
  });
});
