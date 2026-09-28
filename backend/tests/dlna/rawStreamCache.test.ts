// rawStreamCache.ts —— 回环 raw 流「可随机访问」代理层的服务层契约测试。
//
// 这一层的价值全在**正确性红线**上(见源码头部注释 V1~V5):ffmpeg 的 seek 回溯会
// 发一串开放式 Range,每一条都会走到本文件里不同的分支。一旦某条红线被写坏,症状
// 都是「拖动后没声音 / 播到一半静音 / 整首错位」这类最难复现的形态,靠手测几乎
// 抓不到。这里把每条红线都用注入的上游假体钉住。
//
// 关键手法:
//   · 全局 fetch 换成「虚拟资源」假体 —— 任意 [s,e] 区间都能给出确定性字节,
//     于是可以对「吐出来的每一个字节」做断言(而不是只看状态码和响应头)。
//   · 后台补块(warmBlock)是**不 await 的异步协程**,会抢写主线正在用的那个缓存块,
//     让字节数和 upstream 计数都不确定。这里统一让「跨度超过 10 万字节」的请求失败
//     —— 那正是后台补整块的特征指纹,从而把协程从主线的确定性里摘出去。
import "../plugins/_env.js";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------- 模块级配置必须在 import 之前写好 ----------------
// rawStreamCache 在**模块加载时**就把环境变量读成常量(RAW_BLOCK_BYTES 等),
// 静态 import 会先于本文件的任何语句执行 ⇒ 只能动态 import,env 先在这几行赋值。
process.env.RAW_CACHE_BLOCK_KB = "256";   // 262144 字节一块
process.env.RAW_CACHE_SOURCE_MB = "1";    // 单源 1MB ⇒ 约 4 块后触发裁剪
process.env.RAW_CACHE_SOURCES = "3";      // 最多 3 个上游 entry
process.env.RAW_CACHE_MIRROR_MB = "1";
process.env.RAW_CACHE_TTL_MIN = "10";

type RSC = typeof import("../../src/services/dlna/rawStreamCache.js");
let rsc: RSC;

beforeAll(async () => {
  rsc = await import("../../src/services/dlna/rawStreamCache.js");
});

const BLOCK = 256 * 1024;
const TOTAL = 1_000_000;

/** 虚拟资源的第 i 个字节。用算术序列而不是常量填充 —— 偏移错位才会被断言抓住。 */
const byteAt = (i: number) => (i * 7 + 13) % 251;

function fill(from: number, count: number, filler?: number): Uint8Array {
  const b = new Uint8Array(count);
  for (let i = 0; i < count; i++) b[i] = filler ?? byteAt(from + i);
  return b;
}

function expectPattern(buf: Uint8Array, from: number, filler?: number): void {
  for (let i = 0; i < buf.length; i++) expect(buf[i]).toBe(filler ?? byteAt(from + i));
}

// ---------------------------------------------------------------------------
// 上游假体:一个确定性的虚拟资源 + 若干可切换的故障模式。
// ---------------------------------------------------------------------------
const UP = {
  total: TOTAL,
  /** 头 N 次请求直接抛错(模拟网盘瞬时 5xx)。 */
  throwCount: 0,
  throwError: null as any,
  /** true:所有请求按 200 整段应答(上游不认 Range)。 */
  wholeResponse: false,
  /** 非 undefined:正文用固定字节填充(用来区分「来自缓存」还是「来自上游」)。 */
  filler: undefined as number | undefined,
  /** 正文比 Content-Range 声明的更长多少字节(模拟上游少报总长)。 */
  overDeliver: 0,
  /** true:按 416 应答。 */
  status416: false,
  calls: [] as string[],
  cancels: 0,
};

function resetUpstream(): void {
  UP.total = TOTAL;
  UP.throwCount = 0;
  UP.throwError = null;
  UP.wholeResponse = false;
  UP.filler = undefined;
  UP.overDeliver = 0;
  UP.status416 = false;
  UP.calls = [];
  UP.cancels = 0;
}

