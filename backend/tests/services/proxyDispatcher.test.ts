// ==================== 代理分发器与连通性探测契约 ====================
//
// 为什么补这一层:`services/proxy.ts` 的 `getProxyDispatcher`(agent 缓存/FIFO 淘汰)、
// `proxyFetch` 的 proxy 覆盖三态、以及 `testProxyConnection` 的四种结论分支,决定的是
// 「插件市场拉了没拉 / 外呼走没走代理 / 代理坏了怎么报错」。这些分支真跑需要真实代理
// 服务器与真实外网,只能靠替换 undici 假体在离线环境精确驱动。
//
// 手法:vi.mock("undici") 提供可控 fetch 与可观测的 ProxyAgent/Socks5ProxyAgent 存根,
// 设置项仍走真实 settings(内存缓存),从而只隔离「网络出口」这一个变量。
// 每个用例使用**独立代理地址**,避免依赖 agent 模块级缓存的构造次数(套件会打乱顺序)。
//
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { initDatabase } from "../../src/db/index.js";
import { setSetting } from "../../src/services/settings.js";

const H = vi.hoisted(() => ({
  agents: [] as Array<{ kind: string; url: string; closed: number }>,
  fetchMock: vi.fn(),
  netFetch: vi.fn(),
  seq: 0,
}));

vi.mock("undici", () => {
  class Base {
    ref: { kind: string; url: string; closed: number };
    constructor(public url: string) {
      const kind = new.target.name === "Socks5ProxyAgent" ? "socks" : "http";
      this.ref = { kind, url, closed: 0 };
      H.agents.push(this.ref);
    }
    close() {
      this.ref.closed += 1;
      return Promise.resolve();
    }
  }
  class ProxyAgent extends Base {}
  class Socks5ProxyAgent extends Base {}
  return { ProxyAgent, Socks5ProxyAgent, fetch: H.fetchMock };
});

import {
  normalizeProxyUrl,
  proxyFetch,
  testProxyConnection,
  __setProxyTestTargets,
} from "../../src/services/proxy.js";

const ORIG_FETCH = globalThis.fetch;

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

beforeEach(() => {
  H.agents.length = 0;
  H.fetchMock.mockReset();
  H.netFetch.mockReset();
  setSetting("proxy_enabled", "false");
  setSetting("proxy_url", "");
  (globalThis as any).fetch = H.netFetch;
  __setProxyTestTargets("https://raw.githubusercontent.com/x/registry.json", ["https://example.com/", "https://www.gstatic.com/generate_204"]);
});

afterAll(() => {
  (globalThis as any).fetch = ORIG_FETCH;
});

/** 每次调用返回一个互不相同的代理地址 → agent 构造次数可精确断言。 */
function uniqProxy(scheme = "http") {
  H.seq += 1;
  return `${scheme}://127.0.0.1:${10000 + H.seq}`;
}

describe("normalizeProxyUrl:非法地址必须判为未配置(宁可直连,不可半坏)", () => {
  it("无法被 URL 解析的畸形地址 → 返回空串而非抛错", () => {
    // 这一条防的是「用户手抖输入 http://[ 之类」时整条代理链路崩溃:
    // 解析异常必须被吞掉并降级为直连。
    expect(() => normalizeProxyUrl("http://[")).not.toThrow();
    expect(normalizeProxyUrl("http://[")).toBe("");
  });
});

