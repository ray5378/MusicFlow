// ==================== 阶段 5.5 设备-协议绑定 + V13 新协议 fixture ====================
//
// 5.5a 单协议设备行为等价（开关关闭 = 完全走旧路径）
// 5.5b 双协议首选不可用时回退（开关打开）
// V13  新增协议只加插件 + manifest.protocols，核心零改动即可发现/解析/起播
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  enabled: [] as any[],
  settings: new Map<string, string>(),
}));

vi.mock("../../src/plugins/registry.js", () => ({
  getEnabledByCapability: () => h.enabled,
  getPluginManifest: () => undefined,
  getPluginConfig: () => null,
}));

vi.mock("../../src/services/settings.js", () => ({
  getSetting: (key: string, def = "") => (h.settings.has(key) ? h.settings.get(key)! : def),
  setSetting: (key: string, value: string) => void h.settings.set(key, value),
}));

import { createRendererPlayer } from "../../src/services/pluginAccess.js";
import {
  BINDING_SETTING_PREFIX,
  resolveDeviceBindings,
  resolveRendererForDevice,
} from "../../src/services/player/bindings.js";
import { KNOWN_RENDERER_PROTOCOLS } from "../../src/services/player/protocols.js";
import { UniversalPlayer } from "../../src/services/player/UniversalPlayer.js";
import { FIXTURE_DEVICE_ID, FIXTURE_PROTOCOL, fixtureRendererPlugin } from "./fixtures/fixtureRendererPlugin.js";

/** 一个只认自己的协议 + 指定设备 id 的最小渲染器插件（createPlayer 同步、不缓存）。 */
function rendererPlugin(protocol: string, devices: string[]) {
  const manifest = { id: `${protocol}-renderer`, capabilities: ["renderer"], protocols: [protocol] };
  return {
    manifest,
    impl: {
      manifest,
      createPlayer(p: string, deviceId: string) {
        if (p !== protocol || !devices.includes(deviceId)) return null;
        return { protocol, deviceId } as any;
      },
    },
  };
}

let prevFlag: string | undefined;

beforeEach(() => {
  prevFlag = process.env.MF_RENDERER_MULTI_BINDING;
  h.enabled.length = 0;
  h.settings.clear();
  delete process.env.MF_RENDERER_MULTI_BINDING;
});

afterEach(() => {
  if (prevFlag === undefined) delete process.env.MF_RENDERER_MULTI_BINDING;
  else process.env.MF_RENDERER_MULTI_BINDING = prevFlag;
});

describe("5.5a 单协议设备行为等价（开关关闭）", () => {
  it("绑定恒为现有协议派生单条，DB 覆盖被忽略", () => {
    h.settings.set(
      BINDING_SETTING_PREFIX + "dev-1",
      JSON.stringify([{ protocol: "airplay", priority: 1 }]),
    );
    expect(resolveDeviceBindings("dev-1", "dlna")).toEqual([{ protocol: "dlna", priority: 100 }]);
  });

  it("解析结果与改动前一致：单次调用、协议/设备原样透传、每次新建实例", () => {
    h.enabled.push(rendererPlugin("dlna", ["dev-1"]));
    const a = resolveRendererForDevice("dev-1", "dlna");
    const b = resolveRendererForDevice("dev-1", "dlna");
    expect(a?.protocol).toBe("dlna");
    expect((a?.player as any).deviceId).toBe("dev-1");
    expect(b?.player).not.toBe(a?.player);
  });

  it("开关关闭时不做跨协议回退（与今天一致：找不到即 null）", () => {
    h.enabled.push(rendererPlugin("airplay", ["dev-1"]));
    expect(resolveRendererForDevice("dev-1", "dlna")).toBeNull();
  });
});

