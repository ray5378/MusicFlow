// ==================== 渲染器插件 createPlayer 归属闸门 ====================
//
// 阶段 2/3 给 airplay / sendspin 补上 createPlayer(阶段 1 已有 dlna)。三者契约一致:
//   - 协议不匹配 → null(不串协议)
//   - 设备不在**本插件自己的**设备表/名单 → null(禁止盲透传)
//   - 命中 → 交给对应协议工厂(每次新建,不缓存)
// 工厂与设备表全部 mock,只验证闸门与转发,不触网、不建会话。
import { describe, it, expect, vi } from "vitest";

const H = vi.hoisted(() => ({
  dlna: [] as any[],
  ap: [] as any[],
  spin: new Set<string>(),
  made: [] as string[],
}));

vi.mock("../../src/services/dlna/control.js", () => ({
  getCachedDevices: () => H.dlna,
  createDlnaProtocolPlayer: (id: string) => {
    H.made.push(`dlna:${id}`);
    return { playerId: `dlna:${id}` };
  },
}));

vi.mock("../../src/services/dlna/discovery.js", () => ({
  markStaleDevices: (x: any) => x,
}));

vi.mock("../../src/services/airplay/control.js", () => ({
  listAirPlayDevices: () => H.ap,
  hasAirPlayDevice: (id: string) => H.ap.some((d) => d.id === id),
}));

vi.mock("../../src/services/airplay/protocolPlayer.js", () => ({
  createAirPlayPlayerForDevice: (id: string) => {
    H.made.push(`airplay:${id}`);
    return { playerId: `airplay:${id}` };
  },
}));

vi.mock("../../src/services/sendspin/control.js", () => ({
  listSendspinPlayers: async () => [],
  castSendspin: async () => ({ mediaUri: "" }),
  controlSendspin: async () => undefined,
}));

vi.mock("../../src/services/sendspin/index.js", () => ({
  isSendspinClientKnown: (id: string) => H.spin.has(id),
}));

vi.mock("../../src/services/sendspin/protocolPlayer.js", () => ({
  createSendspinProtocolPlayer: (id: string) => {
    H.made.push(`sendspin:${id}`);
    return { playerId: `sendspin:${id}` };
  },
}));

import { dlnaRendererPlugin } from "../../src/services/plugin/renderers/dlna.js";
import { airplayRendererPlugin } from "../../src/services/plugin/renderers/airplay.js";
import { sendspinRendererPlugin } from "../../src/services/plugin/renderers/sendspin.js";

describe("renderer createPlayer 归属闸门", () => {
  it("协议不匹配一律 null(不串协议)", () => {
    H.dlna = [{ id: "d1" }];
    H.ap = [{ id: "a1" }];
    H.spin = new Set(["s1"]);
    expect(dlnaRendererPlugin.createPlayer!("airplay", "d1")).toBeNull();
    expect(dlnaRendererPlugin.createPlayer!("sendspin", "d1")).toBeNull();
    expect(airplayRendererPlugin.createPlayer!("dlna", "a1")).toBeNull();
    expect(airplayRendererPlugin.createPlayer!("sendspin", "a1")).toBeNull();
    expect(sendspinRendererPlugin.createPlayer!("airplay", "s1")).toBeNull();
    expect(sendspinRendererPlugin.createPlayer!("dlna", "s1")).toBeNull();
  });

  it("设备不在本插件设备表/名单 → null(禁止盲透传)", () => {
    H.dlna = [];
    H.ap = [];
    H.spin = new Set();
    expect(dlnaRendererPlugin.createPlayer!("dlna", "x")).toBeNull();
    expect(airplayRendererPlugin.createPlayer!("airplay", "x")).toBeNull();
    expect(sendspinRendererPlugin.createPlayer!("sendspin", "x")).toBeNull();
  });

  it("命中 → 交给对应协议工厂", () => {
    H.dlna = [{ id: "d1" }];
    H.ap = [{ id: "a1" }];
    H.spin = new Set(["s1"]);
    H.made = [];
    expect((dlnaRendererPlugin.createPlayer!("dlna", "d1") as any).playerId).toBe("dlna:d1");
    expect((airplayRendererPlugin.createPlayer!("airplay", "a1") as any).playerId).toBe("airplay:a1");
    expect((sendspinRendererPlugin.createPlayer!("sendspin", "s1") as any).playerId).toBe("sendspin:s1");
    expect(H.made).toEqual(["dlna:d1", "airplay:a1", "sendspin:s1"]);
  });
});