describe("proxyFetch:proxy 覆盖三态", () => {
  it("系统开启 + 覆盖 true → 经 undici fetch + ProxyAgent 转发", async () => {
    const url = uniqProxy();
    setSetting("proxy_enabled", "true");
    setSetting("proxy_url", url);
    H.fetchMock.mockResolvedValue({ status: 200, ok: true });
    const r = await proxyFetch("https://target.example/x", { proxy: true });
    expect(r.status).toBe(200);
    expect(H.fetchMock).toHaveBeenCalledTimes(1);
    const init = H.fetchMock.mock.calls[0][1];
    expect(init.dispatcher).toBeTruthy();
    expect(H.netFetch).not.toHaveBeenCalled();
    // proxy 字段不得泄漏给底层 fetch(undici 不认识会报错)
    expect(init).not.toHaveProperty("proxy");
    const created = H.agents.filter((a) => a.url === url);
    expect(created.length).toBe(1);
    expect(created[0].kind).toBe("http");
  });

  it("socks5:// → 选 Socks5ProxyAgent 而非 ProxyAgent", async () => {
    const url = uniqProxy("socks5");
    setSetting("proxy_enabled", "true");
    setSetting("proxy_url", url);
    H.fetchMock.mockResolvedValue({ status: 200, ok: true });
    await proxyFetch("https://target.example/x", { proxy: true });
    expect(H.agents.find((a) => a.url === url)!.kind).toBe("socks");
  });

  it("覆盖 false → 即使系统开着也强制直连(插件级关闭代理)", async () => {
    setSetting("proxy_enabled", "true");
    setSetting("proxy_url", uniqProxy());
    H.netFetch.mockResolvedValue({ status: 200, ok: true });
    await proxyFetch("https://target.example/x", { proxy: false });
    expect(H.netFetch).toHaveBeenCalledTimes(1);
    expect(H.fetchMock).not.toHaveBeenCalled();
  });

  it("覆盖 true 但系统未配地址 → 降级直连(不构造空 dispatcher)", async () => {
    H.netFetch.mockResolvedValue({ status: 200, ok: true });
    await proxyFetch("https://target.example/x", { proxy: true });
    expect(H.netFetch).toHaveBeenCalledTimes(1);
    expect(H.fetchMock).not.toHaveBeenCalled();
  });

  it("未指定覆盖且系统关闭 → 直连", async () => {
    H.netFetch.mockResolvedValue({ status: 200, ok: true });
    await proxyFetch("https://target.example/x");
    expect(H.netFetch).toHaveBeenCalledTimes(1);
  });

  it("同地址复用同一个 agent(连接池复用,不每次新建)", async () => {
    const url = uniqProxy();
    setSetting("proxy_enabled", "true");
    setSetting("proxy_url", url);
    H.fetchMock.mockResolvedValue({ status: 200, ok: true });
    await proxyFetch("https://a/1", { proxy: true });
    await proxyFetch("https://a/2", { proxy: true });
    expect(H.agents.filter((a) => a.url === url).length).toBe(1);
  });

  it("agent 缓存超上限(32)时淘汰最旧并关闭其连接池(防 socket 泄漏)", async () => {
    setSetting("proxy_enabled", "true");
    H.fetchMock.mockResolvedValue({ status: 200, ok: true });
    const urls: string[] = [];
    for (let i = 0; i < 40; i++) {
      const u = uniqProxy();
      urls.push(u);
      setSetting("proxy_url", u);
      await proxyFetch("https://a/x", { proxy: true });
    }
    const inFile = H.agents.filter((a) => urls.includes(a.url));
    expect(inFile.length).toBe(40);
    // 至少有一个旧 agent 被 close() 过 —— 否则 keep-alive 连接池无界累积。
    expect(inFile.filter((a) => a.closed >= 1).length).toBeGreaterThanOrEqual(1);
  });
});

describe("testProxyConnection:四种结论的判定与文案", () => {
  it("未启用 → success=false 且不发起任何探测", async () => {
    const r = await testProxyConnection();
    expect(r.success).toBe(false);
    expect(r.githubReachable).toBeNull();
    expect(r.probes).toEqual([]);
    expect(H.fetchMock).not.toHaveBeenCalled();
  });

  it("GitHub 返回非 2xx → 通道正常但插件源异常(文案含 HTTP 码)", async () => {
    setSetting("proxy_enabled", "true");
    setSetting("proxy_url", uniqProxy());
    H.fetchMock.mockResolvedValueOnce({ status: 503, ok: false });
    const r = await testProxyConnection();
    expect(r.success).toBe(true);
    expect(r.githubReachable).toBe(false);
    expect(r.message).toContain("503");
  });

  it("GitHub 不通但中性站点可达 → 判定为「分流规则挡住 GitHub」而非「代理坏」", async () => {
    setSetting("proxy_enabled", "true");
    setSetting("proxy_url", uniqProxy());
    H.fetchMock
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockResolvedValueOnce({ status: 204, ok: true });
    const r = await testProxyConnection();
    expect(r.success).toBe(true);
    expect(r.githubReachable).toBeNull();
    expect(r.message).toContain("GitHub");
    expect(r.probes.length).toBe(2);
  });

  it("首个中性站点也不通、第二个通 → 继续尝试直到命中(不因第一个失败就放弃)", async () => {
    setSetting("proxy_enabled", "true");
    setSetting("proxy_url", uniqProxy());
    H.fetchMock
      .mockRejectedValueOnce(new Error("github down"))
      .mockRejectedValueOnce(new Error("neutral1 down"))
      .mockResolvedValueOnce({ status: 200, ok: true });
    const r = await testProxyConnection();
    expect(r.success).toBe(true);
    expect(r.probes.length).toBe(2);
  });

  it("全部不通 → success=false 且文案带底层错误", async () => {
    setSetting("proxy_enabled", "true");
    setSetting("proxy_url", uniqProxy());
    H.fetchMock.mockRejectedValue(new Error("boom-proxy"));
    const r = await testProxyConnection();
    expect(r.success).toBe(false);
    expect(r.message).toContain("boom-proxy");
  });
});
