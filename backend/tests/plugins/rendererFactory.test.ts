// 渲染器工厂门面(阶段 0):验证同步返回 / 协议与设备归属 / 不缓存 / 注册顺序。
import { describe, it, expect, vi, beforeEach } from "vitest";

const enabled: any[] = [];
vi.mock("../../src/plugins/registry.js", () => ({
  getEnabledByCapability: () => enabled,
  getPluginConfig: () => ({}),
  getPluginManifest: () => undefined,
}));

import { createRendererPlayer } from "../../src/services/pluginAccess.js";

function plugin(own: string) {
  return {
    impl: {
      manifest: { id: own + "-renderer" },
      createPlayer(protocol: string, deviceId: string) {
        if (protocol !== own) return null;
        if (!deviceId.startsWith(own)) return null;
        return { protocol: own, deviceId } as any;
      },
    },
  };
}

beforeEach(() => {
  enabled.length = 0;
});

describe("createRendererPlayer(阶段 0 契约)", () => {
  it("同步返回插件新建的播放器实例", () => {
    enabled.push(plugin("dlna"));
    const p = createRendererPlayer("dlna", "dlna-device-1");
    expect(p).toBeTruthy();
    expect((p as any).protocol).toBe("dlna");
    expect((p as any).deviceId).toBe("dlna-device-1");
  });

  it("协议或设备归属不匹配时返回 null(不靠注册顺序兜底)", () => {
    enabled.push(plugin("airplay"), plugin("dlna"));
    expect(createRendererPlayer("sendspin", "sendspin-1")).toBeNull();
    expect(createRendererPlayer("dlna", "airplay-1")).toBeNull();
  });

  it("每次调用新建实例,不缓存", () => {
    enabled.push(plugin("sendspin"));
    const a = createRendererPlayer("sendspin", "sendspin-1");
    const b = createRendererPlayer("sendspin", "sendspin-1");
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it("按注册顺序取首个非 null 结果", () => {
    enabled.push(plugin("airplay"), plugin("dlna"));
    const p = createRendererPlayer("dlna", "dlna-x");
    expect((p as any).protocol).toBe("dlna");
  });
});
