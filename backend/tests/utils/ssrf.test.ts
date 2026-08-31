// SSRF 防护工具单测:isBlockedIp / isBlockedCoverProxyUrl。
// 全部使用 IP 字面量 / 白名单路径,不依赖真实 DNS 外网查询(CI 稳定)。
import { describe, it, expect, afterEach } from "vitest";
import { isBlockedIp, isBlockedCoverProxyUrl } from "../../src/utils/ssrf.js";

describe("isBlockedIp", () => {
  it("拦截回环 / 私网 / 链路本地 / 保留地址", () => {
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("10.0.0.5")).toBe(true);
    expect(isBlockedIp("172.16.0.1")).toBe(true);
    expect(isBlockedIp("172.31.255.255")).toBe(true);
    expect(isBlockedIp("172.32.0.1")).toBe(false); // 172.32 不在私网段
    expect(isBlockedIp("192.168.1.1")).toBe(true);
    expect(isBlockedIp("169.254.169.254")).toBe(true); // 云元数据
    expect(isBlockedIp("0.0.0.0")).toBe(true);
    expect(isBlockedIp("100.64.0.1")).toBe(true); // CGNAT
    expect(isBlockedIp("224.0.0.1")).toBe(true); // 组播
    expect(isBlockedIp("::1")).toBe(true);
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true); // IPv4 映射
    expect(isBlockedIp("fc00::1")).toBe(true); // ULA
    expect(isBlockedIp("fe80::1")).toBe(true); // 链路本地
    expect(isBlockedIp("2001:db8::1")).toBe(true); // 文档
  });

  it("放行公网地址", () => {
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    expect(isBlockedIp("1.1.1.1")).toBe(false);
    expect(isBlockedIp("2001:4860:4860::8888")).toBe(false);
  });
});

describe("isBlockedCoverProxyUrl", () => {
  const prevAllowHosts = process.env.COVER_PROXY_ALLOW_HOSTS;
  const prevAllowPrivate = process.env.COVER_PROXY_ALLOW_PRIVATE;

  afterEach(() => {
    process.env.COVER_PROXY_ALLOW_HOSTS = prevAllowHosts;
    process.env.COVER_PROXY_ALLOW_PRIVATE = prevAllowPrivate;
  });

  it("拦截内网 / 回环 / 链路本地目标(字面量 IP,不走 DNS)", async () => {
    expect(await isBlockedCoverProxyUrl("http://127.0.0.1/x")).toBe(true);
    expect(await isBlockedCoverProxyUrl("http://10.0.0.5/cover.jpg")).toBe(true);
    expect(await isBlockedCoverProxyUrl("http://169.254.169.254/latest/meta-data/")).toBe(true);
    expect(await isBlockedCoverProxyUrl("http://[::1]/x")).toBe(true);
  });

  it("放行公网目标", async () => {
    expect(await isBlockedCoverProxyUrl("http://8.8.8.8/cover.jpg")).toBe(false);
    expect(await isBlockedCoverProxyUrl("https://1.1.1.1/x")).toBe(false);
  });

  it("拒绝非 http(s) scheme 与无法解析的主机名", async () => {
    expect(await isBlockedCoverProxyUrl("ftp://8.8.8.8/x")).toBe(true);
    expect(await isBlockedCoverProxyUrl("file:///etc/passwd")).toBe(true);
    expect(await isBlockedCoverProxyUrl("http://not-a-real-host-name-xyz.invalid/x")).toBe(true);
  });

  it("COVER_PROXY_ALLOW_HOSTS 精确白名单可放行内网主机名(不依赖 DNS)", async () => {
    process.env.COVER_PROXY_ALLOW_HOSTS = "intranet.local,cdn.example.com";
    expect(await isBlockedCoverProxyUrl("http://intranet.local/cover.jpg")).toBe(false);
    expect(await isBlockedCoverProxyUrl("http://127.0.0.1/x")).toBe(true); // IP 不受白名单影响
  });

  it("COVER_PROXY_ALLOW_PRIVATE=1 整体放行内网", async () => {
    process.env.COVER_PROXY_ALLOW_PRIVATE = "1";
    expect(await isBlockedCoverProxyUrl("http://127.0.0.1/x")).toBe(false);
    expect(await isBlockedCoverProxyUrl("http://10.0.0.5/x")).toBe(false);
  });
});
