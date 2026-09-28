// ==================== sendspin roles 工厂/生命周期补测 ====================
//
// 缺口:roles/{base,artwork,color,controller,metadata,player,source,visualizer}.ts
// 的 role 类与纯函数几乎零覆盖。这些是角色协商后真正挂到 client 上的对象 ——
// 一旦 onActivate 发错消息类型 / 编码函数字节序错，真机会「连接成功但界面空白」。
// 契约:
//   - 每个 role 的 roleId 必须与 registry 里注册的 id 一致（协商按 id 匹配）；
//   - onActivate 只做规格允许的下行（metadata/color → server/state，visualizer → stream/start）；
//   - 二进制块 = [typeId][i64 大端 μs][payload]，与 spec 参考实现字节对齐；
//   - base 的 sendJson/sendBinary 对缺失 client 必须静默（防御，不得抛）。
import "../plugins/_env.js";
import { describe, it, expect } from "vitest";
import { BaseRole, sendJson, sendBinary } from "../../src/services/sendspin/roles/base.js";
import {
  packArtworkChunk,
  ArtworkRole,
  createArtworkRole,
} from "../../src/services/sendspin/roles/artwork.js";
import { ColorRole, createColorRole } from "../../src/services/sendspin/roles/color.js";
import {
  ControllerRole,
  createControllerRole,
  mapControllerCommand,
} from "../../src/services/sendspin/roles/controller.js";
import { MetadataRole, createMetadataRole } from "../../src/services/sendspin/roles/metadata.js";
import { PlayerRole, createPlayerRole } from "../../src/services/sendspin/roles/player.js";
// 副作用导入:注册全部内置角色工厂（协商按注册表命中，不导入则 negotiateRoles 恒空）。
import "../../src/services/sendspin/roles/index.js";
import {
  registerRole,
  roleRequiresPairing,
  roleFamily,
  sortRoleIds,
  negotiateRoles,
  ROLE_IDS,
} from "../../src/services/sendspin/roles/registry.js";
import {
  SourceRole,
  createSourceRole,
  packSourceChunk,
  parseSourceChunk,
} from "../../src/services/sendspin/roles/source.js";
import {
  VisualizerRole,
  createVisualizerRole,
  BIN_VIS_LOUDNESS,
  BIN_VIS_BEAT,
  BIN_VIS_F_PEAK,
  BIN_VIS_SPECTRUM,
  BIN_VIS_PEAK,
} from "../../src/services/sendspin/roles/visualizer.js";

/** 收集式假 client：记录所有下行，形状对齐 SendspinConnection 的最小面。 */
function fakeClient() {
  const json: Array<{ type: string; payload: any }> = [];
  const bin: Uint8Array[] = [];
  return {
    json,
    bin,
    client: {
      sendJson(type: string, payload?: any) {
        json.push({ type, payload });
      },
      sendBinary(body: Uint8Array) {
        bin.push(body);
      },
    },
  };
}

describe("base role", () => {
  it("onActivate/onDeactivate 是 no-op（子类未覆写时不得抛）", () => {
    class Probe extends BaseRole {
      constructor(client: any) {
        super("probe@v1", client);
      }
    }
    const p = new Probe(null);
    expect(p.roleId).toBe("probe@v1");
    expect(() => p.onActivate()).not.toThrow();
    expect(() => p.onDeactivate()).not.toThrow();
  });

  it("sendJson 转发到 client.sendJson；client 缺失时静默", () => {
    const { client, json } = fakeClient();
    sendJson(client, "server/state", { a: 1 });
    expect(json).toEqual([{ type: "server/state", payload: { a: 1 } }]);
    // 防御：连接可能已被回收（close 后回调仍在飞）—— 不能因 client 为 null 崩掉热路径
    expect(() => sendJson(null, "server/state")).not.toThrow();
  });

  it("sendBinary 转发原始帧；client 缺失时静默", () => {
    const { client, bin } = fakeClient();
    sendBinary(client, new Uint8Array([1, 2]));
    expect(bin).toEqual([new Uint8Array([1, 2])]);
    expect(() => sendBinary(undefined, new Uint8Array([3]))).not.toThrow();
  });
});

