// 播放器自动发现:只测纯逻辑(mDNS 浏览本身靠真机联调验证)。
import { describe, it, expect } from "vitest";
import { pickIPv4, startPlayerDiscovery, stopPlayerDiscovery } from "./discover.js";

describe("discover pickIPv4", () => {
  it("addresses 优先取 IPv4,跳过 IPv6", () => {
    expect(pickIPv4({ addresses: ["fe80::1", "192.168.10.245"], host: "x.local" }))
      .toBe("192.168.10.245");
  });
  it("无 IPv4 时退 host", () => {
    expect(pickIPv4({ addresses: [], host: "esp32-player-meet.local" }))
      .toBe("esp32-player-meet.local");
  });
  it("referer.address 兼容", () => {
    expect(pickIPv4({ referer: { address: "192.168.10.99" } })).toBe("192.168.10.99");
  });
});

describe("discover lifecycle", () => {
  it("stop 幂等,无服务不炸", () => {
    expect(() => stopPlayerDiscovery()).not.toThrow();
    stopPlayerDiscovery();
  });
});