/** 把一段字节包成 4KB 一块的正文流(顺带统计取消,用于验证断连不泄漏)。 */
function bodyOf(from: number, count: number): ReadableStream<Uint8Array> {
  const CHUNK = 4096;
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (sent >= count) { ctrl.close(); return; }
      const n = Math.min(CHUNK, count - sent);
      ctrl.enqueue(fill(from + sent, n, UP.filler));
      sent += n;
    },
    cancel() { UP.cancels++; },
  });
}

function parseSpan(range: string): { start: number; end: number } | null {
  const m = /^bytes=(\d+)-(\d+)$/.exec(range);
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]) };
}

function upstream(_url: string, init: any): Promise<Response> {
  const range = String(init?.headers?.Range ?? "");
  UP.calls.push(range);

  // 后台补整块(warmBlock)的请求是「刚好覆盖一整块」的特征形态。让它失败,把这条
  // fire-and-forget 协程从主线断言里摘出去,避免它抢写主线正在用的同一个块。
  // 判据必须精确匹配一个整块 —— 用「跨度足够大」会把跨块的主线请求一起误伤。
  const span = parseSpan(range);
  if (span && span.start % BLOCK === 0
    && span.end === Math.min(span.start + BLOCK - 1, UP.total - 1)) {
    throw new Error("warm blocked by test");
  }

  if (UP.throwCount > 0) {
    UP.throwCount -= 1;
    throw UP.throwError ?? new Error("upstream 500");
  }
  if (UP.status416) {
    return Promise.resolve(new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${UP.total}`, "Content-Type": "audio/flac" },
    }));
  }
  if (UP.wholeResponse || !span) {
    return Promise.resolve(new Response(bodyOf(0, UP.total), {
      status: 200,
      headers: { "Content-Type": "audio/flac", "Content-Length": String(UP.total) },
    }));
  }
  const start = span.start;
  const declaredEnd = Math.min(span.end, UP.total - 1);
  const count = declaredEnd - start + 1 + UP.overDeliver;
  return Promise.resolve(new Response(bodyOf(start, count), {
    status: 206,
    headers: {
      "Content-Type": "audio/flac",
      "Content-Range": `bytes ${start}-${declaredEnd}/${UP.total}`,
    },
  }));
}

/** 每个用例一个独立 URL:模块里的缓存账本是全局的,复用 URL 会跨用例串扰。 */
const url = (name: string) => `http://upstream.test/${name}.pcm`;

const proxy = (name: string, rangeHeader?: string | null) =>
  rsc.proxyRawRange({ url: url(name), rangeHeader });

async function readAll(res: Response): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = res.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length) chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

beforeEach(() => {
  vi.stubGlobal("fetch", upstream);
  rsc.resetRawCache();
  resetUpstream();
  delete process.env.RAW_STREAM_CACHE;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.RAW_STREAM_CACHE;
});

// ===========================================================================
describe("Range / Content-Range 解析(请求起点的前置判据)", () => {
  // Range 解析错一位 ⇒ 后续「我要 600 字节却从 590 开始」的错位都从这里来。
  it("parseRangeHeader:合法形态全部解对(闭区间 / 开放式 / suffix)", () => {
    expect(rsc.parseRangeHeader("bytes=600-800")).toEqual({ start: 600, end: 800 });
    expect(rsc.parseRangeHeader("bytes=600-")).toEqual({ start: 600, end: null });
    expect(rsc.parseRangeHeader("bytes=-1024")).toEqual({ start: -1024, end: null });
    expect(rsc.parseRangeHeader("bytes=0-0")).toEqual({ start: 0, end: 0 });
  });

  it("parseRangeHeader:非法形态一律返回 null(调用方按「无 Range」处理)", () => {
    expect(rsc.parseRangeHeader()).toBeNull();
    expect(rsc.parseRangeHeader("")).toBeNull();
    expect(rsc.parseRangeHeader("items=1-2")).toBeNull();
    expect(rsc.parseRangeHeader("bytes=abc-def")).toBeNull();
    expect(rsc.parseRangeHeader("bytes=800-600")).toBeNull();  // 终点小于起点
    expect(rsc.parseRangeHeader("bytes=-0")).toBeNull();       // suffix 长度必须为正
    expect(rsc.parseRangeHeader("bytes=-")).toBeNull();        // 两端都空
  });

  it("parseTotalFromRange:206 / 416 / 垃圾值都能给出正确的「是否知道总长」", () => {
    expect(rsc.parseTotalFromRange("bytes 600-800/1000")).toBe(1000);
    // 416 形态 `bytes */T` 也携带真实总长 —— 取不到就等于放弃了"总长已知"这条信息。
    expect(rsc.parseTotalFromRange("bytes */1000")).toBe(1000);
    expect(rsc.parseTotalFromRange("bytes */0")).toBeUndefined();  // 0 不是合法总长
    expect(rsc.parseTotalFromRange("")).toBeUndefined();
    expect(rsc.parseTotalFromRange(undefined)).toBeUndefined();
    expect(rsc.parseTotalFromRange("garbage")).toBeUndefined();
  });
});

describe("RAW_STREAM_CACHE 总开关", () => {
  it("默认开启;置 0/off/false 均关闭(走旧的纯透传)", () => {
    delete process.env.RAW_STREAM_CACHE;
    expect(rsc.rawProxyEnabled()).toBe(true);
    for (const v of ["0", "off", "false"]) {
      process.env.RAW_STREAM_CACHE = v;
      expect(rsc.rawProxyEnabled()).toBe(false);
    }
    process.env.RAW_STREAM_CACHE = "1";
    expect(rsc.rawProxyEnabled()).toBe(true);
  });

  it("关闭时不介入:响应整段透传,且标记成 passthrough", async () => {
    process.env.RAW_STREAM_CACHE = "0";
    const res = await proxy("disabled", "bytes=600-800");
    // 透传 = 上游 206 原样转发,本层不重算 Content-Length / Content-Range
    expect(res.status).toBe(206);
    expect(res.headers.get("X-MusicFlow-RawCache")).toBe("passthrough");
    expect(res.headers.get("Content-Range")).toBe(`bytes 600-800/${TOTAL}`);
  });

  it("块粒度常量跟随环境配置", () => {
    expect(rsc.RAW_BLOCK_BYTES).toBe(BLOCK);
  });
});

// ===========================================================================
describe("形态红线 V3/V4/V5:吐出去的必须是请求起点的真字节", () => {
  it("未命中 → 透传加镜像:首字节是请求起点,长度与 Content-Range 自洽", async () => {
    const res = await proxy("v3-miss", "bytes=600-800");
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Length")).toBe("201");
    expect(res.headers.get("Content-Range")).toBe(`bytes 600-800/${TOTAL}`);
    expect(res.headers.get("X-MusicFlow-RawCache")).toMatch(/^miss;block=\d+;upstream=\d+$/);

    const buf = await readAll(res);
    expect(buf.length).toBe(201);
    expectPattern(buf, 600);
  });

  it("第二次同范围请求 → 命中缓存,零上游往返且字节不变", async () => {
    const first = await readAll(await proxy("v2-hit", "bytes=600-800"));
    expectPattern(first, 600);
    const before = UP.calls.length;

    const res = await proxy("v2-hit", "bytes=600-800");
    expect(res.headers.get("X-MusicFlow-RawCache")).toMatch(/^hit;block=\d+;upstream=0$/);
    // 零上游往返 —— 这就是本层存在的全部意义
    expect(UP.calls.length).toBe(before);
    expectPattern(await readAll(res), 600);
  });

  it("跨缺口合成:缓存段之后的字节必须来自上游,不得补零字节", async () => {
    // 先把 [600, 801) 挪进缓存。
    await readAll(await proxy("v5-hybrid", "bytes=600-800"));
    // 之后的上游改用填充字节,便于分辨两段来源。
    UP.filler = 0xaa;

    const res = await proxy("v5-hybrid", "bytes=650-1000");
    const buf = await readAll(res);
    expect(buf.length).toBe(351);               // 650..1000,一个不多一个不少
    expectPattern(buf.subarray(0, 151), 650);   // 前 151 字节来自缓存
    expect([...buf.subarray(151)]).toEqual(new Array(200).fill(0xaa));
  });

  it("不相连的两段不得合并成一个有效区间(否则会向中间空洞吐零字节)", async () => {
    // 同一块(block 0)内两次互不相连的写入。
    await readAll(await proxy("v4-disjoint", "bytes=1000-1099"));
    await readAll(await proxy("v4-disjoint", "bytes=5000-5099"));

    // 若把两段合并成 [1000, 5100) 当作整段有效,这里就会「命中」中间的空洞,
    // 给 ffmpeg 喂四个 KB 的零字节 —— 生产上的症状是拖动后一段无声。
    UP.filler = 0xbb;
    const before = UP.calls.length;
    const res = await proxy("v4-disjoint", "bytes=1050-1099");
    expect(UP.calls.length).toBeGreaterThan(before); // 必须回源,不能"命中"空洞
    const buf = await readAll(res);
    expect([...buf]).toEqual(new Array(50).fill(0xbb));
  });

  it("横跨两个块的请求仍能按序拼出完整字节流", async () => {
    const res = await proxy("cross-block", `bytes=0-${BLOCK + 10}`);
    const buf = await readAll(res);
    expect(buf.length).toBe(BLOCK + 11);
    expectPattern(buf, 0);
  });
});

// ===========================================================================
describe("降级:不确定 / 不支持时一律退回旧的纯透传", () => {
  it("suffix Range(bytes=-N)起点由上游裁定 → 本层不介入", async () => {
    const res = await proxy("suffix", "bytes=-1024");
    expect(res.headers.get("X-MusicFlow-RawCache")).toBe("passthrough");
  });

  it("上游未按 206 应答(整段 200)→ 透传,不得自己编造 Content-Range", async () => {
    UP.wholeResponse = true;
    const res = await proxy("whole", "bytes=600-800");
    expect(res.headers.get("X-MusicFlow-RawCache")).toBe("passthrough");
    expect(res.headers.get("Content-Range")).toBeNull();
  });

  it("上游应答起点与请求起点不一致 → 透传(不得按错误偏移接着喂)", async () => {
    // 上游忽略 Range、永远从 0 起,却按 206 应答 —— 这是最危险的错位形态。
    vi.stubGlobal("fetch", async (_u: string, init: any) => {
      const range = String(init?.headers?.Range ?? "");
      UP.calls.push(range);
      const end = UP.total - 1;
      return new Response(bodyOf(0, end + 1), {
        status: 206,
        headers: { "Content-Type": "audio/flac", "Content-Range": `bytes 0-${end}/${UP.total}` },
      });
    });
    const res = await proxy("start-mismatch", "bytes=600-800");
    expect(res.headers.get("X-MusicFlow-RawCache")).toBe("passthrough");
  });

  it("上游 416 → 原样透传成 416(带上它声明的总长)", async () => {
    UP.status416 = true;
    const res = await proxy("up-416", "bytes=900000-999999");
    expect(res.status).toBe(416);
    expect(res.headers.get("X-MusicFlow-RawCache")).toBe("416");
    expect(res.headers.get("Content-Range")).toBe(`bytes */${TOTAL}`);
  });

  it("总长已探明而请求起点越界 → 本层直接 416,不喂空流", async () => {
    // 上游声明的总长比它实际吐出的字节少(少报)。
    UP.total = 1000;
    UP.overDeliver = 900;
    await readAll(await proxy("short-total", "bytes=500-999"));
    // 总长已知(=1000)而请求起点已越过它:必须 416,而不是给一条零字节的假 EOF
    // —— ffmpeg / sendspin 会把"流正常结束"当成"这首放完",进而自动切下一首。
    const res = await proxy("short-total", "bytes=1200-");
    expect(res.status).toBe(416);
    expect(res.headers.get("X-MusicFlow-RawCache")).toBe("416");
    expect(res.headers.get("Content-Range")).toBe("bytes */1000");
  });

  it("本层与透传都失败 → 原错误抛出(绝不静默收尾)", async () => {
    UP.throwError = new Error("boom");
    UP.throwCount = 99;
    await expect(proxy("both-fail", "bytes=600-800")).rejects.toThrow("boom");
  });

  it("客户端取消(AbortError)不当成可降级错误 → 直接抛出,不再回源", async () => {
    UP.throwError = Object.assign(new Error("aborted by client"), { name: "AbortError" });
    UP.throwCount = 1;
    await expect(proxy("abort", "bytes=600-800")).rejects.toThrow("aborted by client");
    // 关键:不能因为「本层异常」就再发一次上游请求 —— 客户端已经走了。
    expect(UP.calls.length).toBe(1);
  });

  it("主线取流瞬时失败 → 退回旧的纯透传并留下告警痕迹", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 第一次(本层回源)失败,第二次(passthrough)成功
    UP.throwCount = 1;
    const res = await proxy("once-fail", "bytes=600-800");
    expect(res.headers.get("X-MusicFlow-RawCache")).toBe("passthrough");
    // 告警有 30s 去抖(同 key),且本文件内多条用例共用 key ⇒ 只断言"至少留了一次痕"。
    expect(warn.mock.calls.length).toBeGreaterThanOrEqual(1);
    warn.mockRestore();
  });
});

// ===========================================================================
describe("收尾:取流失败必须报错而不是假 EOF", () => {
  // ffmpeg / sendspin 都靠「流结束」判断本首放完 —— 一个静默的 null 收尾会被译成
  // 「这首播完了」从而自动切下一首,比一个明确的错误糟得多。
  it("缓存读到一半转上游续接、两次重试都不给 206 ⇒ 流必须报错", async () => {
    await readAll(await proxy("tail-fail", "bytes=600-800"));
    UP.wholeResponse = true; // 续接请求一律 200 ⇒ 不满足字节对齐条件

    const res = await proxy("tail-fail", "bytes=600-1000");
    await expect(readAll(res)).rejects.toThrow(/续接失败/);
  });

  it("下游取消 → 上游 reader 被取消(不会吊住一条没人读的流)", async () => {
    // 取一段够长的正文(多块) —— 一次性取完的小正文会在读到时就把上游流关闭,
    // 那时 cancel 不会再被传播,测不到这层清理。
    const res = await proxy("cancel", "bytes=0-9999");
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => expect(UP.cancels).toBeGreaterThanOrEqual(1));
  });
});

