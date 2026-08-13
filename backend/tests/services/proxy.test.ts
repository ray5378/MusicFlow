// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import http from "node:http";
import { db, initDatabase } from "../../src/db/index.js";
import { normalizeProxyUrl, getProxyConfig, proxyFetch } from "../../src/services/proxy.js";
import { setSetting } from "../../src/services/settings.js";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

beforeEach(() => {
  // 注意:settings.ts 有内存缓存,setSetting 写缓存,db.delete 清不掉 → 必须用 setSetting 复位
  setSetting("proxy_enabled", "false");
  setSetting("proxy_url", "");
});

describe("normalizeProxyUrl", () => {
  it("接受 http://ip:port", () => {
    expect(normalizeProxyUrl("http://192.168.1.10:7890")).toBe("http://192.168.1.10:7890");
  });
  it("接受 https://host:port 并去尾斜杠", () => {
    expect(normalizeProxyUrl("https://proxy.example.com:8443/")).toBe("https://proxy.example.com:8443");
  });
  it("拒绝无协议", () => {
    expect(normalizeProxyUrl("192.168.1.10:7890")).toBe("");
  });
  it("拒绝无端口", () => {
    expect(normalizeProxyUrl("http://192.168.1.10")).toBe("");
  });
  it("接受 socks5:// 并去尾斜杠", () => {
    expect(normalizeProxyUrl("socks5://127.0.0.1:1080/")).toBe("socks5://127.0.0.1:1080");
  });
  it("接受 socks:// 与 socks4://", () => {
    expect(normalizeProxyUrl("socks://192.168.1.10:1080")).toBe("socks://192.168.1.10:1080");
    expect(normalizeProxyUrl("socks4://proxy:1081")).toBe("socks4://proxy:1081");
  });
  it("拒绝非 http(s)/socks 协议与乱码", () => {
    expect(normalizeProxyUrl("ftp://x:21")).toBe("");
    expect(normalizeProxyUrl("not a url")).toBe("");
  });
  it("空串视为未配置", () => {
    expect(normalizeProxyUrl("")).toBe("");
    expect(normalizeProxyUrl("   ")).toBe("");
  });
});

describe("getProxyConfig", () => {
  it("默认关闭、无地址", () => {
    expect(getProxyConfig()).toEqual({ enabled: false, url: "" });
  });
  it("开关开但地址非法 → enabled 视为 false", () => {
    setSetting("proxy_enabled", "true");
    setSetting("proxy_url", "1.2.3.4:99");
    expect(getProxyConfig()).toEqual({ enabled: false, url: "" });
  });
  it("开关开 + 合法地址 → enabled true", () => {
    setSetting("proxy_enabled", "true");
    setSetting("proxy_url", "http://127.0.0.1:8080");
    expect(getProxyConfig()).toEqual({ enabled: true, url: "http://127.0.0.1:8080" });
  });
});

describe("proxyFetch (无代理 = 原生 fetch 直连)", () => {
  it("未启用代理时直连本地服务返回 200", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    try {
      const res = await proxyFetch(`http://127.0.0.1:${port}/x`, { signal: AbortSignal.timeout(5000) });
      expect(res.ok).toBe(true);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      server.close();
    }
  });
});