describe("5.5b 双协议绑定回退（开关打开）", () => {
  it("首选不可用 → 回退次选", () => {
    process.env.MF_RENDERER_MULTI_BINDING = "1";
    h.enabled.push(rendererPlugin("airplay", []), rendererPlugin("dlna", ["box-1"]));
    h.settings.set(
      BINDING_SETTING_PREFIX + "box-1",
      JSON.stringify([
        { protocol: "airplay", priority: 10 },
        { protocol: "dlna", priority: 20 },
      ]),
    );
    const r = resolveRendererForDevice("box-1", "airplay");
    expect(r?.protocol).toBe("dlna");
    expect((r?.player as any).deviceId).toBe("box-1");
  });

  it("首选可用 → 用首选", () => {
    process.env.MF_RENDERER_MULTI_BINDING = "1";
    h.enabled.push(rendererPlugin("airplay", ["box-1"]), rendererPlugin("dlna", ["box-1"]));
    h.settings.set(
      BINDING_SETTING_PREFIX + "box-1",
      JSON.stringify([
        { protocol: "airplay", priority: 10 },
        { protocol: "dlna", priority: 20 },
      ]),
    );
    expect(resolveRendererForDevice("box-1", "dlna")?.protocol).toBe("airplay");
  });

  it("priority 数值小者优先（与请求协议无关）", () => {
    process.env.MF_RENDERER_MULTI_BINDING = "1";
    h.enabled.push(rendererPlugin("airplay", ["box-1"]), rendererPlugin("dlna", ["box-1"]));
    h.settings.set(
      BINDING_SETTING_PREFIX + "box-1",
      JSON.stringify([
        { protocol: "dlna", priority: 5 },
        { protocol: "airplay", priority: 10 },
      ]),
    );
    expect(resolveRendererForDevice("box-1", "airplay")?.protocol).toBe("dlna");
  });

  it("绑定可指定该协议下的设备 id（缺省 = 注册键）", () => {
    process.env.MF_RENDERER_MULTI_BINDING = "1";
    h.enabled.push(rendererPlugin("airplay", ["ap-9"]));
    h.settings.set(
      BINDING_SETTING_PREFIX + "logical-1",
      JSON.stringify([{ protocol: "airplay", deviceId: "ap-9", priority: 10 }]),
    );
    const r = resolveRendererForDevice("logical-1", "dlna");
    expect(r?.protocol).toBe("airplay");
    expect((r?.player as any).deviceId).toBe("ap-9");
  });

  it("坏 JSON / 空数组覆盖 = 回落单条默认绑定", () => {
    process.env.MF_RENDERER_MULTI_BINDING = "1";
    h.settings.set(BINDING_SETTING_PREFIX + "box-2", "{not-json");
    expect(resolveDeviceBindings("box-2", "dlna")).toEqual([{ protocol: "dlna", priority: 100 }]);
    h.settings.set(BINDING_SETTING_PREFIX + "box-2", "[]");
    expect(resolveDeviceBindings("box-2", "dlna")).toEqual([{ protocol: "dlna", priority: 100 }]);
  });
});

describe("V13 新协议 fixture：加插件即可用，核心零改动", () => {
  it("fixture 协议不在已知清单（不是白名单）", () => {
    expect(KNOWN_RENDERER_PROTOCOLS as readonly string[]).not.toContain(FIXTURE_PROTOCOL);
  });

  it("发现 → 解析 → 起播全链路走通用契约", async () => {
    h.enabled.push({ manifest: fixtureRendererPlugin.manifest, impl: fixtureRendererPlugin });

    // 发现（插件侧自述设备，核心不认协议名）
    const devices = await fixtureRendererPlugin.discover();
    expect(devices.map((d) => d.id)).toContain(FIXTURE_DEVICE_ID);

    // 解析（核心门面只按 manifest.protocols 初筛）
    expect(createRendererPlayer(FIXTURE_PROTOCOL, FIXTURE_DEVICE_ID)).toBeTruthy();
    const resolved = resolveRendererForDevice(FIXTURE_DEVICE_ID, FIXTURE_PROTOCOL);
    expect(resolved?.protocol).toBe(FIXTURE_PROTOCOL);

    // 起播（UniversalPlayer 转发给插件新建的协议 player）
    const up = new UniversalPlayer(`${FIXTURE_PROTOCOL}:${FIXTURE_DEVICE_ID}`, "Fixture Speaker");
    up.attachProtocol(resolved!.player);
    const out = await up.playMedia(
      { songId: "s-1", title: "Fixture Song", mime: "audio/mpeg" } as any,
      "http://127.0.0.1:8080/stream/s-1",
    );
    expect(out.mediaUri).toBe("fixture://s-1");
    expect((resolved!.player as any).calls).toEqual(["play:s-1"]);
  });
});