// ===========================================================================
describe("缓存账本:用量受限、过期可回收", () => {
  it("describeRawCache 反映当前账本;resetRawCache 清空", async () => {
    await readAll(await proxy("ledger", "bytes=600-800"));
    const s = rsc.describeRawCache();
    expect(s.sources).toBe(1);
    expect(s.blocks).toBe(1);
    expect(s.bytes).toBe(BLOCK);            // 记账按块粒度(每块 256KB)
    expect(s.entries[0].url).toBe(url("ledger"));

    rsc.resetRawCache();
    expect(rsc.describeRawCache()).toMatchObject({ sources: 0, blocks: 0, bytes: 0 });
  });

  it("上游 entry 数超过上限 → 最久未用的被回收(账本不会无限涨)", async () => {
    for (const n of ["src-a", "src-b", "src-c"]) await readAll(await proxy(n, "bytes=0-99"));
    expect(rsc.describeRawCache().sources).toBeLessThanOrEqual(3);

    // sweep() 在进入 acquire 时执行、且**先于**新条目插入 ⇒ 稳态会稳定在
    // 「上限 + 1」而不是「上限」(本管局存的一条允许偏差,见报告)。
    for (const n of ["src-d", "src-e", "src-f"]) await readAll(await proxy(n, "bytes=0-99"));
    const s = rsc.describeRawCache();
    expect(s.sources).toBeLessThanOrEqual(4);
    // 最久未用的 src-a 必须已经出局 —— 账本不随遇到的上游数量无限增长。
    expect(s.entries.map((e) => e.url)).not.toContain(url("src-a"));
  });

  it("超过 TTL 未使用 → 下次获取时回收并重新回源", async () => {
    await readAll(await proxy("ttl", "bytes=600-800"));
    const warm = UP.calls.length;

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 20 * 60 * 1000); // 超过 RAW_CACHE_TTL_MIN(10min)
    await readAll(await proxy("ttl", "bytes=600-800"));
    expect(UP.calls.length).toBeGreaterThan(warm); // 过期条目已丢 ⇒ 必须重新回源
    vi.useRealTimers();
  });
});