describe("artwork@v1", () => {
  it("packArtworkChunk = [typeId][i64 BE μs][data]", () => {
    const data = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const b = packArtworkChunk(8, 0x0102030405060708n, data);
    expect(b.length).toBe(9 + data.length);
    expect(b[0]).toBe(8);
    expect(Buffer.from(b.subarray(1, 9)).readBigInt64BE(0)).toBe(0x0102030405060708n);
    expect([...b.subarray(9)]).toEqual([0xaa, 0xbb, 0xcc]);
  });

  it("onActivate 是 no-op（artwork 无 client/state 对象）", () => {
    const { client } = fakeClient();
    const r = new ArtworkRole(client);
    expect(r.roleId).toBe("artwork@v1");
    expect(() => r.onActivate()).not.toThrow();
  });

  it("sendImage 默认 typeId=8、ts=0，经 sendBinary 下发", () => {
    const { client, bin } = fakeClient();
    const r = createArtworkRole(client);
    r.sendImage(new Uint8Array([9]));
    expect(bin).toHaveLength(1);
    expect(bin[0][0]).toBe(8);
    expect(Buffer.from(bin[0].subarray(1, 9)).readBigInt64BE(0)).toBe(0n);
    // 自定义 typeId / 时间戳必须透传（type 9-11 为保留通道）
    r.sendImage(new Uint8Array([7]), 42n, 9);
    expect(bin[1][0]).toBe(9);
    expect(Buffer.from(bin[1].subarray(1, 9)).readBigInt64BE(0)).toBe(42n);
  });
});

describe("color@v1", () => {
  it("onActivate 发 server/state {color:null}（清空上次颜色）", () => {
    const { client, json } = fakeClient();
    const r = createColorRole(client);
    r.onActivate();
    expect(json).toEqual([{ type: "server/state", payload: { color: null } }]);
  });

  it("roleId 固定 color@v1", () => {
    expect(new ColorRole(null).roleId).toBe("color@v1");
  });

  it("setState：无 ts 不带 timestamp 字段，有 ts 则带上", () => {
    const { client, json } = fakeClient();
    const r = new ColorRole(client);
    r.setState("#ff00ff");
    expect(json[0]).toEqual({ type: "server/state", payload: { color: { color: "#ff00ff" } } });
    expect(json[0].payload.color).not.toHaveProperty("timestamp");
    r.setState("#00ff00", 12345);
    expect(json[1]).toEqual({
      type: "server/state",
      payload: { color: { color: "#00ff00", timestamp: 12345 } },
    });
  });
});

describe("controller@v1", () => {
  it("roleId 固定 controller@v1", () => {
    expect(new ControllerRole(null).roleId).toBe("controller@v1");
    expect(createControllerRole(null)).toBeInstanceOf(ControllerRole);
  });

  it("缺 command 名 → 抛（不可静默吞掉畸形指令）", () => {
    expect(() => mapControllerCommand({} as any)).toThrow();
    expect(() => mapControllerCommand({ command: "" } as any)).toThrow();
    expect(() => mapControllerCommand({ command: 123 } as any)).toThrow();
  });

  it("必填字段缺失 → 抛（volume/mute/seek/seek_relative）", () => {
    expect(() => mapControllerCommand({ command: "mute" } as any)).toThrow();
    expect(() => mapControllerCommand({ command: "seek" } as any)).toThrow();
    expect(() => mapControllerCommand({ command: "seek_relative" } as any)).toThrow();
  });

  it("mute 命令映射到 muted 字段", () => {
    expect(mapControllerCommand({ command: "mute", muted: true })).toEqual({ k: "mute", v: true });
  });

  it("seek_relative：offset 必须为数字", () => {
    expect(() => mapControllerCommand({ command: "seek_relative", offset_ms: "x" } as any)).toThrow();
    expect(mapControllerCommand({ command: "seek_relative", offset_ms: -500 })).toEqual({
      k: "seek_relative",
      v: -500,
    });
  });

  it("seek：position_ms=0 合法（边界），seek_max 默认为无上限", () => {
    expect(mapControllerCommand({ command: "seek", position_ms: 0 })).toEqual({ k: "seek", v: 0 });
  });

  it("无必填字段的命令（play/pause）返回 v=undefined", () => {
    expect(mapControllerCommand({ command: "pause" })).toEqual({ k: "pause", v: undefined });
  });
});

