// 回环 raw 流的块缓存代理回归(2026-09-23 PERF-B)
//
// 形态契约(事故沉淀,别再改回去):
//   ① **首响应零额外延迟** —— 响应头在上游响应头到达后立刻发出,数据边下边喂;
//      绝不允许「先把一个窗口下载完再回话」(那会让网盘并发一紧张就 408 / 拖动卡死)。
//   ② 未命中 = 透传 + 镜像(字节原样转发,顺手写缓存),并**并行补块首前缀**
//      —— ffmpeg 的 seek 回溯是逐步**往前**退的,不补前缀则后续更早的 Range 永远命中不了;
//   ③ 命中 = 本地供给,零上游往返。
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, vi, afterEach } from "vitest";

type Upstream = {
  url: string;
  payload: Buffer;
  /** 收到的每个请求的 Range 头。 */
  ranges: Array<string | undefined>;
  /** 放开被 `hold` 卡住的 body。 */
  release: () => void;
  close: () => Promise<void>;
};

function makePayload(size: number): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = i % 251; // 位置可校验的确定性内容(不含 0 段)
  return buf;
}

async function startUpstream(opts: {
  payload: Buffer;
  supportRange?: boolean;
  contentType?: string;
  /** 分片写出:响应头声明**完整**长度,body 分多次 write(真实的「慢慢给」)。 */
  chunkWrite?: number;
  /** 只发响应头、body 先不给(等到 `release()`):用来断言「首响应不等数据」。 */
  hold?: boolean;
  /**
   * 「整块」请求(`start % 256KB == 0 && end == start + 256KB - 1`)一律 416。
   * 模拟**后台补块回源失败** —— 网盘并发紧张时这是常态,必须保证失败后退化成回源,
   * 而不是把块里没填到的空洞当数据吐出去。
   */
  failBlockRange?: boolean;
  /**
   * 起点 >= failFrom 的请求返回 500(模拟网盘偶发 5xx —— 240 真机上确实出现过)。
   * `failFromTimes` 限制失败次数(-1 或省略 = 一直失败)。
   */
  failFrom?: number;
  failFromTimes?: number;
}): Promise<Upstream> {
  const supportRange = opts.supportRange !== false;
  const ranges: Array<string | undefined> = [];
  let releaseFn: () => void = () => {};
  const gate = new Promise<void>((r) => { releaseFn = r; });
  let failCount = 0;
  const server = http.createServer(async (req, res) => {
    ranges.push(req.headers["range"] as string | undefined);
    if (opts.failFrom !== undefined) {
      const rm = /^bytes=(\d*)-/.exec((req.headers["range"] as string | undefined || "").trim());
      const st = rm && rm[1] ? Number(rm[1]) : 0;
      const limit = opts.failFromTimes ?? -1;
      if (st >= opts.failFrom && (limit < 0 || failCount < limit)) {
        failCount += 1;
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("boom");
        return;
      }
    }
    const common: Record<string, string> = {
      "Content-Type": opts.contentType ?? "audio/flac",
      "Accept-Ranges": supportRange ? "bytes" : "none",
    };
    const range = req.headers["range"] as string | undefined;
    if (!supportRange || !range) {
      res.writeHead(200, { ...common, "Content-Length": String(opts.payload.length) });
      res.end(opts.payload);
      return;
    }
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim()) || [];
    if (m.length === 0) { res.writeHead(400, common); res.end("bad range"); return; }
    const size = opts.payload.length;
    let start = 0;
    let end = size - 1;
    if (m[1] === "") {
      start = Math.max(0, size - Number(m[2]));
    } else {
      start = Number(m[1]);
      end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
    }
    const BLOCK = 256 * 1024;
    if (
      (start > end || start >= size) ||
      (opts.failBlockRange && start % BLOCK === 0 && end === start + BLOCK - 1)
    ) {
      res.writeHead(416, { ...common, "Content-Range": `bytes */${size}` });
      res.end();
      return;
    }
    const slice = opts.payload.subarray(start, end + 1);
    res.writeHead(206, {
      ...common,
      "Content-Length": String(slice.length),
      "Content-Range": `bytes ${start}-${end}/${size}`,
    });
    if (opts.hold) {
      // ⚠️ writeHead 只登记头,不会真的发 —— 必须 flushHeaders() 客户端才收得到状态码。
      // 头发出去、body 卡住 ⇒ 「首响应是否等了数据」一眼可判。
      res.flushHeaders();
      await gate;
      res.end(slice);
      return;
    }
    if (opts.chunkWrite && slice.length > opts.chunkWrite) {
      // 分片慢慢给,但**声明的长度是完整的** ⇒ 客户端有理由读到 EOF
      (async () => {
        let off = 0;
        while (off < slice.length) {
          const n = Math.min(opts.chunkWrite, slice.length - off);
          res.write(slice.subarray(off, off + n));
          off += n;
          await new Promise((r) => setImmediate(r));
        }
        res.end();
      })();
      return;
    }
    res.end(slice);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/a.flac`,
    payload: opts.payload,
    ranges,
    release: () => releaseFn(),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function readAll(res: Response): Promise<Buffer> {
  const reader = res.body!.getReader();
  const chunks: Buffer[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** 只读前 n 字节就断连 —— 模拟 ffmpeg 在 seek 回溯时「读几百字节就发下一个 Range」。 */
async function readPartial(res: Response, n: number): Promise<Buffer> {
  const reader = res.body!.getReader();
  const chunks: Buffer[] = [];
  let got = 0;
  try {
    while (got < n) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      got += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 20)); // 给后台补前缀/镜像一点回旋
  return Buffer.concat(chunks).subarray(0, Math.min(n, got));
}

const restoreFns: Array<() => void> = [];

async function loadMod(env: Record<string, string> = {}) {
  vi.resetModules();
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k];
    process.env[k] = env[k];
  }
  const mod = await import("../../src/services/dlna/rawStreamCache.js");
  mod.resetRawCache();
  restoreFns.push(() => {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k]!;
    }
  });
  return mod;
}

afterEach(() => {
  while (restoreFns.length) restoreFns.pop()!();
});

describe("parse helpers", () => {
  it("Range / Content-Range 解析覆盖四种形态", async () => {
    const mod = await loadMod();
    expect(mod.parseRangeHeader("bytes=0-")).toEqual({ start: 0, end: null });
    expect(mod.parseRangeHeader("bytes=100-199")).toEqual({ start: 100, end: 199 });
    expect(mod.parseRangeHeader("bytes=-500")).toEqual({ start: -500, end: null });
    expect(mod.parseRangeHeader("nonsense")).toBeNull();
    expect(mod.parseRangeHeader(undefined)).toBeNull();
    expect(mod.parseTotalFromRange("bytes 0-99/1024")).toBe(1024);
    expect(mod.parseTotalFromRange("bytes */1024")).toBe(1024);
    expect(mod.parseTotalFromRange(undefined)).toBeUndefined();
  });
});

describe("Range 语义:与上游逐字节等价", () => {
  it("不带 Range → 200 全流,内容与上游一致", async () => {
    const mod = await loadMod();
    const payload = makePayload(700 * 1024);
    const up = await startUpstream({ payload });
    try {
      const res = await mod.proxyRawRange({ url: up.url });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-length")).toBe(String(payload.length));
      const body = await readAll(res);
      expect(Buffer.compare(body, payload)).toBe(0);
    } finally { await up.close(); }
  });

  it("有界 Range → 206 + 精确 Content-Range", async () => {
    const mod = await loadMod();
    const payload = makePayload(700 * 1024);
    const up = await startUpstream({ payload });
    try {
      const res = await mod.proxyRawRange({ url: up.url, rangeHeader: "bytes=100-199" });
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe(`bytes 100-199/${payload.length}`);
      expect(res.headers.get("content-length")).toBe("100");
      const body = await readAll(res);
      expect(Buffer.compare(body, payload.subarray(100, 200))).toBe(0);
    } finally { await up.close(); }
  });

  it("开放式 Range → 206 且补到文件尾", async () => {
    const mod = await loadMod();
    const payload = makePayload(700 * 1024);
    const up = await startUpstream({ payload });
    try {
      const res = await mod.proxyRawRange({ url: up.url, rangeHeader: "bytes=500-" });
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe(`bytes 500-${payload.length - 1}/${payload.length}`);
      expect(res.headers.get("content-length")).toBe(String(payload.length - 500));
      const body = await readAll(res);
      expect(Buffer.compare(body, payload.subarray(500))).toBe(0);
    } finally { await up.close(); }
  });

  it("suffix Range(`bytes=-N`)→ 末尾 N 字节", async () => {
    const mod = await loadMod();
    const payload = makePayload(300 * 1024);
    const up = await startUpstream({ payload });
    try {
      const res = await mod.proxyRawRange({ url: up.url, rangeHeader: "bytes=-100" });
      expect(res.status).toBe(206);
      expect(res.headers.get("content-length")).toBe("100");
      const body = await readAll(res);
      expect(Buffer.compare(body, payload.subarray(payload.length - 100))).toBe(0);
    } finally { await up.close(); }
  });

  it("起点越界 → 416 + `bytes */size`(不给错字节)", async () => {
    const mod = await loadMod();
    const payload = makePayload(100 * 1024);
    const up = await startUpstream({ payload });
    try {
      const res = await mod.proxyRawRange({ url: up.url, rangeHeader: `bytes=${payload.length + 10}-` });
      expect(res.status).toBe(416);
      expect(res.headers.get("content-range")).toBe(`bytes */${payload.length}`);
    } finally { await up.close(); }
  });

  it("上游分片慢慢给(8KB/片)⇒ 仍完整交付且不吐零", async () => {
    const mod = await loadMod();
    const payload = makePayload(1024 * 1024);
    const up = await startUpstream({ payload, chunkWrite: 8 * 1024 });
    try {
      const res = await mod.proxyRawRange({ url: up.url });
      const body = await readAll(res);
      expect(body.length).toBe(payload.length);
      expect(Buffer.compare(body, payload)).toBe(0);
    } finally { await up.close(); }
  });
});

describe("形态红线:首响应不等数据(2026-09-23 事故)", () => {
  it("上游只给了响应头 ⇒ 本层必须立刻回话", async () => {
    const mod = await loadMod();
    const payload = makePayload(512 * 1024);
    const up = await startUpstream({ payload, hold: true });
    try {
      // 上游 body 卡住不放;若本层「先把窗口下完再回话」,这里必然等不到响应
      const raced = await Promise.race([
        mod.proxyRawRange({ url: up.url, rangeHeader: "bytes=0-" }),
        new Promise<null>((r) => setTimeout(() => r(null), 1500)),
      ]);
      expect(raced).not.toBeNull();
      const res = raced as Response;
      expect(res.status).toBe(206);
      expect(res.headers.get("content-length")).toBe(String(payload.length));
      // ⚠️ 必须先断掉响应体再关服务端:否则连接不关,server.close() 永不回调 ⇒ 测试挂死
      await res.body?.cancel().catch(() => {});
    } finally {
      up.release();
      await up.close();
    }
  });
});

describe("有效区间:绝不喂零字节", () => {
  /**
   * 只把块**中间**一段镜像进缓存:`failBlockRange` 让后台补整块失败 ⇒
   * 块的有效区间停在 `[1000,2000)`,块首 1000 字节是**真实存在的空洞**。
   */
  async function mirrorMiddle(mod: any, up: Upstream) {
    const warm = await mod.proxyRawRange({ url: up.url, rangeHeader: "bytes=1000-1999" });
    await readAll(warm);
  }

  it("更早的 Range 落在空洞里 ⇒ 走回源而不是把空洞当数据", async () => {
    const mod = await loadMod();
    const payload = makePayload(1024 * 1024);
    const up = await startUpstream({ payload, failBlockRange: true });
    try {
      await mirrorMiddle(mod, up);
      const res = await mod.proxyRawRange({ url: up.url, rangeHeader: "bytes=500-999" });
      const body = await readAll(res);
      expect(body.length).toBe(500);
      expect(Buffer.compare(body, payload.subarray(500, 1000))).toBe(0);
    } finally { await up.close(); }
  });

  it("命中区间的**末尾之外**不越界供给(缓存用尽即回源续接)", async () => {
    const mod = await loadMod();
    const payload = makePayload(1024 * 1024);
    const up = await startUpstream({ payload, failBlockRange: true });
    try {
      await mirrorMiddle(mod, up);
      const res = await mod.proxyRawRange({ url: up.url, rangeHeader: "bytes=1500-2499" });
      const body = await readAll(res);
      expect(body.length).toBe(1000);
      expect(Buffer.compare(body, payload.subarray(1500, 2500))).toBe(0);
    } finally { await up.close(); }
  });

  it("不相连的两段不会被合并成一个「看似连续」的区间", async () => {
    const mod = await loadMod();
    const payload = makePayload(1024 * 1024);
    const up = await startUpstream({ payload, failBlockRange: true });
    try {
      // 先写 [1000,2000),再写 [5000,6000) —— 中间 [2000,5000) 是空洞
      await readAll(await mod.proxyRawRange({ url: up.url, rangeHeader: "bytes=1000-1999" }));
      await readAll(await mod.proxyRawRange({ url: up.url, rangeHeader: "bytes=5000-5999" }));
      // 空洞里的点必须走回源,不能把 [1000,6000) 当连续区间吐零
      const res = await mod.proxyRawRange({ url: up.url, rangeHeader: "bytes=3000-3999" });
      const body = await readAll(res);
      expect(Buffer.compare(body, payload.subarray(3000, 4000))).toBe(0);
    } finally { await up.close(); }
  });
});

describe("命中:后续 Range 零上游往返", () => {
  it("同一请求第二次 → 全部命中缓存(上游不再被打扰)", async () => {
    const mod = await loadMod();
    const payload = makePayload(1024 * 1024);
    const up = await startUpstream({ payload });
    try {
      const first = await mod.proxyRawRange({ url: up.url });
      const b1 = await readAll(first);
      expect(Buffer.compare(b1, payload)).toBe(0);
      const afterFirst = up.ranges.length;
      const second = await mod.proxyRawRange({ url: up.url });
      expect(second.headers.get("x-musicflow-rawcache")).toContain("hit");
      const b2 = await readAll(second);
      expect(Buffer.compare(b2, payload)).toBe(0);
      expect(up.ranges.length).toBe(afterFirst); // 第二次零回源
    } finally { await up.close(); }
  });

  it("ffmpeg seek 回溯序列(逐步往前退)只回源两次(透传 1 + 补前缀 1)", async () => {
    const mod = await loadMod();
    const payload = makePayload(2 * 1024 * 1024);
    const up = await startUpstream({ payload });
    try {
      // 生产实测序列同构:`15188724 → 15111738 → 15110563 → 15109290 → 15108053`
      // (每次比上一次**更早**);缩放到 2MB 素材的第 3 个 256KB 块内。
      const starts = [900000, 860000, 858000, 856000, 854000];
      for (let i = 0; i < starts.length; i++) {
        const s = starts[i]!;
        const res = await mod.proxyRawRange({ url: up.url, rangeHeader: `bytes=${s}-` });
        expect(res.status).toBe(206);
        // 响应起点必须**正好是请求的起点**,不能因块对齐偏到块头
        expect(res.headers.get("content-range")).toBe(`bytes ${s}-${payload.length - 1}/${payload.length}`);
        const head = await readPartial(res, 2048);
        expect(Buffer.compare(head, payload.subarray(s, s + 2048))).toBe(0);
        if (i > 0) expect(res.headers.get("x-musicflow-rawcache")).toContain("hit");
      }
      // 关键:5 次回溯只付出 2 次上游往返(旧版是 5 次)
      expect(up.ranges.length).toBe(2);
    } finally { await up.close(); }
  });

  it("同块内更早的一点零回源;跨块才新增一次", async () => {
    const mod = await loadMod();
    const payload = makePayload(2 * 1024 * 1024);
    const up = await startUpstream({ payload });
    try {
      await readPartial(await mod.proxyRawRange({ url: up.url, rangeHeader: "bytes=1000000-" }), 1024);
      expect(up.ranges.length).toBe(2); // 透传 + 补前缀
      await readPartial(await mod.proxyRawRange({ url: up.url, rangeHeader: "bytes=900000-" }), 1024);
      expect(up.ranges.length).toBe(2); // 同块更早 ⇒ 靠补的那块前缀命中
      await readPartial(await mod.proxyRawRange({ url: up.url, rangeHeader: "bytes=1400000-" }), 1024);
      expect(up.ranges.length).toBe(4); // 跨块 ⇒ 再加「透传 + 补前缀」
    } finally { await up.close(); }
  });

  it("长流:中间夹着已缓存的块 ⇒ 整曲逐字节正确(不得把同一段吐两次)", async () => {
    const mod = await loadMod();
    const payload = makePayload(4 * 1024 * 1024);
    const up = await startUpstream({ payload, chunkWrite: 64 * 1024 });
    try {
      const BLOCK = 256 * 1024;
      // 让第 0 / 5 / 10 块各自进缓存(模拟 ffmpeg 在别处探测过的落点)
      for (const n of [0, 5, 10]) {
        await readPartial(await mod.proxyRawRange({ url: up.url, rangeHeader: `bytes=${n * BLOCK + 1000}-` }), 2048);
      }
      await new Promise((r) => setTimeout(r, 80)); // 等后台补块落地
      // 整曲读:命中第 0 块起步 ⇒ 续接上游 ⇒ 途中会经过第 5 / 10 块(已缓存)
      const res = await mod.proxyRawRange({ url: up.url });
      const body = await readAll(res);
      expect(body.length).toBe(payload.length);
      expect(Buffer.compare(body, payload)).toBe(0);
    } finally { await up.close(); }
  });

  it("命中后缓存用尽 ⇒ 续接**只回源一次**,不得逐 chunk 回源(2026-09-23 真机事故)", async () => {
    const mod = await loadMod();
    const payload = makePayload(1024 * 1024);
    // 上游按 16KB 分片给 ⇒ 「每 chunk 一次回源」的写法会立刻在上游计数上暴露
    const up = await startUpstream({ payload, chunkWrite: 16 * 1024 });
    try {
      // 先把第 0 块整块补进缓存:请求块内一点(miss)后,后台补块填满 [0,256KB)
      await readPartial(await mod.proxyRawRange({ url: up.url, rangeHeader: "bytes=100000-" }), 2048);
      await new Promise((r) => setTimeout(r, 80)); // 等后台补块落地
      const before = up.ranges.length;

      const res = await mod.proxyRawRange({ url: up.url, rangeHeader: "bytes=100000-" });
      expect(res.headers.get("x-musicflow-rawcache")).toContain("hit");
      const body = await readAll(res);
      expect(body.length).toBe(payload.length - 100000);
      expect(Buffer.compare(body, payload.subarray(100000))).toBe(0);
      // 关键:缓存覆盖 [0,256KB),剩下 ~768KB 必须是**一条**上游请求读到完
      expect(up.ranges.length - before).toBe(1);
    } finally { await up.close(); }
  });

  it("镜像过的区间被再次请求 ⇒ 逐字节正确(不吐零)", async () => {
    const mod = await loadMod();
    const payload = makePayload(1024 * 1024);
    const up = await startUpstream({ payload });
    try {
      // 先只取一小段(镜像进缓存),再请求同块内**更远**但未被镜像覆盖的位置
      await readAll(await mod.proxyRawRange({ url: up.url, rangeHeader: "bytes=0-999" }));
      const res = await mod.proxyRawRange({ url: up.url, rangeHeader: "bytes=5000-5999" });
      const body = await readAll(res);
      expect(Buffer.compare(body, payload.subarray(5000, 6000))).toBe(0);
    } finally { await up.close(); }
  });
});

describe("续接遇到上游 5xx(240 真机出现过)", () => {
  /** 让第 0 块进缓存:后续整曲请求会「命中起步 + 续接上游」。 */
  async function warmBlock0(mod: any, up: Upstream) {
    await readPartial(await mod.proxyRawRange({ url: up.url, rangeHeader: "bytes=100000-" }), 2048);
    await new Promise((r) => setTimeout(r, 80));
  }

  it("续接首次 500 ⇒ 重试一次后仍完整交付", async () => {
    const mod = await loadMod();
    const payload = makePayload(1024 * 1024);
    const up = await startUpstream({ payload, chunkWrite: 16 * 1024, failFrom: 262144, failFromTimes: 1 });
    try {
      await warmBlock0(mod, up);
      const res = await mod.proxyRawRange({ url: up.url, rangeHeader: "bytes=0-" });
      const body = await readAll(res);
      expect(body.length).toBe(payload.length);
      expect(Buffer.compare(body, payload)).toBe(0);
    } finally { await up.close(); }
  });

  it("续接一直失败 ⇒ 让下游**看到错误**,绝不能静默当成 EOF", async () => {
    const mod = await loadMod();
    const payload = makePayload(1024 * 1024);
    const up = await startUpstream({ payload, chunkWrite: 16 * 1024, failFrom: 262144 });
    try {
      await warmBlock0(mod, up);
      const res = await mod.proxyRawRange({ url: up.url, rangeHeader: "bytes=0-" });
      let threw = false;
      try { await readAll(res); } catch { threw = true; }
      expect(threw).toBe(true); // 假 EOF 会让 sendspin 以为播完而自动切下一首
    } finally { await up.close(); }
  });
});

describe("降级与内存预算", () => {
  it("上游不支持 Range → 原样透传(200 全流,内容正确)", async () => {
    const mod = await loadMod();
    const payload = makePayload(300 * 1024);
    const up = await startUpstream({ payload, supportRange: false });
    try {
      const res = await mod.proxyRawRange({ url: up.url, rangeHeader: "bytes=100-199" });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-musicflow-rawcache")).toBe("passthrough");
      const body = await readAll(res);
      expect(Buffer.compare(body, payload)).toBe(0);
    } finally { await up.close(); }
  });

  it("RAW_STREAM_CACHE=0 → 退回纯透传,回源次数 = 请求次数", async () => {
    const mod = await loadMod({ RAW_STREAM_CACHE: "0" });
    expect(mod.rawProxyEnabled()).toBe(false);
    const payload = makePayload(2 * 1024 * 1024);
    const up = await startUpstream({ payload });
    try {
      for (const s of [900000, 860000, 858000]) {
        const res = await mod.proxyRawRange({ url: up.url, rangeHeader: `bytes=${s}-` });
        const head = await readPartial(res, 1024);
        expect(Buffer.compare(head, payload.subarray(s, s + 1024))).toBe(0);
      }
      expect(up.ranges.length).toBe(3); // 关掉缓存 = 回到「每次 Range 一次上游往返」
    } finally { await up.close(); }
  });

  it("缓存受内存预算约束(单源上限不被突破)", async () => {
    const mod = await loadMod({ RAW_CACHE_SOURCE_MB: "1" });
    const payload = makePayload(4 * 1024 * 1024);
    const up = await startUpstream({ payload });
    try {
      await readAll(await mod.proxyRawRange({ url: up.url }));
      const snap = mod.describeRawCache();
      expect(snap.sources).toBe(1);
      expect(snap.bytes).toBeLessThanOrEqual(1024 * 1024);
    } finally { await up.close(); }
  });

  it("镜像限量:整首读完也不会把整首塞进内存", async () => {
    const mod = await loadMod({ RAW_CACHE_MIRROR_MB: "1", RAW_CACHE_SOURCE_MB: "16" });
    const payload = makePayload(4 * 1024 * 1024);
    const up = await startUpstream({ payload });
    try {
      await readAll(await mod.proxyRawRange({ url: up.url }));
      // 镜像预算是**硬上限**:只写前 allow 字节,不允许一个 chunk 顶穿
      // (块粒度记账下,顶穿会多算一整块 ⇒ 整首歌的镜像量就不可控了)。
      expect(mod.describeRawCache().bytes).toBeLessThanOrEqual(1024 * 1024);
    } finally { await up.close(); }
  });

  it("不同鉴权的上游不共享缓存条目", async () => {
    const mod = await loadMod();
    const payload = makePayload(300 * 1024);
    const up = await startUpstream({ payload });
    try {
      await mod.proxyRawRange({ url: up.url, headers: { Authorization: "Basic AAA" } });
      await mod.proxyRawRange({ url: up.url, headers: { Authorization: "Basic BBB" } });
      expect(mod.describeRawCache().sources).toBe(2);
    } finally { await up.close(); }
  });
});
