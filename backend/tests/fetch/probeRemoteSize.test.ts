import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeRemoteSize } from "../../src/utils/httpDownload.js";

let server: http.Server;
let base = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = req.url || "";
    if (u === "/cl") {
      res.writeHead(200, { "content-length": "12345678" });
      res.end();
      return;
    }
    if (u === "/nohead") {
      if (req.method === "HEAD") {
        res.writeHead(405, { allow: "GET" });
        res.end();
        return;
      }
      if (req.headers.range === "bytes=0-0") {
        res.writeHead(206, { "content-range": "bytes 0-0/7654321" });
        res.end("x");
        return;
      }
      res.writeHead(200, { "content-length": "7654321" });
      res.end();
      return;
    }
    if (u === "/norange") {
      if (req.method === "HEAD") {
        res.writeHead(405);
        res.end();
        return;
      }
      // 服务器忽略 Range：回 200 全量，但客户端读完头就断开
      res.writeHead(200, { "content-length": "7654321" });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("probeRemoteSize（PATCH15 直链体积预探）", () => {
  it("HEAD 200 + content-length → 直接返回", async () => {
    expect(await probeRemoteSize({ url: `${base}/cl`, ssrfGuard: false })).toBe(12345678);
  });

  it("HEAD 405 → GET Range 206 → content-range 全量", async () => {
    expect(await probeRemoteSize({ url: `${base}/nohead`, ssrfGuard: false })).toBe(7654321);
  });

  it("HEAD 405 → GET 200（忽略 Range）→ content-length 兜底", async () => {
    expect(await probeRemoteSize({ url: `${base}/norange`, ssrfGuard: false })).toBe(7654321);
  });

  it("HEAD/GET 全 404 → null", async () => {
    expect(await probeRemoteSize({ url: `${base}/404`, ssrfGuard: false })).toBeNull();
  });

  it("连接拒绝 → null（不抛）", async () => {
    expect(await probeRemoteSize({ url: "http://127.0.0.1:1/x", ssrfGuard: false, timeoutMs: 1500 })).toBeNull();
  });
});
