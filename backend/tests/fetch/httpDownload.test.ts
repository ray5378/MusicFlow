import { afterAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DownloadError, downloadToFile } from "../../src/utils/httpDownload.js";

/** 本轮所有桩服务,统一在 afterAll 关闭。 */
const servers: http.Server[] = [];
/** 本轮所有临时文件落点。 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mf-fetch-http-"));

/** 起一个本地桩服务,返回 base URL(http://127.0.0.1:<port>)。 */
async function start(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  servers.push(server);
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

function dest(name: string): string {
  return path.join(tmpRoot, name);
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** 断言下载抛出的错误码。 */
async function expectCode(p: Promise<unknown>, code: string): Promise<DownloadError> {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(DownloadError);
  expect((err as DownloadError).code).toBe(code);
  return err as DownloadError;
}

afterAll(async () => {
  for (const s of servers) {
    // 停摆用例的响应永不结束,close() 会一直等连接,故先强制断连。
    if (typeof s.closeAllConnections === "function") s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

describe("downloadToFile 正常下载", () => {
  it("bytes / sha256 / 内容与预期一致", async () => {
    const body = Buffer.from("hello musicflow fetch 下载测试");
    const base = await start((_req, res) => {
      res.writeHead(200, { "content-type": "audio/mpeg" });
      res.end(body);
    });
    const p = dest("ok.part");
    const r = await downloadToFile({ url: `${base}/a.mp3`, destPath: p, ssrfGuard: false });

    expect(r.httpStatus).toBe(200);
    expect(r.bytes).toBe(body.length);
    expect(r.partial).toBe(false);
    expect(r.sha256).toBe(sha256(body));
    expect(r.mime).toBe("audio/mpeg");
    expect(r.finalUrl).toBe(`${base}/a.mp3`);
    expect(fs.readFileSync(p)).toEqual(body);
  });

  it("大文件分片流式写入也一致", async () => {
    const body = crypto.randomBytes(300 * 1024);
    const base = await start((_req, res) => {
      res.writeHead(200, { "content-length": String(body.length) });
      // 分 3 片下发,验证流式拼装
      res.write(body.subarray(0, 100 * 1024));
      res.write(body.subarray(100 * 1024, 200 * 1024));
      res.end(body.subarray(200 * 1024));
    });
    const p = dest("big.part");
    const r = await downloadToFile({ url: `${base}/big.mp3`, destPath: p, ssrfGuard: false });
    expect(r.bytes).toBe(body.length);
    expect(r.sha256).toBe(sha256(body));
  });
});

describe("downloadToFile 状态码", () => {
  it("404 → HTTP_404（细分码：资源不存在，参与永久失效判定）", async () => {
    const base = await start((_req, res) => {
      res.writeHead(404);
      res.end("not found");
    });
    await expectCode(
      downloadToFile({ url: `${base}/x.mp3`, destPath: dest("404.part"), ssrfGuard: false }),
      "HTTP_404",
    );
  });

  it("410 / 451 → HTTP_410 / HTTP_451（已下架 / 法律原因不可用）", async () => {
    const b410 = await start((_req, res) => {
      res.writeHead(410);
      res.end("gone");
    });
    await expectCode(
      downloadToFile({ url: `${b410}/x.mp3`, destPath: dest("410.part"), ssrfGuard: false }),
      "HTTP_410",
    );
    const b451 = await start((_req, res) => {
      res.writeHead(451);
      res.end("unavailable for legal reasons");
    });
    await expectCode(
      downloadToFile({ url: `${b451}/x.mp3`, destPath: dest("451.part"), ssrfGuard: false }),
      "HTTP_451",
    );
  });

  it("429 → 仍归 HTTP_4XX（限流可恢复，不得参与永久失效判定）", async () => {
    const base = await start((_req, res) => {
      res.writeHead(429);
      res.end("too many requests");
    });
    await expectCode(
      downloadToFile({ url: `${base}/x.mp3`, destPath: dest("429.part"), ssrfGuard: false }),
      "HTTP_4XX",
    );
  });

  it("403 → HTTP_403", async () => {
    const base = await start((_req, res) => {
      res.writeHead(403);
      res.end("forbidden");
    });
    const err = await expectCode(
      downloadToFile({ url: `${base}/x.mp3`, destPath: dest("403.part"), ssrfGuard: false }),
      "HTTP_403",
    );
    expect(err.httpStatus).toBe(403);
  });

  it("500 → HTTP_5XX", async () => {
    const base = await start((_req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    await expectCode(
      downloadToFile({ url: `${base}/x.mp3`, destPath: dest("500.part"), ssrfGuard: false }),
      "HTTP_5XX",
    );
  });
});

describe("downloadToFile 重定向", () => {
  it("跟随一次重定向并落到最终地址", async () => {
    const body = Buffer.from("redirected-body");
    const base = await start((req, res) => {
      if (req.url === "/a.mp3") {
        res.writeHead(302, { location: "/b.mp3" });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end(body);
    });
    const r = await downloadToFile({ url: `${base}/a.mp3`, destPath: dest("redir.part"), ssrfGuard: false });
    expect(r.httpStatus).toBe(200);
    expect(r.bytes).toBe(body.length);
    expect(r.finalUrl).toBe(`${base}/b.mp3`);
  });

  it("重定向到内网地址 → SSRF_BLOCKED(每跳重新校验)", async () => {
    const base = await start((_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    });
    await expectCode(
      downloadToFile({
        url: `${base}/a.mp3`,
        destPath: dest("ssrf.part"),
        ssrfGuard: true,
        hostAllowlist: ["127.0.0.1"],
      }),
      "SSRF_BLOCKED",
    );
  });

  it("hostAllowlist 未命中 → SSRF_BLOCKED", async () => {
    const base = await start((_req, res) => {
      res.writeHead(200);
      res.end("x");
    });
    await expectCode(
      downloadToFile({
        url: `${base}/a.mp3`,
        destPath: dest("allow.part"),
        ssrfGuard: false,
        hostAllowlist: ["example.com"],
      }),
      "SSRF_BLOCKED",
    );
  });
});

describe("SSRF 白名单 CIDR（2026-10-11：整段内网一次性授权）", () => {
  it("trustedHosts 用 CIDR 放行整段内网：127.0.0.0/8 命中 127.0.0.1（不被内网段拦截）", async () => {
    const body = Buffer.from("cidr-ok");
    const base = await start((_req, res) => {
      res.writeHead(200);
      res.end(body);
    });
    const r = await downloadToFile({
      url: `${base}/a.mp3`,
      destPath: dest("cidr-ok.part"),
      ssrfGuard: true,
      trustedHosts: ["127.0.0.0/8"],
    });
    expect(r.httpStatus).toBe(200);
    expect(r.bytes).toBe(body.length);
  });

  it("CIDR 覆盖不到的网段仍被拦截：192.168.10.0/24 不放行 127.0.0.1", async () => {
    const base = await start((_req, res) => {
      res.writeHead(200);
      res.end("x");
    });
    await expectCode(
      downloadToFile({
        url: `${base}/a.mp3`,
        destPath: dest("cidr-miss.part"),
        ssrfGuard: true,
        trustedHosts: ["192.168.10.0/24"],
      }),
      "SSRF_BLOCKED",
    );
  });

  it("非法 CIDR（前缀越界）→ 不匹配，保守拦截", async () => {
    const base = await start((_req, res) => {
      res.writeHead(200);
      res.end("x");
    });
    await expectCode(
      downloadToFile({
        url: `${base}/a.mp3`,
        destPath: dest("cidr-bad.part"),
        ssrfGuard: true,
        trustedHosts: ["127.0.0.0/33"],
      }),
      "SSRF_BLOCKED",
    );
  });

  it("CIDR 与精确主机名 / *.通配 混用互不影响", async () => {
    const body = Buffer.from("mixed");
    const base = await start((_req, res) => {
      res.writeHead(200);
      res.end(body);
    });
    const r = await downloadToFile({
      url: `${base}/a.mp3`,
      destPath: dest("cidr-mixed.part"),
      ssrfGuard: true,
      trustedHosts: ["music-dl.lan", "*.example.com", "10.0.0.0/8", "127.0.0.0/8"],
    });
    expect(r.httpStatus).toBe(200);
    expect(r.bytes).toBe(body.length);
  });
});

describe("downloadToFile 体积上限", () => {
  it("超过 maxBytes → TOO_LARGE", async () => {
    const body = Buffer.alloc(1000, 7);
    const base = await start((_req, res) => {
      res.writeHead(200, { "content-length": "1000" });
      res.end(body);
    });
    const err = await expectCode(
      downloadToFile({
        url: `${base}/x.mp3`,
        destPath: dest("toolarge.part"),
        ssrfGuard: false,
        maxBytes: 100,
      }),
      "TOO_LARGE",
    );
    expect(err.bytes).toBeGreaterThan(100);
  });
});

describe("downloadToFile 断点续传", () => {
  it("服务端返回 206 → 追加写,partial = true", async () => {
    const full = Buffer.from("ABCDEFGHIJ");
    const base = await start((req, res) => {
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d+)-/.exec(String(range));
        const from = m ? Number(m[1]) : 0;
        res.writeHead(206, { "accept-ranges": "bytes", "content-type": "audio/mpeg" });
        res.end(full.subarray(from));
        return;
      }
      res.writeHead(200);
      res.end(full);
    });
    const p = dest("resume206.part");
    fs.writeFileSync(p, full.subarray(0, 5));
    const r = await downloadToFile({ url: `${base}/x.mp3`, destPath: p, ssrfGuard: false });

    expect(r.partial).toBe(true);
    expect(r.rangeSupported).toBe(true);
    expect(r.bytes).toBe(full.length);
    // 断点续传只覆盖本次接收的字节,sha256 亦然
    expect(r.sha256).toBe(sha256(full.subarray(5)));
    expect(fs.readFileSync(p)).toEqual(full);
  });

  it("服务端忽略 Range 返回 200 → 从头覆盖写", async () => {
    const full = Buffer.from("ABCDEFGHIJ");
    const base = await start((_req, res) => {
      res.writeHead(200);
      res.end(full);
    });
    const p = dest("resume200.part");
    fs.writeFileSync(p, Buffer.from("XXXXX"));
    const r = await downloadToFile({ url: `${base}/x.mp3`, destPath: p, ssrfGuard: false });

    expect(r.partial).toBe(false);
    expect(r.bytes).toBe(full.length);
    expect(fs.readFileSync(p)).toEqual(full);
  });
});

describe("downloadToFile 停摆与限速", () => {
  it("响应头发完后不再来数据 → STALL", async () => {
    const base = await start((_req, res) => {
      res.writeHead(200, { "content-length": "1024" });
      res.write("x");
      // 故意不 end,模拟僵尸连接
    });
    await expectCode(
      downloadToFile({
        url: `${base}/stall.mp3`,
        destPath: dest("stall.part"),
        ssrfGuard: false,
        stallTimeoutMs: 200,
        timeoutMs: 5000,
      }),
      "STALL",
    );
  });

  it("rateLimitKBps 限速:32KB @ 16KB/s 至少耗时 1.2s(放宽避免 flaky)", async () => {
    const body = Buffer.alloc(32 * 1024, 1);
    const base = await start((_req, res) => {
      res.writeHead(200, { "content-length": String(body.length) });
      res.end(body);
    });
    const t0 = Date.now();
    const r = await downloadToFile({
      url: `${base}/slow.mp3`,
      destPath: dest("slow.part"),
      ssrfGuard: false,
      rateLimitKBps: 16,
      stallTimeoutMs: 15000,
    });
    const elapsed = Date.now() - t0;
    expect(r.bytes).toBe(body.length);
    expect(elapsed).toBeGreaterThanOrEqual(1200);
  }, 20000);
});

describe("downloadToFile 取消", () => {
  it("signal 取消 → FETCH_FAILED", async () => {
    const base = await start((_req, res) => {
      res.writeHead(200, { "content-length": "1024" });
      res.write("x");
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await expectCode(
      downloadToFile({
        url: `${base}/cancel.mp3`,
        destPath: dest("cancel.part"),
        ssrfGuard: false,
        stallTimeoutMs: 5000,
        signal: ac.signal,
      }),
      "FETCH_FAILED",
    );
  });
});