describe("metadata@v1", () => {
  it("onActivate 发 {metadata:null}", () => {
    const { client, json } = fakeClient();
    createMetadataRole(client).onActivate();
    expect(json).toEqual([{ type: "server/state", payload: { metadata: null } }]);
  });

  it("roleId 与 setState 透传完整 state", () => {
    const { client, json } = fakeClient();
    const r = new MetadataRole(client);
    expect(r.roleId).toBe("metadata@v1");
    r.setState({ title: "T", state: "playing", duration_ms: 1000 });
    expect(json[0]).toEqual({
      type: "server/state",
      payload: { metadata: { title: "T", state: "playing", duration_ms: 1000 } },
    });
  });
});

describe("player@v1", () => {
  it("roleId 固定 player@v1，激活/反激活为 no-op", () => {
    const r = createPlayerRole(null);
    expect(r).toBeInstanceOf(PlayerRole);
    expect(r.roleId).toBe("player@v1");
    expect(() => {
      r.onActivate();
      r.onDeactivate();
    }).not.toThrow();
  });
});

describe("source@v1", () => {
  it("type 12 块打包/解析往返（上行录音）", () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const b = packSourceChunk(0x1122334455667788n, data);
    expect(b[0]).toBe(12);
    expect(parseSourceChunk(b)).toEqual({ timestampUs: 0x1122334455667788n, data });
  });

  it("roleId 固定 source@v1，sendSourceStart/Data 走下行", () => {
    const { client, json, bin } = fakeClient();
    const r = new SourceRole(client);
    expect(r.roleId).toBe("source@v1");
    r.sendSourceStart({ songId: "s1" });
    expect(json[0]).toEqual({ type: "stream/start", payload: { songId: "s1" } });
    r.sendSourceData(7n, new Uint8Array([5]));
    expect(bin[0][0]).toBe(12);
    expect(() => createSourceRole(null).onDeactivate()).not.toThrow();
  });
});

describe("visualizer@v1", () => {
  it("onActivate 发 stream/start {}（BIN 通道已由 binframe 定义）", () => {
    const { client, json } = fakeClient();
    createVisualizerRole(client).onActivate();
    expect(json).toEqual([{ type: "stream/start", payload: {} }]);
  });

  it("roleId 固定 visualizer@v1，BIN 常量与 spec 对齐", () => {
    expect(new VisualizerRole(null).roleId).toBe("visualizer@v1");
    expect([BIN_VIS_LOUDNESS, BIN_VIS_BEAT, BIN_VIS_F_PEAK, BIN_VIS_SPECTRUM, BIN_VIS_PEAK]).toEqual([
      16, 17, 18, 19, 20,
    ]);
  });
});

describe("registry requiresPairing 查询", () => {
  it("未注册角色 → false（不得抛）", () => {
    expect(roleRequiresPairing("never-registered@v9")).toBe(false);
  });

  it("registerRole 的 requiresPairing 可被读回（配对门控的唯一来源）", () => {
    registerRole("probe-req@v1", () => ({}), true);
    expect(roleRequiresPairing("probe-req@v1")).toBe(true);
    registerRole("probe-noreq@v1", () => ({}), false);
    expect(roleRequiresPairing("probe-noreq@v1")).toBe(false);
  });

  it("sortRoleIds 稳定：player < controller < 其余(保持 client 序)", () => {
    expect(sortRoleIds(["color@v1", "player@v1", "metadata@v1", "controller@v1"])).toEqual([
      "player@v1",
      "controller@v1",
      "color@v1",
      "metadata@v1",
    ]);
    expect(roleFamily("source@v1")).toBe("source");
    expect(ROLE_IDS).toContain("visualizer@v1");
  });

  it("negotiateRoles 同 family 只取首个命中（客户端重复声明不重复激活）", () => {
    expect(negotiateRoles(["player@v1", "player@v1", "controller@v1"])).toEqual([
      "player@v1",
      "controller@v1",
    ]);
  });
});
